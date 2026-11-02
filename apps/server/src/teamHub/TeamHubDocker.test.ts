import { assert, describe, it } from "@effect/vitest";
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

const encoder = new TextEncoder();

type Reply = { stdout?: string; stderr?: string; code?: number; delayMs?: number } | "not-found";

/** A fake `docker` CLI: each command gets the reply its handler returns. */
const dockerWith = (handler: (args: ReadonlyArray<string>) => Reply) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = TeamHubDocker.layer.pipe(
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
      const { layer } = dockerWith(() => ({ delayMs: 700_000 }));
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
      const run = calls[0] ?? [];
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
      assert.deepStrictEqual(calls[1], ["rm", "-f", createdId]);

      // A name conflict creates nothing, so nothing of that name is removed.
      const conflict = dockerWith(() => ({ code: 125, stderr: "is already in use by container" }));
      yield* start(conflict.layer);
      assert.strictEqual(conflict.calls.length, 1);
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
describe("hub image versions", () => {
  it("pins stable builds and uses edge for development and prereleases", () => {
    assert.strictEqual(teamHubDockerTag("1.2.3"), "1.2.3");
    for (const version of ["0.0.0", "dev", "1.2.3-nightly.20261101", "0.0.0-main.123"])
      assert.strictEqual(teamHubDockerTag(version), "edge");
    assert.strictEqual(teamHubDockerTag("1.2.3", true), "edge");
  });
});
