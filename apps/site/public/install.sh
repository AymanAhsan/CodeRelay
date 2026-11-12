#!/usr/bin/env bash
# CodeRelay installer for macOS and Linux:
#
#   curl -fsSL https://site-olive-two-79.vercel.app/install.sh | bash
#
# Installs the latest desktop app built from main:
#   macOS: CodeRelay into /Applications (or ~/Applications if that is not writable)
#   Linux: the AppImage into ~/.local/share/coderelay, a `coderelay` command in
#          ~/.local/bin, and an app-menu entry
#
# Pass --source to clone CodeRelay and install its dependencies instead, for the
# local Alice and Bob demo (needs Git and Node.js 24):
#
#   curl -fsSL https://site-olive-two-79.vercel.app/install.sh | bash -s -- --source
#
# Everything runs inside main(), so a partially downloaded script does nothing.
set -euo pipefail

RELEASE_URL="https://github.com/AymanAhsan/CodeRelay/releases/download/main-latest"
REPO_URL="https://github.com/AymanAhsan/CodeRelay.git"

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$1" >&2; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

download() {
  say "Downloading $1"
  curl -fL --progress-bar "$RELEASE_URL/$1" -o "$2" || fail "Could not download $RELEASE_URL/$1"
}

install_macos() {
  local arch asset tmp mount app dest_dir dest
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) fail "Unsupported Mac architecture: $(uname -m)" ;;
  esac
  asset="CodeRelay-macos-$arch.dmg"
  tmp="$(mktemp -d)"
  mount="$tmp/mount"
  trap 'hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

  download "$asset" "$tmp/$asset"
  mkdir -p "$mount"
  hdiutil attach "$tmp/$asset" -nobrowse -readonly -quiet -mountpoint "$mount"
  app="$(find "$mount" -maxdepth 1 -name '*.app' -print -quit)"
  [ -n "$app" ] || fail "No app found in $asset"

  dest_dir=/Applications
  [ -w "$dest_dir" ] || { dest_dir="$HOME/Applications"; mkdir -p "$dest_dir"; }
  dest="$dest_dir/$(basename "$app")"
  say "Installing $(basename "$app") into $dest_dir"
  rm -rf "$dest"
  ditto "$app" "$dest"
  hdiutil detach "$mount" -quiet

  # The build is unsigned. curl does not quarantine downloads, but clear the
  # flag in case it was set, and give Apple silicon the ad-hoc signature it
  # requires if the bundle lacks a valid one.
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  if ! codesign --verify --deep "$dest" >/dev/null 2>&1; then
    codesign --force --deep --sign - "$dest" >/dev/null 2>&1 || warn "Could not ad-hoc sign $dest"
  fi

  printf '\n\033[32mCodeRelay is installed.\033[0m Open it from %s or Launchpad.\n' "$dest_dir"
}

install_linux() {
  local arch asset data_dir bin_dir apps_dir appimage
  case "$(uname -m)" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "Unsupported Linux architecture: $(uname -m)" ;;
  esac
  asset="CodeRelay-linux-$arch.AppImage"
  data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/coderelay"
  bin_dir="$HOME/.local/bin"
  apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  appimage="$data_dir/CodeRelay.AppImage"
  mkdir -p "$data_dir" "$bin_dir" "$apps_dir"

  # Download beside the old copy and swap, so a failed download keeps it.
  download "$asset" "$appimage.download"
  chmod +x "$appimage.download"
  mv -f "$appimage.download" "$appimage"
  ln -sf "$appimage" "$bin_dir/coderelay"

  cat >"$apps_dir/coderelay.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=CodeRelay
Comment=Hand off work between teammates' coding agents
Exec="$appimage" %U
Terminal=false
Categories=Development;
EOF

  printf '\n\033[32mCodeRelay is installed.\033[0m Open it from your app menu or run: coderelay\n'
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf 'Add %s to your PATH to use the coderelay command.\n' "$bin_dir" ;;
  esac
  # AppImages need FUSE 2, which recent Ubuntu and Debian releases leave out.
  if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    warn "AppImages need FUSE 2 (libfuse.so.2). On Ubuntu or Debian: sudo apt install libfuse2t64 (or libfuse2 on older releases)."
  fi
}

install_source() {
  local dir="${CODERELAY_DIR:-$HOME/CodeRelay}"
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
    git clone --depth 1 "$REPO_URL" "$dir"
  fi

  say "Installing dependencies"
  (cd "$dir" && vp i)

  printf '\n\033[32mCodeRelay is installed.\033[0m Try the Alice and Bob demo:\n\n'
  printf '  cd %s\n  vp run dev:team\n\n' "$dir"
  printf 'Open a new terminal first if vp was just installed.\n'
}

main() {
  case "${1:-}" in
    --source) install_source; return ;;
    "") ;;
    *) fail "Unknown option: $1 (the only option is --source)" ;;
  esac
  case "$(uname -s)" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *) fail "This installer supports macOS and Linux. On Windows, run in PowerShell: irm https://site-olive-two-79.vercel.app/install.ps1 | iex" ;;
  esac
}

main "$@"
