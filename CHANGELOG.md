# Changelog

## 1.0.13 - 2026-10-01

### Fixed

- Restored thinking-step rendering in Pi 1.0.0's bundled CLI by patching the public host `AssistantMessageComponent` rather than a separate deep-imported renderer.
- Used the active terminal UI theme while preserving three-mode switching, Alt+T, native rendering metadata, and reversible patch cleanup.

### Changed

- Documented bundled-host compatibility and isolated checkout testing without loading an installed npm copy twice.

### Tests

- Added a regression for public host renderer identity and UI-theme injection without deep renderer or theme modules.
- Validated all 160 tests and a real bundled Pi 1.0.0 loader smoke check covering mode switching, streaming, Markdown transforms, and cleanup.

## 1.0.11 - 2026-05-12

### Fixed

- Made final patch cleanup retryable across same-scope session-shutdown retries and cleared stale message ownership on shutdown before later session reuse.
- Preserved heading scope across intro-plus-list sections, split bare imperative post-list prose, demoted uncertain safer-plan wording ahead of decision/plan-change classification, narrowed reference-only issue/problem/warning error-role false positives, and stripped non-CSI ESC control residue from rendered thinking text.

### Changed

- Published `tsconfig.json` plus the advertised validation tests in the npm package, refreshed the README release metadata, and updated the audit prompts and project instructions to reflect the current release surface.
- Marked the local `plan.md` planning artifact as historical/non-authoritative and marked the archived v1 audit prompt as superseded by the canonical v2 prompt.

### Tests

- Added regressions for cleanup retryability, shutdown message rebinds, parser boundary cases, non-CSI ESC sanitization, package metadata contracts, and semantic summarizer assertions.
## 1.0.10 - 2026-05-11

### Fixed

- Isolated thinking patch release ownership and active thinking state across concurrent session scopes.
- Preserved message ownership through patched rendering, including reused message objects and duplicate timestamps.
- Hardened parser/summarizer handling for list continuations, failure vocabulary, plan-change wording, and visible summary metadata.
- Stripped ST-terminated terminal control payloads from rendered thinking text.

### Changed

- Clarified compatibility and workflow documentation for scope-owned cleanup, degraded sessions, tracked changelog handling, and local planning artifacts.
- Centralized persisted preference scope typing in shared contracts.

### Tests

- Added regressions covering scoped patch lifecycle, parser/summarizer edge cases, terminal control sanitization, package metadata contracts, and docs/workflow drift.

## 1.0.9 - 2026-05-06

### Fixed

- Prevented CPU saturation during long thinking streams by bounding baseline summarizer candidate scoring to a salient retained subset instead of processing an unbounded candidate list.
- Reduced hot-path allocation in summary similarity scoring by caching token sets per candidate and reusing them during comparisons.
- Preserved summary fidelity for late high-signal failure candidates while limiting generic candidate volume.

### Tests

- Added regressions for small-input failure summary preservation and late salient failure retention after large generic candidate sets.
