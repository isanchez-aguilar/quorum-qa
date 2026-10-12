# Quorum

**A quorum of AI reviewers for your code. It reports only verified findings.**

> Status: planning. Nothing is implemented yet. Start with [docs/PLAN.md](docs/PLAN.md).

Quorum runs several AI coding CLIs over a change: Codex, Claude Code, Antigravity (with its Gemini, Claude and GPT-OSS models), Jules for reproducing blockers in the cloud, and a local model. Each one is used for what it is best at, under your own logins.

- **Deterministic checks first.** Lint, typecheck and a11y run before any model, and cost nothing.
- **Cheap models triage first.** Expensive models only confirm what needs it.
- **Independent means a different model family.** Claude through two CLIs still counts as one opinion.
- **Every finding is verified against the code.** A finding whose file, line or quote isn't in the code is dropped. A blocker comes with a failing test that proves it.
- **Each finding is labelled** as **introduced**, **pre-existing** or **improvement**.
- **Review modes:** new features, redesigns (feature parity and visual review), refactors, bug hunts, contracts and runtime.

## Docs

- [Plan](docs/PLAN.md): the problem, architecture, modes, token strategy and v1 scope
- [Roadmap](docs/ROADMAP.md)
- [Lessons from real use](docs/LESSONS.md)
- [Naming](docs/NAMING.md)

## Your logins, not ours

Quorum calls each vendor's own CLI, signed in with your own subscription. It never stores, requests or proxies API keys.

## License

[Apache-2.0](LICENSE). "Quorum" as a project name is reserved; see [TRADEMARKS.md](TRADEMARKS.md). Contributions are accepted under the DCO; see [CONTRIBUTING.md](CONTRIBUTING.md).
