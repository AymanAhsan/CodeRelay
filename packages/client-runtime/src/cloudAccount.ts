export const CLOUD_UPDATES_LABEL = "Email me about cloud early access and product updates.";
export const CLOUD_UPDATES_VERSION = "2026-10-31";

/** User-editable preferences, never authorization or a server-verified consent audit. */
export function readsCloudUpdatesPreference(metadata: Record<string, unknown>): boolean {
  const account = metadata.codeRelayCloud;
  return (
    typeof account === "object" &&
    account !== null &&
    "updatesOptIn" in account &&
    account.updatesOptIn === true
  );
}

export function cloudUpdatesMetadata(updatesOptIn: boolean, now = new Date()) {
  return {
    codeRelayCloud: {
      updatesOptIn,
      updatedAt: now.toISOString(),
      wordingVersion: CLOUD_UPDATES_VERSION,
      wording: CLOUD_UPDATES_LABEL,
    },
  };
}
