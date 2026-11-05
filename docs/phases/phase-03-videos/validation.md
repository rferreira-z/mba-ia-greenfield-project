---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 1
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-05T20:25:20-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-05T20:23:27-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "'rascunho' names both a processing status (F03) and a publication state (F04)"
    resolved_by: phase-03-videos/TD-10
  - id: AMB-2
    status: resolved
    summary: "'até 10GB' unit undefined: 10×10^9 bytes (GB) or 10×1024^3 bytes (GiB)"
    resolved_by: phase-03-videos/TD-02
  - id: MD-1
    status: resolved
    summary: "No TD fixes the canonical env var keys for storage, queue and upload limits"
    resolved_by: phase-03-videos/TD-12
  - id: MD-2
    status: resolved
    summary: "No TD defines which video container/MIME types the upload accepts"
    resolved_by: phase-03-videos/TD-13
  - id: DG-1
    status: resolved
    summary: "Worker needs ffmpeg/ffprobe but phase-01 Dockerfile.dev image ships neither"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Message Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Large File Upload Protocol (up to 10GB)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Object Storage Layout and Access Model"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Local S3-Compatible Server Distribution"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Video Worker Runtime"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Media Metadata and Thumbnail Extraction"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Access Policy for Video Consumption Endpoints in Phase 03"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Video Status Lifecycle and Failure Handling"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Test Strategy for Storage, Queue and Worker"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Canonical Environment Configuration for Storage, Queue and Uploa"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Accepted Upload Media Types"
    resolved_by: phase-03-videos/TD-13
  - id: ICC-1
    status: open
    summary: "TD-11 (real MinIO in tests) conflicts with testing guide storage strategy"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._
### Ambiguities

_None._
### Missing Decisions

_None._
### Dependency Gaps

_None._
### Inherited Constraint Conflicts

- **ICC-1** — Decided phase-03-videos/TD-11 (A — real MinIO/Redis/FFmpeg from Compose in integration and e2e tests) contradicts the inherited testing requirement in `## Testing Requirements` ("Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) **or local adapter**") and the `testing-guide-nestjs-project` reference `references/external-systems.md` § "Object Storage — Local Filesystem" ("Local filesystem storage in development and tests. S3 in production."). Following the guide would require a storage abstraction with a filesystem adapter that cannot exercise presigned multipart or range/206 (TD-02/TD-08). Explicit choice: (a) reaffirm TD-11 and record that the guide's storage section is superseded for this project (the plan must update `references/external-systems.md` and its queue section, which is still "TBD"); or (b) supersede TD-11 in favour of the filesystem adapter.
### Unresolved Open Questions

_None._
### UI Coverage Gaps

_None._ _(No UI scope in this phase.)_

## Resolved Issues

- **AMB-1** _(resolved_by phase-03-videos/TD-10)_ — 'rascunho' names both a processing status (F03) and a publication state (F04). Clarified in TD-10 **Note:** `status` models only upload/processing; publication is a separate Fase 04 concern.
- **AMB-2** _(resolved_by phase-03-videos/TD-02)_ — 'até 10GB' unit undefined: 10×10^9 bytes (GB) or 10×1024^3 bytes (GiB). Clarified in TD-02 **Note:** limit is 10 GiB = 10,737,418,240 bytes (inclusive).
- **MD-1** _(resolved_by phase-03-videos/TD-12)_ — No TD fixes the canonical env var keys for storage, queue and upload limits. New TD added by /research; its own decision is tracked as OQ-12.
- **MD-2** _(resolved_by phase-03-videos/TD-13)_ — No TD defines which video container/MIME types the upload accepts. New TD added by /research; its own decision is tracked as OQ-13.
- **DG-1** _(resolved_by phase-03-videos/TD-05)_ — Worker needs ffmpeg/ffprobe but phase-01 Dockerfile.dev image ships neither. TD-05 **Note:** FFmpeg installed in the shared dev image, ordered as the first plan step.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 pending — Message Queue Technology. Decision recorded (Recommendation accepted).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 pending — Large File Upload Protocol (up to 10GB). Decision recorded (Recommendation accepted).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 pending — Object Storage Layout and Access Model. Decision recorded (Recommendation accepted).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 pending — Local S3-Compatible Server Distribution. Decision recorded (Recommendation accepted).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 pending — Video Worker Runtime. Decision recorded (Recommendation accepted).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 pending — Media Metadata and Thumbnail Extraction. Decision recorded (Recommendation accepted).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 pending — Unique Video URL Identifier. Decision recorded (Recommendation accepted).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 pending — Streaming and Download Delivery. Decision recorded (Recommendation accepted).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 pending — Access Policy for Video Consumption Endpoints in Phase 03. Decision recorded (Recommendation accepted).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 pending — Video Status Lifecycle and Failure Handling. Decision recorded (Recommendation accepted).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 pending — Test Strategy for Storage, Queue and Worker. Decision recorded (Recommendation accepted).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 pending — Canonical Environment Configuration for Storage, Queue and Uploa. Decision recorded (Recommendation accepted).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 pending — Accepted Upload Media Types. Decision recorded (Recommendation accepted).
