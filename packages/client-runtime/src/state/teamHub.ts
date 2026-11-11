import type {
  TeamHubCheckInput,
  TeamHubStartInput,
  TeamHubCreateLocalTeamInput,
  TeamHubClientMessage,
  TeamHubJoinInput,
  TeamHubBootstrapInput,
  TeamHubContractRef,
  TeamHubMember,
  TeamHubNetworkInput,
  TeamHubSnapshot,
  TeamHubTask,
} from "@t3tools/contracts/teamHub";
import { matchesDomain, TEAM_HUB_TASK_TEXT_MAX_LENGTH } from "@t3tools/contracts/teamHub";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import { WS_METHODS, type ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { EnvironmentShellState } from "./shell.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

/** Uses the environment's existing RPC session, including reconnection. */
export function createTeamHubStateAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:team-hub",
    tag: WS_METHODS.subscribeTeamHubState,
  });
}

/**
 * What `selfId` can do with a suggested task right now: `decide` (accept or dismiss),
 * `agree` (the author agrees to the assignee's revised contract), or `waiting` (the assignee
 * revised the contract and the author has not agreed yet). `null` when it is not theirs.
 */
export function teamHubTaskTurn(
  task: TeamHubTask,
  selfId: string,
): "decide" | "agree" | "waiting" | null {
  if (task.status !== "suggested") return null;
  if (task.authorId === selfId && task.contractAwaiting === "author") return "agree";
  if (task.assigneeId !== null && task.assigneeId !== selfId) return null;
  return task.contractAwaiting === "author" ? "waiting" : "decide";
}

/** Suggested tasks waiting on this member, oldest first. */
export function incomingTeamHubTasks(
  snapshot: TeamHubSnapshot | null,
  options: { readonly includeWaiting?: boolean } = {},
) {
  return (
    snapshot?.tasks.filter((task) => {
      const turn = teamHubTaskTurn(task, snapshot.selfId);
      return turn === "decide" || turn === "agree" || (options.includeWaiting && turn !== null);
    }) ?? []
  ).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Work in progress and completed handoffs for either side of a task. */
export function delegatedTeamHubTasks(snapshot: TeamHubSnapshot | null) {
  return (
    snapshot?.tasks.filter(
      (task) =>
        (task.status === "accepted" || task.status === "done") &&
        (task.authorId === snapshot.selfId || task.assigneeId === snapshot.selfId),
    ) ?? []
  );
}

/** Team admins can move queued tasks between teammates and take them for themselves. */
export function canManageTeamHubTasks(snapshot: TeamHubSnapshot | null): boolean {
  return (
    snapshot?.members.some((member) => member.id === snapshot.selfId && member.role === "admin") ??
    false
  );
}

/** Suggested tasks queued for another teammate, oldest first. Only admins can act on them. */
export function queuedTeamHubTasksForOthers(snapshot: TeamHubSnapshot | null) {
  return (
    snapshot?.tasks.filter(
      (task) =>
        task.status === "suggested" &&
        task.assigneeId !== null &&
        task.assigneeId !== snapshot.selfId,
    ) ?? []
  ).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

const EXPLICIT_HANDOFF =
  /\b(hand(?:ing)?[\s-]?(?:it\s+|this\s+)?off|handoff|delegate|(?:assign|give|send|pass)\s+(?:this|it)\s+to)\b/i;

/** The prompt already asks to hand work off, so the agent handles it with the team tools. */
export function promptRequestsTeamHandoff(prompt: string): boolean {
  return EXPLICIT_HANDOFF.test(prompt);
}

// Path segments that say nothing about who owns an area.
const GENERIC_SEGMENTS = new Set([
  "app",
  "apps",
  "packages",
  "package",
  "src",
  "lib",
  "libs",
  "services",
  "service",
  "modules",
  "internal",
  "pkg",
  "components",
  "source",
  "code",
]);

/** Words in a domain glob that a prompt might name, such as `api` for `apps/api/**`. */
function domainKeywords(glob: string): string[] {
  return glob
    .split("/")
    .filter((segment) => segment.length > 0 && !/[*?]/.test(segment))
    .map((segment) => segment.replace(/\.[a-z0-9]+$/i, "").toLowerCase())
    .flatMap((segment) => [segment, ...segment.split(/[-_.]/)])
    .filter((word) => word.length >= 3 && !GENERIC_SEGMENTS.has(word));
}

export interface TeamHubHandoffCandidate {
  readonly member: TeamHubMember;
  /** The member's domains the prompt touches. Empty when nothing in the prompt matched. */
  readonly matchedDomains: ReadonlyArray<string>;
  readonly score: number;
}

/**
 * Ranks teammates for taking a prompt by how much of it falls in their areas. A path in the
 * prompt that a domain owns outweighs a word that only names the area. Online teammates come
 * first among equals; offline ones stay listed because the hub keeps tasks until they return.
 */
export function rankTeamHubHandoffCandidates(
  snapshot: TeamHubSnapshot,
  prompt: string,
): TeamHubHandoffCandidate[] {
  const text = prompt.toLowerCase();
  const paths = [...prompt.matchAll(/@?([\w.-]+(?:\/[\w.*-]+)+\/?)/g)].map((match) => match[1]!);
  const words = new Set(text.split(/[^a-z0-9]+/).filter((word) => word.length > 0));
  return snapshot.members
    .filter((member) => member.id !== snapshot.selfId)
    .map((member) => {
      let score = 0;
      const matchedDomains: string[] = [];
      for (const glob of member.domains) {
        const pathHits = paths.filter((path) => matchesDomain(path, glob)).length;
        const keywordHits = new Set(domainKeywords(glob).filter((word) => words.has(word))).size;
        if (pathHits + keywordHits === 0) continue;
        score += pathHits * 3 + keywordHits;
        matchedDomains.push(glob);
      }
      return { member, matchedDomains, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.member.online) - Number(a.member.online) ||
        a.member.name.localeCompare(b.member.name),
    );
}

/**
 * Teammates to offer a handoff to before sending a prompt to this member's own agent, or
 * `null` when no offer fits: the hub is not connected, the project is not the team's
 * repository, the prompt is too long for a task or already asks for a handoff, or no
 * teammate's areas match it.
 */
export function teamHubHandoffOffer(
  state: { readonly status: string; readonly snapshot: TeamHubSnapshot | null } | null,
  projectRepositoryKey: string | null | undefined,
  prompt: string,
): TeamHubHandoffCandidate[] | null {
  if (state?.status !== "connected" || state.snapshot === null) return null;
  if (
    !projectRepositoryKey ||
    projectRepositoryKey !== normalizeGitRemoteUrl(state.snapshot.team.repo)
  )
    return null;
  const text = prompt.trim();
  if (
    text.length === 0 ||
    text.length > TEAM_HUB_TASK_TEXT_MAX_LENGTH ||
    promptRequestsTeamHandoff(text)
  )
    return null;
  const candidates = rankTeamHubHandoffCandidates(state.snapshot, prompt);
  return candidates.some((candidate) => candidate.score > 0) ? candidates : null;
}

/** Turns the comma- or newline-separated "Your areas" text into domain globs. */
export function parseTeamHubDomains(text: string): string[] {
  const domains = text
    .split(/[\n,]/)
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0 && domain.length <= 256);
  return [...new Set(domains)].slice(0, 20);
}

/** Short label for a task's contract, such as `api/auth.yaml @ 1a2b3c4 (contract/login)`. */
export function formatTeamHubContract(contract: TeamHubContractRef): string {
  return `${contract.path} @ ${contract.sha.slice(0, 7)} (${contract.branch})`;
}

export type TeamHubAction =
  | { readonly type: "join"; readonly input: TeamHubJoinInput }
  | { readonly type: "bootstrap"; readonly input: TeamHubBootstrapInput }
  | { readonly type: "exposeHub"; readonly input: TeamHubNetworkInput }
  | { readonly type: "unexposeHub"; readonly input: TeamHubNetworkInput }
  | { readonly type: "checkHub"; readonly input: TeamHubCheckInput }
  | { readonly type: "startHub"; readonly input: TeamHubStartInput }
  | { readonly type: "restartHub"; readonly input: TeamHubStartInput }
  | { readonly type: "setupLink"; readonly input: TeamHubStartInput }
  | { readonly type: "createLocalTeam"; readonly input: TeamHubCreateLocalTeamInput }
  | { readonly type: "leave" }
  | { readonly type: "deleteTeam"; readonly teamId: string }
  | { readonly type: "publish"; readonly input: TeamHubClientMessage }
  | { readonly type: "invite" }
  | { readonly type: "revokeInvite"; readonly inviteId: string }
  | { readonly type: "updateRepo"; readonly repo: string }
  | { readonly type: "removeMember"; readonly memberId: string }
  | {
      readonly type: "decideTask";
      readonly taskId: string;
      readonly decision: "accepted" | "dismissed";
    };

export function teamHubActionErrorMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "EnvironmentRequestInvalidError" &&
    "reason" in error &&
    error.reason === "team_hub_project_missing"
  ) {
    return "Clone the team repo and add it as a project to accept tasks.";
  }
  return error instanceof Error ? error.message : "The team hub request failed.";
}

export function parseTeamHubLink(value: string): { url: string; token: string } | null {
  try {
    const link = new URL(value);
    const token = new URLSearchParams(link.hash.slice(1)).get("token");
    return (link.protocol === "https:" || link.protocol === "http:") && token
      ? { url: link.origin, token }
      : null;
  } catch {
    return null;
  }
}

/**
 * Re-points a pasted hub link at another address, keeping its one-time token.
 * Setup links print `localhost` when the hub is shared over Tailscale, and the
 * token does not depend on the host.
 */
export function withTeamHubOrigin(
  link: { readonly url: string; readonly token: string },
  origin: string,
): { url: string; token: string } | null {
  try {
    const next = new URL(origin);
    return next.protocol === "https:" || next.protocol === "http:"
      ? { url: next.origin, token: link.token }
      : null;
  } catch {
    return null;
  }
}

export const readTeamHubInvites = Effect.fn("clientRuntime.teamHub.readInvites")(function* (
  prepared: PreparedConnection,
) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    group: "teamHub",
    method: "GET",
    url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.invites(),
    timeoutMs: 8_000,
    request: ({ client, headers }) => client.invites({ headers }),
  });
});

export const readTeamHubNetworkState = Effect.fn("clientRuntime.teamHub.readNetworkState")(
  function* (prepared: PreparedConnection, input: TeamHubNetworkInput) {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "teamHub",
      method: "POST",
      url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.networkState(),
      // The server waits on the Tailscale CLI and two probes.
      timeoutMs: 15_000,
      request: ({ client, headers }) => client.networkState({ headers, payload: input }),
    });
  },
);

/** HTTP acceptance can finish before the shell subscription delivers the new thread. */
export const waitForTeamHubThread = Effect.fn("clientRuntime.teamHub.waitForThread")(function* (
  registry: AtomRegistry.AtomRegistry,
  shell: Atom.Atom<EnvironmentShellState>,
  threadId: ThreadId,
) {
  yield* AtomRegistry.toStream(registry, shell).pipe(
    Stream.filter(
      (state) =>
        Option.isSome(state.snapshot) &&
        state.snapshot.value.threads.some(
          (thread) => thread.id === threadId && thread.deletedAt === null,
        ),
    ),
    Stream.runHead,
    Effect.timeout("15 seconds"),
    Effect.mapError(
      () => new Error("Task accepted, but its thread has not loaded. Reconnect to see it."),
    ),
  );
});

export const runTeamHubAction = Effect.fn("clientRuntime.teamHub.action")(function* (
  prepared: PreparedConnection,
  action: TeamHubAction,
  synchronization?: {
    readonly registry: AtomRegistry.AtomRegistry;
    readonly shell: Atom.Atom<EnvironmentShellState>;
  },
) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const common = {
    prepared,
    signer,
    remoteAuthorization,
    group: "teamHub" as const,
    method: "POST" as const,
    timeoutMs: 8_000,
  };
  switch (action.type) {
    case "bootstrap":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.bootstrap(),
        request: ({ client, headers }) => client.bootstrap({ headers, payload: action.input }),
      });
    case "join":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.join(),
        request: ({ client, headers }) => client.join({ headers, payload: action.input }),
      });
    case "exposeHub":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        // Sharing waits for Tailscale to issue the HTTPS certificate.
        timeoutMs: 45_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.exposeHub(),
        request: ({ client, headers }) => client.exposeHub({ headers, payload: action.input }),
      });
    case "unexposeHub":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        timeoutMs: 20_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.unexposeHub(),
        request: ({ client, headers }) => client.unexposeHub({ headers, payload: action.input }),
      });
    case "startHub":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        // Docker can be slow to create a container, then the hub needs a moment to print its link.
        timeoutMs: 11 * 60_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.startHub(),
        request: ({ client, headers }) => client.startHub({ headers, payload: action.input }),
      });
    case "createLocalTeam":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        timeoutMs: 20_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.createLocalTeam(),
        request: ({ client, headers }) =>
          client.createLocalTeam({ headers, payload: action.input }),
      });
    case "setupLink":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        timeoutMs: 15_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.setupLink(),
        request: ({ client, headers }) => client.setupLink({ headers, payload: action.input }),
      });
    case "restartHub":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        // The server waits up to 30s for Docker, then a few seconds for the hub's link.
        timeoutMs: 45_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.restartHub(),
        request: ({ client, headers }) => client.restartHub({ headers, payload: action.input }),
      });
    case "checkHub":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        timeoutMs: 15_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.checkHub(),
        request: ({ client, headers }) => client.checkHub({ headers, payload: action.input }),
      });
    case "deleteTeam":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        timeoutMs: 45_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.deleteTeam(),
        request: ({ client, headers }) =>
          client.deleteTeam({ headers, payload: { teamId: action.teamId } }),
      });
    case "leave":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.leave(),
        request: ({ client, headers }) => client.leave({ headers }),
      });
    case "publish":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.publish(),
        // HttpApiClient exposes a union request as overloaded calls; the wire schema validates the union.
        request: ({ client, headers }) =>
          client.publish({ headers, payload: action.input as never }),
      });
    case "invite":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.invite(),
        request: ({ client, headers }) => client.invite({ headers }),
      });
    case "revokeInvite":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.revokeInvite(),
        request: ({ client, headers }) =>
          client.revokeInvite({ headers, payload: { inviteId: action.inviteId } }),
      });
    case "updateRepo":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.updateRepo(),
        request: ({ client, headers }) =>
          client.updateRepo({ headers, payload: { repo: action.repo } }),
      });
    case "removeMember":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.removeMember(),
        request: ({ client, headers }) =>
          client.removeMember({ headers, payload: { memberId: action.memberId } }),
      });
    case "decideTask":
      const result = yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.decideTask(),
        request: ({ client, headers }) =>
          client.decideTask({
            headers,
            payload: { taskId: action.taskId, decision: action.decision },
          }),
      });
      if (result.threadId !== null && synchronization) {
        yield* waitForTeamHubThread(
          synchronization.registry,
          synchronization.shell,
          result.threadId,
        );
      }
      return result;
  }
});
