# 01 — Architecture

## 1. Purpose

An **agentic control plane** that sits *beside* an implementation repo and drives AI agents (GitHub Copilot primary, Codex CLI fallback) through gated, evidence-backed workflows:

1. **Ticket Analysis Pipeline** — Jira ticket → `pbi.md` → `spec.md` → `plan.md` → `tasks.md` → TDD implement → code review → Confluence publish.
2. **Code Review Runtime** — PR / branch / ticket review with frozen context, worker waves, repro tests, red-team rebuttal, citation verification.
3. **Legacy Test Coverage Pipeline** — business-first tests for legacy code that has no spec (JaCoCo/Surefire evidence, fixture reuse).
4. *(Extended edition)* **Business Rule Graph** — deterministic scanners that build an API/Mobile/Flow graph of the implementation code, used for impact analysis and a knowledge base.

## 2. Design principles (invariants)

| # | Principle | How it is enforced |
|---|---|---|
| P1 | **Models produce candidates; trusted code decides.** A model never writes `valid`, `passed`, `approved`, `handoff_ready`, gate or stage status. | `FORBIDDEN_MODEL_FIELDS` in `scripts/lib/pbi-contract.js`; `validateReview` in `scripts/lib/review-contract.js` |
| P2 | **Evidence before model.** Jira/Confluence/KB evidence is captured and frozen (SHA-256) before semantic generation. Generation runs with **no tools**. | `common/source-packet.json` + `pbi-manifest-writer` agent with `tools: []` |
| P3 | **Artifacts are the hand-off contract**, not chat history. | `handoff.artifact_is_contract: true` in `orchestrator/pipeline.yaml` |
| P4 | **Humans own gates** `GATE_1`…`GATE_5`. Nothing bypasses a failed validator or a human gate. | `gates:` in pipeline YAML; `gates/GATE_N.approved` marker files |
| P5 | **Honest statuses only**: `EXECUTED_PASS`, `EXECUTED_FAIL`, `INSPECTED_ONLY`, `NOT_RUN`, `ENVIRONMENT_BLOCKED`, `NOT_APPLICABLE`. Code review stays `INSPECTED_ONLY`. | `run.json` ledger + validators |
| P6 | **Every claim is source-backed or explicitly `INFERRED`**; ambiguity becomes a blocking Open Question, never a guessed requirement. | PBI contract evidence kinds `SOURCE` / `DERIVED` / `INFERRED` |
| P7 | **Single source of truth (SSOT)** for agent customization is `.github/`; Codex layout is generated. | `scripts/sync-codex.js --check` |
| P8 | **Isolated execution**: builds/tests run in a per-ticket Docker sandbox, never on the host. | `scripts/sandbox.js`, `sandbox-execution` skill |
| P9 | **Anti-leak coverage**: every diff hunk / requirement / unit is accounted for by set equality. | `review-enumerate.js`, coverage ledger, `chunking` skill |

Source-of-truth precedence (earlier wins):
1. `orchestrator/pipeline.yaml` / `pipeline-legacy-test.yaml`
2. `orchestrator/contracts/` + `orchestrator/schemas/`
3. Stage agent / skill + referenced template
4. `run.json` (execution state only, never a quality authority)

## 3. Layered architecture

```mermaid
flowchart TB
  subgraph L0[Layer 0 - Entry points]
    U[User in VS Code Chat<br/>slash commands]
    CLI[Unattended CLIs<br/>pipeline-unattended / review-unattended]
    WEB[Webapp dashboard<br/>webapp/server.js]
  end
  subgraph L1[Layer 1 - Instructions SSOT .github]
    CI[copilot-instructions.md]
    AG[agents/*.agent.md]
    SK[skills/*/SKILL.md]
    PR[prompts/*.prompt.md]
  end
  subgraph L2[Layer 2 - Declarative control plane orchestrator]
    PY[pipeline.yaml<br/>pipeline-legacy-test.yaml]
    CT[contracts/*.md]
    SC[schemas/*.json]
    RG[review-unit-registry.json]
    RR[.ai/review/policies/risk-routing.yml]
  end
  subgraph L3[Layer 3 - Trusted runtime scripts]
    LIB[lib: pbi-contract, review-contract,<br/>llm-gateway, graph-impact]
    DRV[review-driver.js]
    VAL[validate-*.js, verify-citations]
    SBX[sandbox.js]
  end
  subgraph L4[Layer 4 - External systems]
    MCP[MCP server: Jira / Confluence / FAQ]
    GH[GitHub API + MCP]
    LLM[LLM gateway: OpenAI-compatible]
    IMPL[Implementation repo checkout]
    DOCK[Docker sandbox]
  end
  subgraph L5[Layer 5 - Artifacts]
    SPECS[specs/unit/ticket/...<br/>run.json, pbi.md, spec.md, plan.md, tasks.md]
    REV[review/... packets, rebuttals,<br/>SUMMARY.md, code-review.html]
  end
  U --> CI --> AG & SK
  CLI --> DRV
  WEB --> CLI
  AG --> PY
  SK --> PY
  PY --> CT --> SC
  DRV --> LIB --> SC
  DRV --> LLM
  AG --> MCP
  DRV --> IMPL
  SBX --> DOCK --> IMPL
  LIB --> SPECS & REV
  VAL --> SPECS & REV
```

## 4. Trust boundary

```mermaid
sequenceDiagram
  participant H as Human
  participant O as Orchestrator agent
  participant A as Acquisition (tools ON)
  participant G as Generator model (tools OFF)
  participant T as Trusted runtime (Node)
  H->>O: /ticket-analyze KEY
  O->>A: fetch Jira/Confluence/KB via MCP
  A-->>T: raw evidence
  T->>T: hash + freeze source-packet.json
  T->>G: frozen packet only
  G-->>T: candidate pbi-manifest.json
  T->>T: validate schema + provenance + traceability
  T->>T: render pbi.md / traceability.md, write run.json status
  T-->>H: GATE_1 checklist
  H->>T: approve (gates/GATE_1.approved) or reject
```

Key point: the **only** component allowed to write a status is the trusted runtime; the only component allowed to approve is a human.

## 5. Two-repo model

| Repo | Owns |
|---|---|
| Workflow repo (this kind of project) | pipelines, agents, skills, contracts, scripts, templates, webapp, generated artifacts under `specs/` and `review/` |
| Implementation repo (e.g. `{{IMPL_REPO_NAME}}`) | product code + tests; mutated only by the `implement` stage inside the sandbox |
| MCP server repo | Jira / Confluence / FAQ tool server (Python FastMCP) |
| Graph data store (optional, `{{graph.bd_root}}`) | generated Business Rule Graph JSON + explorer HTML |

## 6. Editions compared

| Area | Extended | Core |
|---|---|---|
| Pipelines, contracts, schemas, templates | yes | yes (same) |
| 19 agents, ~23 skills, SSOT sync to Codex | yes | yes |
| Review runtime (driver, unattended, repro, citations, coverage map, retro) | yes | yes |
| Webapp PR dashboard | yes | yes |
| `scripts/lib/executor-adapters/` (pluggable executors) + `probe-executors.js` | yes | no |
| `scripts/lib/review-matrix-contract.js` + `validate-review-matrix.js` | yes | no |
| Business Rule Graph: `api-inventory`, `mobile-inventory`, `flow-trace`, `build-explorer`, `regen-all`, `gap-analysis`, `impact-report`, `render-knowledge-base` | yes | only consumer lib `graph-impact.js` |
| PR comment analytics: `crawl-pr-comments`, `analyze-causes` | yes | no |
| Diagnostics: `probe-ratelimit`, `test-gateway`, `test-embed`, `test-fetch`, `read-session` | yes | no |
| `research/`, `memories/`, real `specs/`, `review/` outputs | yes | no |
| Tracker/wiki MCP server | external | optional `mcp-server/` |

Recommendation for a new project: start from the **Core** edition, then enable the Extended modules as optional feature flags (see `04-parameters.md` → `features.*`).
