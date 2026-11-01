import {
  teamHubDockerRunArgs,
  type TeamHubStartFailureReason,
  type TeamHubStartInput,
  type TeamHubStartResult,
} from "@t3tools/contracts/teamHub";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

// Creating a container is quick with `--pull never`; the slack covers a cold Docker Desktop.
const RUN_TIMEOUT = Duration.seconds(45);
const LOGS_TIMEOUT = Duration.seconds(5);
// The hub prints its setup link right after it starts listening.
const SETUP_LINK_ATTEMPTS = 10;
const SETUP_LINK_RETRY_DELAY = Duration.millis(500);
// Enough for any Docker error, small enough to send to a client.
const OUTPUT_LIMIT = 2_000;

const SETUP_LINK_PATTERN = /One-time setup link: (\S+)/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;

// Matched against Docker's stderr, most specific first.
const FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, TeamHubStartFailureReason]> = [
  [/is already in use by container/i, "name-in-use"],
  [/port is already allocated|address already in use|ports are not available/i, "port-in-use"],
  [/no such image|unable to find image|pull access denied/i, "image-missing"],
  [
    /cannot connect to the docker daemon|error during connect|docker daemon is not running|docker desktop is not running/i,
    "docker-not-running",
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
  }
>()("t3/teamHub/TeamHubDocker") {}

const make = Effect.gen(function* () {
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

  const readSetupLink = (name: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < SETUP_LINK_ATTEMPTS; attempt += 1) {
        const logs = yield* docker(["logs", name], LOGS_TIMEOUT);
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
      const run = yield* docker(teamHubDockerRunArgs(input), RUN_TIMEOUT);
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
            return { status: "failed", reason: reasonOf(output), output } as const;
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

  return TeamHubDocker.of({ start });
});

export const layer = Layer.effect(TeamHubDocker, make);
