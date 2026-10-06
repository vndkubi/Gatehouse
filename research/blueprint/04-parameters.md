# 04 — Parameters (make the project dynamic)

Every organization- or repository-specific value is a parameter in `project.config.yaml`. Generated files must read these values (scripts: via `scripts/lib/config.js`; Markdown/YAML: rendered from `{{PARAM}}` placeholders at generation time). Values below are generic examples / defaults.

## 1. Parameter catalog

| Parameter | Example / default | Used in |
|---|---|---|
| `project.name` | `my-agent-workflows` | README, package.json, sandbox image name |
| `project.language.chat` | `English` (any; may be bilingual) | `copilot-instructions.md` |
| `project.language.artifacts` | `English` | `copilot-instructions.md`, templates |
| `impl.repo_name` | `my-service` | README, skills, agents, `graph-impact.js` |
| `impl.github_repo` | `my-org/my-service` | webapp config, `review-unattended.js` |
| `impl.local_checkout` | derived `{{paths.repos_dir}}/{{impl.repo_name}}` (machine scope) | webapp `sourceCheckouts`, `REPRO_CHECKOUT`, `SANDBOX_HOST_REPO` |
| `impl.default_branch` | `origin/main` | `SANDBOX_DEFAULT_BRANCH`, branch-review |
| `impl.stack` | `java-maven` \| `java-gradle` \| `node` \| `python` \| `dotnet` | sandbox Dockerfile, legacy-test skills, graph scanners |
| `impl.build.test_cmd` | e.g. `mvn clean jacoco:prepare-agent test -Dtest={class}` / `npx jest {file} --coverage` | `REPRO_TEST_CMD`, AGENTS.md "Build and test" |
| `impl.build.coverage_tool` | `jacoco` \| `istanbul` \| `coverage.py` | legacy-test pipeline |
| `impl.platforms` | `[server]` (+ `ios`, `android`, `web`) | pbi contract platform dispositions, `mobile-inventory.js` |
| `impl.mobile.android_repo` / `ios_repo` | paths or empty | `mobile-inventory.js` |
| `jira.url` | `https://jira.example.com` | MCP, `jira-evidence.js` |
| `jira.project_key` | `PROJ` | `pipeline.yaml trigger`, `jql-queries.md`, `ticket-scan` |
| `jira.unit_folder` | `proj` | `specs/<unit>/` |
| `jira.team_label` | `team-backlog` | JQL |
| `jira.platform_labels` | `{server: p_server, ios: p_ios, android: p_android}` | JQL |
| `jira.approved_statuses` | `["Approved"]` | JQL |
| `confluence.url` | `https://confluence.example.com` | MCP |
| `confluence.space` / `confluence.parent_page_id` | publish target | `publish` stage |
| `confluence.checklist_page` | optional internal review-checklist page | `review-checklist/review-impediments.md` |
| `mcp.server_name` | `tracker` | `.vscode/mcp.json`, agent tool names |
| `mcp.transport` / `mcp.image` | `uv` / docker image | `.vscode/mcp.json`, `JIRA_MCP_IMAGE` |
| `mcp.enable_faq` | `false` | optional `kb_*` tools |
| `github.members` | team logins | webapp `members` |
| `github.me` | login | webapp `me` |
| `github.ai_reviewer_bot` | bot login | webapp |
| `llm.base_url` | `https://api.openai.com/v1` (any OpenAI-compatible gateway) | `LLM_BASE_URL` |
| `llm.chat_model` | `gpt-4o` | `LLM_MODEL`, `COPILOT_MODEL` |
| `llm.embed_model` | `text-embedding-3-large` | `LLM_EMBED_MODEL` |
| `llm.vision_model` | any vision-capable model, or empty | `image-transcriber.agent.md` |
| `llm.max_concurrency` / `max_retries` | 4 / 3 | `llm-gateway.js` |
| `executor.primary` / `fallback` | `copilot` / `codex` | AGENTS.md, unattended runners |
| `executor.unattended_model` | — | `UNATTENDED_MODEL` |
| `network.https_proxy` | empty, or `http://proxy:80` | `HTTPS_PROXY`, `UNATTENDED_PROXY`, `GH_PROXY` |
| `network.no_proxy` | `github.com,api.github.com,api.githubcopilot.com,localhost` | `NO_PROXY` |
| `network.extra_ca_cert` | empty, or `webapp/corp-root.pem` | `NODE_EXTRA_CA_CERTS`, `export-corp-ca.ps1` |
| `sandbox.image` | `{{project.name}}-sandbox:latest` | `SANDBOX_IMAGE` |
| `sandbox.db_image` | `postgres:16-alpine` | `SANDBOX_DB_IMAGE` |
| `sandbox.build_cache` | `~/.m2/repository` / `~/.npm` | `SANDBOX_BUILD_CACHE` |
| `graph.bd_root` | `../business-data` | `BD_ROOT` |
| `reference.*_repo` | empty | optional read-only reference implementations for generation |
| `review.workers` | 4 | `--workers`, `UNATTENDED_WORKERS` |
| `review.chunk_loc` | 50k (200k ctx) / 200k (1M ctx) | `chunking` skill |
| `review.severity_levels` | P1–P4 | `severity-rubric.md` |
| `review.gate5_author_checks` | A1–A4 | README, `pr-self-review` |
| `webapp.port` | 8787 | `PORT`, config |
| `runtime.host` | `wsl` \| `linux` \| `windows` \| `mac` | rendered terminal rules, path handling, setup script |
| `runtime.node_alias_winpty` | `false` (true only for git-bash on Windows) | AGENTS.md terminal rules |
| `paths.workspace_root` / `repos_dir` / `worktrees_dir` | `~/work`, `~/work/repos`, `~/work/worktrees` | clone + worktree manager, sandbox mounts |
| `repos[]` | `{name, url, branch, fetch}` | Settings UI → Repositories tab |
| `git.allowed_hosts` | `[github.com]` | clone URL allow-list |
| `features.*` | — | toggles optional modules (see below) |

Scope of each key (team / machine / secret) is declared in the schema via `x-ui.scope` — see [07-settings-ui-and-host-setup.md](07-settings-ui-and-host-setup.md) §A1.

## 2. Feature flags

| Flag | Enables |
|---|---|
| `features.ticket_pipeline` | 9-stage pipeline, intake/pbi/spec/plan/tasks agents |
| `features.code_review` | review runtime, review skills, red-team |
| `features.legacy_tests` | legacy-test pipeline + 6 agents + 5 prompts |
| `features.webapp` | `webapp/` + `start-server.js` |
| `features.sandbox` | `sandbox.js` + Dockerfile |
| `features.business_graph` | scanners (`api-inventory`, `mobile-inventory`, `flow-trace`, `build-explorer`, `regen-all`, `gap-analysis`, `impact-report`, `render-knowledge-base`) |
| `features.pr_analytics` | `crawl-pr-comments`, `analyze-causes` |
| `features.codex_sync` | `sync-codex.js` + `.codex/` |
| `features.mcp_server` | scaffold Python FastMCP server for Jira/Confluence |
| `features.advisory_embeddings` | `stage-info-gain`, `review-coverage-map` |

## 3. Rules for parameterization

1. **Secrets never in config files** — only env var *names*. Values in `.env` (git-ignored, mode 600) or OS keychain, written by the Settings UI write-only endpoint.
2. Precedence at runtime: CLI flag > env var > `.env` secrets > `config.local.yaml` (machine) > `project.config.yaml` (team) > schema default.
3. Node scripts load config through one module `scripts/lib/config.js` (YAML → frozen object, env override, schema-validated by `orchestrator/schemas/project-config.schema.json`).
4. Markdown/YAML customization files (`.github/**`, `orchestrator/**`, `templates/**`) are generated from templates with `{{dotted.param}}` placeholders by `scripts/render-config.js`; re-run after changing config. `npm run validate` must fail if any `{{...}}` is left unresolved.
5. Stage IDs, gate IDs, status labels, and forbidden model fields are **not** parameters — they are invariants.
