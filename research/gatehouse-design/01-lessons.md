# 01 — Bài học: v1 + hội thảo → hệ quả thiết kế

## 1. v1 đã làm đúng những gì (giữ nguyên)

v1 ([BP]) có nền tảng tốt hơn phần lớn hệ thống "AI coding workflow" đang có. Những invariant dưới đây **được giữ nguyên** trong v2:

| v1 | Vì sao đúng | Talk nào xác nhận |
|---|---|---|
| P1 *Models produce candidates; trusted code decides* (`FORBIDDEN_MODEL_FIELDS`) | Tách người đề xuất khỏi người quyết định | [BDWA] Pattern C: *"the agent that proposes is never the agent that approves"* |
| P2 *Evidence before model*: packet được freeze bằng SHA-256, generator chạy `tools: []` | Model không có tool thì prompt injection trong ticket không gây ra hành động | [STE] EchoLeak: injection + scope violation |
| P3 *Artifact là hand-off contract*, không phải chat history | Có thể resume, audit, diff | [BDWA] *"Strict JSON Schema validation enforced between every stage handoff"* |
| P5 *Honest statuses* (`EXECUTED_PASS`, `INSPECTED_ONLY`…) | Không cho phép "pass giả" | [CSW] *"continuously proven by telemetry, not asserted on paper"* |
| P6 Mọi claim có nguồn hoặc được gắn nhãn `INFERRED`; chỗ mơ hồ thành Open Question | Grounding | [BDWA] *"Reasoning without grounding is just confident guessing"* |
| P9 Anti-leak coverage bằng set equality (hunk ↔ unit) | Có bằng chứng là đã xét đủ, không bỏ sót | — (đây là điểm mạnh riêng của v1) |
| Review: citation verify, repro test RED/GREEN, red-team | Finding phải có bằng chứng chạy được | [BDWA] Pattern C critic-verifier |
| Business Rule Graph quét deterministic, mỗi node có `file:line` | "Structured truth" plane cho code | [BDWA] Plane 01 *Structured truth* |

## 2. v1 hổng ở đâu

Xếp theo mức độ nghiêm trọng. Cột "Test" dùng câu hỏi của [SGX]: ***Agent có tự gỡ được control này không?***

| # | Lỗ hổng trong v1 | Hệ quả | Test | Sửa trong v2 |
|---|---|---|---|---|
| G1 | Gate = file `gates/GATE_N.approved` nằm trong `specs/`, là chỗ agent cũng ghi được | Agent (hoặc nội dung đã bị inject vào agent) **tự approve gate** được | ❌ gỡ được | Signed approval event gắn với `artifact_hash` + danh tính người duyệt, lưu trong store agent không có quyền ghi |
| G2 | Copilot/Codex CLI chạy trên host, `review-repro.js` chạy test **trên host** | Code trong PR (do người lạ viết) chạy trên máy dev, có `.env`, `~/.ssh`, token `gh` | ❌ | Mọi agent loop và mọi lệnh exec đều chạy trong sandbox. Repro cũng chạy trong sandbox |
| G3 | PAT dài hạn (`JIRA_PAT`, `GITHUB_TOKEN`, `OPENAI_API_KEY`) trong `.env` và env của process executor | Một lần exfil là lộ toàn bộ quyền, không giới hạn thời gian | ❌ | Identity broker + gateway giữ credential. Sandbox không bao giờ thấy secret |
| G4 | "Orchestrator **agent**" điều phối stage, `run.json` là state | Luồng điều khiển phụ thuộc LLM. State là file agent ghi được | ❌ | Workflow engine deterministic, event log append-only. `run.json` chỉ còn là projection |
| G5 | Sandbox Docker có network mặc định | Đường exfil qua package registry, SSRF qua dịch vụ dùng chung | ❌ | Default-deny egress, allowlist đi qua proxy. Không có service dùng chung nào nối thẳng ra internet |
| G6 | Red-team rebuttal là LLM thuyết phục LLM (`FINDING_WITHDRAWN`) | **Sycophancy**: finding đúng có thể bị rút vì "bị cãi" | n/a | Chỉ bằng chứng mới quyết định: rút finding phải có counter-evidence (repro GREEN, citation sai) |
| G7 | Không có eval. Prompt, skill, model, policy thay đổi là áp dụng luôn | Regression âm thầm | n/a | Eval plane: offline suite là gate CI cho mọi thay đổi hành vi agent |
| G8 | Một `llm.chat_model` cho mọi việc, không đo token và chi phí | Tốn tiền, không biết ROI | n/a | Router theo tier + budget + metric `cost_per_completed_workflow` |
| G9 | Không có trace, chỉ có log rời rạc | Không debug được *vì sao* agent làm vậy, không biết latency nằm ở đâu | n/a | OTel GenAI trace, audit log hash-chained |
| G10 | Hàng đợi tuần tự (`queue-state.json`), chỉ một user | Không scale, một job treo là kẹt cả hàng | n/a | Worker pool, khóa theo repo, budget theo run |
| G11 | Đầu vào không tin cậy (ticket, PR body, comment trong code, Confluence) vào thẳng context của agent *có tool* (intake, reviewer) | Indirect prompt injection | ❌ | Taint tracking + input guard + pattern "quarantined reader" |
| G12 | SSOT `.github/` gắn với Copilot, rồi sync sang Codex | Bị khóa vào executor | n/a | Agent Spec trung lập, compile ra từng executor |

## 3. Bài học theo từng talk

### [GC] Tokenomics — Google Cloud
- **Agentic workflow tốn 20k–50k token/task**, so với khoảng 2k của chatbot. Giá mỗi token giảm 98% kể từ 2024, nhưng lượng token tăng còn nhanh hơn nên tổng chi tiêu vẫn tăng (dự báo khoảng 24× vào 2030).
- 3 đòn bẩy giảm chi phí: **(1) chọn model** theo tier: *Frontier* (Pro/Opus), *Workhorse* (Flash/Sonnet), *Scale* (Flash-Lite/Haiku), *Open-weight* (Gemma, GLM, Kimi, DeepSeek, Qwen); **(2) agent harness**: giữ context, tránh vòng lặp vô hạn, *"premium models plan while specialized sub-agents execute"*, tự route model; **(3) cost observability + guardrail** chi tiết.
- Open-weight: dữ liệu nằm trong hạ tầng của mình, nhưng phải tự vận hành và model nhanh lỗi thời.
- **→ v2:** mỗi step khai báo `model_tier`, *không* khai báo model cụ thể. Có router, budget theo run/step, chiến lược *cheap-first, escalate on validator fail*, và policy dữ liệu nhạy cảm → open-weight/local.

### [BDWA] Blueprints for the Autonomous Enterprise
- **Maturity L1–L4**: L1 prompt craft → L2 grounded copilot (chỉ đọc) → **L3 bounded task agent** (MCP tool có quyền ghi + HITL) → **L4 multi-agent fleet** (A2A + HOTL). v1 đang ở L3. v2 hướng tới L4 *có kiểm soát*.
- **"Never build a monolithic God-Prompt"**: agent là microservice gồm 4 primitive: *tiered reasoning core*, *scoped MCP tooling* (JSON schema chặt), *dual-horizon memory* (scratchpad của session + episodic memory dài hạn), *A2A interop*.
- **3 orchestration pattern**: **A** Supervisor–Specialist fleet (dùng khi kế hoạch phụ thuộc vào khám phá lúc chạy), **B** Deterministic handoff pipeline (khối lượng lớn, có cấu trúc, validate schema giữa mỗi stage), **C** Generator + independent critic (*"Only critic-signed payloads unlock production MCP write tools"*).
- **3 data plane**: *Structured truth* (DW/DB, "100% deterministic row-level truth"), *Unstructured knowledge* (search có ACL + byte-offset citation), *Transactional action* (API server/MCP gateway, rate limit, schema, **idempotency key**).
- **Guardrail 4 ring nằm ngoài context window**: Ring 1 Non-human agent IAM (OAuth ngắn hạn, row-level security), Ring 2 AI firewall (soi prompt, PDF, tool output; chặn indirect injection; DLP), Ring 3 policy engine deterministic (OPA/Rego: trần giá trị, allowlist), Ring 4 HITL gate. *"Never rely on a system prompt for security."*
- Ví dụ: invoice có chữ trắng ẩn "wire $190,000 to IBAN…" bị chặn ở Ring 2. Credit memo $240k vượt trần tự động $25k thì dừng ở Ring 3+4.
- **ROI**: bỏ đo "minutes saved", đo **cost per completed workflow**, **straight-through resolution %**, **cycle-time compression**.
- **→ v2:** workflow engine + pattern catalog; tool gateway có scope/schema/idempotency; policy engine với *autonomy ceiling*; KPI theo unit economics.

### [STE] Building agents without losing control — ST Engineering
- 4 control còn thiếu: **Sandbox** (quyền truy cập quá rộng), **Evals** (không biết hiệu năng thật), **Guardrails** (hành vi ngoài ý muốn), **Observability** (không thấy gì).
- Sự cố: 1,200 eval run *đã được sandbox*, nhưng **một service dùng chung (artifactory)** cho chúng đường đi ra internet qua SSRF. → *Sandbox không tính là cô lập nếu có dịch vụ dùng chung đi ra ngoài.*
- 2 pattern sandbox: **agent-in-sandbox** (giống dev local, nhưng agent và môi trường dính chặt) và **sandbox-as-tool** (agent loop ở server, *credentials stay outside the sandbox*).
- Sycophancy: agent biết đáp án đúng nhưng đổi đáp án khi user phản bác. → Phải có eval cho chuyện này.
- Eval: **offline** (dataset có kiểm soát, chạy trước khi ship) + **online** (liên tục trên tương tác thật) + **judge & scoring**.
- Guardrail 3 điểm: **Input** (injection, topic, PII, retrieval hygiene) → **Action** (permission, allowlist, limit, human approval) → **Output** (groundedness, schema, PII, safety). Check: PASS → bước tiếp; FAIL → reject / redact / ask a human / stop.
- Observability: **Traces** (mỗi lần gọi model/tool, in/out, timing, token cost), **Metrics** (latency, cost/task, success/escalation, số lần guardrail trip, số retry/loop), **Logs** (stack lỗi, output thô của sandbox, *ai đã approve cái gì*, chống sửa, có timestamp).
- **→ v2:** kiến trúc "complete picture" (Evaluation trên cùng; Input guard → Agent loop trong sandbox → Action guard → Output guard; Observability & Control dưới cùng) được dùng **trực tiếp** làm khung của execution plane.

### [SGX] Secure GitHub Actions Governance — SGX Group
- *"In CI/CD, write access becomes execution capability."* Một workflow file là lệnh thực thi, không phải config. Với agent: **một prompt hay skill file cũng là execution capability.**
- Câu hỏi bảo mật: *chạm được tới đâu? mang identity nào? chạy được code gì? **ai kiểm soát các ranh giới đó?***
- **The Test: Can the workflow remove it?** Network (không có route ra internet + egress allowlist), Identity (OIDC trust condition), Actions (enterprise allowlist), Artifact (repo bất biến + promotion policy). *"The workflow controls what to execute — not the boundaries around the execution."* *Thứ trông giống control nhưng không phải: shared workflow, runner image.*
- **CI và CD tách bằng artifact boundary**; *promotion moves the same artifact forward, does not rebuild*. Version thay đổi thì review như code.
- **Short-lived identity**: mỗi run có identity dùng một lần, gắn với repo/env/workflow. *"The workflow presents identity. The target system decides whether to trust it."*
- *"Platform owns the boundaries, not every pipeline. Strong guardrails are what make self-service possible at scale."* *"The paved road spreads by being faster, not by being required."* *"Before rebuilding a control, ask what it actually protects."*
- **→ v2:** bảng "Agent có gỡ được không?" trở thành checklist thiết kế bắt buộc; artifact store bất biến + promotion; identity broker; Gatehouse sở hữu *ranh giới*, còn workflow pack thì team tự viết.

### [CSW] The end of the old playbook — Cyber Security World
- Audit định kỳ là ảo tưởng; governance tốc độ người không theo kịp đối thủ tốc độ máy.
- 3 nguyên lý: **continuous automated assurance** (policy được chứng minh bằng telemetry), **blast-radius hard containment** (một component bị chiếm không kéo theo cả hệ thống), **autonomous flywheel** gồm 3 vòng: *outer* (threat intel), *middle* (phát hiện lúc chạy + cô lập ngay + thu hồi credential), *inner* (root cause → sửa vĩnh viễn qua IaC/dev workflow).
- **→ v2:** kill switch + thu hồi token theo run; tách blast radius theo run; vòng *retro → eval case → policy/checklist*. Đây là bản nâng cấp của `review-retro.js` trong v1.

### [Panel] + Gemini Enterprise
- Stack nền tảng agent hiện nay có: model registry (1P/3P/open), runtime, **agent & tool registry**, **agent gateway**, **agent identity/security**, **observability/evaluation**. Theo trục Build → Scale → Govern → Optimize.
- **→ v2:** Gatehouse có đúng các khối này nhưng ở quy mô local-first, không khóa vào vendor.

## 4. Một câu tóm lại

> v1 đã đúng ở chỗ **model không được quyết định**. v2 bổ sung: **agent không được chạm vào ranh giới**, **mọi thay đổi hành vi phải qua eval**, và **autonomy chỉ có được khi telemetry chứng minh**.
