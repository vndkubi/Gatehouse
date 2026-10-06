# Agent Workflow Blueprint

Company- and repository-neutral documentation + regeneration kit for an **agentic workflow control plane** (Jira-style tracker + wiki + Git host + AI coding agents). All organization-specific values live in `project.config.yaml`.

Two editions are described:

| Edition | Role |
|---|---|
| **Core** | Portable control plane: pipelines, contracts, agents, skills, review runtime, webapp, optional MCP server for tracker/wiki. |
| **Extended** | Core **plus** code knowledge graph scanners, pluggable executor adapters, review-matrix contract, PR-comment analytics, diagnostics. |

## Files

| # | File | Content |
|---|---|---|
| 1 | [01-architecture.md](01-architecture.md) | Purpose, design principles, layers, component diagram, trust boundary, the two projects compared |
| 2 | [02-how-it-works.md](02-how-it-works.md) | End-to-end flows: ticket pipeline, code review runtime, legacy-test pipeline, unattended runners, webapp, sandbox, MCP, graph |
| 3 | [03-components-reference.md](03-components-reference.md) | Directory layout, every script / lib / agent / skill / contract / schema / template, env vars |
| 4 | [04-parameters.md](04-parameters.md) | Every project-specific value, mapped to a parameter name and the files that use it |
| 5 | [project.config.example.yaml](project.config.example.yaml) | Team-scope parameters (committed) |
| 5b | [config.local.example.yaml](config.local.example.yaml) | Machine-scope parameters (git-ignored): runtime host, paths, repos, network |
| 6 | [05-generation-plan.md](05-generation-plan.md) | Phased plan (P0–P9) to build a new project like this, with Definition of Done per phase |
| 7 | [06-generation-prompts.md](06-generation-prompts.md) | Copy-paste prompts (one per phase) using `{{PARAM}}` placeholders |
| 8 | [07-settings-ui-and-host-setup.md](07-settings-ui-and-host-setup.md) | Settings UI (schema-driven, layered config, apply/re-render) + Ubuntu/WSL2-on-Windows setup and in-Linux clone/worktree flow |

## How to use for a new project

1. Copy this `blueprint/` folder into an empty repo.
2. Fill `project.config.yaml` (from the example).
3. Open the repo in VS Code, run the prompts in `06-generation-prompts.md` in order (P0 → P9). Each prompt reads `project.config.yaml`, so the generated project is parameterized, not hard-coded.
4. After each phase run the phase's verification command; stop if it fails.
