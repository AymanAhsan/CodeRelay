#!/usr/bin/env bash
# CodeRelay installer for macOS and Linux:
#
#   curl -fsSL https://site-olive-two-79.vercel.app/install.sh | bash
#
# Clones (or updates) CodeRelay into $CODERELAY_DIR (default ~/CodeRelay),
# installs Vite+ (vp) if it is missing, and installs dependencies.
# Requires Git and Node.js 24 or later.
#
# Everything runs inside main(), so a partially downloaded script does nothing.
set -euo pipefail

main() {
  local repo_url="https://github.com/AymanAhsan/CodeRelay.git"
  local dir="${CODERELAY_DIR:-$HOME/CodeRelay}"

  say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
  fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

  command -v git >/dev/null 2>&1 || fail "Git is required. Install it from https://git-scm.com and run this again."
  command -v node >/dev/null 2>&1 || fail "Node.js 24 or later is required. Install it from https://nodejs.org and run this again."
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 24 ] || fail "Node.js 24 or later is required (found $(node -v)). Update it from https://nodejs.org and run this again."

  if ! command -v vp >/dev/null 2>&1; then
    say "Installing Vite+ (vp)"
    # Pin the install location so we know where vp lands, and download to a
    # file so a failed download cannot run as an empty script.
    export VP_BIN_DIR="$HOME/.local/share/vite-plus/bin"
    export VP_DATA_DIR="$HOME/.local/share/vite-plus"
    export VP_CACHE_DIR="$HOME/.cache/vite-plus"
    local vp_installer
    vp_installer="$(mktemp)"
    curl -fsSL https://vite.plus -o "$vp_installer"
    VP_NODE_MANAGER=no bash "$vp_installer"
    rm -f "$vp_installer"
    export PATH="$VP_BIN_DIR:$PATH"
    command -v vp >/dev/null 2>&1 || fail "Vite+ installed but vp is not on PATH. Open a new terminal and run this again."
  fi

  if [ -d "$dir/.git" ]; then
    say "Updating CodeRelay in $dir"
    git -C "$dir" pull --ff-only
  elif [ -e "$dir" ]; then
    fail "$dir already exists and is not a CodeRelay checkout. Set CODERELAY_DIR to install somewhere else."
  else
    say "Downloading CodeRelay into $dir"
    git clone --depth 1 "$repo_url" "$dir"
  fi

  say "Installing dependencies"
  (cd "$dir" && vp i)

  printf '\n\033[32mCodeRelay is installed.\033[0m Try the Alice and Bob demo:\n\n'
  printf '  cd %s\n  vp run dev:team\n\n' "$dir"
  printf 'Open a new terminal first if vp was just installed.\n'
}

main "$@"
