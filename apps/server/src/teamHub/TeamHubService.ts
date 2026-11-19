// @effect-diagnostics globalFetchInEffect:off globalTimers:off nodeBuiltinImport:off preferSchemaOverJson:off - The hub connector owns the native WebSocket, companion HTTP requests, and bootstrap operation secrets.
import * as NodeCrypto from "node:crypto";
import type {
  TeamHubActivity,
  TeamHubCreateLocalTeamInput,
  TeamHubClientMessage,
  TeamHubInviteRecord,
  TeamHubInvite,
  TeamHubJoinInput,
  TeamHubRepoAccess,
  TeamHubState,
} from "@t3tools/contracts/teamHub";
import type { ThreadId } from "@t3tools/contracts";
import {
  TEAM_HUB_PROTOCOL_VERSION,
  TeamHubBootstrapInput,
  normalizeTeamHubAdvertisedUrl,
  TeamHubSnapshot as TeamHubSnapshotSchema,
} from "@t3tools/contracts/teamHub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamHubDocker from "./TeamHubDocker.ts";

const CREDENTIAL_NAME = "team-hub-membership";
const ACTIVE_BOOTSTRAP_NAME = "team-hub-pending-bootstrap";
const BOOTSTRAP_RECORD_PREFIX = "team-hub-bootstrap-";
const BOOTSTRAP_RECORD_KEY = /^team-hub-bootstrap-[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeSnapshot = Schema.decodeUnknownSync(TeamHubSnapshotSchema);
const PendingBootstrap = Schema.Struct({
  input: TeamHubBootstrapInput,
  operationSecret: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
type PendingBootstrap = typeof PendingBootstrap.Type;
const pendingBootstrapJson = Schema.fromJsonString(PendingBootstrap);

const bootstrapKey = (input: TeamHubBootstrapInput) =>
  BOOTSTRAP_RECORD_PREFIX +
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([input.url, input.token]))
    .digest("hex");

const sameBootstrap = (left: TeamHubBootstrapInput, right: TeamHubBootstrapInput) =>
  left.url === right.url &&
  left.token === right.token &&
  left.teamName === right.teamName &&
  left.repo === right.repo &&
  left.displayName === right.displayName;
const bootstrapPayload = (input: TeamHubBootstrapInput) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([input.teamName, input.repo, input.displayName]))
    .digest("hex");

export class TeamHubError extends Schema.TaggedError<TeamHubError>()("TeamHubError", {
  reason: Schema.String,
  cause: Schema.Defect(),
  status: Schema.optional(Schema.Number),
}) {
  override get message(): string {
    return this.reason;
  }
}

const isTeamHubError = Schema.is(TeamHubError);

export class TeamHubService extends Context.Service<
  TeamHubService,
  {
    readonly state: Effect.Effect<TeamHubState>;
    readonly stream: Stream.Stream<TeamHubState>;
    readonly start: Effect.Effect<void, TeamHubError>;
    readonly stop: Effect.Effect<void>;
    readonly join: (input: {
      readonly url: string;
      readonly token: string;
      readonly displayName: string;
    }) => Effect.Effect<void, TeamHubError>;
    readonly bootstrap: (input: TeamHubBootstrapInput) => Effect.Effect<void, TeamHubError>;
    readonly retryBootstrap: Effect.Effect<void, TeamHubError>;
    readonly createLocalTeam: (
      input: TeamHubCreateLocalTeamInput,
    ) => Effect.Effect<void, TeamHubError>;
    readonly leave: Effect.Effect<void, TeamHubError>;
    readonly deleteTeam: (teamId: string) => Effect.Effect<void, TeamHubError>;
    readonly publish: (message: TeamHubClientMessage) => Effect.Effect<void, TeamHubError>;
    readonly publishCheckpoint: (input: {
      readonly threadId: ThreadId;
      readonly repository: string;
      readonly branch: string;
      readonly files: ReadonlyArray<string>;
      readonly description: string;
    }) => Effect.Effect<void>;
    /** Tells the team what this machine's agents are doing. Unchanged reports are dropped. */
    readonly reportActivity: (activity: TeamHubActivity) => Effect.Effect<void>;
    /** Tells the team whether this machine can open the team repository. Unchanged reports are dropped. */
    readonly reportRepoAccess: (access: TeamHubRepoAccess) => Effect.Effect<void>;
    readonly createInvite: Effect.Effect<TeamHubInvite, TeamHubError>;
    readonly listInvites: Effect.Effect<ReadonlyArray<TeamHubInviteRecord>, TeamHubError>;
    readonly revokeInvite: (inviteId: string) => Effect.Effect<void, TeamHubError>;
    readonly updateRepo: (repo: string) => Effect.Effect<void, TeamHubError>;
    readonly updateAdvertisedUrl: (url: string) => Effect.Effect<void, TeamHubError>;
    readonly removeMember: (memberId: string) => Effect.Effect<void, TeamHubError>;
    readonly reserveAutoStart: (
      taskId: string,
      token: string,
      sha: string,
    ) => Effect.Effect<{ reserved: boolean }, TeamHubError>;
    readonly releaseAutoStart: (
      taskId: string,
      token: string,
    ) => Effect.Effect<unknown, TeamHubError>;
    readonly decideTask: (
      taskId: string,
      decision: "accepted" | "dismissed",
      threadId?: ThreadId,
      autoStartToken?: string,
    ) => Effect.Effect<void, TeamHubError>;
  }
>()("t3/teamHub/TeamHubService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const docker = yield* TeamHubDocker.TeamHubDocker;
  const enrollmentLock = yield* Semaphore.make(1);
  let completedBootstrap: { key: string; payload: string } | null = null;
  let state: TeamHubState = { url: null, status: "disconnected", snapshot: null, error: null };
  const listeners = new Set<(state: TeamHubState) => void>();
  const setState = (next: TeamHubState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  // Send current state on every subscription, then only changes. A slow client
  // retains at most one full snapshot, since intermediate states can be skipped.
  const stream = Stream.callback<TeamHubState>(
    (mailbox) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (next: TeamHubState) => Queue.offerUnsafe(mailbox, next);
          listeners.add(listener);
          listener(state);
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      ),
    { bufferSize: 1, strategy: "sliding" },
  );
  let credential: string | null = null;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Resent after every hello, so the hub learns it again after a reconnect or a hub restart.
  let activity: TeamHubActivity | null = null;
  const sendActivity = () => {
    if (!activity || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({ type: "set_activity", ...activity } satisfies TeamHubClientMessage),
    );
  };
  let repoAccess: TeamHubRepoAccess | null = null;
  const sendRepoAccess = () => {
    if (!repoAccess || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "set_repo_access",
        access: repoAccess,
      } satisfies TeamHubClientMessage),
    );
  };

  const disconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close();
    socket = null;
    setState({ ...state, status: "disconnected", snapshot: null });
  };

  const connect = () => {
    if (stopped || !state.url || !credential) return;
    disconnect();
    let url: URL;
    try {
      url = new URL("/ws", state.url);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Invalid hub protocol");
    } catch {
      setState({ ...state, error: "Invalid team hub address" });
      return;
    }
    url.searchParams.set("version", String(TEAM_HUB_PROTOCOL_VERSION));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(url);
    socket = current;
    setState({ ...state, status: "connecting", error: null });
    current.addEventListener("open", () => {
      if (socket !== current) return;
      current.send(JSON.stringify({ type: "hello", credential }));
      sendActivity();
      sendRepoAccess();
    });
    current.addEventListener("message", (event) => {
      if (socket !== current) return;
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "snapshot" &&
          "snapshot" in message
        ) {
          setState({
            ...state,
            status: "connected",
            snapshot: decodeSnapshot(message.snapshot),
            error: null,
          });
        } else if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "error" &&
          "message" in message &&
          typeof message.message === "string"
        ) {
          setState({ ...state, error: message.message });
        }
      } catch {
        setState({ ...state, error: "Hub sent an invalid response" });
      }
    });
    current.addEventListener("close", (event) => {
      if (socket !== current) return;
      socket = null;
      setState({
        ...state,
        status: "disconnected",
        snapshot: null,
        error: event.code === 4003 ? "Membership revoked" : "Hub disconnected",
      });
      if (!stopped && event.code !== 4003) reconnectTimer = setTimeout(connect, 3000);
    });
    current.addEventListener("error", () => {
      if (socket === current) setState({ ...state, error: "Cannot reach team hub" });
    });
  };

  const request = <A>(path: string, input?: unknown): Effect.Effect<A, TeamHubError> =>
    Effect.tryPromise({
      try: async () => {
        if (!state.url || !credential) throw new Error("Not joined to a team hub");
        const response = await fetch(new URL(path, state.url), {
          method: input === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            ...(input === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        const result: unknown = await response.json();
        if (!response.ok) {
          throw new TeamHubError({
            reason:
              typeof result === "object" &&
              result !== null &&
              "error" in result &&
              typeof result.error === "string"
                ? result.error
                : `Hub returned ${response.status}`,
            cause: null,
            status: response.status,
          });
        }
        return result as A;
      },
      catch: (cause) =>
        isTeamHubError(cause)
          ? cause
          : new TeamHubError({
              reason: cause instanceof Error ? cause.message : "Team hub request failed",
              cause,
            }),
    });

  const start = Effect.gen(function* () {
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new TeamHubError({ reason: "Cannot load team hub settings", cause }),
      ),
    );
    const saved = yield* secrets
      .get(CREDENTIAL_NAME)
      .pipe(
        Effect.mapError(
          (cause) => new TeamHubError({ reason: "Cannot load team membership", cause }),
        ),
      );
    setState({ ...state, url: currentSettings.teamHubUrl });
    credential = Option.isSome(saved) ? decoder.decode(saved.value) : null;
    connect();
  });

  const normalizeUrl = (address: string) =>
    Effect.try({
      try: () => {
        const parsed = new URL(address);
        if (
          (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
          parsed.username ||
          parsed.password
        )
          throw new Error("Invalid hub origin");
        parsed.pathname = "/";
        parsed.search = "";
        parsed.hash = "";
        return parsed;
      },
      catch: (cause) => new TeamHubError({ reason: "Invalid team hub address", cause }),
    });

  const saveMembership = Effect.fn("TeamHubService.saveMembership")(function* (
    url: URL,
    result: string,
  ) {
    yield* secrets
      .set(CREDENTIAL_NAME, encoder.encode(result))
      .pipe(
        Effect.mapError(
          (cause) => new TeamHubError({ reason: "Cannot save team membership", cause }),
        ),
      );
    yield* settings
      .updateSettings({ teamHubUrl: url.toString() })
      .pipe(
        Effect.mapError(
          (cause) => new TeamHubError({ reason: "Cannot save team hub address", cause }),
        ),
      );
    disconnect();
    completedBootstrap = null;
    credential = result;
    setState({ url: url.toString(), status: "disconnected", snapshot: null, error: null });
    connect();
  });

  const enroll = (
    url: URL,
    endpoint: "/api/join" | "/api/bootstrap",
    payload:
      | TeamHubJoinInput
      | (TeamHubBootstrapInput & {
          readonly operationSecret: string;
          readonly advertisedUrl?: string;
        }),
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(new URL(endpoint, url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        const data: unknown = await response.json();
        if (
          !response.ok ||
          !data ||
          typeof data !== "object" ||
          !("credential" in data) ||
          typeof data.credential !== "string"
        )
          throw new Error("Team hub enrollment was rejected");
        return data.credential;
      },
      catch: () =>
        new TeamHubError({
          reason:
            endpoint === "/api/bootstrap"
              ? "Could not create team on the hub"
              : "Could not join team hub",
          cause: null,
        }),
    });

  const pendingError = () =>
    new TeamHubError({ reason: "Cannot save or read the pending team setup", cause: null });

  const readPendingBootstrap = (key: string) =>
    Effect.gen(function* () {
      const saved = yield* secrets.get(key).pipe(Effect.mapError(pendingError));
      if (Option.isNone(saved)) return null;
      const record = yield* Schema.decodeEffect(pendingBootstrapJson)(
        decoder.decode(saved.value),
      ).pipe(Effect.mapError(pendingError));
      if (bootstrapKey(record.input) !== key) return yield* pendingError();
      return record;
    });

  const readActiveBootstrapKey = Effect.gen(function* () {
    const saved = yield* secrets.get(ACTIVE_BOOTSTRAP_NAME).pipe(Effect.mapError(pendingError));
    if (Option.isNone(saved)) return null;
    const key = decoder.decode(saved.value);
    if (!BOOTSTRAP_RECORD_KEY.test(key)) return yield* pendingError();
    return key;
  });

  const cleanUpBootstrap = (key: string) =>
    Effect.gen(function* () {
      if ((yield* readActiveBootstrapKey) === key) {
        yield* secrets.remove(ACTIVE_BOOTSTRAP_NAME);
      }
      yield* secrets.remove(key);
    }).pipe(Effect.ignore);

  const finishBootstrap = (key: string, pending: PendingBootstrap, url: URL) =>
    Effect.gen(function* () {
      const advertisedUrl = normalizeTeamHubAdvertisedUrl(url.origin);
      const result = yield* enroll(url, "/api/bootstrap", {
        ...pending.input,
        operationSecret: pending.operationSecret,
        ...(advertisedUrl === null ? {} : { advertisedUrl }),
      });
      if (credential !== null && state.url !== null && credential !== result) {
        return yield* new TeamHubError({
          reason: "This CodeRelay environment is already joined to a team",
          cause: null,
        });
      }
      yield* saveMembership(url, result);
      completedBootstrap = { key, payload: bootstrapPayload(pending.input) };
      yield* cleanUpBootstrap(key);
    });

  const bootstrap = (input: TeamHubBootstrapInput) =>
    enrollmentLock.withPermits(1)(
      Effect.gen(function* () {
        const url = yield* normalizeUrl(input.url);
        const normalized = {
          url: url.origin,
          token: input.token.trim(),
          teamName: input.teamName.trim(),
          repo: input.repo.trim(),
          displayName: input.displayName.trim(),
        };
        const key = bootstrapKey(normalized);
        if (credential !== null && state.url !== null) {
          if (
            completedBootstrap?.key === key &&
            completedBootstrap.payload === bootstrapPayload(normalized)
          )
            return;
          return yield* new TeamHubError({
            reason: "This CodeRelay environment is already joined to a team",
            cause: null,
          });
        }
        let pending = yield* readPendingBootstrap(key);
        if (pending === null) {
          const record = {
            input: normalized,
            operationSecret: NodeCrypto.randomBytes(32).toString("base64url"),
          };
          const data = yield* Schema.encodeEffect(pendingBootstrapJson)(record).pipe(
            Effect.mapError(pendingError),
          );
          pending = yield* secrets.create(key, encoder.encode(data)).pipe(
            Effect.as(record),
            Effect.catch((cause) =>
              ServerSecretStore.isSecretAlreadyExistsError(cause)
                ? readPendingBootstrap(key)
                : Effect.fail(pendingError()),
            ),
          );
        }
        if (pending === null) return yield* pendingError();
        if (!sameBootstrap(pending.input, normalized)) {
          return yield* new TeamHubError({
            reason: "Retry setup using the original team details",
            cause: null,
          });
        }
        yield* secrets
          .set(ACTIVE_BOOTSTRAP_NAME, encoder.encode(key))
          .pipe(Effect.mapError(pendingError));
        setState({ ...state, hasPendingBootstrap: true });
        yield* finishBootstrap(key, pending, url);
      }),
    );

  const resumeBootstrap = enrollmentLock.withPermits(1)(
    Effect.gen(function* () {
      const key = yield* readActiveBootstrapKey;
      if (key === null) return;
      const pending = yield* readPendingBootstrap(key);
      if (pending === null) return;
      const url = yield* normalizeUrl(pending.input.url);
      if (credential !== null && state.url !== null && state.url !== url.toString()) {
        return;
      }
      if (state.url === null && !state.hasPendingBootstrap) {
        setState({ ...state, hasPendingBootstrap: true });
      }
      yield* finishBootstrap(key, pending, url);
    }),
  );

  const leave = Effect.gen(function* () {
    disconnect();
    completedBootstrap = null;
    credential = null;
    yield* secrets
      .remove(CREDENTIAL_NAME)
      .pipe(
        Effect.mapError(
          (cause) => new TeamHubError({ reason: "Cannot remove team membership", cause }),
        ),
      );
    yield* settings
      .updateSettings({ teamHubUrl: null })
      .pipe(
        Effect.mapError(
          (cause) => new TeamHubError({ reason: "Cannot clear team hub address", cause }),
        ),
      );
    setState({ url: null, status: "disconnected", snapshot: null, error: null });
  });

  const service = TeamHubService.of({
    state: Effect.sync(() => state),
    stream,
    start,
    stop: Effect.sync(() => {
      stopped = true;
      disconnect();
    }),
    join: (input) =>
      enrollmentLock.withPermits(1)(
        Effect.gen(function* () {
          const url = yield* normalizeUrl(input.url);
          const result = yield* enroll(url, "/api/join", input);
          yield* saveMembership(url, result);
        }),
      ),
    bootstrap,
    retryBootstrap: resumeBootstrap,
    createLocalTeam: Effect.fn("TeamHubService.createLocalTeam")(function* (input) {
      const url = yield* normalizeUrl(input.url);
      const membership = yield* docker
        .createTeam(input)
        .pipe(Effect.mapError((cause) => new TeamHubError({ reason: cause.reason, cause })));
      yield* saveMembership(url, membership);
    }),
    leave,
    deleteTeam: Effect.fn("TeamHubService.deleteTeam")(function* (teamId) {
      const currentCredential = credential;
      const currentUrl = state.url;
      if (!currentCredential || !currentUrl) {
        return yield* new TeamHubError({ reason: "Not joined to a team hub", cause: null });
      }
      const container = yield* docker.findTeamContainer(teamId, currentCredential);
      if (credential !== currentCredential || state.url !== currentUrl) {
        return yield* new TeamHubError({ reason: "Team membership changed", cause: null });
      }
      const result = yield* request<{ empty: boolean }>("/api/team/delete", { teamId }).pipe(
        Effect.catchIf(
          (error) => error.status === 404,
          (error) =>
            container
              ? docker.deleteLastTeam(container, teamId, currentCredential).pipe(
                  Effect.mapError((cause) => new TeamHubError({ reason: cause.reason, cause })),
                  Effect.as({ empty: true }),
                )
              : Effect.fail(error),
        ),
      );
      const cleanup = yield* Effect.result(
        result.empty === true && container ? docker.removeEmptyContainer(container) : Effect.void,
      );
      if (credential === currentCredential && state.url === currentUrl) yield* leave;
      if (cleanup._tag === "Failure") {
        return yield* new TeamHubError({ reason: cleanup.failure.reason, cause: cleanup.failure });
      }
    }),
    publish: (message) => request("/api/publish", message),
    publishCheckpoint: (input) =>
      Effect.sync(() => {
        if (
          !socket ||
          socket.readyState !== WebSocket.OPEN ||
          !state.snapshot ||
          normalizeGitRemoteUrl(state.snapshot.team.repo) !== input.repository
        )
          return;
        const files = input.files.filter((path) => path.length <= 256).slice(0, 200);
        const task = state.snapshot.tasks.find(
          (task) =>
            task.threadId === input.threadId &&
            task.assigneeId === state.snapshot?.selfId &&
            (task.status === "accepted" || task.status === "done"),
        );
        socket.send(
          JSON.stringify({
            type: "publish_summary",
            ...(task ? { taskId: task.id } : {}),
            branch: input.branch.slice(0, 256),
            files,
            description: input.description.slice(0, 1000),
          } satisfies TeamHubClientMessage),
        );
        const contractPaths = files.filter((path) =>
          /(?:^|\/)(?:contracts?|schemas?|routes?|api)(?:\/|\.)|\.(?:graphql|proto)$/i.test(path),
        );
        if (contractPaths.length > 0) {
          socket.send(
            JSON.stringify({
              type: "post_contract_change",
              description: `Changed ${contractPaths.length} interface file${contractPaths.length === 1 ? "" : "s"}`,
              paths: contractPaths.slice(0, 50),
            } satisfies TeamHubClientMessage),
          );
        }
      }),
    reportActivity: (next) =>
      Effect.sync(() => {
        if (activity?.provider === next.provider && activity.working === next.working) return;
        activity = next;
        sendActivity();
      }),
    reportRepoAccess: (next) =>
      Effect.sync(() => {
        if (repoAccess === next) return;
        repoAccess = next;
        sendRepoAccess();
      }),
    createInvite: request("/api/invites", {}),
    listInvites: request("/api/invites"),
    revokeInvite: (inviteId) => request("/api/invites/revoke", { inviteId }),
    updateRepo: (repo) => request("/api/team/repo", { repo }),
    updateAdvertisedUrl: (url) => request("/api/team/advertised-url", { url }),
    removeMember: (memberId) => request("/api/members/remove", { memberId }),
    reserveAutoStart: (taskId, token, sha) =>
      request("/api/tasks/auto-start", { taskId, token, sha }),
    releaseAutoStart: (taskId, token) =>
      request("/api/tasks/auto-start-release", { taskId, token }),
    decideTask: (taskId, decision, threadId, autoStartToken) =>
      request("/api/tasks/decide", { taskId, decision, threadId, autoStartToken }),
  });
  return { service, resumeBootstrap };
});

export const layer = Layer.effect(
  TeamHubService,
  Effect.gen(function* () {
    const { service, resumeBootstrap } = yield* make;
    yield* service.start;
    yield* Effect.addFinalizer(() => service.stop);
    yield* resumeBootstrap.pipe(Effect.ignore, Effect.forkScoped);
    return service;
  }),
);
