import {
  teamHubDockerRunArgs,
  type TeamHubExposure,
  type TeamHubNetworkBlockedReason,
  type TeamHubNetworkState,
  type TeamHubReachability,
  type TeamHubStartInput,
  type TeamHubStartResult,
} from "@t3tools/contracts/teamHub";

export const DEFAULT_HUB_PORT = 8080;
export const DEFAULT_SHARE_PORT = 443;

// Funnel only publishes on these ports; Serve accepts them too, so one list
// serves both choices.
const SHARE_PORTS = [443, 8443, 10000] as const;

const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
const TAILSCALE_DNS_SETTINGS_URL = "https://login.tailscale.com/admin/dns";
const TAILSCALE_FUNNEL_DOCS_URL = "https://tailscale.com/kb/1223/funnel";
const DOCKER_INSTALL_URL = "https://docs.docker.com/get-started/get-docker/";

export type ReachAction =
  | { readonly kind: "link"; readonly label: string; readonly href: string }
  | { readonly kind: "retry"; readonly label: string }
  | { readonly kind: "restart"; readonly label: string }
  | { readonly kind: "share"; readonly label: string }
  | { readonly kind: "use-port"; readonly label: string; readonly servePort: number }
  | { readonly kind: "copy"; readonly label: string; readonly value: string };

/** What to tell the person, and the one or two things they can do about it. */
export interface ReachPresentation {
  readonly tone: "info" | "success" | "warning" | "error";
  readonly title: string;
  readonly detail: string;
  readonly actions: ReadonlyArray<ReachAction>;
}

export interface ReachContext {
  readonly exposure: TeamHubExposure;
  readonly hubPort: number;
  readonly servePort: number;
  /** The container name the admin picked for a hub the app starts. */
  readonly containerName: string;
  readonly imageTag: string;
}

/** The terminal command that does what the Share button does, for when it cannot. */
export function shareCommand(context: Omit<ReachContext, "containerName" | "imageTag">): string {
  const subcommand = context.exposure === "public" ? "funnel" : "serve";
  return `tailscale ${subcommand} --bg --https=${String(context.servePort)} http://127.0.0.1:${String(context.hubPort)}`;
}

/** The command the Start hub button runs, for a person who would rather run it themselves. */
export function hubStartCommand(input: TeamHubStartInput, tag: string): string {
  // Container names and ports never need quoting.
  return `docker ${teamHubDockerRunArgs(input, tag).join(" ")}`;
}

/** Docker's names: a letter or digit, then letters, digits, `_`, `.` or `-`. */
export function isValidContainerName(name: string): boolean {
  return name.length <= 64 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}

/**
 * What to say when Docker refused to start the hub. Docker's own message is shown
 * beside it. `restarting` is for a failed restart of an existing container, which
 * keeps the port it was created with, so the port the person typed is not the cause.
 */
export function presentStartFailure(
  failure: Extract<TeamHubStartResult, { status: "failed" }>,
  input: TeamHubStartInput,
  restarting = false,
): ReachPresentation {
  const base = { tone: "error" as const };
  if (restarting && failure.reason === "port-in-use") {
    return {
      ...base,
      title: `${input.name} can't start because its port is already in use.`,
      detail:
        "Something else on this computer is using the port this hub was created with. Free it, or pick another container name to start a new hub.",
      actions: [],
    };
  }
  switch (failure.reason) {
    case "docker-not-installed":
      return {
        ...base,
        title: "Docker isn't installed on this computer.",
        detail: "Install Docker and start it, then try again.",
        actions: [{ kind: "link", label: "Get Docker", href: DOCKER_INSTALL_URL }],
      };
    case "docker-not-running":
      return {
        ...base,
        title: "Docker isn't running.",
        detail: "Open Docker Desktop (or start the Docker service), then try again.",
        actions: [],
      };
    case "image-missing":
      return {
        ...base,
        title: "The hub image could not be downloaded.",
        detail:
          "Check your internet connection and try again. The image may not be published or public yet.",
        actions: [],
      };
    case "name-in-use":
      return {
        ...base,
        title: `A container named ${input.name} already exists.`,
        detail: "Pick another name, or start that container again if it is your hub.",
        actions: [{ kind: "restart", label: "Restart hub" }],
      };
    case "port-in-use":
      return {
        ...base,
        title: `Port ${String(input.hubPort)} is already in use on this computer.`,
        detail: "Pick another hub port and try again.",
        actions: [],
      };
    case "timed-out":
      return {
        ...base,
        title: "Docker didn't answer in time.",
        detail:
          "Check Docker and your internet connection. The first download can take several minutes.",
        actions: [],
      };
    case "command-failed":
      return {
        ...base,
        title: "Docker couldn't start the hub.",
        detail: "Docker's message is below.",
        actions: [],
      };
  }
}

/** The next port to offer when this one is taken, cycling through the allowed ones. */
export function nextSharePort(current: number): number {
  const index = SHARE_PORTS.findIndex((port) => port === current);
  return SHARE_PORTS[(index + 1) % SHARE_PORTS.length] ?? DEFAULT_SHARE_PORT;
}

/** The port a hub address is served on. */
export function servePortOfUrl(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port.length > 0) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === "http:" ? 80 : DEFAULT_SHARE_PORT;
  } catch {
    return DEFAULT_SHARE_PORT;
  }
}

/**
 * The address a hub is shared on, from what a person typed or pasted, or null
 * when it is not an http(s) address. Paths and query strings are dropped: the
 * hub lives at the origin.
 */
export function normalizeHubAddress(input: string): string | null {
  const text = input.trim();
  if (text.length === 0) return null;
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Only these names can be a Tailscale share, so only these are worth asking Tailscale about. */
export function isTailscaleShareUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".ts.net");
  } catch {
    return false;
  }
}

const RETRY: ReachAction = { kind: "retry", label: "Check again" };

function blocked(
  reason: TeamHubNetworkBlockedReason,
): Pick<ReachPresentation, "title" | "detail" | "actions"> {
  switch (reason) {
    case "not-installed":
      return {
        title: "Tailscale isn't installed on this computer.",
        detail: "Install it and sign in, then check again.",
        actions: [
          { kind: "link", label: "Download Tailscale", href: TAILSCALE_DOWNLOAD_URL },
          RETRY,
        ],
      };
    case "daemon-not-running":
      return {
        title: "Tailscale isn't running.",
        detail: "Open the Tailscale app (or start the tailscaled service), then check again.",
        actions: [RETRY],
      };
    case "signed-out":
      return {
        title: "Tailscale is signed out.",
        detail: "Sign in from the Tailscale app, then check again.",
        actions: [RETRY],
      };
    case "stopped":
      return {
        title: "Tailscale is turned off.",
        detail: "Turn it on from the Tailscale app, then check again.",
        actions: [RETRY],
      };
    case "awaiting-approval":
      return {
        title: "This device is waiting for approval.",
        detail: "A tailnet admin needs to approve it in the Tailscale admin console.",
        actions: [RETRY],
      };
    case "https-disabled":
      return {
        title: "HTTPS certificates are off for your tailnet.",
        detail:
          "Turn on MagicDNS and HTTPS certificates in the Tailscale admin console. Your machine names will then appear in public certificate logs.",
        actions: [
          { kind: "link", label: "Open Tailscale DNS settings", href: TAILSCALE_DNS_SETTINGS_URL },
          RETRY,
        ],
      };
    case "funnel-not-allowed":
      return {
        title: "This device can't use Funnel yet.",
        detail:
          "A tailnet admin has to allow Funnel for it in the tailnet policy. You can share on your tailnet only instead.",
        actions: [
          { kind: "link", label: "How to enable Funnel", href: TAILSCALE_FUNNEL_DOCS_URL },
          RETRY,
        ],
      };
  }
}

const exposureDetail = (exposure: TeamHubExposure): string =>
  exposure === "public"
    ? "Anyone on the internet can reach the address, but joining or reading team data still needs an invite or a member credential. Teammates install nothing."
    : "Only devices on your tailnet can reach the address. Teammates need Tailscale and access to your tailnet.";

/** What the admin sees while sharing a hub that runs on this computer. */
export function presentNetworkState(
  state: TeamHubNetworkState,
  context: ReachContext,
): ReachPresentation {
  switch (state.status) {
    case "blocked":
      return { tone: "warning", ...blocked(state.reason) };
    case "no-hub":
      return {
        tone: "info",
        title: `No hub found on port ${String(state.hubPort)}.`,
        detail:
          "Start one here with Docker, or run the command yourself and check again. The hub runs as its own container and keeps running after you close the app.",
        actions: [
          {
            kind: "copy",
            label: "Copy command",
            value: hubStartCommand(
              { hubPort: state.hubPort, name: context.containerName },
              context.imageTag,
            ),
          },
          RETRY,
        ],
      };
    case "ready":
      return {
        tone: context.exposure === "public" ? "warning" : "info",
        title:
          context.exposure === "public"
            ? "Ready to share publicly."
            : "Ready to share on your tailnet.",
        detail: exposureDetail(context.exposure),
        actions: [
          {
            kind: "share",
            label: context.exposure === "public" ? "Share publicly" : "Share on my tailnet",
          },
        ],
      };
    case "exposed":
      return state.reachable
        ? {
            tone: "success",
            title: state.exposure === "public" ? "Shared publicly." : "Shared on your tailnet.",
            detail: exposureDetail(state.exposure),
            actions: [],
          }
        : {
            tone: "info",
            title: "Preparing the HTTPS certificate…",
            detail: "Tailscale issues it on first use, which can take up to a minute.",
            actions: [RETRY],
          };
    case "conflict": {
      const alternative = nextSharePort(state.servePort);
      return {
        tone: "warning",
        title: `Port ${String(state.servePort)} is already in use on this machine's Tailscale name.`,
        detail: "Something else is shared there, and sharing the hub would replace it.",
        actions: [
          { kind: "use-port", label: `Use port ${String(alternative)}`, servePort: alternative },
        ],
      };
    }
    case "failed": {
      const command = shareCommand(context);
      const copy: ReachAction = { kind: "copy", label: "Copy command", value: command };
      switch (state.reason) {
        case "permission-denied":
          return {
            tone: "error",
            title: "Tailscale refused the change.",
            detail:
              "This user isn't allowed to manage Tailscale. On Linux, run `sudo tailscale set --operator=$USER` once, or run the share command yourself.",
            actions: [copy, RETRY],
          };
        case "timed-out":
          return {
            tone: "error",
            title: "Tailscale didn't answer in time.",
            detail:
              "It may be waiting for you to approve something. Run the command in a terminal to see its prompt, then check again.",
            actions: [copy, RETRY],
          };
        case "command-failed":
          return {
            tone: "error",
            title: "Tailscale couldn't apply the change.",
            detail: "Run the command in a terminal to see why, then check again.",
            actions: [copy, RETRY],
          };
      }
    }
  }
}

/** What a teammate sees after pasting an invite, or when the hub stops answering. */
export function presentReachability(reachability: TeamHubReachability): ReachPresentation {
  if (reachability.reachable) {
    return { tone: "success", title: "The hub is reachable.", detail: "", actions: [] };
  }
  if (reachability.blocked !== null) {
    const reason = blocked(reachability.blocked);
    return {
      tone: "warning",
      title: `This hub is on Tailscale. ${reason.title}`,
      detail: reason.detail,
      actions: reason.actions,
    };
  }
  if (reachability.tailnetHost) {
    return {
      tone: "info",
      title: "Tailscale is on, but this computer can't reach the hub.",
      detail:
        "If the hub is private, ask the admin to add you to their tailnet. If it's public, ask them to check that sharing is still on.",
      actions: [RETRY],
    };
  }
  return {
    tone: "info",
    title: "This computer can't reach the hub.",
    detail: "Check the address and your network connection.",
    actions: [RETRY],
  };
}
