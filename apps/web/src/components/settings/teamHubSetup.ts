import { teamHubCloneRemote } from "@t3tools/client-runtime/state/team-hub";
import { PortSchema } from "@t3tools/contracts";
import { TEAM_HUB_DEFAULT_CONTAINER_NAME, TeamHubContainerName } from "@t3tools/contracts/teamHub";
import * as Schema from "effect/Schema";
import { DEFAULT_HUB_PORT, DEFAULT_SHARE_PORT, normalizeHubAddress } from "./TeamHubReach.logic";

// Persist choices only. Credentials and observations about Docker and Tailscale
// must come from the current setup session.
export const TeamHubSetupDraft = Schema.Struct({
  reach: Schema.Literals(["public", "private", "other"]),
  name: TeamHubContainerName,
  hubPort: PortSchema,
  servePort: PortSchema,
});
export type TeamHubSetupDraft = typeof TeamHubSetupDraft.Type;

export const DEFAULT_TEAM_HUB_SETUP: TeamHubSetupDraft = {
  reach: "public",
  name: TEAM_HUB_DEFAULT_CONTAINER_NAME,
  hubPort: DEFAULT_HUB_PORT,
  servePort: DEFAULT_SHARE_PORT,
};

export type LocalTeamHubSetup =
  | { readonly status: "checking" | "unavailable" | "initialized" }
  | { readonly status: "pending"; readonly setupLink: string };

export function teamHubSetupStage(input: {
  readonly localSetup: LocalTeamHubSetup["status"];
  readonly advertisedAddress: string | null;
}) {
  if (input.localSetup === "initialized") return "already-initialized";
  if (input.localSetup !== "pending") return "deploy";
  return input.advertisedAddress === null ? "network" : "team";
}

export const advertisedTeamHubOrigin = normalizeHubAddress;

export function canLinkTeamHubRepository(input: string): boolean {
  const remote = teamHubCloneRemote(input);
  if (remote === null) return false;
  // SCP-style Git remotes accept a user and host but have no credential field.
  if (!/^[a-z]+:\/\//i.test(remote)) return !/[?#]/.test(remote);
  const url = new URL(remote);
  // The repo is shared with the whole team. Keep credentials in Git's local store.
  return !url.password && !url.search && !url.hash && (url.protocol === "ssh:" || !url.username);
}
