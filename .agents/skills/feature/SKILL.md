---
name: feature
description: Plan and build a CodeRelay change with the least token spend. Sizes the work first, then for cross-surface changes lands the contract and fans out parallel relay-* subagents per surface. Use when asked to implement a feature, issue, or multi-file fix in this repo.
---

# Feature workflow

Follow `AGENTS.md`. This skill only decides how much process the change gets and how the work is split.

## 1. Size it first

| Size | Signal | Do this |
|---|---|---|
| **S** | One file, or a bug with an obvious cause | Implement directly. Run `vp test run <file>`. Stop. No plan, no subagents. |
| **M** | One area, roughly 3 to 8 files, no contract change | Write a plan of 5 lines or fewer, implement in this thread, then run `/code-review medium` once. |
| **L** | Changes `packages/contracts`, touches more than one surface, or has a sender side and a receiver side | Run the full workflow below. |

When in doubt, choose the smaller size. Move up a size only when you find a reason.

## 2. Explore (L only)

Launch one `relay-explorer` per area the change touches, all in one message. Usually that's 1 to 3 agents: contracts+server, client, mobile. Give each one the area and the question. Don't read those files yourself while they run.

## 3. Plan (L only)

From the explorer maps, write the plan in this thread:

- **Contract**: the exact schema change in `packages/contracts`.
- **Server**: the service method signature, and which transports and MCP tools call it.
- **Client and mobile**: the state in `client-runtime`, the entry points (chat, Settings, command palette, keybinding), and the reverse states.
- **Surface checklist**: from AGENTS.md "Hit every surface", one line per entry saying "do" or "n/a" and why. Cover each provider adapter if the change is provider-shaped, and both teammate sides if it's a handoff change, including what each side sees when the other is offline.
- **File ownership**: which agent owns which files. No file may appear twice.

If a product decision is ambiguous, ask the user now, once. Don't start implementing on a guess.

## 4. Land the contract (L only, in this thread)

Write the `packages/contracts` change yourself and run `vp run --filter @t3tools/contracts typecheck`. It is the interface every parallel agent codes against, so it must exist before anyone forks. If shared `client-runtime` types are needed by both web and mobile, land those here too.

## 5. Implement in parallel

Send every implementer in **one message** so they run at the same time:

- `relay-server-impl`: server and hub.
- `relay-client-impl`: client-runtime and web/desktop.
- `relay-mobile-impl`: only when the surface checklist says mobile applies.

Give each agent a fresh brief, never the conversation. A brief contains:

- the contract file path
- that agent's section of the plan
- the files it owns
- the pattern to copy, as `path:line`

Use `isolation: "worktree"` only when two agents might write the same paths. Otherwise ownership is enough.

Skip parallelism when one piece needs another's output, or when the whole change is under about 6 files. Coordination costs more than it saves.

## 6. Integrate

- Read each report, not each diff. Open a file only where a report flags a gap.
- Run `vp test run` on every touched test file. Typecheck each touched package with `vp run --filter <pkg> typecheck`.
- Walk the surface checklist and confirm each "do" landed.
- Never run `vp check`, `vp run -r test` or `vp run -r typecheck`. CI owns those.

## 7. Review once

Run `/code-review medium` on the diff. Fix confirmed findings in this thread. Don't stack more reviewers.

## 8. Real-client pass

Do this only if the user asks. The primary agent does it once after integrating, following the `test-t3-app` or `test-t3-mobile` skill.

## Token rules

- Model by phase: Haiku explores, Sonnet implements, the main model plans, integrates and debugs.
- Every subagent report has a word cap. A report lands straight in this thread's context.
- Don't re-read a file you already read. Use Grep with `head_limit` and line ranges.
- Write docs only when `AGENTS.md` "Documentation" says the change needs them.
