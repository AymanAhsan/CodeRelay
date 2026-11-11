import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId, type ProjectCloneSnapshot } from "@t3tools/contracts";
import type { TeamHubMember, TeamHubSnapshot, TeamHubTask } from "@t3tools/contracts/teamHub";
import type { EnvironmentProject } from "./models.ts";
import {
  canManageTeamHubTasks,
  findTeamHubProject,
  promptRequestsTeamHandoff,
  queuedTeamHubTasksForOthers,
  rankTeamHubHandoffCandidates,
  teamHubHandoffOffer,
  formatTeamHubContract,
  incomingTeamHubTasks,
  delegatedTeamHubTasks,
  parseTeamHubDomains,
  parseTeamHubLink,
  teamHubCloneRemote,
  withTeamHubOrigin,
} from "./teamHub.ts";

describe("team repository projects", () => {
  const environmentId = EnvironmentId.make("connected-machine");
  const remoteUrl = "https://github.com/acme/backend.git";
  const timestamp = "2026-01-01T00:00:00.000Z";
  const project: EnvironmentProject = {
    environmentId,
    id: ProjectId.make("backend"),
    title: "Backend",
    workspaceRoot: "/projects/backend",
    createdAt: timestamp,
    updatedAt: timestamp,
    repositoryIdentity: {
      canonicalKey: "github.com/acme/backend",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    },
    defaultModelSelection: null,
    scripts: [],
  };

  it("matches the repository across Git transports only on the selected machine", () => {
    const sshRemote = "git@github.com:acme/backend.git";
    const otherProject = { ...project, environmentId: EnvironmentId.make("other-machine") };
    expect(findTeamHubProject(sshRemote, environmentId, [otherProject], [])).toBeUndefined();
    expect(findTeamHubProject(sshRemote, environmentId, [otherProject, project], [])).toBe(project);
  });

  it("reopens a failed clone so the teammate can retry it", () => {
    const cloningProject = { ...project, repositoryIdentity: null };
    const clone: ProjectCloneSnapshot = {
      projectId: project.id,
      remoteUrl,
      destinationPath: project.workspaceRoot,
      repository: null,
      phase: "failed",
      stage: "connecting",
      percent: null,
      detail: null,
      error: "Permission denied",
      startedAt: timestamp,
      endedAt: timestamp,
      sequence: 2,
    };
    expect(findTeamHubProject(remoteUrl, environmentId, [cloningProject], [clone])).toBe(
      cloningProject,
    );
    const unrelatedProject = {
      ...cloningProject,
      repositoryIdentity: {
        canonicalKey: "github.com/acme/frontend",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/frontend.git",
        },
      },
    };
    expect(
      findTeamHubProject(remoteUrl, environmentId, [unrelatedProject], [clone]),
    ).toBeUndefined();
  });

  it("only offers to clone network Git remotes supplied by the team", () => {
    expect(teamHubCloneRemote(remoteUrl)).toBe(remoteUrl);
    expect(teamHubCloneRemote("git@github.com:acme/backend.git")).toBe(
      "git@github.com:acme/backend.git",
    );
    expect(teamHubCloneRemote("file:///projects/backend")).toBeNull();
    expect(teamHubCloneRemote("/projects/backend")).toBeNull();
    expect(teamHubCloneRemote("https://github.com")).toBeNull();
  });
});

describe("incomingTeamHubTasks", () => {
  const task = (id: string, overrides: Partial<TeamHubTask> = {}): TeamHubTask => ({
    id,
    authorId: "author",
    assigneeId: "self",
    text: "Review the change",
    status: "suggested",
    threadId: null,
    result: null,
    contract: null,
    contractAwaiting: null,
    createdAt: 10,
    ...overrides,
  });
  const snapshot = (tasks: TeamHubTask[]): TeamHubSnapshot => ({
    team: { id: "team", name: "Team", repo: "repo" },
    selfId: "self",
    members: [],
    summaries: [],
    tasks,
    notes: [],
    claims: [],
    contractChanges: [],
  });

  it("only shows pending tasks assigned to self or offered to everyone", () => {
    expect(
      incomingTeamHubTasks(
        snapshot([
          task("mine"),
          task("everyone", { assigneeId: null }),
          task("other", { assigneeId: "other" }),
          task("accepted", { status: "accepted" }),
          task("dismissed", { status: "dismissed" }),
        ]),
      ).map((task) => task.id),
    ).toEqual(["everyone", "mine"]);
  });

  it("keeps the oldest task first without mutating the snapshot", () => {
    const state = snapshot([task("new", { createdAt: 20 }), task("old")]);
    expect(incomingTeamHubTasks(state).map((task) => task.id)).toEqual(["old", "new"]);
    expect(state.tasks.map((task) => task.id)).toEqual(["new", "old"]);
  });

  it("puts a revised contract in front of the author and out of the assignee's way", () => {
    const contract = { branch: "contract/x", path: "api/x.yaml", sha: "a".repeat(40) };
    const state = snapshot([
      task("assigned-waiting", { contract, contractAwaiting: "author" }),
      task("authored-agree", {
        authorId: "self",
        assigneeId: "bob",
        contract,
        contractAwaiting: "author",
      }),
      task("authored-pending", {
        authorId: "self",
        assigneeId: "bob",
        contract,
        contractAwaiting: "assignee",
      }),
    ]);
    expect(incomingTeamHubTasks(state).map((task) => task.id)).toEqual(["authored-agree"]);
    expect(incomingTeamHubTasks(state, { includeWaiting: true }).map((task) => task.id)).toEqual([
      "assigned-waiting",
      "authored-agree",
    ]);
  });

  it("has no incoming tasks before joining a team", () => {
    expect(incomingTeamHubTasks(null)).toEqual([]);
  });

  it("shows accepted and completed handoffs to both parties, outside incoming suggestions", () => {
    const state = snapshot([
      task("incoming"),
      task("working", { status: "accepted" }),
      task("finished", { status: "done", authorId: "self", assigneeId: "bob" }),
      task("unrelated", { status: "done", authorId: "alice", assigneeId: "bob" }),
      task("dismissed", { status: "dismissed" }),
    ]);
    expect(delegatedTeamHubTasks(state).map((task) => task.id)).toEqual(["working", "finished"]);
    expect(incomingTeamHubTasks(state).map((task) => task.id)).toEqual(["incoming"]);
    expect(delegatedTeamHubTasks(null)).toEqual([]);
  });
});

describe("withTeamHubOrigin", () => {
  it("re-points a setup link at the shared address and keeps its token", () => {
    const link = parseTeamHubLink("http://localhost:8080/setup#token=abc%2Bdef");
    expect(link).toEqual({ url: "http://localhost:8080", token: "abc+def" });
    expect(withTeamHubOrigin(link!, "https://desk.tail.ts.net/")).toEqual({
      url: "https://desk.tail.ts.net",
      token: "abc+def",
    });
  });

  it("drops any path or port detail down to the origin", () => {
    expect(
      withTeamHubOrigin(
        { url: "http://localhost:8080", token: "t" },
        "https://desk.tail.ts.net:8443/x?y=1",
      ),
    ).toEqual({ url: "https://desk.tail.ts.net:8443", token: "t" });
  });

  it("rejects an address that is not http or https", () => {
    expect(
      withTeamHubOrigin({ url: "http://localhost:8080", token: "t" }, "ftp://example.test"),
    ).toBeNull();
    expect(withTeamHubOrigin({ url: "http://localhost:8080", token: "t" }, "not a url")).toBeNull();
  });
});

describe("team hub domains and contracts", () => {
  it("splits areas on commas and newlines, dropping blanks and duplicates", () => {
    expect(parseTeamHubDomains(" apps/api/**, \n\napps/api/**\nserver/ ,")).toEqual([
      "apps/api/**",
      "server/",
    ]);
  });

  it("labels a contract by path, short sha, and branch", () => {
    const contract = {
      branch: "contract/login",
      path: "api/auth.yaml",
      sha: "1a2b3c4".padEnd(40, "0"),
    };
    expect(formatTeamHubContract(contract)).toBe("api/auth.yaml @ 1a2b3c4 (contract/login)");
  });
});

describe("team handoff suggestions", () => {
  const member = (id: string, overrides: Partial<TeamHubMember> = {}): TeamHubMember => ({
    id,
    name: id,
    role: "member",
    online: true,
    domains: [],
    activity: { provider: null, working: false },
    ...overrides,
  });
  const snapshot = (
    members: ReadonlyArray<TeamHubMember>,
    tasks: TeamHubTask[] = [],
  ): TeamHubSnapshot => ({
    team: { id: "team", name: "Team", repo: "https://github.com/acme/app.git" },
    selfId: "self",
    members,
    summaries: [],
    tasks,
    notes: [],
    claims: [],
    contractChanges: [],
  });
  const team = snapshot([
    member("self", { domains: ["apps/web/**"] }),
    member("Bob", { domains: ["apps/api/**"], online: false }),
    member("Cara", { domains: ["apps/mobile/**", "packages/auth-kit/"] }),
    member("Dan"),
  ]);

  it("ranks teammates by the areas a prompt names, keeping offline ones", () => {
    const ranked = rankTeamHubHandoffCandidates(team, "Add a login endpoint to the api");
    expect(ranked.map((candidate) => candidate.member.id)).toEqual(["Bob", "Cara", "Dan"]);
    expect(ranked[0]).toMatchObject({ matchedDomains: ["apps/api/**"], score: 1 });
    expect(ranked[1]?.score).toBe(0);
  });

  it("weights an owned path above a keyword", () => {
    const ranked = rankTeamHubHandoffCandidates(
      team,
      "Fix the token refresh in packages/auth-kit/src/refresh.ts and the api client",
    );
    expect(ranked[0]).toMatchObject({ member: { id: "Cara" }, score: 5 });
    expect(ranked[1]).toMatchObject({ member: { id: "Bob" }, score: 1 });
  });

  it("only offers a handoff for the team repository when a teammate's areas match", () => {
    const connected = { status: "connected", snapshot: team };
    const repo = "github.com/acme/app";
    expect(teamHubHandoffOffer(connected, repo, "Update the api docs")?.[0]?.member.id).toBe("Bob");
    expect(teamHubHandoffOffer(connected, repo, "Rename this variable")).toBeNull();
    expect(teamHubHandoffOffer(connected, "github.com/acme/other", "Update the api")).toBeNull();
    expect(teamHubHandoffOffer({ ...connected, status: "connecting" }, repo, "api")).toBeNull();
    expect(teamHubHandoffOffer(connected, repo, "Hand this off to Bob: update the api")).toBeNull();
  });

  it("recognizes prompts that already ask for a handoff", () => {
    expect(promptRequestsTeamHandoff("please delegate the api work")).toBe(true);
    expect(promptRequestsTeamHandoff("assign this to Bob")).toBe(true);
    expect(promptRequestsTeamHandoff("fix the offset handling")).toBe(false);
  });

  it("lists tasks queued for others and lets only admins manage them", () => {
    const task = (id: string, assigneeId: string | null, status: TeamHubTask["status"]) =>
      ({
        id,
        authorId: "Dan",
        assigneeId,
        text: id,
        status,
        threadId: null,
        result: null,
        contract: null,
        contractAwaiting: null,
        createdAt: 1,
      }) satisfies TeamHubTask;
    const state = snapshot(team.members, [
      task("bob", "Bob", "suggested"),
      task("mine", "self", "suggested"),
      task("open", null, "suggested"),
      task("started", "Bob", "accepted"),
    ]);
    expect(queuedTeamHubTasksForOthers(state).map((queued) => queued.id)).toEqual(["bob"]);
    expect(canManageTeamHubTasks(state)).toBe(false);
    expect(
      canManageTeamHubTasks(
        snapshot([member("self", { role: "admin" }), ...team.members.slice(1)]),
      ),
    ).toBe(true);
  });
});
