export const REPOSITORY_URL = "https://github.com/AymanAhsan/CodeRelay";
export const UPSTREAM_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";
// Kept current by .github/workflows/desktop-latest.yml on every push to main.
const LATEST_RELEASE_URL = `${REPOSITORY_URL}/releases/download/main-latest`;
export const WINDOWS_INSTALLER_URL = `${LATEST_RELEASE_URL}/CodeRelay-windows-x64.exe`;
export const MAC_ARM64_INSTALLER_URL = `${LATEST_RELEASE_URL}/CodeRelay-macos-arm64.dmg`;
export const MAC_X64_INSTALLER_URL = `${LATEST_RELEASE_URL}/CodeRelay-macos-x64.dmg`;
export const LINUX_X64_INSTALLER_URL = `${LATEST_RELEASE_URL}/CodeRelay-linux-x86_64.AppImage`;
export const LINUX_ARM64_INSTALLER_URL = `${LATEST_RELEASE_URL}/CodeRelay-linux-arm64.AppImage`;
export const SITE_URL = "https://site-olive-two-79.vercel.app";
// GitHub regenerates this archive from the tip of main on every request.
export const SOURCE_ZIP_URL = `${REPOSITORY_URL}/archive/refs/heads/main.zip`;
export const QUICK_START_URL = `${REPOSITORY_URL}#quick-start`;
export const TEAM_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/user/team-hub.md`;
export const HOSTING_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/operations/team-hub.md`;
