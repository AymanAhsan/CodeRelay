import {
  TEAM_HUB_DOCKER_IMAGE,
  teamHubDockerRunArgs,
  type TeamHubStartFailureReason,
  type TeamHubStartInput,
  type TeamHubStartResult,
  type TeamHubSetupLinkResult,
  type TeamHubCreateLocalTeamInput,
} from "@t3tools/contracts/teamHub";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { hubDockerTag } from "./image.ts";

// The first run downloads the image, including on slower connections.
const RUN_TIMEOUT = Duration.minutes(10);
const LOGS_TIMEOUT = Duration.seconds(5);
// Starting a container that already exists never downloads anything.
const RESTART_TIMEOUT = Duration.seconds(30);
// The hub prints its setup link right after it starts listening.
const SETUP_LINK_ATTEMPTS = 10;
const SETUP_LINK_RETRY_DELAY = Duration.millis(500);
// Enough for any Docker error, small enough to send to a client.
const OUTPUT_LIMIT = 2_000;

// The registry answered but has no image under that tag, unlike a network failure.
const TAG_NOT_PUBLISHED_PATTERN = /manifest unknown|failed to resolve reference.*: not found/i;
const FALLBACK_TAG = "edge";

const SETUP_LINK_PATTERN = /One-time setup link: (\S+)/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const PUBLISHED_PORT_PATTERN = /:(\d+)\s*$/m;

// Run against the existing image too: no image upgrade or hub restart is needed.
// Read current state rather than logs, which can still contain a consumed token.
const READ_SETUP_TOKEN = `
const { DatabaseSync } = require("node:sqlite");
const { join } = require("node:path");
const { createHmac, createHash } = require("node:crypto");
const db = new DatabaseSync(join(process.env.HUB_DATA_DIR ?? "/data", "hub.sqlite"), { readOnly: true });
try {
  db.exec("BEGIN");
  const key = db.prepare("SELECT value FROM meta WHERE key='signing_key'").get()?.value;
  const setup = db.prepare("SELECT value FROM meta WHERE key='setup_hash'").get()?.value;
  if (key && setup && !db.prepare("SELECT 1 FROM teams LIMIT 1").get()) {
    const token = createHmac("sha256", key).update("first-team-setup").digest("base64url");
    if (createHash("sha256").update(token).digest("hex") === setup) process.stdout.write(token);
  } else if (db.prepare("SELECT 1 FROM teams LIMIT 1").get()) {
    process.stdout.write("configured");
  }
} finally { db.close(); }
`;

// Docker access is hub-operator authority. Use the image's store API so existing
// images work too, without reviving setup tokens or changing any old membership.
const CREATE_LOCAL_TEAM = `
import { HubStore } from "./apps/hub/src/store.ts";
const input = JSON.parse(process.argv[1]);
const store = new HubStore(process.env.HUB_DATA_DIR ?? "/data");
try {
  const admin = store.db.prepare("SELECT * FROM members WHERE role='admin' AND revoked_at IS NULL LIMIT 1").get();
  const result = store.setupToken
    ? store.bootstrap(store.setupToken, input.teamName, input.repo, input.displayName)
    : store.createTeam({ ...admin, name: input.displayName }, input.teamName, input.repo);
  process.stdout.write(JSON.stringify({ credential: result.credential }));
} finally { store.close(); }
`;

// Check the local database before associating a hub URL with a Docker container.
const CHECK_HUB_TEAM = `
const { DatabaseSync } = require("node:sqlite");
const { join } = require("node:path");
const db = new DatabaseSync(join(process.env.HUB_DATA_DIR ?? "/data", "hub.sqlite"), { readOnly: true });
try {
  const [teamId, credentialHash] = process.argv.slice(1);
  const matches = credentialHash
    ? db.prepare("SELECT 1 FROM members WHERE team_id=? AND credential_hash=? AND role='admin' AND revoked_at IS NULL").get(teamId, credentialHash)
    : !db.prepare("SELECT 1 FROM teams LIMIT 1").get();
  if (matches) process.stdout.write("yes");
} finally { db.close(); }
`;

// Older hub images lack the HTTP delete route. With one team in the database,
// stopping the container also closes every connection for that team.
const DELETE_LAST_HUB_TEAM = `
const { DatabaseSync } = require("node:sqlite");
const { join } = require("node:path");
const db = new DatabaseSync(join(process.env.HUB_DATA_DIR ?? "/data", "hub.sqlite"));
try {
  db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  const [teamId, credentialHash] = process.argv.slice(1);
  const owner = db.prepare("SELECT 1 FROM members WHERE team_id=? AND credential_hash=? AND role='admin' AND revoked_at IS NULL").get(teamId, credentialHash);
  if (owner && !db.prepare("SELECT 1 FROM teams WHERE id<>? LIMIT 1").get(teamId)) {
    for (const table of ["claims", "contract_changes", "notes", "summaries", "tasks", "invites", "members"]) {
      db.prepare("DELETE FROM " + table + " WHERE team_id=?").run(teamId);
    }
    db.prepare("DELETE FROM teams WHERE id=?").run(teamId);
    db.exec("DELETE FROM meta WHERE key IN ('signing_key','setup_hash'); COMMIT");
    process.stdout.write("yes");
  }
} finally { db.close(); }
`;

export class TeamHubDockerError extends Schema.TaggedError<TeamHubDockerError>()(
  "TeamHubDockerError",
  {
    reason: Schema.String,
  },
) {}

const decodeCreatedMembership = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.NonEmptyString })),
);
const encodeLocalTeam = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      teamName: Schema.String,
      repo: Schema.String,
      displayName: Schema.String,
    }),
  ),
);

// Matched against Docker's stderr, most specific first.
const FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, TeamHubStartFailureReason]> = [
  [/is already in use by container/i, "name-in-use"],
  [/port is already allocated|address already in use|ports are not available/i, "port-in-use"],
  [
    /cannot connect to the docker daemon|error during connect|docker daemon is not running|docker desktop is not running/i,
    "docker-not-running",
  ],
  [
    /no such image|pull access denied|manifest unknown|manifest.*not found|TLS handshake|no such host|failed to resolve reference|unauthorized|denied:|network is unreachable|connection refused|i\/o timeout/i,
    "image-missing",
  ],
];

const reasonOf = (output: string): TeamHubStartFailureReason =>
  FAILURE_PATTERNS.find(([pattern]) => pattern.test(output))?.[1] ?? "command-failed";

const trimOutput = (output: string): string => {
  const text = output.trim();
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…` : text;
};

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

type DockerRun =
  | {
      readonly _tag: "exited";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly _tag: "not-installed" }
  | { readonly _tag: "timed-out" };

export class TeamHubDocker extends Context.Service<
  TeamHubDocker,
  {
    /**
     * Starts a hub container on this machine and reads back its setup link.
     * Docker's failures come back as a result, with its message, so the person
     * sees what Docker said rather than a generic error.
     */
    readonly start: (input: TeamHubStartInput) => Effect.Effect<TeamHubStartResult>;
    /**
     * Starts an existing hub container again, for when `start` found its name taken.
     * The container keeps the port and volume it was created with, so the address
     * comes from Docker, not from the input.
     */
    readonly restart: (input: TeamHubStartInput) => Effect.Effect<TeamHubStartResult>;
    /** Reads an unused setup link from a running local Docker hub without restarting it. */
    readonly setupLink: (input: TeamHubStartInput) => Effect.Effect<TeamHubSetupLinkResult>;
    readonly findTeamContainer: (
      teamId: string,
      credential: string,
    ) => Effect.Effect<string | null>;
    readonly deleteLastTeam: (
      id: string,
      teamId: string,
      credential: string,
    ) => Effect.Effect<void, TeamHubDockerError>;
    readonly removeEmptyContainer: (id: string) => Effect.Effect<void, TeamHubDockerError>;
    readonly createTeam: (
      input: TeamHubCreateLocalTeamInput,
    ) => Effect.Effect<string, TeamHubDockerError>;
  }
>()("t3/teamHub/TeamHubDocker") {}

const make = (tag: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const docker = (args: ReadonlyArray<string>, timeout: Duration.Duration) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make("docker", args));
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectText(child.stdout),
            collectText(child.stderr),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        return { _tag: "exited", code, stdout, stderr } satisfies DockerRun as DockerRun;
      }).pipe(
        Effect.scoped,
        Effect.timeout(timeout),
        Effect.catchTag("TimeoutError", () => Effect.succeed<DockerRun>({ _tag: "timed-out" })),
        // Failing to spawn at all means there is no `docker` to run. Node can also
        // throw synchronously for a bad PATH entry, which surfaces as a defect.
        Effect.catch(() => Effect.succeed<DockerRun>({ _tag: "not-installed" })),
        Effect.catchDefect(() => Effect.succeed<DockerRun>({ _tag: "not-installed" })),
      );

    // `since` limits the logs to the container's latest run: Docker keeps a
    // container's output across restarts, and an earlier run's link is stale.
    const readSetupLink = (name: string, since?: string) =>
      Effect.gen(function* () {
        const logsArgs = since === undefined ? ["logs", name] : ["logs", "--since", since, name];
        for (let attempt = 0; attempt < SETUP_LINK_ATTEMPTS; attempt += 1) {
          const logs = yield* docker(logsArgs, LOGS_TIMEOUT);
          if (logs._tag === "exited") {
            const match = SETUP_LINK_PATTERN.exec(`${logs.stdout}\n${logs.stderr}`);
            if (match?.[1] !== undefined) return match[1];
            // Listening without a link means the volume already holds a team.
            if (/Team hub listening/.test(logs.stdout)) return null;
          }
          yield* Effect.sleep(SETUP_LINK_RETRY_DELAY);
        }
        return null;
      });

    const start = (input: TeamHubStartInput): Effect.Effect<TeamHubStartResult> =>
      Effect.gen(function* () {
        // Edge moves with main, so refresh a cached copy first. A failed pull is
        // ignored: offline, the cached image still starts.
        const runFrom = (imageTag: string) =>
          Effect.gen(function* () {
            if (imageTag === FALLBACK_TAG) {
              yield* docker(["pull", `${TEAM_HUB_DOCKER_IMAGE}:${imageTag}`], RUN_TIMEOUT);
            }
            return yield* docker(teamHubDockerRunArgs(input, imageTag), RUN_TIMEOUT);
          });
        let run = yield* runFrom(tag);
        // A build can carry a version whose hub image was never published, such as a
        // main build. The newest main image beats refusing to start.
        if (
          tag !== FALLBACK_TAG &&
          run._tag === "exited" &&
          run.code !== 0 &&
          TAG_NOT_PUBLISHED_PATTERN.test(run.stderr)
        ) {
          run = yield* runFrom(FALLBACK_TAG);
        }
        switch (run._tag) {
          case "not-installed":
            return { status: "failed", reason: "docker-not-installed", output: "" } as const;
          case "timed-out":
            return { status: "failed", reason: "timed-out", output: "" } as const;
          case "exited": {
            if (run.code !== 0) {
              // Docker creates the container before it binds the port, so a failed
              // run can leave one behind holding the name. Remove only the one this
              // run created, by the id it printed, never another container of that name.
              const createdId = run.stdout.trim();
              if (CONTAINER_ID_PATTERN.test(createdId)) {
                yield* docker(["rm", "-f", createdId], LOGS_TIMEOUT);
              }
              const output = trimOutput(run.stderr.length > 0 ? run.stderr : run.stdout);
              return {
                status: "failed",
                reason: reasonOf(run.stderr || run.stdout),
                output,
              } as const;
            }
            return {
              status: "started",
              name: input.name,
              address: `http://localhost:${String(input.hubPort)}`,
              setupLink: yield* readSetupLink(input.name),
            } as const;
          }
        }
      });

    // The first line is the IPv4 binding; the IPv6 one repeats its port.
    const publishedPort = (name: string) =>
      docker(["port", name, "8080/tcp"], LOGS_TIMEOUT).pipe(
        Effect.map((run) =>
          run._tag === "exited" && run.code === 0
            ? (PUBLISHED_PORT_PATTERN.exec(run.stdout)?.[1] ?? null)
            : null,
        ),
      );

    const startedAt = (name: string) =>
      docker(["inspect", "--format", "{{.State.StartedAt}}", name], LOGS_TIMEOUT).pipe(
        Effect.map((run) => {
          const text = run._tag === "exited" && run.code === 0 ? run.stdout.trim() : "";
          return text.length > 0 ? text : null;
        }),
      );

    const restart = (input: TeamHubStartInput): Effect.Effect<TeamHubStartResult> =>
      Effect.gen(function* () {
        const run = yield* docker(["start", input.name], RESTART_TIMEOUT);
        switch (run._tag) {
          case "not-installed":
            return { status: "failed", reason: "docker-not-installed", output: "" } as const;
          case "timed-out":
            return { status: "failed", reason: "timed-out", output: "" } as const;
          case "exited": {
            if (run.code !== 0) {
              const output = run.stderr.length > 0 ? run.stderr : run.stdout;
              return {
                status: "failed",
                reason: reasonOf(output),
                output: trimOutput(output),
              } as const;
            }
            const since = yield* startedAt(input.name);
            return {
              status: "started",
              name: input.name,
              address: `http://localhost:${(yield* publishedPort(input.name)) ?? String(input.hubPort)}`,
              // Without a start time the logs cannot be told apart from an earlier run's.
              setupLink: since === null ? null : yield* readSetupLink(input.name, since),
            } as const;
          }
        }
      });

    const setupLink = Effect.fn("TeamHubDocker.setupLink")(function* (input: TeamHubStartInput) {
      // A manually selected port may belong to a different hub than the named container.
      if ((yield* publishedPort(input.name)) !== String(input.hubPort))
        return { setupLink: null, canCreateTeam: false };
      const run = yield* docker(
        [
          "exec",
          input.name,
          "node",
          "--disable-warning=ExperimentalWarning",
          "-e",
          READ_SETUP_TOKEN,
        ],
        LOGS_TIMEOUT,
      );
      const token = run._tag === "exited" && run.code === 0 ? run.stdout.trim() : "";
      return {
        setupLink: /^[A-Za-z0-9_-]{43}$/.test(token)
          ? `http://localhost:${String(input.hubPort)}/setup#token=${token}`
          : null,
        canCreateTeam: token === "configured" || /^[A-Za-z0-9_-]{43}$/.test(token),
      };
    });

    const createTeam = Effect.fn("TeamHubDocker.createTeam")(function* (
      input: TeamHubCreateLocalTeamInput,
    ) {
      if ((yield* publishedPort(input.name)) !== String(input.hubPort)) {
        return yield* new TeamHubDockerError({ reason: "Docker hub port does not match" });
      }
      const run = yield* docker(
        [
          "exec",
          input.name,
          "node",
          "--disable-warning=ExperimentalWarning",
          "--input-type=module",
          "-e",
          CREATE_LOCAL_TEAM,
          encodeLocalTeam({
            teamName: input.teamName,
            repo: input.repo,
            displayName: input.displayName,
          }),
        ],
        LOGS_TIMEOUT,
      );
      if (run._tag !== "exited" || run.code !== 0) {
        return yield* new TeamHubDockerError({
          reason: "Could not create a team in the Docker hub",
        });
      }
      const result = yield* decodeCreatedMembership(run.stdout).pipe(
        Effect.mapError(() => new TeamHubDockerError({ reason: "Invalid Docker hub response" })),
      );
      return result.credential;
    });

    const checkHubTeam = (id: string, args: ReadonlyArray<string>) =>
      docker(
        [
          "exec",
          id,
          "node",
          "--disable-warning=ExperimentalWarning",
          "-e",
          CHECK_HUB_TEAM,
          "--",
          ...args,
        ],
        LOGS_TIMEOUT,
      ).pipe(
        Effect.map((run) => run._tag === "exited" && run.code === 0 && run.stdout.trim() === "yes"),
      );

    const findTeamContainer = Effect.fn("TeamHubDocker.findTeamContainer")(function* (
      teamId: string,
      credential: string,
    ) {
      const running = yield* docker(
        ["ps", "--no-trunc", "--format", "{{.ID}} {{.Image}}"],
        LOGS_TIMEOUT,
      );
      if (running._tag !== "exited" || running.code !== 0) return null;
      const credentialHash = NodeCrypto.createHash("sha256").update(credential).digest("hex");
      let match: string | null = null;
      for (const line of running.stdout.trim().split(/\r?\n/)) {
        const [id, image] = line.split(" ");
        if (
          !id ||
          !CONTAINER_ID_PATTERN.test(id) ||
          !image?.startsWith(`${TEAM_HUB_DOCKER_IMAGE}:`)
        ) {
          continue;
        }
        if (yield* checkHubTeam(id, [teamId, credentialHash])) {
          if (match) return null;
          match = id;
        }
      }
      return match;
    });

    const deleteLastTeam = Effect.fn("TeamHubDocker.deleteLastTeam")(function* (
      id: string,
      teamId: string,
      credential: string,
    ) {
      const run = yield* docker(
        [
          "exec",
          id,
          "node",
          "--disable-warning=ExperimentalWarning",
          "-e",
          DELETE_LAST_HUB_TEAM,
          "--",
          teamId,
          NodeCrypto.createHash("sha256").update(credential).digest("hex"),
        ],
        LOGS_TIMEOUT,
      );
      if (run._tag !== "exited" || run.code !== 0 || run.stdout.trim() !== "yes") {
        return yield* new TeamHubDockerError({
          reason:
            "This Docker hub could not delete the team. Shared hubs require an updated image.",
        });
      }
    });

    const removeEmptyContainer = Effect.fn("TeamHubDocker.removeEmptyContainer")(function* (
      id: string,
    ) {
      if (!(yield* checkHubTeam(id, []))) {
        return yield* new TeamHubDockerError({
          reason: "Could not verify that the Docker hub is empty",
        });
      }
      const run = yield* docker(["rm", "-f", id], RESTART_TIMEOUT);
      if (run._tag !== "exited" || (run.code !== 0 && !/No such container/i.test(run.stderr))) {
        return yield* new TeamHubDockerError({ reason: "Could not remove the team hub container" });
      }
    });

    return TeamHubDocker.of({
      start,
      restart,
      setupLink,
      createTeam,
      findTeamContainer,
      deleteLastTeam,
      removeEmptyContainer,
    });
  });

/** Starts hubs from the given image tag, falling back to edge when it is not published. */
export const layerWithTag = (tag: string) => Layer.effect(TeamHubDocker, make(tag));

export const layer = layerWithTag(hubDockerTag);
