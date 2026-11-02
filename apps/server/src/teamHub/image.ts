import { teamHubDockerTag } from "@t3tools/contracts/teamHub";
import packageJson from "../../package.json" with { type: "json" };

// Source runs use .ts; distributed servers bundle this module into .mjs.
export const hubDockerTag = teamHubDockerTag(packageJson.version, import.meta.url.endsWith(".ts"));
