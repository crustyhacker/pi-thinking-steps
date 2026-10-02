# Pi Thinking Steps

<div align="center">
  <img src="./assets/readme-hero.svg" alt="Pi Thinking Steps hero graphic showing collapsed, summary, and expanded terminal views" width="1100" />
</div>

<p align="center">
  <strong>Faithful, terminal-native thinking visualization for Pi.</strong><br />
  Turn raw provider reasoning into a clean, structured TUI view without changing what it means.
</p>
<p align="center">
  <a href="https://github.com/crustyhacker/pi-thinking-steps/releases/tag/v1.0.15"><img alt="release" src="https://img.shields.io/badge/release-v1.0.15-4f46e5" /></a>
  <a href="https://www.npmjs.com/package/pi-thinking-steps"><img alt="npm version" src="https://img.shields.io/npm/v/pi-thinking-steps" /></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-16a34a" /></a>
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-strict-3178c6" />
  <img alt="ui" src="https://img.shields.io/badge/UI-terminal--native-f59e0b" />
</p>

---

## Why this exists

Pi already exposes provider thinking, but raw reasoning streams are hard to scan in a real terminal. Pi Thinking Steps keeps the source text faithful while making it dramatically easier to follow:

- less visual noise while a model is still thinking
- more structure when you want the reasoning flow at a glance
- cleaner full-detail rendering when you need to inspect the exact text
- no invented reasoning, synthetic logic, or browser-style chrome

The goal is simple: **preserve meaning, improve readability, and stay native to Pi's TUI.**

---

## Visual tour

<div align="center">
  <img src="./assets/modes-overview.svg" alt="Overview of the collapsed, summary, and expanded thinking modes" width="1100" />
</div>

---

## What you get

- **Three focused modes** — `collapsed`, `summary`, `expanded`
- **Always-visible thinking panels** — honest waiting or missing-content indicators when the provider supplies no thinking text
- **Session-linked review files** — manually export prompts and available thinking as a branching tree in JSON, Markdown, or both
- **Terminal-first rendering** — width-aware, ANSI-safe, and live-update friendly
- **Faithful parsing** — deterministic step derivation and restrained summarization
- **Markdown-aware output** — headings, bullets, ordered lists, code spans, and emphasis render cleanly
- **Scoped persistence** — session, project, and global defaults with predictable restore precedence
- **Patch safety** — isolated, reversible, reference-counted runtime patching
- **Regression coverage** — parser, renderer, lifecycle, compatibility, and metadata checks

---

## The three modes

| Mode | Best for | Behavior |
|---|---|---|
| `collapsed` | Live active thinking | Shows a width-aware compact preview of the highest-signal active step; it may wrap in narrow terminals |
| `summary` | Flow at a glance | Shows a chronological top-N set of salient summaries, preserving active, failure, success, and decision context when space is limited |
| `expanded` | Deep inspection | Shows the full step text in a cleaner, structured terminal layout |

### `collapsed`
Use it when you want the smallest possible thinking footprint while the model is still working.

### `summary`
Use it when you want to understand the reasoning path quickly without reading the full transcript.

### `expanded`
Use it when you want the whole text, but formatted for a terminal instead of dumped as a raw stream.

---

## Control surface

| Action | Control |
|---|---|
| Cycle thinking view | `Alt+T` |
| Choose a mode interactively | `/thinking-steps` |
| Set session mode | `/thinking-steps collapsed` / `summary` / `expanded` |
| Save a project default | `/thinking-steps project <mode>` |
| Save a global default | `/thinking-steps global <mode>` |
| Clear a project default | `/thinking-steps project clear` |
| Clear a global default | `/thinking-steps global clear` |
| Export the session thinking tree | `/thinking-steps export json` / `export markdown` / `export both` |

---

## Persistence and restore precedence

Mode restoration follows this order:

1. session history
2. project default from `.pi/thinking-steps.json`
3. global default from `~/.pi/agent/state/thinking-steps.json`
4. built-in default `summary`

Use plain `/thinking-steps <mode>` when the choice should stay local to the current session. Use `project` or `global` when you want future sessions to inherit that choice automatically.

---

## Example output

### Summary

```text
┆ Thinking Steps · Summary
├─ ◫ Inspect the current renderer implementation.
├─ ↔ Compare how visibility toggling works.
└─ ✓ Verify the refresh path after mode changes.
```

### Expanded

```text
┆ Thinking Steps · Expanded
├─ ◫ Inspect the current renderer implementation.
│  Inspect the current renderer implementation.
├─ ↔ Compare how visibility toggling works.
│  Compare how visibility toggling works.
└─ ✓ Verify the refresh path after mode changes.
   Verify the refresh path after mode changes.
```

### Collapsed

```text
│ Thinking ✓ Verify the refresh path after mode changes. ·
```

---

## Rendering behavior

Pi Thinking Steps is built to improve readability **without changing meaning**.

### Always-visible panel

Every assistant message rendered by a compatible terminal session has a thinking panel in all three modes, including text-only and tool-only responses. Before thinking text arrives it says **Waiting for thinking content**; when a response finishes without any, it says **No thinking content supplied**. Provider-redacted blocks remain marked as hidden. These are availability indicators, not generated reasoning. The extension cannot force a provider to expose thinking or recover hidden content.

### Manual session exports

Run `/thinking-steps export json`, `/thinking-steps export markdown`, or `/thinking-steps export both` while the session is idle. There is no automatic saving. Exports require a persistent session; in-memory sessions receive a clear warning instead.

Each export creates a new private directory beside the session file (`<session-file>.thinking-steps-<unique suffix>`), with `thinking-steps.json`, `thinking-steps.md`, or both. Directories use owner-only permissions and files use mode `0600` on POSIX systems. Repeated exports create independent snapshots rather than overwriting files. Failed writes remove the incomplete export; errors are reported.

A durable `thinking-steps.export` custom entry attaches file references to the session without adding the export to model context or triggering another turn. The transcript displays local file links when this extension is loaded, including after restarting. File links remain local: moving/deleting a session or export does not move/repair those absolute paths. If the session changes while saving, files are kept and their paths reported, but they are not attached to a different session or branch.

**Privacy and scope:** exports contain all recorded branches in the current session file, including abandoned branches and original prompts before later context edits. They are archival snapshots, not reconstructions of the current model context. Separate forked session files are not followed. Treat exports as sensitive conversation data and review them before sharing.

JSON schema version `1` stores session/leaf IDs and a flat tree of entries linked by their original `id` and `parentId`. User text, assistant response text, available thinking blocks, and every derived step are included independently of the selected display mode. Provider signatures, redacted block payloads, image bytes, tool arguments/results, system prompts, and custom-entry payloads are excluded; structural entries retain only metadata to keep branch links intact. Markdown provides a linked tree plus prompt, response, thinking-block, and detailed-step sections. Deep trees cap visual indentation but retain exact parent links. Text is fenced to prevent Markdown/HTML injection, and terminal controls are shown as escapes in Markdown; JSON preserves the supplied text.

### Parsing and step derivation

The parser uses deterministic rules to keep step boundaries believable and stable. Examples:

- standalone markdown headings stay attached to the body they introduce
- list items split into separate steps when that improves scanability
- blank-line continuation paragraphs stay attached to the correct list item
- standalone concluding prose after a list stays separate from the final list item
- provider-hidden reasoning remains clearly marked as hidden

### Display formatting

The renderer normalizes markdown-like content for terminal display:

- headings render as headings instead of leaking raw `#` markers
- unordered list items render with clean bullets
- ordered and lettered list markers are preserved
- backticks render as code-styled inline text
- emphasis markers render cleanly instead of leaking raw `*...*` / `_..._`
- raw control sequences from model output are stripped before rendering

### Terminal-first constraints

This extension is designed for a real terminal, not a browser UI. That means:

- width-aware wrapping matters
- ANSI-safe rendering matters
- over-decoration is intentionally avoided in the live TUI
- the output should remain readable in narrow layouts

---

## Technical approach

Pi currently exposes only a minimal public hook for built-in thinking rendering: `setHiddenThinkingLabel`.

To deliver a full three-mode thinking view, Pi Thinking Steps patches Pi's internal `AssistantMessageComponent` at runtime and replaces the default visible thinking rendering path with a custom renderer.

That patch layer is:

- **isolated** — patching lives in `internal-patch.ts`
- **reversible** — cleanup restores original methods
- **reference-counted** — multiple retain/release paths are handled safely
- **guarded** — compatibility checks fail loudly when Pi internals drift
- **tested** — integration and regression coverage protects the patch lifecycle

---

## Compatibility contract

This extension intentionally depends on Pi's current internal TUI implementation.

The patch is validated against the unbundled Pi `0.99.2` development host and the bundled Pi `1.0.0` CLI.

`AssistantMessageComponent` is imported from the host's public `@earendil-works/pi-coding-agent` API, so the patch targets the class that Pi actually renders. A deep import of `dist/modes/interactive/components/assistant-message.js` can return a separate, unused class in bundled Pi installations. Terminal sessions supply their active `ctx.ui.theme` rather than using a separate theme instance.

The remaining internal module dependencies are:

- `dist/modes/interactive/components/markdown-transform.js` for native assistant-text transforms
- `dist/modes/interactive/theme/theme.js` only for direct patch callers that do not supply a UI theme

These internal helpers are resolved from the running Pi host via its public `getPackageDir()` API, rather than from a separate extension-local Pi installation. The patch preserves native response padding, assistant-text Markdown transforms, streaming state, terminal message markers, and truncation/error notices. It is installed only in terminal (`tui`) sessions; RPC, JSON, and print sessions retain their native rendering.

That means:

- upstream Pi internal changes can break the patch layer
- Pi upgrades should be treated as deliberate compatibility work
- the pinned Pi package versions and `package-lock.json` matter
- `npm test` is part of the maintenance contract, not an optional extra
- if patch install fails during `session_start`, the current session stays on Pi's native thinking renderer and live mode switching is disabled for that degraded session
- project/global default saves and clears remain available during a degraded session, but they apply only to future compatible sessions
- retained patch releases are scope-owned; cleanup runs on matching `session_shutdown`, failed final cleanup is retained for retry on a later matching same-scope shutdown, this package does not register a generic extension-unload hook, and missed shutdowns are not recovered by unrelated cwd shutdowns
- assistant message ownership is recorded from lifecycle events so patched rendering can keep a message on its original scope even if another scope becomes current later
- one registered extension instance still has a single active lifecycle scope for session-level events; Pi should not interleave new unowned sessions through one handler set without a new `session_start`/message ownership path

Pi packages are host-provided peer dependencies, with exact `0.99.2` development pins in `package.json`. Compatibility-sensitive upgrades must update `package-lock.json` in the same change. Node.js `22.19.0` or later is required by the current Pi packages.

---

## Quick start

### Install from npm

With Pi installed, add the published extension:

```bash
pi install npm:pi-thinking-steps
```

Restart Pi, then use `Alt+T` to cycle views or `/thinking-steps` to choose one. After a response finishes, run `/thinking-steps export both` to save a session-linked review. Exports include all recorded branches and may contain sensitive conversation data; see [Manual session exports](#manual-session-exports).

Find the package on [npm](https://www.npmjs.com/package/pi-thinking-steps) and release notes on [GitHub](https://github.com/crustyhacker/pi-thinking-steps/releases).

### Try a local checkout

From the repository root, using Pi `0.99.2` or `1.0.0`:

```bash
pi -e ./index.ts
```

If the npm package is already configured, test the checkout in isolation to avoid loading both copies:

```bash
pi --no-extensions -e ./index.ts
```

This disables other automatically loaded and built-in extensions for that invocation; it does not change your saved settings. Editing the checkout does not update an installed npm copy.

The package entry point is already configured in `package.json`:

```json
"pi": {
  "extensions": ["./index.ts"]
}
```

---

## Development

Install dependencies:

```bash
npm install
```

Run the full validation suite:

```bash
npm test
```

Typecheck only:

```bash
npm run build
```
---

## Published package contents

The package ships:

- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- the extension TypeScript sources
- `tsconfig.json`
- the published validation tests under `test/`
- the README SVG assets under `assets/`

That keeps the GitHub README, packaged validation surface, and published package presentation aligned.

---

## Project structure

- `index.ts` — extension entry point, commands, shortcut, lifecycle hooks
- `internal-patch.ts` — Pi runtime patching and cleanup
- `parse.ts` — thinking-step splitting, summaries, role inference, mode parsing
- `persistence.ts` — project/global mode preference storage
- `render.ts` — collapsed, summary, and expanded terminal rendering
- `export.ts` — session tree snapshots, JSON/Markdown serialization, private export files
- `state.ts` — shared mode, active-thinking state, patch lifecycle state
- `types.ts` — shared contracts
- `test/thinking-steps.test.ts` — unit and integration coverage
- `test/export.test.ts` — manual export, attachment, privacy, and always-visible panel coverage
- `test/summarizer-challenger.test.ts` — focused summarizer-regression coverage

---

## Design principles

1. **Readable over flashy**
   - The goal is clarity, not decoration.

2. **Faithful over clever**
   - The renderer should not invent meaning the source text does not support.

3. **Terminal-native over web-like**
   - The output should feel right in a terminal first.

4. **Small surface area**
   - Parsing, rendering, state, and patching stay deliberately separated.

5. **Strict validation**
   - Changes should be backed by tests, especially around patch lifecycle and compatibility.

---

## Versioning

For the canonical package version, see [`package.json`](./package.json). For release points, use the repository tags.

---

## License

This project is released under the [MIT License](./LICENSE).
