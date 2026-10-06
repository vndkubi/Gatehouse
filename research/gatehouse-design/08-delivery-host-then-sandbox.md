# 08 — Lộ trình giao hàng: Host mode trước, Sandbox sau

Tài liệu này điều chỉnh [04-roadmap.md](04-roadmap.md). Toàn bộ thiết kế (01–07) vẫn giữ nguyên, nhưng thứ tự giao hàng đổi để **dùng được sớm**:

| Version | Môi trường | Workflow đầu tiên | Isolation |
|---|---|---|---|
| **A, Host mode** | Máy dev đã có sẵn toolchain (Windows native, và cả WSL/Linux) | PR Review | Cùng OS user, giảm rủi ro |
| **B, Máy mới** | Gatehouse tự dựng sandbox (runc / gVisor / Kata) từ source (07) | Như A | Run Cell (05) |

## 1. Seam: `ExecutionTarget`

```ts
interface ExecutionTarget {
  kind: 'host' | 'cell';
  prepare(run, repo, sha, env): Promise<Workspace>;      // worktree (host) hoặc volume (cell)
  exec(ws, argv, opts): Promise<ExecResult>;              // build / test, không qua shell
  runAgent(ws, adapter, step): Promise<CandidateBundle>;
  destroy(ws): Promise<void>;
}
```

Workflow, gateway, MCP proxy, gate và console chỉ biết tới interface này. B chỉ thêm `CellTarget`.

`env.yaml` có thêm `target: host | cell`. Ở host mode, `toolchain` là **fingerprint đo được** từ máy (vd. `mvn -v` báo JDK 21 nhờ `mavenrc_pre.cmd`, trong khi `java` trên PATH là JDK 11), không phải thứ cần cài.

## 2. Version A: giữ gì, nới gì

| Control | Host mode | Cell mode |
|---|---|---|
| Engine deterministic, event log hash-chain, CAS | ✅ | ✅ |
| Gate có chữ ký | ✅ Approve bằng **WebAuthn (Windows Hello/passkey)**. Chữ ký nằm trên `(gate, artifact_hash)`, nên agent chạy cùng user cũng không giả được | ✅ |
| LLM qua Gateway + DLP + budget | ✅ Copilot BYOK + `COPILOT_OFFLINE=true`; Codex `model_providers` → `127.0.0.1` | ✅ |
| Không có secret trong env của executor | ✅ Lọc env theo allowlist | ✅ |
| Mask instruction file | ✅ Ghi đè trong worktree tạm | ✅ |
| Cô lập filesystem/network | ⚠️ Không có ranh giới thật (cwd = worktree, flag tool của CLI, DLP ở gateway) | ✅ |
| Song song | ⚠️ Mỗi repo chỉ 1 step chạy test cùng lúc (~/.m2, port, DB local dùng chung) | ✅ |

**Rủi ro còn lại:** agent đọc được file ngoài worktree. Chỉ dùng host mode cho repo và PR của team. PCI: bắt buộc Mode G + DLP preflight; máy dev không được chứa CHD; cần QSA xác nhận.

**Đặc thù khi chạy trên host:**
- Không đổi `USERPROFILE`/`HOME`, nếu không `mavenrc_pre.cmd` và `~/.m2` sẽ bị mất. Config của CLI được cô lập bằng biến riêng (`CODEX_HOME`, …).
- Windows: Node ≥ 20 không spawn trực tiếp `.cmd` được nữa (CVE-2024-27980). Gọi qua `cmd.exe /d /s /c` với argv đã escape, hoặc resolve ra `node <entry.js>`.
- Kill cả cây process (`taskkill /T /F` / process group); có timeout.
- `core.longpaths=true`; giữ line ending theo `.gitattributes`.

**Milestones:** A0 skeleton → A1 onboarding repo (detect + verify trên host + GATE_ENV) → A2 HostTarget + adapter Copilot/Codex → A3 LLM Gateway → A4 MCP Proxy (read-only) → A5 PR Review → A6 Console + WebAuthn gate + Publisher.

## 3. Version B: thời gian và khả năng chạy test

Ước lượng cho một service Spring Boot cỡ vừa (200–500 dependency), mạng 50–100 Mbps, máy 8 luồng / 23 GB. **Sẽ đo lại ở B0.**

| Giai đoạn | Cold | Warm |
|---|---|---|
| Bootstrap máy mới (WSL Ubuntu, runtime, base image) | 15–30 phút, một lần | — |
| Toolchain layer (JDK + Maven) | 1–3 phút | 0 (dùng chung giữa các repo) |
| Onboarding một repo (clone, detect, prefetch deps, compile, baseline) | 15–40 phút, một lần cho mỗi repo (≈1 phút nếu seed mirror từ `~/.m2` của host) | Incremental khi lockfile/CI đổi |
| Tạo cell + materialize + DLP preflight | — | runc/gVisor 5–30 giây; Kata 10–40 giây |
| Chạy test so với host | — | runc ~1.0×; gVisor 1.2–2×; Kata 1.1–1.5× |
| Tổng overhead cho 1 PR review | — | khoảng +30–90 giây |

**Có chạy được test không:**
- L1/L2: khả năng cao nếu repo có CI chạy trên Linux mà không cần secret.
- L3: service khai báo trong spec thì chạy được. Testcontainers chỉ chạy được trên Kata. Hệ thống ngoài → `ENVIRONMENT_BLOCKED`.
- Rủi ro: repo dev trên Windows có thể fail trên Linux (đường dẫn, CRLF, locale). Nexus nội bộ phải được cấu hình trong mirror.

**Thước đo khách quan: parity check.** So tập test pass trên host (baseline của A) với tập test pass trong cell.

**Milestones:** B0 spike đo trên 3–5 repo thật → B1 CellTarget (runc/gVisor) + build image → B2 Kata + Testcontainers → B3 Env Doctor + drift → B4 `gatehouse bootstrap` cho máy mới.

## 4. Trạng thái triển khai (2026-10-06)

| Hạng mục | Trạng thái | Ở đâu |
|---|---|---|
| Version A (A0–A6) | Xong, đã chạy thật (petclinic L2, review PR ecommerce-jhipter#1) | `packages/*`, README |
| Parity PR review (T/B/V/S, risk routing, blast radius, HTML, retro, workflow YAML) | Xong | `packages/workflows`, `registry/` |
| Webapp (dashboard, PR + nút Review, queue, Settings/Secrets ký passkey, Evals, gate trung gian tự chạy tiếp, gate cuối tự publish) | Xong | `packages/console` |
| Ticket → PR, Legacy tests | Xong (test tích hợp với agent/Maven giả); chưa chạy thật end-to-end | `ticket.ts`, `legacy.ts` |
| IDE: Agent Spec trung lập + compiler, slash command (VS Code/Copilot, Codex, Claude Code), `gatehouse mcp serve` | Xong | `registry/agents/*/agent.yaml`, `registry/ide/`, `compile.ts` |
| B1 CellTarget (runc; gVisor/Kata qua `cell.runtime`) + warm cache | Xong; runc chạy thật | `cell-target.ts` |
| B0 parity (`env parity`) | Xong | `sandbox.ts` |
| B4 readiness (`bootstrap --check`, chỉ đọc, không cài gì) | Xong | `sandbox.ts` |
| B2 Kata + Testcontainers, B3 Env Doctor/drift | Chưa | — |

Khác với thiết kế ban đầu: bản compile của Agent Spec **không** mount vào workspace. Adapter truyền prompt trực tiếp, còn file instruction của repo bị mask, nên ranh giới chặt hơn. Bản compile dùng cho người: chạy agent bằng tay trong IDE và xem agent đã được dặn gì.
