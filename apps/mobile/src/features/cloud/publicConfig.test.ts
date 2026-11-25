import { describe, expect, it, vi } from "vite-plus/test";
import Constants from "expo-constants";

import {
  CloudPublicConfigMissingError,
  hasAccountPublicConfig,
  hasCloudPublicConfig,
  hasCodeRelayAccounts,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("allows CodeRelay accounts without activating relay features", () => {
    const config = Constants.expoConfig!;
    const previousExtra = config.extra;
    try {
      config.extra = { clerk: { publishableKey: "pk_test_example", codeRelayAccounts: true } };
      expect(hasAccountPublicConfig()).toBe(true);
      expect(hasCodeRelayAccounts()).toBe(true);
      expect(hasCloudPublicConfig()).toBe(false);
      config.extra = { clerk: { codeRelayAccounts: true } };
      expect(hasAccountPublicConfig()).toBe(false);
      expect(hasCodeRelayAccounts()).toBe(false);
    } finally {
      config.extra = previousExtra;
    }
  });
  it("reports the missing Clerk JWT template as structured configuration", () => {
    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });

  it("returns no cloud configuration for an unconfigured build", () => {
    expect(resolveCloudPublicConfig({})).toEqual({
      clerk: {
        publishableKey: null,
        jwtTemplate: null,
      },
      relay: {
        url: null,
      },
    });
  });

  it("normalizes statically injected cloud configuration", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "  pk_test_example  ", jwtTemplate: "  t3-relay  " },
        relay: { url: " https://relay.example.test/// " },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: "https://relay.example.test",
      },
    });
  });

  it("ignores legacy tracing configuration in an existing Expo manifest", () => {
    const oldManifest = {
      relay: { url: "https://relay.example.test" },
      observability: {
        tracesUrl: "https://collector.example.test/v1/traces",
        tracesDataset: "legacy",
        tracesToken: "legacy-token",
      },
    };
    expect(resolveCloudPublicConfig(oldManifest)).toEqual(
      resolveCloudPublicConfig({
        relay: oldManifest.relay,
      }),
    );
  });

  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: null,
      },
    });
  });
});
