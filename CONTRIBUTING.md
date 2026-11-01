# Contributing

Thanks for your interest in CodeRelay. Bug reports, fixes, and ideas are welcome.

## Developer setup

See the [development runbook](docs/operations/development.md#first-checkout) for the initial checkout,
development commands, tests, and platform-specific desktop packaging prerequisites.

To try the team handoff locally with two teammates, run `vp run dev:team`.

## Before you start

- **Bugs:** open an [issue](https://github.com/AymanAhsan/CodeRelay/issues) with steps to reproduce,
  what you expected, and what happened. Search existing issues first.
- **Small, obvious fixes:** open a pull request directly.
- **Features or behavior changes:** open an issue first so we can agree on the direction before you
  build it. This saves you from writing code that may not fit the project.

CodeRelay is maintained by one person, so reviews can take time.

## Pull requests

- Keep each PR to one problem. Split unrelated fixes into separate PRs.
- Use a conventional commit title in plain language, such as
  `fix(web): new threads no longer spike CPU`.
- In the description, explain the problem, how you fixed it, and how you checked it. Give the test
  commands you ran or the manual steps you took, and say what you could not check.
- Add focused tests for backend behavior changes. Run the tests for the files you touched with
  `vp test run <files>`; CI runs the full suite.
- Include before/after screenshots for UI changes, and a short recording when motion or timing
  matters. Attach them to the PR; do not commit them.
- Follow the [documentation rules](AGENTS.md#documentation).

## Upstream changes

CodeRelay is built on [T3 Code](https://github.com/pingdotgg/t3code). A fix for code CodeRelay
shares with T3 Code may also be useful upstream; consider sending it to them too.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
