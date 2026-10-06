# 06 — Generation Prompts

Run in order in VS Code Chat (Agent mode) inside the **new** repo. Each prompt assumes `project.config.yaml` and `blueprint/` exist at the repo root. Reference repos are read-only.

Common preamble (prepend to every prompt):

```text
Context:
- New repo root: ${workspaceFolder}. Parameters: project.config.yaml (read it first).
- Design docs: blueprint/01-architecture.md, 02-how-it-works.md, 03-components-reference.md, 04-parameters.md, 05-generation-plan.md.
- Reference implementations (optional, READ-ONLY, never edit): paths in reference.core_repo,
  reference.extended_repo, reference.mcp_repo. If empty, build from the blueprint docs only.
- Never copy organization-specific names, URLs, ticket keys, or paths from reference repos;
  replace them with config parameters.
Rules:
- Never hard-code a value that exists in project.config.yaml; use {{dotted.key}} in md/yaml, config.js in Node.
- Keep invariants unchanged: stage IDs, GATE_1..GATE_5, honest statuses, forbidden model fields, trust boundary.
- No secrets in files; env var names only.
- Only generate files for features enabled in features.*.
- Finish with the phase verification command from 05-generation-plan.md and report the result. Stop if it fails.
```

---

## P0 — Config & skeleton

```text
Phase P0. Create:
1. Directory tree from blueprint/03-components-reference.md §1 (only enabled features).
2. package.json: name={{project.name}}, scripts test/validate/start/render/sync:codex/sync:codex:check, dependency undici (+ yaml parser).
3. .gitignore (node_modules, .env, config.local.yaml, *.bak, settings-audit.log, specs/**/assets, .test-fixtures, webapp/queue-*).
4. .env.example listing every env var from blueprint/04-parameters.md with empty values and a comment.
5. orchestrator/schemas/project-config.schema.json matching project.config.example.yaml + config.local.example.yaml, every property annotated with x-ui {group, order, scope: team|machine|secret, widget, rerender, restart, test, dangerous} per blueprint/07 §A2.
6. scripts/lib/config.js: layered merge (schema defaults < project.config.yaml < config.local.yaml < .env < env < CLI), schema validate, record source layer per key, deep-freeze, fs.watch hot reload for runtime-only keys, export get(path), save(scope, patch) with atomic write + .bak + audit. `--print` prints resolved config + sources with secrets redacted.
7. scripts/render-config.js: render {{dotted.key}} and {{#if flag}}...{{/if}} in files under templates-src/ into the repo; `--dry-run` prints a unified diff; fail if any placeholder unresolved.
8. scripts/setup-wsl.sh per blueprint/07 §B6 (idempotent, no secrets, sudo steps printed for the user to run).
Verify: node scripts/lib/config.js --print
```

## P1 — Control plane

```text
Phase P1. Using the reference repo's orchestrator/ as the model, create parameterized versions:
- orchestrator/pipeline.yaml: 9 stages (intake, pbi, spec, plan, tasks, review-artifacts, implement, code-review, publish), gates GATE_1..GATE_5 with concrete checklists, handoff, resume, validation, stage-metrics. Trigger JQL uses {{jira.project_key}}, {{jira.team_label}}, platform labels, approved statuses. Implementation repo = {{impl.repo_name}}. Platform plan folders from {{impl.platforms}}.
- orchestrator/pipeline-legacy-test.yaml (if features.legacy_tests): 7 stages, 4 gates, test command {{impl.build.test_cmd}}, coverage tool {{impl.build.coverage_tool}}.
- orchestrator/contracts/: pbi-stage-contract.md, code-review-stage-contract.md, legacy-test-evidence-contract.md.
- orchestrator/schemas/: source-packet, pbi-manifest, review (packet/rebuttal/synthesis $defs).
- orchestrator/review-unit-registry.json (adapters ticket/branch/pr/local; groups B,T,R,H,O,V,S).
- orchestrator/jql-queries.md, .ai/review/policies/risk-routing.yml (path patterns derived from {{impl.stack}}).
Put the placeholder sources in templates-src/ and render them.
Verify: node scripts/render-config.js && node -e "require('yaml').parse(require('fs').readFileSync('orchestrator/pipeline.yaml','utf8'))"
```

## P2 — Trusted libraries & validators

```text
Phase P2. Implement deterministic, model-free code (port logic from the reference scripts/lib, read config via scripts/lib/config.js):
- scripts/lib/pbi-contract.js: stableStringify, sha256Value, parseJsonCandidate (tolerate fenced JSON), validateAgainstSchema, validateSourcePacket (hash check), validateManifest (profiles intake|pbi: provenance SOURCE/DERIVED/INFERRED, AC->matrix->scenario traceability, platform dispositions for {{impl.platforms}}, blocking ambiguity), renderPbi, renderTraceability, writeJsonAtomic, FORBIDDEN_MODEL_FIELDS.
- scripts/pbi-contract.js CLI: validate-packet | validate | render.
- scripts/lib/review-contract.js: safePath, freezeContext, verifyContext, validatePacket, validateRebuttal, validateReview, persistValidation, renderViews, unitsFor.
- scripts/lib/llm-gateway.js: OpenAI-compatible, base url {{llm.base_url}}, proxy via undici EnvHttpProxyAgent, pool {{llm.max_concurrency}}, header-driven rate limit, 429 Retry-After, chatJson.
- scripts/validate-pipeline.js, scripts/validate-legacy-pipeline.js: gates defined/used, every stage has validation rule, every reference path exists, no unresolved {{ }}.
- test/pbi-contract.test.js and test/review-driver.test.js skeleton using node:test.
Verify: npm test && npm run validate
```

## P3 — Templates

```text
Phase P3. Create templates/ by adapting the reference templates (artifact language {{project.language.artifacts}}):
run.json, legacy-test-run.json, pbi-input-template.md, spec-template.md, plan-template.md (per platform), tasks-template.md, pbi-to-spec.md, spec-to-plan.md, review-policy.md (incl. §7b matrix derivation), review-prompt.md, review-plan.md, review-requirements.md, review-packet.example.json, code-review.md, severity-rubric.md ({{review.severity_levels}}).
run.json stages must equal pipeline.yaml stage IDs; code-review default status INSPECTED_ONLY.
Verify: npm run validate
```

## P4 — Agents, skills, instructions

```text
Phase P4. Generate .github/ (SSOT):
1. copilot-instructions.md (<=150 lines): sources of truth, global invariants, language ({{project.language.chat}}), image handling (vision model {{llm.vision_model}} or INACCESSIBLE), terminal rules rendered from {{runtime.host}} (winpty section only if {{runtime.node_alias_winpty}}), intake/PBI quality floor, design loop, execution environment (sandbox, executor {{executor.primary}} with fallback {{executor.fallback}}), review flow, build/test command {{impl.build.test_cmd}}.
2. agents/*.agent.md for every agent in blueprint/03 §5 that belongs to an enabled feature. Frontmatter: name, description (>-), tools/agents/model where needed. pbi-manifest-writer: tools: []. code-reviewer: agents: [red-team-reviewer]. image-transcriber: tools [read, view_image], model {{llm.vision_model}}. MCP tool names prefixed {{mcp.server_name}}.
3. skills/<name>/SKILL.md for all slash commands (disable-model-invocation: true) and reference skills (review-checklist with companion files, chunking, sandbox-execution, ticket-analysis, legacy-test-patterns).
4. prompts/legacy-test-*.prompt.md if features.legacy_tests.
Each agent: Role, Input, Output, Rules, Forbidden, Hand-off sections. Agents never write statuses.
Verify: node scripts/validate-pipeline.js (extend it to check every pipeline agent has a .agent.md and frontmatter parses).
```

## P5 — Review runtime

```text
Phase P5. Implement the review runtime (port from reference scripts, parameterized):
- review-enumerate.js (hunks, sibling structural deltas, fixture blast radius; cache by commit pair)
- review-driver.js (init/refresh/validate/dry-run; waves: viewpoints -> first-pass -> rebuttals for P1/P2 -> seams -> synthesis; --workers default {{review.workers}}; re-verify context around each worker; 429 backoff; SUMMARY.md + validation.json)
- review-copilot.js (executor adapter; BYOK COPILOT_API_URL/KEY/MODEL or llm-gateway)
- review-repro.js (host-side; test cmd {{impl.build.test_cmd}}; RED/GREEN; always cleanup)
- review-verify-citations.js (file:line + quote + finding completeness; exit 0/1/2)
- review-dump-prompt.js, review-retro.js
- review-coverage-map.js only if features.advisory_embeddings (model {{llm.embed_model}})
Extend test/review-driver.test.js: git fixture repo, init, dry-run, tamper -> verify fails, forbidden status in packet -> rejected.
Verify: npm test
```

## P6 — Unattended runners & sandbox

```text
Phase P6.
- pipeline-unattended.js: --ticket/--run/--stage/--approve GATE_N/--executor/--dry-run; stops at gates; approval = gates/GATE_N.approved; never marks EXECUTED_PASS without validator.
- review-unattended.js: --repo/--pr or --run/--source; per-PR git worktree; refresh GitHub token from `gh auth token`; phases plan -> freeze -> fleet/exec -> repro -> validate -> retro; env UNATTENDED_*.
- jira-evidence.js: MCP over stdio ({{mcp.transport}}), freeze jira-evidence.md, non-fatal.
- sandbox.js + scripts/sandbox/Dockerfile for {{impl.stack}}; image {{sandbox.image}}, db {{sandbox.db_image}}, cache {{sandbox.build_cache}}, repo {{impl.local_checkout}}; commands create/exec/shell/review/regen/stop/start/rm.
Proxy: {{network.https_proxy}}, NO_PROXY {{network.no_proxy}}, CA {{network.extra_ca_cert}}.
Verify: node scripts/pipeline-unattended.js --ticket {{jira.project_key}}-1 --dry-run ; node scripts/review-unattended.js --repo {{impl.github_repo}} --pr 1 --dry-run
```

## P7 — Webapp

```text
Phase P7 (if features.webapp). Port webapp/ from reference:
- gh.js (GitHub REST via undici, token env {{github.token_env}} or gh auth token, retry 403/429, proxy).
- Structure: thin server.js + webapp/lib/* (context, http, router, runner, settings, ...) + webapp/routes/* (one register(router) module per API area). Start from the reference v1 Settings/doctor/clone (blueprint/07 §A0) and extend to the target below.
- server.js on {{webapp.port}}: GET /, /api/prs, /api/config (no secrets), POST /api/review/start, /api/review/status, GET /api/review/progress, /api/artifacts/tree, /api/artifacts/file (path confined with safePath), /api/review/process, POST /api/report/generate, GET /api/report/view. Sequential queue persisted to queue-state.json; logs in queue-logs/.
- public/index.html: tabs Members, Assigned, Archive, Stats, Review runs, Settings + Queue panel.
- Settings UI per blueprint/07 §A: form generated from GET /api/settings/schema (x-ui), shows value source per key; endpoints GET/PUT /api/settings, PUT /api/settings/secret/:name (write-only), POST /api/settings/test/:kind, POST /api/settings/apply (dry-run diff, then confirm → render + sync:codex + validate + test, restore .bak on failure), GET /api/settings/history. Optional "commit team change to branch".
- Repositories tab per blueprint/07 §B4: POST /api/repos/clone (host in {{git.allowed_hosts}}, blobless clone into {{paths.repos_dir}}, progress via SSE), POST /api/repos/fetch, worktree add/remove per PR/ticket under {{paths.worktrees_dir}}; use spawn with arg arrays, never shell strings; credentials via git credential helper, never token-in-URL.
- First-run wizard /setup when project.config.yaml is missing (runtime checks for node, git, docker, gh, codex/copilot, uv, WSL).
- Remove webapp/config.json; all settings come from scripts/lib/config.js (replace the reference seam scripts/lib/webapp-config.js).
- scripts/setup.js + scripts/lib/setup.js: `npm run setup` (create local files from *.example, npm install, health checks) and `npm run doctor` (`--check`, `--json` for the webapp).
- scripts/start-server.js: preflight, CA import, kill stale port, open browser (on WSL use `cmd.exe /c start` or `wslview`).
Security: bind 127.0.0.1, Origin/Host check + CSRF token on mutations, secrets never returned, paths canonicalized under {{paths.workspace_root}}, `dangerous` fields need confirm + audit, rate-limit test/clone endpoints.
Verify: npm start; GET /api/settings has no secret values; PUT invalid jira.url → 400; clone from non-allowed host → 403; apply dry-run returns diff.
```

## P8 — MCP server & Codex sync

```text
Phase P8.
- If features.mcp_server: create mcp-server/ (Python FastMCP, httpx + truststore, sensitive-data/secret sanitizer) with tools jira_get_issue, jira_search, jira_get_issue_full, jira_get_issue_comments, jira_get_linked_issues, jira_get_issue_changelog, confluence_get_page, confluence_search, confluence_update_page, confluence_upload_attachment, investigate_issue, search_knowledge_base, debug_test_connection. URLs {{jira.url}}, {{confluence.url}}; tokens from env {{jira.pat_env}}, {{confluence.pat_env}}. Add Dockerfile, pyproject.toml, mcp.json.example. Register in .vscode/mcp.json as {{mcp.server_name}}.
- If features.codex_sync: scripts/sync-codex.js (.github -> AGENTS.md, .codex/agents/*.toml, .codex/skills, .codex/prompts; GENERATED banner; --check; --home).
Verify: npm run sync:codex && npm run sync:codex:check
```

## P9 — Optional modules, docs, E2E

```text
Phase P9.
- If features.business_graph: port api-inventory, mobile-inventory, flow-trace, build-explorer, regen-all, gap-analysis, impact-report, render-knowledge-base, lib/graph-impact.js (from {{reference.extended_repo}}/scripts if set), adapted to {{impl.stack}}; output under {{graph.bd_root}}. Deterministic, every node has file:line.
- If features.pr_analytics: port crawl-pr-comments.js, analyze-causes.js for {{github.members}}.
- docs/: architecture.md, pipeline-design.md, code-review-workflow.md, vscode-chat-guide.md (bilingual), customization.md, webapp-how-it-works.md, legacy-test-user-guide.md.
- README.md with slash command table and quick start.
E2E (manual, stop at gates):
1. /ticket-analyze <real ticket> -> GATE_1 with validated manifest.
2. /pr-review <real PR> -> SUMMARY.md, citations pass, stage INSPECTED_ONLY.
Verify: npm test && npm run validate && npm run sync:codex:check
```

---

## One-shot "regenerate after config change" prompt

```text
project.config.yaml changed. Run: npm run render, npm run sync:codex, npm run validate, npm test.
Report files changed, any unresolved placeholders, and failing checks. Do not edit generated files by hand; fix templates-src/ or config instead.
```

## Prompt to add a new stage / agent later

```text
Add stage <id> after <stage> in orchestrator/pipeline.yaml (gate: <none|GATE_N>).
Create .github/agents/<agent>.agent.md, a template in templates/, a validation rule, update templates/run.json and validate-pipeline.js, add a test. Keep invariants. Verify with npm run validate && npm test.
```
