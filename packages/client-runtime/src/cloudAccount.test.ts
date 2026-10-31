import { describe, expect, it } from "vite-plus/test";
import { cloudUpdatesMetadata, readsCloudUpdatesPreference } from "./cloudAccount";

describe("cloud email preferences", () => {
  it("requires an explicit opt-in, including for existing or malformed metadata", () => {
    for (const value of [
      undefined,
      null,
      true,
      "true",
      {},
      { updatesOptIn: "true" },
      { updatesOptIn: 1 },
    ]) {
      expect(readsCloudUpdatesPreference({ codeRelayCloud: value })).toBe(false);
    }
    expect(readsCloudUpdatesPreference(cloudUpdatesMetadata(true))).toBe(true);
    expect(readsCloudUpdatesPreference(cloudUpdatesMetadata(false))).toBe(false);
  });

  it("records the displayed wording and a timestamp on withdrawal as well as opt-in", () => {
    expect(cloudUpdatesMetadata(false, new Date("2026-10-31T12:00:00Z")).codeRelayCloud).toEqual({
      updatesOptIn: false,
      updatedAt: "2026-10-31T12:00:00.000Z",
      wordingVersion: "2026-10-31",
      wording: "Email me about cloud early access and product updates.",
    });
  });
});
