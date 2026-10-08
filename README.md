# Gatehouse

Agentic control plane: agents work inside the walls, humans and trusted code hold the keys.

Design: [`research/gatehouse-design/`](research/gatehouse-design/README.md). Delivery order: [08 — host mode first, sandbox later](research/gatehouse-design/08-delivery-host-then-sandbox.md).

## Status

| Milestone | State |
|---|---|
| A0 Skeleton: layered config, hash-chained event store, host fingerprint, CLI | done |
| A1 Repo onboarding: mirror, detect, env spec, verify L1/L2 with test baseline, GATE_ENV | done |
| A2 Executors: Copilot CLI (BYOK via gateway) + Codex CLI (subscription), isolated homes, instruction-file masking | done |
| A3 LLM gateway: run tokens, tier→model routing, DLP block/redact, token budget, per-call events | done |
| A4 MCP proxy: bring-your-own MCP (Jira/Confluence), manifest filtering, DLP, agent-facing HTTP endpoint | done |
| A5 PR review: T/B/V/S review dimensions, risk routing, blast radius, citations, repro evidence, critic, HTML report, declarative workflow YAML | done |
| A6 Console: dashboard, PR list + Review, job queue, runs/traces, passkey approvals, passkey-signed settings/secrets, evals | done |
| Ticket → draft PR: PBI → spec → plan → tasks (GATE_1–4) → test-first implementation → embedded review → GATE_5 | done |
| Legacy tests: coverage inventory → triage → charters → characterization tests → measured coverage delta → GATE_4 | done |
| IDE: Agent Spec compiler, slash commands for VS Code/Copilot, Codex, Claude Code, `gatehouse mcp serve` | done |
| B: sandbox cells (Docker; runc/gVisor/Kata), cache warm-up, host↔cell parity, readiness check | done (runc verified; gVisor/Kata need installing) |
| Batched-audit PR review (design 09): arms A/B/C, context packs, investigation, root-cause grouping, test-based verification, `run review-arms` comparison | built and tested with fake models; not yet measured on real PRs |

## Requirements

Node ≥ 22.13 (uses the built-in `node:sqlite`), git. Copilot CLI and/or Codex CLI for agent steps. Docker for sandbox cells. Runs on Windows natively and on Linux/WSL.

```bash
npm install
npm test
```

## Setup (once)

```bash
node bin/gatehouse.mjs doctor
node bin/gatehouse.mjs secret import-env COPILOT_PROVIDER_API_KEY --as llm.deepseek
node bin/gatehouse.mjs secret set github.pat
node bin/gatehouse.mjs agent probe
node bin/gatehouse.mjs serve                 # http://localhost:8787, keep it running
node bin/gatehouse.mjs approver enroll       # one-time code; enroll your passkey at /approvers
```

- Secrets live in the OS store (DPAPI on Windows, libsecret or a 0600 file on Linux). Gatehouse reads them itself and never puts them in an agent's environment.
- Model tiers map to providers in config (`llm.tiers`, `llm.providers`). Defaults: `tier-frontier` → `deepseek-v4-pro`, `tier-workhorse`/`tier-scale` → `deepseek-flash`; Codex uses `gpt-5.6-luna` on your ChatGPT login.
- After enrollment, settings and secrets can also be changed in the console (`/settings`); every save is confirmed with your passkey.

## The console

| Page | What it does |
|---|---|
| Dashboard | Runs waiting for your decision, the live job queue, all runs |
| Pull requests | Open PRs of every registered GitHub repo (marks "review requested" / "mine"), **Review** button |
| Start | Ticket → PR, legacy tests, branch review |
| Repositories | Add a repo, verify its environment on host or in a cell, see GATE_ENV state |
| Run | What each gate approves, approve/reject with your passkey, answer blocking questions, retry a stage with feedback, full trace |
| Evals | Every final decision becomes a labelled case (`~/.gatehouse/evals`): verdicts, evidence, tokens, agent versions |
| Settings | Config fields with the layer each value came from; write-only secrets |

Approving an intermediate gate continues the run in the queue. Approving the final gate publishes it: a PR review, or a `gatehouse/*` branch plus a draft PR. The publisher re-verifies the signature first.

## Workflows

Each workflow is declared in `registry/workflows/*.yaml` and bound to code that must match it exactly. Every agent has a neutral spec in `registry/agents/<name>/` (`agent.yaml`, `prompt.md`, output schema). A step can narrow an agent's declared tool scope but never widen it.

```bash
node bin/gatehouse.mjs repo add https://github.com/<owner>/<repo>.git
node bin/gatehouse.mjs env verify <repo>                       # L2 + GATE_ENV enables tests
node bin/gatehouse.mjs run pr-review <repo> --pr 12            # stops at GATE_5
node bin/gatehouse.mjs run branch-review <repo> --head feature/x
node bin/gatehouse.mjs run pr-review <repo> --pr 12 --arm C               # batched-audit workflow (design 09)
node bin/gatehouse.mjs run review-arms <repo> --pr 12 --arms A,B,C       # same PR through each arm, then a measured comparison
node bin/gatehouse.mjs run ticket <repo> --ticket SHOP-7 [--ticket-file t.md]
node bin/gatehouse.mjs run legacy-tests <repo> [--package com.acme] [--top 3]
node bin/gatehouse.mjs run answer <runId> --q Q1 --answer "..."
node bin/gatehouse.mjs run retry <runId> --from plan --note "use the existing PriceCalculator"
node bin/gatehouse.mjs publish <runId>                         # retry publishing an approved run
node bin/gatehouse.mjs eval stats
```

**PR review**
1. **freeze** pins base/head/merge-base SHAs, **enumerate** splits the diff into hunks, and **mask** removes agent-instruction files (`AGENTS.md`, `.github/copilot-instructions.md`, `.vscode/mcp.json`, …) from the workspace.
2. **blast-radius** finds the changed symbols and the code that uses them. **quarantine-read** runs a tool-less agent that turns the PR text (DLP'd, wrapped as untrusted) into requirements.
3. **plan** builds the review units:
   - **T**: technical slices;
   - **B**: business checks, one per acceptance criterion;
   - **V**: viewpoints from `registry/policies/risk-routing.yml` (security, money and data-integrity are mandatory);
   - **S**: seams, the callers the PR did not touch.

   A ledger checks that every hunk was covered.
4. **citations** checks every `file:line` and quote against the code. **evidence** runs repro tests on the head and on the merge base (L2 and GATE_ENV only). **challenge** has Codex critique the P1/P2 findings. Code decides the outcome: a failing test outranks any argument.
5. **synthesis** writes `SUMMARY.md` and `review.html`, then the run waits at **GATE_5**.

**PR review, batched audit (`--arm`, design 09)**
1. The same intake and plan as above. The review is then split into checkable items: per technical unit, `.tech` and `.conv`; acceptance criteria; Spec Kit checklists, scenarios and decision-table rows under `specs/<feature>/` touched by the PR; viewpoint checklist lines; seams.
2. **audit** (arms B, C): one single-pass, schema-bound call per code region × lens. The prompt is ordered for prefix caching: requirements + item catalog, then the region's context pack (hunks, callers, service-boundary signals with the contracts/config the repo holds), then the batch. Each item gets `pass | fail | not_applicable | cannot_determine` with citations and what context was missing. The call asks for a verdict, not a fix. Arm A runs the agentic unit reviewers instead.
3. **investigate** (arm C): items with missing context or unknown cross-service impact get a bounded lookup (repo search first, then a narrow read-only agent) and are asked again. High-risk items and a sample of passes get an independent second read. Whatever stays undecided is reported as unresolved, never as a pass.
4. **group** merges candidates by root cause (cause location + violated rule). **verify** asks for one test per business/technical cause against a checkable source of the expected behaviour. A cause is confirmed only when an assertion fails on head; the merge base shows whether it is new. Convention issues are explained, not tested. **propose-fix** writes AS-IS/TO-BE only for what survived.
5. `run review-arms` compares the arms from their events: candidates, confirmed/withdrawn/blocked, items not checked, tokens per phase (and provider cache hits), test runs, quota waits, wall clock.

Provider quotas can be enforced in the gateway with `llm.providers.<name>.rateLimit: { rpm, tpm, countCachedTokens }`. Calls wait for room in a one-minute window shared by all runs on the machine.

**Ticket → PR**
1. The PBI must quote the ticket verbatim. Inferred criteria become open questions, and blocking questions stop the run until you answer.
2. Spec, plan and tasks each wait for a gate, and an independent critic reviews the planning artifacts.
3. Each task is red → green: the agent only edits files and Gatehouse runs the tests. Changes to build files and protected paths are reverted.
4. The patch is reviewed by an embedded PR review. GATE_5 then pushes the branch and opens a draft PR.

**Legacy tests**
1. JaCoCo runs on the default branch. An agent ranks the classes by business risk (GATE_1), then writes scenario charters (GATE_2).
2. Characterization tests must pass on unchanged code, and only test files are kept.
3. Coverage is re-measured (GATE_3) and a critic reviews the tests. GATE_4 opens a draft PR.

## IDE integration

```bash
node bin/gatehouse.mjs ide install --target <your repo checkout> [--for copilot,codex,claude]
node bin/gatehouse.mjs agents list
node bin/gatehouse.mjs agents compile --for all --out gatehouse-agents
```

`ide install` adds:
- slash commands `/gatehouse-review`, `/gatehouse-self-review`, `/gatehouse-ticket`, `/gatehouse-legacy-tests` and `/gatehouse-status`, as VS Code prompt files, Claude Code commands, and Codex prompts to copy;
- a `gatehouse` custom agent;
- the MCP server entry (`.vscode/mcp.json`, `.mcp.json`, plus a Codex TOML snippet).

The MCP server (`gatehouse mcp serve`) is a client of the running console. It authenticates with a local token and can only start jobs and read state. Gate decisions, publishing, settings and secrets need the browser session and your passkey. It returns PR and run text wrapped as untrusted data.

`agents compile` turns each neutral Agent Spec into Copilot `.agent.md`, Claude Code agents and Codex prompts. The tool lists come from the spec's scope, and no generated agent gets a shell.

## Sandbox cells (Version B)

```bash
node bin/gatehouse.mjs bootstrap --check                       # what this machine still needs (changes nothing)
node bin/gatehouse.mjs env verify <repo> --target cell         # pull image, warm cache once, verify offline
node bin/gatehouse.mjs env parity <repo>                       # does the cell reproduce the host baseline?
```

In cell mode, every build and test command runs in a throwaway container:
- `--network none`, `--cap-drop ALL`, `no-new-privileges`, a read-only root, CPU/memory/pid limits, and `--runtime runsc|kata` when configured;
- the checkout (LF line endings) and a per-repo dependency cache are mounted;
- only the one-time warm-up of the trusted default branch gets network access.

A repo onboarded with `--target cell` runs all later workflows' tests in cells. Agents still run on the host with read-only or edit-only tools.

## PCI-DSS

The default providers (DeepSeek via the gateway, Codex on its own subscription) are not approved third parties. Policy therefore only allows them on repos registered with `--pci out` (the default). Repos marked `cde` or `connected` are refused until an approved provider (`tpspApproved: true`) is configured and Codex is disabled. The gateway blocks prompts containing card data and redacts credentials; the MCP proxy redacts tool results.

## Optional: Jira/Confluence via your MCP server

```yaml
# ~/.gatehouse/config.local.yaml
mcp:
  servers:
    tracker:
      command: uv
      args: [run, --directory, C:/path/to/jira-mcp, server.py]
      env: { JIRA_URL: https://jira.example.com, JIRA_PAT: { secret: jira.pat } }
      tools: { read: [jira_get_issue, jira_search], write: [jira_add_comment], deny: ["*delete*"] }
review:
  ticketTool: tracker:jira_get_issue:issue_key
```

`gatehouse mcp inspect tracker` shows how each tool is classified. Tools not listed are never callable, and write tools are never offered to agents.

## Boundaries

Host mode runs agents and builds as your OS user with your toolchain. It withholds secrets from every step's environment, isolates each run in its own clone, restricts agent tools and routes model traffic through the gateway. It has **no filesystem or network boundary**: repro and TDD tests execute PR code on your machine. Use it for your team's repos, or onboard the repo with `--target cell`.

With `runc`, cells share the host kernel. Install gVisor (`runsc`) or Kata and set `cell.runtime` for a stronger boundary; `bootstrap --check` reports what is missing.
