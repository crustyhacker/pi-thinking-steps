# Pi Thinking Steps

<div align="center">
  <img src="./assets/readme-hero.svg" alt="Pi Thinking Steps hero graphic showing collapsed, summary, and expanded terminal views" width="1100" />
</div>

<p align="center">
  <strong>Faithful, terminal-native thinking visualization for Pi.</strong><br />
  Turn raw provider reasoning into a clean, structured TUI view without changing what it means.
</p>
<p align="center">
  <a href="https://github.com/fluxgear/pi-thinking-steps/releases/tag/v1.0.11"><img alt="release" src="https://img.shields.io/badge/release-v1.0.11-4f46e5" /></a>
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

Today, the patch relies on these internal modules in `@mariozechner/pi-coding-agent`:

- `dist/modes/interactive/components/assistant-message.js`
- `dist/modes/interactive/theme/theme.js`

When available (Pi >= 0.84), it additionally loads `dist/modes/interactive/components/markdown-transform.js` on a best-effort basis so assistant text keeps Pi's markdown transformers (mermaid/LaTeX rendering). On the pinned Pi version that module does not exist and the patch falls back to its legacy Markdown construction, which is not treated as a patch failure.

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

The current package uses Pi package version `0.69.0` as runtime dependencies in `package.json`, and compatibility-sensitive upgrades must update `package-lock.json` in the same change.

---

## Quick start

From the repository root:

```bash
pi -e ./index.ts
```

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
- `state.ts` — shared mode, active-thinking state, patch lifecycle state
- `types.ts` — shared contracts
- `test/thinking-steps.test.ts` — unit and integration coverage
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
