import { describe, expect, it } from "vite-plus/test";

import { gitHubRepositoryName, resolveRepoAccess } from "./TeamHubRepoAccessReporter.ts";

describe("gitHubRepositoryName", () => {
  it("reads owner and name from any GitHub remote form", () => {
    for (const remote of [
      "https://github.com/Example/Repo.git",
      "git@github.com:example/repo.git",
      "github.com/example/repo",
    ]) {
      expect(gitHubRepositoryName(remote)).toBe("example/repo");
    }
  });

  it("skips repositories hosted elsewhere", () => {
    expect(gitHubRepositoryName("https://gitlab.com/example/repo")).toBeNull();
    expect(gitHubRepositoryName("not a remote")).toBeNull();
  });
});

describe("resolveRepoAccess", () => {
  it("grants access when the repository opens", () => {
    expect(resolveRepoAccess("ok", "ok")).toBe("granted");
  });

  it("denies access only when the account works but the repository does not", () => {
    expect(resolveRepoAccess("failed", "ok")).toBe("denied");
  });

  it("stays unknown when GitHub itself is unreachable or signed out", () => {
    expect(resolveRepoAccess("failed", "failed")).toBe("unknown");
    expect(resolveRepoAccess("failed", "unavailable")).toBe("unknown");
    expect(resolveRepoAccess("unavailable", "ok")).toBe("unknown");
  });
});
