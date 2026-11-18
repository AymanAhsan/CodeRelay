import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  advertisedTeamHubOrigin,
  canLinkTeamHubRepository,
  DEFAULT_TEAM_HUB_SETUP,
  TeamHubSetupDraft,
  teamHubSetupStage,
} from "./teamHubSetup";

describe("Team Hub setup draft", () => {
  const codec = Schema.fromJsonString(TeamHubSetupDraft);

  it("persists hosting choices without setup links or enrollment data", () => {
    const draft = {
      ...DEFAULT_TEAM_HUB_SETUP,
      name: "engineering-hub",
      hubPort: 18_080,
      reach: "private" as const,
      setupLink: "http://localhost/setup#token=secret",
      credential: "secret",
    };
    const restored = Schema.decodeSync(codec)(Schema.encodeSync(codec)(draft));
    expect(restored).toEqual({
      reach: "private",
      name: "engineering-hub",
      hubPort: 18_080,
      servePort: 443,
    });
  });

  it("requires current setup observations when resuming", () => {
    const advertisedAddress = "https://work.tail.ts.net";
    expect(teamHubSetupStage({ localSetup: "checking", advertisedAddress })).toBe("deploy");
    expect(teamHubSetupStage({ localSetup: "unavailable", advertisedAddress })).toBe("deploy");
    expect(teamHubSetupStage({ localSetup: "pending", advertisedAddress: null })).toBe("network");
    expect(teamHubSetupStage({ localSetup: "pending", advertisedAddress })).toBe("team");
    expect(teamHubSetupStage({ localSetup: "initialized", advertisedAddress })).toBe(
      "already-initialized",
    );
  });
});

describe("Team Hub repository validation", () => {
  it.each([
    "https://github.com/org/repo.git",
    "ssh://git@github.com/org/repo.git",
    "git@github.com:org/repo.git",
  ])("accepts a shareable Git remote (%s)", (remote) => {
    expect(canLinkTeamHubRepository(remote)).toBe(true);
  });

  it.each([
    "https://secret@github.com/org/repo.git",
    "https://github.com/org/repo.git?token=secret",
    "ssh://git:secret@github.com/org/repo.git",
    "/home/user/repo",
  ])("rejects a local or credential-bearing Git remote (%s)", (remote) => {
    expect(canLinkTeamHubRepository(remote)).toBe(false);
  });
});

describe("advertised Team Hub address", () => {
  it("uses a teammate-facing origin without setup or invite tokens", () => {
    expect(advertisedTeamHubOrigin("https://hub.example.com:8443/setup#token=x")).toBe(
      "https://hub.example.com:8443",
    );
    expect(advertisedTeamHubOrigin("http://192.168.1.5:8080")).toBe("http://192.168.1.5:8080");
  });

  it.each([
    "http://localhost:8080",
    "http://desk.localhost.",
    "http://127.0.0.2",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://0.0.0.0",
    "http://[::]",
  ])("rejects an address teammates cannot use (%s)", (url) =>
    expect(advertisedTeamHubOrigin(url)).toBeNull(),
  );
});
