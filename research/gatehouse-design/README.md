# Gatehouse v2 — Thiết kế lại agentic control plane

> **Luận điểm chính:** Agent làm việc *bên trong tường*. Con người và code tin cậy giữ *chìa khóa*.
> Mọi control phải nằm **ngoài tầm với của agent**. Nếu agent tự gỡ được một control thì đó không phải là control.

Đây là bản thiết kế lại hệ thống trong [`../blueprint/`](../blueprint/README.md) (gọi tắt là **v1**). Nó kết hợp:

- những gì v1 đã làm đúng, như frozen evidence, model không có tool, artifact là contract, honest status và anti-leak coverage;
- bài học từ các talk ở **Singapore Tech Week, 29–30/9/2026**, gồm DevOps Live, Big Data & AI World, Cloud & AI Infrastructure và Cyber Security World.

## TL;DR — 8 thay đổi lớn so với v1

| # | v1 | v2 (Gatehouse) | Nguồn bài học |
|---|---|---|---|
| 1 | "Orchestrator **agent**" đọc `run.json` để chạy stage | **Workflow engine bằng code, deterministic**, event-sourced. LLM chỉ chạy *bên trong* một step | BDWA keynote: *"Architect for workflows, not prompts"*, *"Never build a God-Prompt"* |
| 2 | Gate là **file marker** `gates/GATE_N.approved`, agent cũng ghi được | Gate là **signed approval event**, gắn với *hash của artifact*, nằm trong store agent không chạm tới được | SGX: *"Can the workflow remove it?"* |
| 3 | Copilot/Codex CLI và `review-repro` chạy **trên host**, đọc được `.env` | **Mọi agent loop và mọi lệnh chạy trong sandbox**: default-deny egress, không có secret bên trong | ST Engineering: sandbox + sự cố SSRF qua artifactory |
| 4 | PAT dài hạn trong `.env` | **Identity broker**: token ngắn hạn, gắn với một run và một repo, quyền tối thiểu. Gateway giữ credential | SGX: *"Short-lived identity, not long-lived credentials"* |
| 5 | Agent ghi thẳng vào impl repo hoặc PR | **Artifact promotion**: agent chỉ tạo *patch artifact* bất biến. Publisher riêng, có identity ghi, mới mở PR sau khi gate đã ký | SGX: *"No direct path from build to deployment"*, *"Promotion moves the same artifact forward"* |
| 6 | Không có eval, đổi prompt là "đổi mù" | **Eval plane**: offline eval chặn mọi thay đổi prompt/skill/model/policy. Online eval lấy label từ quyết định của người ở gate | ST Engineering: offline + online eval, sycophancy |
| 7 | Một `chat_model` cho mọi việc, không biết chi phí | **Model router theo tier** (frontier / workhorse / scale / open-weight) + budget, đo **cost per completed workflow** | Google Cloud: tokenomics; BDWA: *"Measure cost per completed workflow"* |
| 8 | Chỉ có log và `run.json` | **OpenTelemetry trace** cho mọi span (model, tool, guard, chờ người), audit log hash-chained, metric dùng để **cấp autonomy dần dần** (earned autonomy) | ST Engineering: traces/metrics/logs; Cyber: *telemetry-proven governance* |

## Tài liệu

| # | File | Nội dung |
|---|---|---|
| 1 | [01-lessons.md](01-lessons.md) | Kiến thức đã chắt lọc: v1 làm đúng gì, hổng ở đâu, và mỗi talk dạy gì → hệ quả thiết kế |
| 2 | [02-architecture.md](02-architecture.md) | Invariants, 5 plane, từng component, tầng guard, bảng *"Agent có gỡ được không?"*, identity, model tier, threat model |
| 3 | [03-workflows.md](03-workflows.md) | Step contract, 4 orchestration pattern, 3 workflow viết lại (Ticket→PR, PR Review, Legacy Tests), earned autonomy |
| 4 | [04-roadmap.md](04-roadmap.md) | Lộ trình từ v1 lên v2 (Phase 0 → 4, có DoD), KPI, tech stack, trade-off chấp nhận có chủ đích |
| 5 | [05-executors-and-run-cells.md](05-executors-and-run-cells.md) | ADR đã chốt; Copilot CLI và Codex CLI chạy trong cell (BYOK qua gateway); **Run Cells** chạy nhiều repo song song; **BYO-MCP** cho Jira/Confluence Server/DC |
| 6 | [06-pci-dss.md](06-pci-dss.md) | PCI-DSS v4.0.1: clean room, DLP, ma trận `pci.scope`, LLM provider là TPSP, map requirement → control, các điểm cần QSA xác nhận |
| 7 | [07-environment-synthesis.md](07-environment-synthesis.md) | Tự dựng môi trường build/test từ repo của user: detect (CI, devcontainer, manifest) → `env.yaml` → image theo lớp → verify L0–L3 → Env Doctor → GATE_ENV |
| 8 | [08-delivery-host-then-sandbox.md](08-delivery-host-then-sandbox.md) | Thứ tự giao hàng: **Version A host mode** (dùng toolchain có sẵn trên máy) trước, **Version B sandbox** (máy mới) sau; ước lượng thời gian, parity check |

## Quyết định đã chốt (06/10/2026)

| # | Quyết định | Ảnh hưởng chính |
|---|---|---|
| ADR-01 | Executor: **Copilot CLI + Codex CLI** | Agent-in-sandbox; Copilot và Codex đều trỏ tới LLM Gateway (BYOK) |
| ADR-02 | **Local**, một người dùng, **nhiều repo song song** trong sandbox cô lập | Run Cell: network, volume, clone, cache, token riêng cho từng run |
| ADR-03 | Jira/Confluence **Server/DC**, user **tự setup MCP** | BYO-MCP phía sau MCP Proxy (lọc tool, DLP, taint, audit) |
| ADR-04 | Tuân thủ **PCI-DSS** | Clean room + DLP ở 4 lối vào + DLP ở gateway; Mode G bắt buộc với repo trong scope; người review thứ hai; log giữ 12 tháng |

## Nguồn

| Ký hiệu | Nguồn |
|---|---|
| **[BP]** | `research/blueprint/*` — Agent Workflow Blueprint (v1) |
| **[GC]** | Saurabh Mangal (AI Lead SEA, Google Cloud): *Tokenomics, model choice, agent harness*; slide Gemini Enterprise Agent Platform |
| **[BDWA]** | BDWA 2026 Keynote: *Blueprints for the Autonomous Enterprise* (maturity L1–L4, 3 orchestration pattern, 3 data plane, guardrail 4 ring, ROI) |
| **[STE]** | Joey Chua (ST Engineering): *Building agents without losing control* (sandbox, eval, guardrails, observability) |
| **[SGX]** | Takahiro Yamaki (SGX Group): *Designing Secure GitHub Actions Governance* (boundaries, identity, artifact promotion) |
| **[CSW]** | Cyber Security World Asia 2026: *The end of the old playbook* (continuous assurance, blast radius, security flywheel) |
| **[Panel]** | *The New Guardrails for Managing Agentic Workflows*; *Collaboration with AI Agents*; AWS *OpenClaw in Kubernetes with MicroVM* (chỉ có slide tiêu đề) |

> Lưu ý: folder Drive còn 13 file ghi âm `.m4a` chưa được xử lý vì không có công cụ chuyển giọng nói thành văn bản. Bản thiết kế này chỉ dựa trên ảnh slide và blueprint.
