# Security policy

## Supported versions

Until 1.0, only the latest published minor version receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting instead: on the repository page, go to **Security → Report a vulnerability**. Include the Quorum version, your OS, the command you ran, and the smallest reproduction you can share. Do not include real secrets or private code; synthetic examples are enough.

You should get an acknowledgement within 7 days. Please allow up to 90 days for a fix before you disclose.

## What counts

Quorum runs other tools on your machine, so these are in scope:
- Quorum writing outside `.quorum/` or the disposable worktrees it creates.
- A reviewed change, or configuration taken from it, getting to choose which commands run without `--trust-head-config`.
- The reproduction container reaching the network or the host filesystem.
- Secrets or personal data leaking into reports, logs, cache files or prompts beyond what the diff already contains.
- Model output being treated as instructions, or bypassing the verifier.

Out of scope:
- Findings that the AI providers themselves got wrong; please report those as normal issues.
- Vulnerabilities in the provider CLIs (Antigravity, Codex, Claude Code). Report those to their vendors.
