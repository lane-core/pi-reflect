# pi-reflect — Agent Instructions

## Scope

This repo is a **pi extension** (not a standalone CLI). Entry point is `src/extension.ts` which registers commands via `pi.registerCommand()`. It analyzes session transcripts and edits behavioral markdown files.

## Non-Discoverable Commands

- **Tests**: `npm test` runs `node --import tsx --test tests/*.test.ts`. Uses Node's built-in `node:test`, not jest/vitest.
- **Type check**: `npx tsc --noEmit` (no separate build step; tsx handles runtime).

## Landmines

### Do not delete "unused" error classes

`src/errors.ts` defines `ValidationError`, `LLMError`, `ReflectionError` that appear unused. **They are scaffolding for the neverthrow `Result<T,E>` migration into `src/reflect.ts`.** Deleting them breaks the planned architectural boundary. A TODO comment in the file explains this.

### Do not opportunistically "fix" sync I/O

The codebase uses `fs.*Sync` inside async functions throughout (`reflect.ts`, `commands.ts`, `extract.ts`). This is **known tracked debt** (P0 #2). It requires a mechanical, file-wide migration to `fs/promises` — not piecemeal fixes. Check the todo list before starting; if P0 #2 is not assigned to you, leave it alone.

### Do not over-type the LLM layer

`analyzeTranscriptBatch` and `runAnalysisLoop` use `any` for `model` and `completeFn`. The upstream `@mariozechner/pi-ai` types are opaque and unstable. Replacing these with strict interfaces without understanding the provider boundary will break at runtime. If you type this layer, define the interfaces locally in `src/types.ts` and verify against actual provider responses — don't assume the npm types.

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

### Neverthrow boundary is half-built

`src/config.ts` uses `neverthrow` `Result<T,E>` (`loadConfig`, `saveConfig`, `loadHistory`, `saveHistory`). Callers in `src/commands.ts` unwrap with `.unwrapOr()` / `.match()`. `src/reflect.ts` phases still return `T | null` with ad-hoc `notify(..., "error"); return null`. **Do not force Results into reflect.ts until the error scheme is designed** — see the todo list and `src/errors.ts` TODO.

### Config and data paths

- Config: `~/.pi/agent/reflect.json`
- History: `~/.pi/agent/reflect-history.json`
- Sessions: `~/.pi/agent/sessions/` (nested project dirs containing `.jsonl` files)
- Backups: `~/.pi/agent/reflect-backups/` (default, overridable per target)

These are hardcoded in `src/config.ts` and not parameterized.

### v1.x vs v2.0 architecture

The current codebase is v1.x: phase-based decomposition in `src/reflect.ts` with 4 edit types (`strengthen`, `add`, `remove`, `merge`). `docs/refactor.md` describes a v2.0 layer-aware architecture with persistence engines and semantic edits. **Unless explicitly tasked with v2.0, build v1.x-style.** The v2.0 spec is aspirational; the working code is v1.x.
