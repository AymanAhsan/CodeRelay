# CodeRelay

CodeRelay is a GUI for coding agents, built on T3 Code. It includes web, Electron desktop, and mobile clients, plus a Team hub for handing work between teammates and their agents.

This is an independently maintained repository. The application currently retains upstream T3 Code names and package identifiers. Upstream installers and published T3 Code releases do not install CodeRelay; run this checkout from source.

## Development

Requires Node.js 24 (see `package.json`) and Vite+ (`vp`). Install and authenticate the provider you intend to use.

### Install vp

On macOS or Linux:

```sh
curl -fsSL https://vite.plus | bash
```

On Windows, in PowerShell:

```powershell
irm https://vite.plus/ps1 | iex
```

### Run from source

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. See the [development guide](docs/operations/development.md), [mobile setup](apps/mobile/README.md), and [Team hub guide](docs/user/team-hub.md) for details.

## License and attribution

CodeRelay is built on [T3 Code](https://github.com/pingdotgg/t3code). The original MIT license and copyright notice are preserved in [LICENSE](LICENSE). See [NOTICE.md](NOTICE.md) for attribution.
