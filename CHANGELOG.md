# Changelog

## 1.0.16 - 2026-10-02

### Added

- Added explicit current-branch or all-branches export selection. Existing export commands retain their all-branches default; append `branch` to export only the current leaf's ancestry.
- Added `/thinking-steps review [branch|all]`, a read-only terminal browser for recorded prompts, responses, provider-supplied thinking, and derived steps.
- Added session-specific, opt-in automatic exports with confirmation, format/scope/content controls, and retention of 1–50 owned snapshots. Defaults are JSON, current branch, thinking only, and 10 snapshots; autosaving is off until enabled. Manual exports are never pruned.
- Added compatibility CI for Node 22.19.0/24 and Pi 0.99.2/1.0.0, including real bundled-host loader checks.

### Fixed

- Made published tests self-contained instead of requiring unpublished workflow documents or the repository lockfile. Added an actual packed/extracted-package validation command and a separate repository lockfile check.

### Tests

- Added 11 branch-selection, review-browser, autosave-consent, privacy, retention, and failure-path regressions.
- Validated 186 behavior/metadata tests, a separate lockfile integrity test, extracted-package tests, and real Pi 0.99.2/1.0.0 host smoke checks covering rendering, export, review, autosave, and cleanup.

## 1.0.15 - 2026-10-02

### Changed

- Updated README and package repository, homepage, and issue links to the canonical `crustyhacker/pi-thinking-steps` repository.
- Added an npm badge and installation quick start, with prominent always-visible panel and session-export highlights.
- Clarified how to begin using the published package and where to find export privacy guidance and release notes. No runtime behavior or dependency changes.

## 1.0.14 - 2026-10-01

### Added

- Kept a thinking panel visible for every assistant message in compatible terminal sessions, with honest waiting or missing-content labels when no thinking text is supplied.
- Added `/thinking-steps export json`, `export markdown`, and `export both` for manual session-linked prompt and thinking-tree snapshots across all recorded branches.
- Saved exports in private directories beside the session, with durable local file links outside model context. Exports include available thinking and derived steps, but exclude provider signatures, redacted payloads, image bytes, and tool/custom-entry contents.

### Tests

- Added 15 tests covering panel transitions, export formats, branch relationships, private file permissions, session attachment/reopening, payload exclusions, and failure handling.
- Validated 175 tests and a bundled Pi 1.0.0 loader smoke check for modes, Alt+T, exports, session links, model-context isolation, and reversible cleanup.

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
