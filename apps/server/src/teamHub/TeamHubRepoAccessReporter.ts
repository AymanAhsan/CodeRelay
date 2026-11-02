import type { TeamHubRepoAccess } from "@t3tools/contracts/teamHub";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as TeamHubService from "./TeamHubService.ts";

// Access changes rarely, and each check is two small API calls.
const RECHECK_INTERVAL = Duration.minutes(10);

/** `owner/name` for a GitHub remote in any URL form, or null for other hosts. */
export function gitHubRepositoryName(repo: string): string | null {
  const match = /^github\.com\/([^/]+)\/([^/]+)$/.exec(normalizeGitRemoteUrl(repo));
  return match ? `${match[1]}/${match[2]}` : null;
}

/** How a `gh` call ended: it worked, GitHub answered with an error, or GitHub never answered. */
export type GitHubProbe = "ok" | "failed" | "unavailable";

/**
 * GitHub answers "not found" both for missing repositories and for private ones the account
 * can't see, so a failed repository lookup only means no access when the account itself works.
 */
export function resolveRepoAccess(
  repository: GitHubProbe,
  account: GitHubProbe,
): TeamHubRepoAccess {
  if (repository === "ok") return "granted";
  return repository === "failed" && account === "ok" ? "denied" : "unknown";
}

const DEV_OVERRIDE = Config.Literals(
  ["granted", "denied", "unknown"],
  "T3CODE_DEV_TEAM_REPO_ACCESS",
).pipe(Config.option);

/**
 * Checks with this machine's `gh` login whether the team's repository opens, and tells the
 * team. Rechecks when the repository changes and every few minutes, so granted or revoked
 * access shows up without a restart.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const hub = yield* TeamHubService.TeamHubService;
    const gitHub = yield* GitHubCli.GitHubCli;
    const { cwd } = yield* ServerConfig;
    // Lets `dev:team` show a teammate without access, since both share one `gh` login.
    const override = yield* DEV_OVERRIDE;

    const probe = (args: ReadonlyArray<string>) =>
      gitHub.execute({ cwd, args, timeoutMs: 15_000 }).pipe(
        Effect.as<GitHubProbe>("ok"),
        Effect.catch((error) =>
          Effect.succeed<GitHubProbe>(
            error._tag === "GitHubCliCommandError" ? "failed" : "unavailable",
          ),
        ),
      );

    const check = (repo: string) =>
      Effect.gen(function* () {
        if (Option.isSome(override)) return override.value;
        const name = gitHubRepositoryName(repo);
        if (name === null) return "unknown" as const;
        const repository = yield* probe(["api", `repos/${name}`, "--jq", ".full_name"]);
        const account =
          repository === "failed" ? yield* probe(["api", "user", "--jq", ".login"]) : "ok";
        return resolveRepoAccess(repository, account);
      });

    const watch = (repo: string) =>
      Effect.gen(function* () {
        // Forget the last repository's answer while the new one is checked.
        yield* hub.reportRepoAccess("unknown");
        yield* check(repo).pipe(
          Effect.flatMap(hub.reportRepoAccess),
          Effect.repeat(Schedule.spaced(RECHECK_INTERVAL)),
        );
      });

    yield* hub.stream.pipe(
      Stream.map((state) => state.snapshot?.team.repo ?? null),
      Stream.filter((repo): repo is string => repo !== null),
      Stream.changes,
      Stream.switchMap((repo) => Stream.fromEffect(watch(repo))),
      Stream.runDrain,
      Effect.forkScoped,
    );
  }),
);
