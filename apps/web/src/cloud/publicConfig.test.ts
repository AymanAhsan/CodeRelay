import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasCloudPublicConfig,
  hasAccountPublicConfig,
  hasCodeRelayAccounts,
  resolveRelayClerkTokenOptions,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("supports opt-in accounts without enabling remote access", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    vi.stubEnv("VITE_CODERELAY_ACCOUNTS", "");
    expect(hasAccountPublicConfig()).toBe(true);
    expect(hasCloudPublicConfig()).toBe(false);
    expect(hasCodeRelayAccounts()).toBe(false);
    vi.stubEnv("VITE_CODERELAY_ACCOUNTS", "1");
    expect(hasCodeRelayAccounts()).toBe(true);
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    expect(hasCodeRelayAccounts()).toBe(false);
  });
  it("requires both public cloud values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("reports the missing Clerk JWT template as structured configuration", () => {
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");

    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });
});
