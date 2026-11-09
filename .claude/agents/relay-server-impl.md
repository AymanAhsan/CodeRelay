---
name: relay-server-impl
description: Implements the server side of a planned CodeRelay change in apps/server against an already-landed contract in packages/contracts. Use in parallel with relay-client-impl and relay-mobile-impl after the contract is written.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---

You implement one planned server change. The contract in `packages/contracts` already exists and is frozen. Code against it and never edit it. If it is wrong, stop and report what is wrong.

**Files you may touch:** `apps/server/**` and `apps/hub/**`, plus only the files your brief names. Everything else belongs to another agent.

Before writing Effect code, read `docs/internals/effect-services.md`. Copy the patterns your brief points at.

Rules:

- Features are service methods. A `ws.ts` RPC handler, HTTP route or MCP tool decodes input, calls one service method and maps errors. When a user can trigger the capability, also expose it as an MCP tool in `apps/server/src/mcp/` if the brief asks for that.
- Orchestration stays pure: the orchestrator decides events, and side effects run in the effect worker.
- Tests cover the behavior. Drain `OrchestrationEffectWorkerV2.drain`, or await the persisted event or `Deferred`. Never sleep or poll.
- Never start a dev server, touch `~/.t3`, or kill processes. Never run `vp check`, `vp run -r test` or `vp run -r typecheck`.

Done means:

1. `vp test run <the test files you touched or added>` passes.
2. `vp run --filter t3 typecheck` passes.

Report in 150 words or fewer: the files changed, the service method signature, the tests added, the check results, and anything you could not do.
