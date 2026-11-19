# Self-host a team hub

The hub is a small server with a SQLite database. Run it on any machine your teammates can reach, such as the PC you already use. It must stay on, with Docker running, for teammates to see each other. If it is offline, local agent work continues and team updates resume when it reconnects.

## Quick start for self-hosted teams

1. Start Docker and sign in to Tailscale on the computer running CodeRelay.
2. In CodeRelay, select **Set up a team**. Choose public Funnel for teammates who do not use Tailscale or private sharing for teammates on the same tailnet.
3. If a hub is not running, select **Start hub** and wait for the image to download and the hub to start. Share the hub when prompted. Public Funnel requires your confirmation.
4. Enter your team name, your display name, and a Git remote that teammates can clone. Create the team and generate an invite.
5. On a teammate's computer, use **Join with invite** and paste the link. Open an existing checkout or select **Clone & open**.

If you leave setup, use **Continue setup** when you return. CodeRelay saves hosting choices in this app and checks Docker and Tailscale again. If someone else already initialized the hub, ask the existing team's admin for an invite. Discarding the draft leaves the container and volume intact.

If CodeRelay closes or loses its connection after you submit **Create team**, it tries the submitted setup again on startup using its private credential store. If the hub is still unavailable, use **Retry team setup** once it is back online. Updated hubs return the original admin membership if the first request already created it. A hub that predates this feature cannot recover a bootstrap that consumed the setup token without returning the membership.

## Manual Docker deployment

If the hub runs on a separate machine, or your team uses a LAN address or an existing proxy, run it manually. Substitute the release version of your CodeRelay server and the address teammates can reach.

```bash
docker run -d -p 8080:8080 -v hub-data:/data \
  -e HUB_PUBLIC_URL="http://192.168.1.20:8080" \
  "ghcr.io/aymanahsan/coderelay-hub:${HUB_VERSION:?Set this to your CodeRelay release version}"
```

Development and nightly builds use `edge`. To build locally, run `docker build -f apps/hub/Dockerfile -t t3-team-hub .` from a checkout and use `t3-team-hub` in your run command.

State lives in `/data/hub.sqlite`. Keep `/data` on a persistent volume: recreating the container without it creates an empty hub, and every member's credential stops working. Back the volume up, or use SQLite's backup API while the hub is running.

## Publishing images

The CodeRelay repository's `publish-hub-image.yml` publishes Linux amd64 and arm64 images to `ghcr.io/aymanahsan/coderelay-hub`. Pushes to `main` publish `edge`; releases publish their version and stable releases also publish `latest`. Each build includes a `sha-<short>` tag. The release workflow calls the publisher directly because releases created with `GITHUB_TOKEN` do not trigger another workflow.

For the first publish, run **Publish hub image** manually on `main`. Then open the GitHub package settings and change its visibility to **Public** so users can pull without signing in. Check `docker pull ghcr.io/aymanahsan/coderelay-hub:edge` on Windows with Linux containers and an arm64 Mac.

## The hub address must be reachable by teammates

Each teammate's local CodeRelay server connects to the hub, so the address has to work from their machine. `localhost` only works on the machine running the container.

Guided setup saves the confirmed share address for invitations. For a manual hub, `HUB_PUBLIC_URL` determines the address printed in the setup link and supplies a default for the team's invite address. In **Set up a team → Another address**, paste the link and enter an address teammates can reach if the printed address is local or outdated.

For an existing team, an admin can open **Invite address → Edit address** to save a new address for that team's invitations. This also fixes teams whose original connection was through localhost. If the edit option is missing, update the hub. Members keep their saved connection and credentials. Already issued invite links keep their old address and tokens remain valid until used, expired, or revoked. When retiring the old address, revoke outstanding invites and issue new ones. Verify the new address from a teammate's machine before sharing it.

## Choosing an address

| Situation                                                | Use                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teammates on the same network                            | The host's LAN IP, e.g. `http://192.168.1.20:8080`. No extra software.                                                                                   |
| Teammates anywhere, no cost, nothing for them to install | [Tailscale Funnel](#tailscale-funnel)                                                                                                                    |
| Teammates anywhere, hub kept off the public internet     | A Tailscale tailnet (or ZeroTier, WireGuard). Every teammate installs the client and joins the same network, then you use the host's private name or IP. |
| A short demo                                             | `cloudflared tunnel --url http://localhost:8080`. The URL changes on every restart, which breaks saved addresses and invites.                            |

### Local network

Use the host's LAN IP and the published Docker port. Allow inbound traffic to that port through the host firewall. Every teammate must be on a network that can reach the host.

### Private Tailscale networking

Make sure teammates can access the same tailnet and its access policy permits their connections. Use the private Tailscale name or IP and test the address from a teammate's computer before sharing invites.

### Tailscale Funnel

Funnel gives the host a stable public HTTPS address, so teammates install nothing.

1. Install Tailscale on the host and sign in. Enable HTTPS and Funnel for your tailnet in the Tailscale admin console.
2. Find the host's address, which looks like `https://my-pc.<tailnet>.ts.net`.
3. Start the hub with that address, then expose it:

   ```bash
   docker run -d -p 8080:8080 -v hub-data:/data \
     -e HUB_PUBLIC_URL="https://my-pc.<tailnet>.ts.net" \
     "ghcr.io/aymanahsan/coderelay-hub:${HUB_VERSION:?Set this to your CodeRelay release version}"
   tailscale funnel 8080
   ```

Funnel makes the hub reachable from the public internet. Access is controlled by single-use invites and per-member credentials, not by the network. Tailscale's client is open source but its coordination service is not; [Headscale](https://github.com/juanfont/headscale) is an open-source replacement if you need one.

## First team

For a manually deployed hub, get the one-time setup link from the container log and paste it under **Set up a team → Another address**. Completing setup consumes the token, so the hub prints no setup link on later starts.

Invites expire after 24 hours and admins can revoke them from the Team hub panel.

### Verify a handoff between networks

1. Start and share the hub on the first computer. From a second computer on a separate network, join with a fresh invite and open or clone the team's Git repository.
2. From the first computer, propose a task assigned to the second teammate using a contract committed and pushed to the shared remote.
3. On the second computer, confirm that the task displays the expected commit, then accept it. In the accepted thread, complete the work, push the branch, and report completion using `team_complete_task`.
4. On the first computer, confirm that the task reports completion with the summary, branch, and full commit. From each computer, use **Check connection** if updates stop arriving.

## Protocol

The hub requires protocol version 8 for WebSocket connections and responds with HTTP 426 when the client uses a different version. Version 8 added repository access status to member snapshots. The advertised invite address is optional, so clients and hubs on version 8 can connect whether or not they support editing it. On startup, the hub creates a separate table for invite addresses in existing databases.

## Local development with Alice and Bob

Run these commands from the CodeRelay checkout after [installing its dependencies](./development.md#first-checkout). Node 24 and Git must be available. The selected project must have a Git `origin` remote, which identifies the team's repository. Docker is not needed for this local launcher.

Start a local hub and two web/server sessions using this checkout as the project:

```sh
vp run dev:team
```

Alice is the team admin and Bob is a member; both join automatically and get a project and initial thread. Open each session's labeled pairing URL printed in the terminal. The launcher does not open browsers. Authenticate any provider you want to test before starting agent work.

### Test another repository without building the app

Pass the directory where Alice and Bob should work. The app code still runs from the CodeRelay checkout, so you can test local app changes against a different project without compiling or installing CodeRelay.

```sh
vp run dev:team --project-dir ../notes-api
```

Absolute paths work too. Quote paths containing spaces. For example, in PowerShell:

```powershell
vp run dev:team --project-dir "C:\Users\Your Name\notes-api"
```

Relative paths resolve from the shell's current directory. Both sessions share the selected project files, so agent edits affect the same files.

### Preview, ports, and stopping

Preview the selected project, Git origin, hub address, and state directory without starting processes or creating demo state:

```sh
vp run dev:team --project-dir ../notes-api --dry-run
```

If port 8080 is occupied, choose another hub port:

```sh
vp run dev:team --project-dir ../notes-api --hub-port 18080
```

Alice and Bob's server and web ports move automatically when occupied. Read their actual addresses from the startup output. Press Ctrl+C in the launcher terminal to stop the hub and both sessions. Run `vp run dev:team --help` for the available options.

### Saved sessions and restart errors

State persists under `.t3/team-demo`, with separate Alice and Bob settings, credentials, and databases. Explicit `--project-dir` targets use separate state under `.t3/team-demo/projects`, keyed by directory and Git origin; returning to the same target resumes its sessions. Omitting the option keeps using the original demo state. Moving the target directory or changing its Git origin selects fresh state.

If startup reports `Saved Alice membership belongs to a different team/repository.`, the saved team's repository differs from the selected project's Git origin. Restart with an explicit `--project-dir` for the intended repository to use its separate state. This also works with `--project-dir .` when testing the CodeRelay checkout itself. Existing demo state is preserved.

The launcher binds locally and does not change Tailscale configuration. If it was forcibly killed, confirm its processes have stopped and remove only `launcher.lock` from the state directory printed in the error before restarting.

### Check launcher changes

Run the focused tests, lint, and hub typecheck from the CodeRelay checkout:

```sh
vp test run apps/hub/src/dev-team.test.ts
vp lint apps/hub/src/dev-team.ts apps/hub/src/dev-team.test.ts
vp run --filter @t3tools/hub typecheck
```

The tests cover repository isolation, saved membership reuse, and dry-run selection. Use a dry run against your target repository to check its actual path and origin before starting the sessions.
