# pi-reflect — Agent Instructions

## Scope

This repo is a **pi extension** (not a standalone CLI). Entry point is `src/extension.ts` which registers commands via `pi.registerCommand()`. It analyzes session transcripts and edits behavioral markdown files.

## Non-Discoverable Commands

- **Tests**: `npm test` runs `node --import tsx --test tests/*.test.ts`. Uses Node's built-in `node:test`, not jest/vitest.
- **Type check**: `npx tsc --noEmit` (no separate build step; tsx handles runtime).

## Landmines

### LSP stale index after structural changes

After deleting directories or moving files (e.g., during refactors), the pi-lens LSP may retain stale exports. If edits are blocked with "Redefining existing export(s)", run:

```bash
rm -rf .pi-lens/
```

This is documented in `.pi/memos/` but not in code.

## Task-Specific Constraints

### Commit footers

Poll `~/.pi/agent/settings.json` for the model string (e.g., `kimi-coding/kimi-for-coding`). Do not fabricate model names.

### Memos go in `.pi/memos/`, not `docs/`

Handoff and continuation memos are written to `.pi/memos/` (already gitignored). Do not commit them. The `docs/` directory is for public-facing documentation (`docs/refactor.md` is the v2.0 spec).

### Config and data paths

- Config: `~/.pi/agent/reflect.json`
- History: `~/.pi/agent/reflect-history.json`
- Sessions: `~/.pi/agent/sessions/` (nested project dirs containing `.jsonl` files)
- Backups: `~/.pi/agent/reflect-backups/` (default, overridable per target)

These are hardcoded in `src/config.ts` and not parameterized.

### v1.x vs v2.0 architecture

The current codebase is v1.x: phase-based decomposition in `src/reflect.ts` with 4 edit types (`strengthen`, `add`, `remove`, `merge`). `docs/refactor.md` describes a v2.0 layer-aware architecture with persistence engines and semantic edits. **Unless explicitly tasked with v2.0, build v1.x-style.** The v2.0 spec is aspirational; the working code is v1.x.
