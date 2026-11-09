// @effect-diagnostics nodeBuiltinImport:off - Exercise the actual Docker Node script against an isolated SQLite fixture.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { teamHubDockerTag, type TeamHubStartFailureReason } from "@t3tools/contracts/teamHub";

import * as TeamHubDocker from "./TeamHubDocker.ts";
import { HubStore } from "../../../hub/src/store.ts";

const encoder = new TextEncoder();

type Reply = { stdout?: string; stderr?: string; code?: number; delayMs?: number } | "not-found";

/** A fake `docker` CLI: each command gets the reply its handler returns. */
const dockerWith = (handler: (args: ReadonlyArray<string>) => Reply, tag?: string) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = (tag === undefined ? TeamHubDocker.layer : TeamHubDocker.layerWithTag(tag)).pipe(
    Layer.provide(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
          calls.push(args);
          const reply = handler(args);
          if (reply === "not-found") {
            return Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
              }),
            );
          }
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.code ?? 0)).pipe(
                Effect.delay(reply.delayMs ?? 0),
              ),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(encoder.encode(reply.stdout ?? "")),
              stderr: Stream.make(encoder.encode(reply.stderr ?? "")),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        }),
      ),
    ),
  );
  return { calls, layer };
};

const start = (layer: Layer.Layer<TeamHubDocker.TeamHubDocker>) =>
  Effect.gen(function* () {
    const docker = yield* TeamHubDocker.TeamHubDocker;
    return yield* docker.start({ hubPort: 9090, name: "my-hub" });
  }).pipe(Effect.provide(layer));

describe("TeamHubDocker.start", () => {
  it.effect("allows a first download longer than the old timeout", () =>
    Effect.gen(function* () {
      const { layer } = dockerWith((args) =>
        args[0] === "run" ? { delayMs: 120_000 } : { stdout: "Team hub listening" },
      );
      const fiber = yield* start(layer).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual((yield* Fiber.join(fiber)).status, "started");
    }),
  );

  it.effect("times out a stalled image download", () =>
    Effect.gen(function* () {
      const { layer } = dockerWith((args) => (args[0] === "pull" ? {} : { delayMs: 700_000 }));
      const fiber = yield* start(layer).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 minutes");
      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        status: "failed",
        reason: "timed-out",
        output: "",
      });
    }),
  );

  it.effect("runs the hub under the chosen name and port and reads its setup link", () =>
    Effect.gen(function* () {
      const { calls, layer } = dockerWith((args) =>
        args[0] === "logs"
          ? {
              stdout:
                "Team hub listening on 0.0.0.0:8080\nOne-time setup link: http://localhost:8080/setup#token=abc\n",
            }
          : { stdout: "f00d\n" },
      );
      const result = yield* start(layer);
      assert.deepStrictEqual(result, {
        status: "started",
        name: "my-hub",
        address: "http://localhost:9090",
        setupLink: "http://localhost:8080/setup#token=abc",
      });
      const run = calls.find((args) => args[0] === "run") ?? [];
      assert.strictEqual(run.at(-1), "ghcr.io/aymanahsan/coderelay-hub:edge");
      assert.notInclude(run, "--pull");
      assert.includeMembers([...run], ["--name", "my-hub", "9090:8080", "my-hub-data:/data"]);
    }),
  );

  it.effect("reports no setup link when the hub's volume already has a team", () =>
    Effect.gen(function* () {
      const { layer } = dockerWith((args) =>
        args[0] === "logs" ? { stdout: "Team hub listening on 0.0.0.0:8080\n" } : {},
      );
      const result = yield* start(layer);
      assert.strictEqual(result.status === "started" ? result.setupLink : "failed", null);
    }),
  );

  it.effect("passes Docker's message through with a reason for the hint", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, TeamHubStartFailureReason]> = [
        [
          'docker: Error response from daemon: Conflict. The container name "/my-hub" is already in use by container "f00d".',
          "name-in-use",
        ],
        [
          "docker: Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:9090 failed: port is already allocated.",
          "port-in-use",
        ],
        ["docker: Error response from daemon: No such image: t3-team-hub:latest.", "image-missing"],
        [
          "docker: error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
          "docker-not-running",
        ],
        ["manifest unknown", "image-missing"],
        ["net/http: TLS handshake timeout", "image-missing"],
        ["lookup ghcr.io: no such host", "image-missing"],
        ["pull access denied", "image-missing"],
        ["Unable to find image locally\nis already in use by container", "name-in-use"],
        ["Unable to find image locally\nCannot connect to the Docker daemon", "docker-not-running"],
        ["progress\n".repeat(400) + "manifest unknown", "image-missing"],
        ["docker: something new went wrong.", "command-failed"],
      ];
      for (const [stderr, reason] of cases) {
        const { layer } = dockerWith(() => ({ code: 125, stderr: `${stderr}\n` }));

        assert.deepStrictEqual(yield* start(layer), {
          status: "failed",
          reason,
          output: stderr.length > 2000 ? `${stderr.slice(0, 2000)}…` : stderr,
        });
      }
    }),
  );

  it.effect("removes the container a failed run created, and only that one", () =>
    Effect.gen(function* () {
      const createdId = "a".repeat(64);
      const { calls, layer } = dockerWith((args) =>
        args[0] === "run"
          ? {
              code: 125,
              stdout: `${createdId}\n`,
              stderr: "Bind failed: port is already allocated",
            }
          : {},
      );
      const result = yield* start(layer);
      assert.strictEqual(result.status === "failed" ? result.reason : "started", "port-in-use");
      assert.deepStrictEqual(calls.at(-1), ["rm", "-f", createdId]);

      // A name conflict creates nothing, so nothing of that name is removed.
      const conflict = dockerWith(() => ({ code: 125, stderr: "is already in use by container" }));
      yield* start(conflict.layer);
      assert.isFalse(conflict.calls.some((args) => args[0] === "rm"));
    }),
  );

  it.effect("falls back to edge when the version's image was never published", () =>
    Effect.gen(function* () {
      const { calls, layer } = dockerWith(
        (args) =>
          args[0] === "run" && args.at(-1)?.endsWith(":0.0.45")
            ? {
                code: 125,
                stderr:
                  'docker: Error response from daemon: failed to resolve reference "ghcr.io/aymanahsan/coderelay-hub:0.0.45": ghcr.io/aymanahsan/coderelay-hub:0.0.45: not found',
              }
            : { stdout: "Team hub listening" },
        "0.0.45",
      );
      assert.strictEqual((yield* start(layer)).status, "started");
      const runs = calls.filter((args) => args[0] === "run").map((args) => args.at(-1));
      assert.deepStrictEqual(runs, [
        "ghcr.io/aymanahsan/coderelay-hub:0.0.45",
        "ghcr.io/aymanahsan/coderelay-hub:edge",
      ]);
      assert.deepStrictEqual(
        calls.map((args) => args[0]),
        ["run", "pull", "run", "logs"],
      );
    }),
  );

  it.effect("refreshes edge before running it, and still starts when the pull fails", () =>
    Effect.gen(function* () {
      const { calls, layer } = dockerWith((args) =>
        args[0] === "pull"
          ? { code: 1, stderr: "lookup ghcr.io: no such host" }
          : { stdout: "Team hub listening" },
      );
      assert.strictEqual((yield* start(layer)).status, "started");
      assert.deepStrictEqual(calls[0], ["pull", "ghcr.io/aymanahsan/coderelay-hub:edge"]);
      assert.strictEqual(calls[1]?.[0], "run");
    }),
  );

  it.effect("does not pull a versioned image separately", () =>
    Effect.gen(function* () {
      const { calls, layer } = dockerWith(() => ({ stdout: "Team hub listening" }), "1.2.3");
      assert.strictEqual((yield* start(layer)).status, "started");
      assert.isFalse(calls.some((args) => args[0] === "pull"));
    }),
  );

  it.effect("does not retry with edge when the registry cannot be reached", () =>
    Effect.gen(function* () {
      const { calls, layer } = dockerWith(
        () => ({ code: 125, stderr: "lookup ghcr.io: no such host" }),
        "0.0.45",
      );
      const result = yield* start(layer);
      assert.strictEqual(result.status === "failed" ? result.reason : "started", "image-missing");
      assert.strictEqual(calls.length, 1);
    }),
  );

  it.effect("says Docker is not installed when there is no docker to run", () =>
    Effect.gen(function* () {
      const { layer } = dockerWith(() => "not-found");
      assert.deepStrictEqual(yield* start(layer), {
        status: "failed",
        reason: "docker-not-installed",
        output: "",
      });
    }),
  );
});

const restart = (layer: Layer.Layer<TeamHubDocker.TeamHubDocker>) =>
  Effect.gen(function* () {
    const docker = yield* TeamHubDocker.TeamHubDocker;
    return yield* docker.restart({ hubPort: 8080, name: "my-hub" });
  }).pipe(Effect.provide(layer));

describe("TeamHubDocker.restart", () => {
  it.effect("starts the existing container and reports the port it was created with", () =>
    Effect.gen(function* () {
      const { calls, layer } = dockerWith((args) => {
        switch (args[0]) {
          case "port":
            return { stdout: "0.0.0.0:9090\n[::]:9090\n" };
          case "inspect":
            return { stdout: "2026-11-08T12:00:00.123456789Z\n" };
          case "logs":
            return { stdout: "Team hub listening on 0.0.0.0:8080\n" };
          default:
            return { stdout: "my-hub\n" };
        }
      });
      assert.deepStrictEqual(yield* restart(layer), {
        status: "started",
        name: "my-hub",
        // The input said 8080, but the container keeps the port it was created with.
        address: "http://localhost:9090",
        setupLink: null,
      });
      assert.deepStrictEqual(calls[0], ["start", "my-hub"]);
      assert.isFalse(calls.some((args) => args[0] === "run" || args[0] === "pull"));
    }),
  );

  it.effect("ignores a setup link printed before the latest start", () =>
    Effect.gen(function* () {
      const startedAt = "2026-11-08T12:00:00.123456789Z";
      // Docker keeps a container's logs across restarts; `--since` is what drops the old run's.
      const { calls, layer } = dockerWith((args) => {
        switch (args[0]) {
          case "port":
            return { stdout: "0.0.0.0:8080\n" };
          case "inspect":
            return { stdout: `${startedAt}\n` };
          case "logs":
            return args.includes(startedAt)
              ? { stdout: "Team hub listening on 0.0.0.0:8080\n" }
              : {
                  stdout:
                    "Team hub listening on 0.0.0.0:8080\nOne-time setup link: http://localhost:8080/setup#token=stale\n",
                };
          default:
            return {};
        }
      });
      const result = yield* restart(layer);
      assert.strictEqual(result.status === "started" ? result.setupLink : "failed", null);
      assert.deepStrictEqual(
        calls.find((args) => args[0] === "logs"),
        ["logs", "--since", startedAt, "my-hub"],
      );
    }),
  );

  it.effect("falls back to the requested port when Docker will not say which one", () =>
    Effect.gen(function* () {
      const { layer } = dockerWith((args) => {
        switch (args[0]) {
          case "port":
            return { code: 1, stderr: "no public port" };
          case "logs":
            return { stdout: "Team hub listening on 0.0.0.0:8080\n" };
          default:
            return { stdout: "2026-11-08T12:00:00Z\n" };
        }
      });
      const result = yield* restart(layer);
      assert.strictEqual(
        result.status === "started" ? result.address : "failed",
        "http://localhost:8080",
      );
    }),
  );

  it.effect("passes Docker's message through when the container cannot start", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, TeamHubStartFailureReason]> = [
        ["Error response from daemon: No such container: my-hub", "command-failed"],
        ["Bind for 0.0.0.0:8080 failed: port is already allocated", "port-in-use"],
        ["Cannot connect to the Docker daemon", "docker-not-running"],
      ];
      for (const [stderr, reason] of cases) {
        const { layer } = dockerWith(() => ({ code: 1, stderr: `${stderr}\n` }));
        assert.deepStrictEqual(yield* restart(layer), { status: "failed", reason, output: stderr });
      }
    }),
  );

  it.effect("says Docker is not installed when there is no docker to run", () =>
    Effect.gen(function* () {
      const { layer } = dockerWith(() => "not-found");
      assert.deepStrictEqual(yield* restart(layer), {
        status: "failed",
        reason: "docker-not-installed",
        output: "",
      });
    }),
  );
});

describe("TeamHubDocker.setupLink", () => {
  it.effect(
    "creates new teams in the existing image without changing the first team's membership",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hub-create-local-"));
        const store = new HubStore(dir);
        try {
          const { layer } = dockerWith((args) => {
            if (args[0] === "port") return { stdout: "0.0.0.0:8080\n" };
            assert.strictEqual(args[0], "exec");
            const result = NodeChildProcess.spawnSync(process.execPath, args.slice(3), {
              env: { ...process.env, HUB_DATA_DIR: dir },
              encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, result.stderr);
            return { stdout: result.stdout };
          });
          yield* Effect.gen(function* () {
            const docker = yield* TeamHubDocker.TeamHubDocker;
            const input = {
              name: "my-hub",
              hubPort: 8080,
              url: "https://hub.example.com",
              displayName: "Alice",
              teamName: "First team",
              repo: "repo",
            };
            const first = store.authenticate(yield* docker.createTeam(input));
            store.publish(first, { type: "post_note", text: "Keep this history" });
            const second = store.authenticate(
              yield* docker.createTeam({
                ...input,
                teamName: "Alice's second team",
                displayName: "Bob",
              }),
            );
            assert.notStrictEqual(first.team_id, second.team_id);
            assert.strictEqual(second.name, "Bob");
            assert.strictEqual(second.role, "admin");
            assert.strictEqual(
              store.snapshot(first, new Set()).notes[0]?.text,
              "Keep this history",
            );
            assert.strictEqual(store.snapshot(second, new Set()).team.name, "Alice's second team");
            assert.deepStrictEqual(store.snapshot(second, new Set()).notes, []);
          }).pipe(Effect.provide(layer));
        } finally {
          store.close();
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }),
  );

  const lookup = (layer: Layer.Layer<TeamHubDocker.TeamHubDocker>) =>
    Effect.gen(function* () {
      const docker = yield* TeamHubDocker.TeamHubDocker;
      return yield* docker.setupLink({ hubPort: 8080, name: "my-hub" });
    }).pipe(Effect.provide(layer));

  it.effect(
    "recovers an interrupted setup and stops returning the token immediately after bootstrap",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hub-setup-lookup-"));
        let store = new HubStore(dir);
        try {
          const token = store.setupToken!;
          store.close();
          store = new HubStore(dir);
          const { calls, layer } = dockerWith((args) => {
            if (args[0] === "port") return { stdout: "0.0.0.0:8080\n" };
            if (args[0] === "exec") {
              // Execute the actual in-container script against a real hub database.
              const result = NodeChildProcess.spawnSync(process.execPath, args.slice(3), {
                env: { ...process.env, HUB_DATA_DIR: dir },
                encoding: "utf8",
              });
              assert.strictEqual(result.status, 0, result.stderr);
              return { stdout: result.stdout };
            }
            assert.fail("Lookup must not start, restart, or read logs from the container");
          });
          assert.deepStrictEqual(yield* lookup(layer), {
            setupLink: `http://localhost:8080/setup#token=${token}`,
            canCreateTeam: true,
          });
          store.bootstrap(token, "Team", "repo", "Alice");
          assert.deepStrictEqual(yield* lookup(layer), { setupLink: null, canCreateTeam: true });
          assert.deepStrictEqual(calls[1]?.slice(0, 3), ["exec", "my-hub", "node"]);
        } finally {
          store.close();
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("does not return a token for another port or unavailable Docker", () =>
    Effect.gen(function* () {
      for (const reply of [{ stdout: "0.0.0.0:9090\n" }, "not-found"] as const) {
        const { calls, layer } = dockerWith(() => reply);
        assert.deepStrictEqual(yield* lookup(layer), { setupLink: null, canCreateTeam: false });
        assert.strictEqual(calls.length, 1);
      }
    }),
  );

  it.effect("returns no link when the container is stopped or its database cannot be read", () =>
    Effect.gen(function* () {
      for (const reply of [{ code: 1 }, { stdout: "invalid-token" }, "not-found"] as const) {
        const { layer } = dockerWith((args) =>
          args[0] === "port" ? { stdout: "0.0.0.0:8080\n" } : reply,
        );
        assert.deepStrictEqual(yield* lookup(layer), { setupLink: null, canCreateTeam: false });
      }
    }),
  );
});

describe("hub image versions", () => {
  it("pins stable builds and uses edge for development and prereleases", () => {
    assert.strictEqual(teamHubDockerTag("1.2.3"), "1.2.3");
    for (const version of ["0.0.0", "dev", "1.2.3-nightly.20261101", "0.0.0-main.123"])
      assert.strictEqual(teamHubDockerTag(version), "edge");
    assert.strictEqual(teamHubDockerTag("1.2.3", true), "edge");
  });
});
