# Approved v1 smoke review (manual; at most six inference calls)

This is the prepared command for Isaac's approved smoke run, not evidence that it
has run. Use only synthetic code under this repo's ignored `.quorum/` directory.
Existing CLI logins are required. No probes are included. The six-call budget
includes confirmations, proposals, fallback attempts and Codex retries. Never
rerun automatically after exhaustion.

From this repo in PowerShell, prepare a separate synthetic Git repo (no branch
change or commit in Quorum's checkout):

```powershell
pnpm.cmd build
$quorumRoot = (Get-Location).Path
$sample = Join-Path $quorumRoot '.quorum/smoke-m6'
if (Test-Path -LiteralPath $sample) { throw 'Use a fresh smoke directory.' }
New-Item -ItemType Directory -Path $sample | Out-Null
Copy-Item -Path 'tests/fixtures/repro-repo/*' -Destination $sample
Set-Content -LiteralPath "$sample/.gitignore" -Value '.quorum/' -Encoding utf8
Set-Content -LiteralPath "$sample/spec.md" -Value '# Acceptance criteria', '- [ ] A zero divisor throws before division.' -Encoding utf8
Set-Content -LiteralPath "$sample/divide.js" -Value 'export function divide(a, b) { if (b === 0) throw new Error("zero divisor"); return a / b; }' -Encoding utf8
@'
{
  "base": "smoke-base", "checks": [],
  "tiers": {
    "triage": ["agy:gemini-3.8-flash-medium"],
    "review": ["agy:gemini-4-argon-high"],
    "confirm": ["codex"], "visual": []
  },
  "budget": { "maxCalls": 6, "maxMinutes": 10, "quotaFloorPercent": 10 },
  "reproduce": {
    "isolation": "container", "timeoutSeconds": 120,
    "testGlobs": ["*.test.js"],
    "testCommand": ["pnpm", "vitest", "run", "--reporter=json"]
  }
}
'@ | Set-Content -LiteralPath "$sample/quorum.config.json" -Encoding utf8
git -C $sample init
git -C $sample add .
git -C $sample -c user.name=Synthetic -c user.email=synthetic@example.invalid -c commit.gpgsign=false commit -s -m 'Add synthetic smoke baseline'
git -C $sample branch smoke-base
Set-Content -LiteralPath "$sample/divide.js" -Value 'export function divide(a, b) { return a / b; }' -Encoding utf8
git -C $sample add divide.js
git -C $sample -c user.name=Synthetic -c user.email=synthetic@example.invalid -c commit.gpgsign=false commit -s -m 'Introduce synthetic division regression'
```

The exact review command (this spends provider quota):

```powershell
Push-Location $sample
try {
  node "$quorumRoot/bin/quorum.js" review --mode feature --diff smoke-base...HEAD --spec spec.md --reproduce --no-checks --no-cache --out .quorum/smoke.md --sarif .quorum/smoke.sarif
} finally { Pop-Location }
```

Inspect the report, calls/ledger, reproduction status and worktree cleanup. A
BLOCKER is not guaranteed: a reviewer can classify this small defect IMPORTANT.
Preparation downloads dependencies; the test runs offline. Without a runtime it
stays unproven; decline host fallback prompts to keep this smoke container-only.
Do not use `--allow-unproven` to hide that result.

The separate slow escape test requires `QUORUM_CONTAINER_TESTS=1` and a responding
Docker daemon. It spends no model quota and is not part of this smoke run.
Neither command was run during M6 implementation.
