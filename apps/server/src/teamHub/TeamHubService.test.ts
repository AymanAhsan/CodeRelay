// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests use an isolated hub database and can drop its actual HTTP response.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { TeamHubState } from "@t3tools/contracts/teamHub";
import { ThreadId } from "@t3tools/contracts";
import { createHubServer } from "../../../hub/src/server.ts";
import { HubStore } from "../../../hub/src/store.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TeamHubService, layer } from "./TeamHubService.ts";
import * as TeamHubDocker from "./TeamHubDocker.ts";

const testSecretLayer = (secrets: Map<string, Uint8Array>) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          secrets.set(key, value);
        }),
      create: (key, value) =>
        Effect.sync(() => {
          expect(secrets.has(key)).toBe(false);
          secrets.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          if (key.startsWith("team-hub-bootstrap-") || key === "team-hub-pending-bootstrap") {
            expect(secrets.has("team-hub-membership")).toBe(true);
          }
          secrets.delete(key);
        }),
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  );

describe("local team hub connector", () => {
  it.effect(
    "recovers a committed bootstrap after restart and retries when startup recovery is offline",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "t3-team-hub-bootstrap-retry-"),
          );
          const store = new HubStore(dir);
          const server = yield* Effect.promise(() =>
            createHubServer(store, { host: "127.0.0.1", port: 0 }),
          );
          const originalFetch = globalThis.fetch;
          const startupAttempted = Promise.withResolvers<void>();
          let attempts = 0;
          let originalCredential: string | null = null;
          const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (input, init) => {
              if (!String(input).endsWith("/api/bootstrap")) return originalFetch(input, init);
              attempts += 1;
              if (attempts === 2) {
                startupAttempted.resolve();
                throw new TypeError("Hub temporarily unreachable");
              }
              const response = await originalFetch(input, init);
              if (attempts === 1) {
                expect(response.status).toBe(201);
                originalCredential = ((await response.json()) as { credential: string }).credential;
                throw new TypeError("Bootstrap response was lost");
              }
              return response;
            });
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              fetchMock.mockRestore();
              await server.close();
              store.close();
              NodeFS.rmSync(dir, { recursive: true, force: true });
            }),
          );
          const secrets = new Map<string, Uint8Array>();
          const connector = layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(testSecretLayer(secrets)),
            Layer.provide(Layer.mock(TeamHubDocker.TeamHubDocker)({})),
          );
          const pendingInput = {
            url: `http://127.0.0.1:${server.port}`,
            token: store.setupToken!,
            teamName: "Engineering",
            repo: "https://github.com/example/repo",
            displayName: "Alice",
          };
          yield* Effect.gen(function* () {
            const hub = yield* TeamHubService;
            expect((yield* hub.bootstrap(pendingInput).pipe(Effect.flip)).message).toContain(
              "Could not create",
            );
            expect((yield* hub.state).hasPendingBootstrap).toBe(true);
            expect(secrets.has("team-hub-membership")).toBe(false);
            expect(secrets.has("team-hub-pending-bootstrap")).toBe(true);
            expect(
              (yield* hub
                .bootstrap({ ...pendingInput, teamName: "Other details" })
                .pipe(Effect.flip)).message,
            ).toContain("original team details");
            expect(attempts).toBe(1);
          }).pipe(Effect.provide(connector), Effect.scoped);

          yield* Effect.gen(function* () {
            const hub = yield* TeamHubService;
            yield* Effect.promise(() => startupAttempted.promise);
            expect((yield* hub.state).hasPendingBootstrap).toBe(true);
            yield* hub.retryBootstrap;
            const connected = yield* hub.stream.pipe(
              Stream.filter((state) => state.status === "connected"),
              Stream.runHead,
            );
            const saved = new TextDecoder().decode(secrets.get("team-hub-membership"));
            expect(saved).toBe(originalCredential);
            expect(Option.getOrThrow(connected).snapshot?.selfId).toBe(
              store.authenticate(saved).id,
            );
            expect((yield* hub.state).hasPendingBootstrap).toBeUndefined();
            expect([...secrets.keys()]).toEqual(["team-hub-membership"]);
            expect(attempts).toBe(3);
          }).pipe(Effect.provide(connector), Effect.scoped);
        }),
      ),
  );

  it.effect("bootstraps through the local service, stores membership, and posts a note", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-local-team-hub-"));
        const store = new HubStore(dir);
        const dockerLayer = Layer.succeed(
          TeamHubDocker.TeamHubDocker,
          TeamHubDocker.TeamHubDocker.of({
            findTeamContainer: () => Effect.succeed("container"),
            deleteLastTeam: () => Effect.die("the hub supports team deletion"),
            removeEmptyContainer: () => Effect.die("must preserve a shared container"),
            start: () => Effect.die("unused"),
            restart: () => Effect.die("unused"),
            setupLink: () => Effect.die("unused"),
            createTeam: (input) =>
              Effect.sync(() => {
                // Model Docker's operator boundary; the Docker tests execute the real script.
                return store.createTeam(
                  store.authenticate(new TextDecoder().decode(secrets.get("original-membership"))),
                  input.teamName,
                  input.repo,
                ).credential;
              }),
          }),
        );
        const server = yield* Effect.promise(() =>
          createHubServer(store, { host: "127.0.0.1", port: 0 }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await server.close();
            store.close();
            NodeFS.rmSync(dir, { recursive: true, force: true });
          }),
        );
        const secrets = new Map<string, Uint8Array>();
        const secretLayer = testSecretLayer(secrets);
        yield* Effect.gen(function* () {
          const hub = yield* TeamHubService;
          const updates = yield* Queue.unbounded<TeamHubState>();
          yield* hub.stream.pipe(
            Stream.runForEach((state) => Queue.offer(updates, state)),
            Effect.forkScoped,
          );
          expect(yield* Queue.take(updates)).toEqual({
            url: null,
            status: "disconnected",
            snapshot: null,
            error: null,
          });
          const nextState = (predicate: (state: TeamHubState) => boolean) =>
            Stream.fromQueue(updates).pipe(
              Stream.filter(predicate),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
          const input = {
            url: `http://127.0.0.1:${server.port}`,
            token: store.setupToken!,
            teamName: "Engineering",
            repo: "github.com/example/repo",
            displayName: "Alice",
          };
          yield* Effect.all([hub.bootstrap(input), hub.bootstrap(input)], {
            concurrency: "unbounded",
          });
          const credential = new TextDecoder().decode(secrets.get("team-hub-membership"));
          const member = store.authenticate(credential);
          secrets.set("original-membership", new TextEncoder().encode(credential));
          const connected = yield* nextState((state) => state.status === "connected");
          expect(connected.snapshot?.selfId).toBe(member.id);
          yield* hub.publish({
            type: "post_task",
            assigneeId: member.id,
            text: "Review the API",
            contract: null,
          });
          const suggested = yield* nextState((state) => state.snapshot?.tasks.length === 1);
          const task = suggested.snapshot!.tasks[0]!;
          expect(task.text).toBe("Review the API");
          expect(task.status).toBe("suggested");
          // A reconnecting client receives the latest full state immediately.
          const resumed = yield* hub.stream.pipe(Stream.runHead);
          expect(Option.getOrThrow(resumed)).toEqual(suggested);
          yield* hub.decideTask(task.id, "dismissed");
          const dismissed = yield* nextState(
            (state) => state.snapshot?.tasks[0]?.status === "dismissed",
          );
          expect(dismissed.snapshot?.tasks[0]?.id).toBe(task.id);
          yield* hub.publish({
            type: "post_task",
            assigneeId: member.id,
            text: "Build API",
            contract: null,
          });
          const offered = yield* nextState(
            (state) => state.snapshot?.tasks.some((task) => task.text === "Build API") === true,
          );
          const workTask = offered.snapshot!.tasks.find((task) => task.text === "Build API")!;
          const threadId = ThreadId.make("delegated-thread");
          yield* hub.decideTask(workTask.id, "accepted", threadId);
          yield* nextState(
            (state) => state.snapshot?.tasks.some((task) => task.threadId === threadId) === true,
          );
          yield* hub.publishCheckpoint({
            threadId,
            repository: "github.com/example/repo",
            branch: "work/api",
            files: ["src/service.ts"],
            description: "API progress",
          });
          const progress = yield* nextState(
            (state) =>
              state.snapshot?.summaries.some((summary) => summary.taskId === workTask.id) === true,
          );
          expect(progress.snapshot?.tasks.find((task) => task.id === workTask.id)?.status).toBe(
            "accepted",
          );
          const result = {
            branch: "work/api",
            sha: "a".repeat(40),
            description: "API complete; tests passed",
          };
          yield* hub.publish({ type: "complete_task", taskId: workTask.id, result });
          const completed = yield* nextState(
            (state) => state.snapshot?.tasks.some((task) => task.status === "done") === true,
          );
          expect(completed.snapshot?.tasks.find((task) => task.id === workTask.id)?.result).toEqual(
            result,
          );
          yield* hub.publish({ type: "reopen_task", taskId: workTask.id });
          const reopened = yield* nextState(
            (state) =>
              state.snapshot?.tasks.some(
                (task) => task.id === workTask.id && task.status === "accepted",
              ) === true,
          );
          expect(
            reopened.snapshot?.tasks.find((task) => task.id === workTask.id)?.result,
          ).toBeNull();
          yield* hub.publish({ type: "post_note", text: "Ready to pair" });
          expect(store.snapshot(member, new Set()).notes[0]?.text).toBe("Ready to pair");
          const invite = store.createInvite(member, store.snapshot(member, new Set()).team.id);
          const teammate = store.join(invite.token, "Bob");
          store.publish(store.authenticate(teammate.credential), {
            type: "claim_files",
            paths: ["src/api.ts"],
          });
          const conflict = yield* hub
            .publish({
              type: "claim_files",
              paths: ["src/api.ts"],
            })
            .pipe(Effect.flip);
          expect(conflict.message).toContain("File already claimed");
          yield* hub.updateRepo("https://github.com/example/new-repo");
          const edited = yield* nextState(
            (state) => state.snapshot?.team.repo === "https://github.com/example/new-repo",
          );
          expect(edited.snapshot?.selfId).toBe(member.id);
          expect(edited.snapshot?.notes[0]?.text).toBe("Ready to pair");
          yield* hub.leave;
          expect(yield* nextState((state) => state.url === null)).toEqual({
            url: null,
            status: "disconnected",
            snapshot: null,
            error: null,
          });
          expect(secrets.has("team-hub-membership")).toBe(false);
          yield* hub.createLocalTeam({
            url: `http://127.0.0.1:${server.port}`,
            name: "my-hub",
            hubPort: server.port,
            teamName: "Second team",
            repo: "github.com/example/second",
            displayName: "Alice",
          });
          const second = yield* nextState((state) => state.status === "connected");
          expect(second.snapshot?.team.name).toBe("Second team");
          expect(second.snapshot?.selfId).not.toBe(member.id);
          expect(store.snapshot(member, new Set()).team.name).toBe("Engineering");
          expect(store.snapshot(member, new Set()).notes[0]?.text).toBe("Ready to pair");
          const secondCredential = new TextDecoder().decode(secrets.get("team-hub-membership"));
          yield* hub.deleteTeam(second.snapshot!.team.id);
          expect((yield* hub.state).url).toBeNull();
          expect(secrets.has("team-hub-membership")).toBe(false);
          expect(() => store.authenticate(secondCredential)).toThrow("Invalid credential");
          expect(store.snapshot(member, new Set()).team.name).toBe("Engineering");
        }).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(secretLayer),
              Layer.provide(dockerLayer),
            ),
          ),
        );
      }),
    ),
  );
});
