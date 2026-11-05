---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 16
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-05T20:22:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-05T20:22:16-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "'rascunho' names both a processing status (F03) and a publication state (F04)"
  - id: AMB-2
    status: open
    summary: "'até 10GB' unit undefined: 10×10^9 bytes (GB) or 10×1024^3 bytes (GiB)"
  - id: MD-1
    status: resolved
    summary: "No TD fixes the canonical env var keys for storage, queue and upload limits"
    resolved_by: phase-03-videos/TD-12
  - id: MD-2
    status: resolved
    summary: "No TD defines which video container/MIME types the upload accepts"
    resolved_by: phase-03-videos/TD-13
  - id: DG-1
    status: open
    summary: "Worker needs ffmpeg/ffprobe but phase-01 Dockerfile.dev image ships neither"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Message Queue Technology"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Large File Upload Protocol (up to 10GB)"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Object Storage Layout and Access Model"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Local S3-Compatible Server Distribution"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Video Worker Runtime"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Media Metadata and Thumbnail Extraction"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — Unique Video URL Identifier"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Streaming and Download Delivery"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Access Policy for Video Consumption Endpoints in Phase 03"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Video Status Lifecycle and Failure Handling"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Test Strategy for Storage, Queue and Worker"
  - id: OQ-12
    status: open
    summary: "TD-12 pending — Canonical Environment Configuration for Storage, Queue and Uploa"
  - id: OQ-13
    status: open
    summary: "TD-13 pending — Accepted Upload Media Types"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._
### Ambiguities

- **AMB-1** — The capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" (Fase 03) and the Fase 04 neighbor "Fluxo de rascunho → publicação" both use *rascunho*. If Phase 03 models `draft` as a **processing** status (upload in progress, per TD-10's recommendation `draft → processing → ready | failed`), Fase 04 must not reuse the same column for **publication** state, or a `ready` video could never be a "rascunho" awaiting publication. Explicit choice: confirm that the Phase 03 `status` column models only the upload/processing lifecycle and that publication state is a separate concern added by Fase 04 (record it in TD-10).
- **AMB-2** — "Upload de vídeos com suporte a arquivos de até 10GB" does not fix the unit. TD-02's recommendation proposes 10 GiB (10 × 1024³ = 10,737,418,240 bytes) while the capability text says "10GB" (10 × 10⁹ = 10,000,000,000 bytes). The boundary value is enforced by DTO validation and by the completion size check, and the frontend will mirror it. Explicit choice: fix the exact byte limit in TD-02 (Revision or Decision text).
### Missing Decisions

_None._
### Dependency Gaps

- **DG-1** — TD-05/TD-06 (pending) assume the worker runs `ffprobe`/`ffmpeg`, but the inherited dev image (`nestjs-project/Dockerfile.dev`, phase 01) installs only `procps curl`. Processing ("Processamento automático…") and thumbnail ("Geração automática de thumbnail…") capabilities therefore depend on an infrastructure change that no prior phase delivers. Explicit choice: make the image change (FFmpeg installed in the dev image used by `nestjs-api` and the worker) an explicit prerequisite of the processing work, ordered before it in the plan.
### Inherited Constraint Conflicts

_None._ _(No current-scope TD is decided yet; conflicts are evaluated against decided TDs only.)_
### Unresolved Open Questions

- **OQ-1** — phase-03-videos/TD-01 pending — Message Queue Technology. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-2** — phase-03-videos/TD-02 pending — Large File Upload Protocol (up to 10GB). Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-3** — phase-03-videos/TD-03 pending — Object Storage Layout and Access Model. Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-4** — phase-03-videos/TD-04 pending — Local S3-Compatible Server Distribution. Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-5** — phase-03-videos/TD-05 pending — Video Worker Runtime. Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-6** — phase-03-videos/TD-06 pending — Media Metadata and Thumbnail Extraction. Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-7** — phase-03-videos/TD-07 pending — Unique Video URL Identifier. Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-8** — phase-03-videos/TD-08 pending — Streaming and Download Delivery. Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-9** — phase-03-videos/TD-09 pending — Access Policy for Video Consumption Endpoints in Phase 03. Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-10** — phase-03-videos/TD-10 pending — Video Status Lifecycle and Failure Handling. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-11** — phase-03-videos/TD-11 pending — Test Strategy for Storage, Queue and Worker. Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-12** — phase-03-videos/TD-12 pending — Canonical Environment Configuration for Storage, Queue and Upload. Resolution: fill the **Decision:** field of TD-12 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-13** — phase-03-videos/TD-13 pending — Accepted Upload Media Types. Resolution: fill the **Decision:** field of TD-13 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
### UI Coverage Gaps

_None._ _(No UI scope in this phase.)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-12)_ — No TD fixes the canonical env var keys for storage, queue and upload limits. New TD added by /research; its own decision is tracked as OQ-12.
- **MD-2** _(resolved_by phase-03-videos/TD-13)_ — No TD defines which video container/MIME types the upload accepts. New TD added by /research; its own decision is tracked as OQ-13.
