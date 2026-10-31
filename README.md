# CodeRelay

Agents on the same team step on each other's work: they edit the same files, duplicate tasks, or build against different assumptions about an API.

CodeRelay gives teammates a way to hand work between their agents. Each teammate declares the repository areas they own. When Alice's agent needs a change in Bob's area, it sends a task with a contract pinned to a Git commit. Bob reviews and accepts it into his own agent thread. Both agents work from the agreed contract, and the completed task carries a summary, branch, and commit back to Alice.

## See the handoff

> **GIF placeholder · 30–60 seconds**
>
> Alice's agent needs an API change → pushes a contract and sends Bob a task → Bob accepts it into his agent thread → Bob's agent completes the work and returns the branch and commit.

<!-- Replace the placeholder above with the Alice-to-Bob handoff GIF when recorded. -->

## Quick start

Requires **Node.js 24**, **Git**, and **Vite+ (`vp`)**. Install and authenticate a supported agent provider, such as Codex or Claude Code, before starting agent work.

### Install vp

On macOS or Linux:

```sh
curl -fsSL https://vite.plus | bash
```

On Windows, in PowerShell:

```powershell
irm https://vite.plus/ps1 | iex
```

### Try Alice and Bob locally

```sh
git clone https://github.com/AymanAhsan/CodeRelay.git
cd CodeRelay
vp i
vp run dev:team
```

The launcher starts a local Team hub and separate Alice and Bob sessions, with both teammates already joined. Open each session's labeled pairing URL from the terminal. Docker is not required for this demo.

1. Set each teammate's owned paths under **Your areas** in the Team hub panel.
2. Ask Alice's agent for work that needs a change in Bob's area. Have it push a contract and suggest a task for Bob.
3. In Bob's session, review the contract and accept the task to start his agent thread.
4. When Bob's agent finishes and marks the task done, review its summary, branch, and commit in Alice's session, then fetch and integrate the work.

Both local sessions share the selected project's files. To try a different repository with an `origin` remote, run `vp run dev:team --project-dir ../your-repo` instead. Press **Ctrl+C** in the launcher terminal to stop the demo.

See the [local demo guide](docs/operations/team-hub.md#local-development-with-alice-and-bob) for options, the [Team hub guide](docs/user/team-hub.md) for contract review and trusted automatic tasks, or [self-host a hub](docs/operations/team-hub.md) to connect real teammates. For a single session, run `vp run dev`; see the [development guide](docs/operations/development.md).

## Built on T3 Code

CodeRelay is built on [T3 Code](https://github.com/pingdotgg/t3code), which provides the agent GUI and web, desktop, and mobile foundations. This independently maintained repository adds the Team hub workflow for handing work between teammates' agents. The application currently retains upstream names and package identifiers; run CodeRelay from this checkout.

The original MIT license and **Copyright (c) 2026 T3 Tools Inc.** notice are preserved in [LICENSE](LICENSE). See [NOTICE.md](NOTICE.md) for attribution.
