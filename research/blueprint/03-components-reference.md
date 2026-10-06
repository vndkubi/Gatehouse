# 03 — Components Reference

## 1. Directory layout (target structure for a new project)

```
<workflow-repo>/
├── AGENTS.md                         GENERATED from .github/copilot-instructions.md
├── README.md
├── package.json                      setup / doctor / test / validate / start / sync:codex scripts; dep: undici
├── .env.example                      all env vars (no secrets)
├── project.config.yaml               NEW: parameter file (see 04-parameters.md)
├── .github/                          SSOT for AI customization
│   ├── copilot-instructions.md       always-on rules (small!)
│   ├── agents/*.agent.md             stage agents
│   ├── skills/<name>/SKILL.md        slash commands + reference skills
│   └── prompts/*.prompt.md           legacy-test slash commands
├── .codex/                           GENERATED (agents .toml, skills, prompts)
├── .ai/review/policies/risk-routing.yml
├── .vscode/mcp.json(.example)        MCP server registrations (secrets only via ${input:..}/${env:..})
├── orchestrator/
│   ├── pipeline.yaml                 ticket pipeline (9 stages / 5 gates)
│   ├── pipeline-legacy-test.yaml     legacy test pipeline (7 stages / 4 gates)
│   ├── review-unit-registry.json     review adapters + unit groups
│   ├── jql-queries.md                JQL cookbook
│   ├── contracts/                    pbi / code-review / legacy-test contracts
│   └── schemas/                      source-packet / pbi-manifest / review JSON schemas
├── templates/                        artifact templates + run ledgers
├── scripts/
│   ├── lib/                          trusted libraries
│   ├── sandbox/Dockerfile
│   └── *.js                          CLIs
├── test/                             node:test suites + fixtures + helpers
├── webapp/                           dashboard: server.js, gh.js, lib/ (context, http, router, runner,
│                                     settings, github-data, artifacts, reports, pending-reviews, review-dirs),
│                                     routes/ (prs, queue, review, reports, settings, static), public/,
│                                     config.json (git-ignored, from config.json.example)
├── docs/                             operator + design docs
├── specs/                            RUNTIME: per-ticket artifacts
└── review/                           RUNTIME: review packages
```

Per-ticket artifact tree (e.g. `specs/proj/PROJ-123-short-slug/`):
```
specs/<unit>/<TICKET>-<slug>/
├── run.json
├── assets/img-001.png ...
├── gates/GATE_N.approved
├── common/source-packet.json, pbi-manifest.json, pbi.md, traceability.md, spec.md
├── server/plan.md, tasks.md
├── tasks.review.html
└── review/ requirements.md, review-plan.md, context.json, packets/, rebuttals/, repro-tests/, driver/SUMMARY.md, validation.json, code-review.html
```

## 2. Orchestrator files

| File | Enforces |
|---|---|
| `pipeline.yaml` | `trigger` (manual / JQL), `stages[]` (id, agent, input, output, gate, parallel), `gates` (question, checklist, reference, on_approve/on_reject), `handoff` (artifact_is_contract, auto_continue_stages, manual_transition_stages, branch_after), `resume`, `validation` per stage, `stage-metrics` |
| `pipeline-legacy-test.yaml` | same shape for legacy tests + `status_labels`, `overall_status`, `forbidden` lists |
| `contracts/pbi-stage-contract.md` | evidence kinds, intake vs pbi profile, decision variables/matrix/scenarios traceability, platform impact, forbidden fields, blocking ambiguity |
| `contracts/code-review-stage-contract.md` | main reviewer + repro + blind red-team (`VERDICT: FINDING_STANDS|FINDING_WITHDRAWN`) + ASIS/TOBE; stage `INSPECTED_ONLY` |
| `contracts/legacy-test-evidence-contract.md` | artifact ownership, `SCN-*` IDs, fixture reuse plan, Business Scenario Map, freshness |
| `schemas/source-packet.schema.json` | frozen packet: sources, ids, hashes |
| `schemas/pbi-manifest.schema.json` | semantic manifest |
| `schemas/review.schema.json` | `$defs`: packet, rebuttal, synthesis |
| `review-unit-registry.json` | adapters `ticket/branch/pr/local`; groups B/T/R/H/O/V/S with ID patterns |

## 3. Scripts

| Script | Purpose | Key args |
|---|---|---|
| `review-driver.js` | trusted review runtime: freeze, verify, worker waves, validate, SUMMARY | `<TICKET> --source <dir> --init/--refresh/--validate/--dry-run --base --head --workers --codex --model` |
| `review-unattended.js` | end-to-end unattended PR review | `--repo o/r --pr N` / `--run run.json --source dir`, `--executor copilot|codex` |
| `review-copilot.js` | Copilot executor adapter | same as driver |
| `review-enumerate.js` | mechanical hunk / sibling / fixture enumeration (cached) | `--source --base --head --out` |
| `review-repro.js` | run repro tests on host, RED/GREEN evidence | `--run --finding --generate --dry-run` |
| `review-verify-citations.js` | verify `file:line` + quotes + finding completeness | `--package --source` |
| `review-coverage-map.js` | embeddings hunk ↔ plan item (advisory) | `--enumeration --plan --top --min-score` |
| `review-retro.js` | append lesson to case-study doc | `--run --exit` |
| `review-dump-prompt.js` | dump one worker prompt for manual chat run | `<TICKET> <UNIT> <ROLE>` |
| `pipeline-unattended.js` | run ticket pipeline stage by stage, stop at gates | `--ticket/--run --stage --approve GATE_N --executor` |
| `pbi-contract.js` | CLI: `validate-packet`, `validate`, `render` | `--packet --manifest --profile --pbi --traceability --result` |
| `jira-evidence.js` | fetch Jira/Confluence via MCP docker (stdio), freeze evidence | `--ticket --out` |
| `render-scenarios.js` | deterministic scenarios/matrix/Mermaid from manifest | `<manifest> [flow-graph] [out]` |
| `stage-info-gain.js` | advisory drift metrics | `<run-dir> | --all` |
| `sandbox.js` | Docker sandbox lifecycle | `create|exec|shell|review|regen|stop|start|rm` |
| `start-server.js` | webapp launcher: load `.env`, create `webapp/config.json` on first run, use `webapp/*.pem` as `NODE_EXTRA_CA_CERTS`, free port, open browser | `PORT` |
| `setup.js` | first-run setup (npm deps, `webapp/config.json`, `.env`, `.vscode/mcp.json` from examples) + health checks (`npm run setup` / `npm run doctor`) | `--check`, `--json` |
| `setup-wsl.sh` | idempotent Ubuntu/WSL bootstrap (see 07 §B6) | env `REPO_URL`, `WORK_DIR`, `INSTALL_DOCKER`, `SKIP_EXECUTORS` |
| `sync-codex.js` | SSOT → AGENTS.md + .codex | `--check --home` |
| `validate-pipeline.js` / `validate-legacy-pipeline.js` | static structural validation of YAML + run ledger | — |
| `export-corp-ca.ps1` | export corporate root CA (TLS-inspecting proxy) to PEM | — |
| *Extended edition only* | `api-inventory`, `mobile-inventory`, `flow-trace`, `build-explorer`, `regen-all`, `gap-analysis`, `impact-report`, `render-knowledge-base`, `crawl-pr-comments`, `analyze-causes`, `validate-review-matrix`, `probe-executors`, `probe-ratelimit`, `test-*`, `read-session` | see 01-architecture §6 |

## 4. Libraries (`scripts/lib/`)

| Module | Exports / role |
|---|---|
| `pbi-contract.js` | `stableStringify`, `sha256Value`, `parseJsonCandidate`, `validateAgainstSchema`, `validateSourcePacket`, `validateManifest`, `renderPbi`, `renderTraceability`, `writeJsonAtomic`, `FORBIDDEN_MODEL_FIELDS` |
| `review-contract.js` | `GROUPS`, `POLICY_FILES`, `safePath`, `freezeContext`, `verifyContext`, `validatePacket`, `validateRebuttal`, `validateReview`, `persistValidation`, `renderViews`, `unitsFor`, path helpers |
| `llm-gateway.js` | `chat`, `chatJson`, pool, rate-limit from headers, 429 retry, budgets |
| `graph-impact.js` | load per-sha graph cache, impact lookup |
| `setup.js` | `doctor()` checks, `ensureConfig/EnvFile/McpConfig`, `loadDotEnv`, write-only `setSecret` (allow-list `SECRET_NAMES`), `secretStatus`, `defaultWorkspaceDir`, `isWsl` |
| `webapp-config.js` | single read/write point for `webapp/config.json` (`WEBAPP_DATA_DIR` override) — the seam to swap in `config.js` later |
| `json-util.js` | `readJsonSafe` |
| `review-matrix-contract.js` *(awf)* | review-matrix partition validator |
| `executor-adapters/` *(awf)* | pluggable executor registry (copilot, codex, ...) |

## 5. Agents (`.github/agents/*.agent.md`)

| Agent | Pipeline | Role |
|---|---|---|
| `ticket-analysis-orchestrator` | ticket | runs stages, owns `run.json` transitions via runtime |
| `intake` | ticket | evidence acquisition only |
| `image-transcriber` | shared | vision transcription (`tools: [read, view_image]`, vision model) |
| `pbi-manifest-writer` | ticket | candidate manifest, `tools: []` |
| `spec-writer` / `plan-writer` / `tasks-writer` | ticket | Spec Kit artifacts |
| `reviewer` | ticket | artifact review → `tasks.review.html` |
| `implement` | ticket | TDD in sandbox |
| `code-reviewer` | review | main reviewer, `agents: [red-team-reviewer]` |
| `business-reviewer` / `technical-reviewer` | review | B* / T* units |
| `red-team-reviewer` | review | independent rebuttal |
| `coverage-surveyor`, `test-charter-writer`, `legacy-test-implementer`, `coverage-verifier`, `test-quality-reviewer`, `legacy-test-orchestrator` | legacy | legacy test stages |

Frontmatter: `name`, `description` (`>-`), optional `tools`, `agents`, `model`, `user-invocable: false`.

## 6. Skills (`.github/skills/<name>/SKILL.md`)

Slash-command skills (`disable-model-invocation: true`): `ticket-scan`, `ticket-analyze`, `ticket-implement`, `ticket-review`, `ticket-review-plan`, `review-pbi`, `review-plan`, `pr-review`, `pr-self-review`, `branch-review`, `branch-review-plan`, `pbi-manifest-generate`, `pbi-manifest-repair`, `legacy-test-scan|charter|implement|review|publish`.

Reference skills (auto-loadable): `ticket-analysis`, `review-checklist` (+ `company-checklist.md`, `pr-history-viewpoints.md`, `review-impediments.md`, `matrix-methods.md`, `historical-review-evidence.md`), `chunking`, `sandbox-execution`, `legacy-test-patterns` (+ `references/fixture-design.md`).

## 7. Templates (`templates/`)

`run.json`, `legacy-test-run.json`, `pbi-input-template.md`, `spec-template.md`, `plan-template.md`, `tasks-template.md`, `pbi-to-spec.md`, `spec-to-plan.md`, `review-policy.md`, `review-prompt.md`, `review-plan.md`, `review-requirements.md`, `review-packet.example.json`, `code-review.md`, `severity-rubric.md`.

## 8. Tests

`npm test` → `node --test test/pbi-contract.test.js test/review-driver.test.js test/webapp.test.js` (node:test, git fixtures in `.test-fixtures/`). `npm run validate` → both pipeline validators. `npm run sync:codex:check` → SSOT drift. `npm run doctor` → environment health checks.
