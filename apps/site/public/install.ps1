# CodeRelay installer for Windows (PowerShell):
#
#   irm https://site-olive-two-79.vercel.app/install.ps1 | iex
#
# Downloads the latest Windows x64 installer built from main and runs it.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is far slower with the progress bar.

  if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'CodeRelay needs 64-bit Windows 10 or later.'
  }

  $url = 'https://github.com/AymanAhsan/CodeRelay/releases/download/main-latest/CodeRelay-windows-x64.exe'
  $installer = Join-Path $env:TEMP 'CodeRelay-windows-x64.exe'

  Write-Host '==> Downloading CodeRelay'
  Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing

  # The installer is unsigned, so Windows may ask you to confirm before it runs.
  Write-Host '==> Running the installer'
  Start-Process -FilePath $installer -Wait
  Remove-Item $installer -Force -ErrorAction SilentlyContinue

  Write-Host 'CodeRelay is installed. Launch it from the Start menu.'
}
