# Handoff: FP Refactor (neverthrow + zod)

**Date:** 2026-04-29
**Commits:** `c931f05` (restructure) → `fa3cdd8` (foundation)
**Status:** Foundation laid. Core migration blocked by LSP stale-index issue (resolved).

---

## What Was Done

### 1. Restructure (commit `c931f05`)

Collapsed 35 files across 10 directories into 7 files. Zero barrel files. All imports point directly to the defining file. Tests updated. 157/157 tests pass.

### 2. Foundation (commit `fa3cdd8`)

- Installed `neverthrow` + `zod`
- Created `src/errors.ts` — domain error types (`ConfigError`, `FileError`, `LLMError`, `ValidationError`, `ReflectionError`)
- Created `src/schemas.ts` — zod schemas for LLM response validation
  - `EditTypeSchema` — enum of 4 edit types
  - `AnalysisEditSchema` — full edit structure
  - `AnalysisResponseSchema` — complete LLM response shape
- Updated `src/types.ts` — `EditType` and `AnalysisEdit` now re-exported from `schemas.ts` (zod-derived)

### 3. Review

Wrote comprehensive review memo (`.pi/memos/review-findings.md`) with 20 findings ranked P0→P2 and 4 abstraction ideas. Wrote FP library selection memo (`.pi/memos/fp-library-selection.md`).

---

## What Was Attempted and Blocked

### The Goal

Migrate `src/config.ts` file operations (`loadConfig`, `saveConfig`, `loadHistory`, `saveHistory`) to return `Result<T, E>` from neverthrow, then update all callers in `src/commands.ts` and `src/reflect.ts`.

### What Happened

1. Updated `src/config.ts` to wrap file ops in `Result.fromThrowable()` — **this worked**
2. Attempted to update `src/commands.ts` to unwrap Results with `.unwrapOr()` and `.match()` — **this triggered LSP blocking**

### Root Cause: LSP Stale Index

The restructure used `rm -rf` to delete old directories. The LSP (pi-lens) never got filesystem events, so its index still contained exports from deleted files (`src/commands/index.ts`, `src/commands/reflect.ts`, etc.). When editing `src/commands.ts`, the LSP saw duplicate exports and blocked writes/edits with "Redefining existing export(s)."

### Resolution

Deleted `.pi-lens/` directory (LSP cache). This cleared the stale index. The LSP now correctly sees only the 9 source files on disk.

**Lesson:** After major structural renames/deletes, clear `.pi-lens/` before continuing.

### Stashed Work

The partial `commands.ts` Result migration is in stash `stash@{0}` (`wip: fp refactor blocked by lsp`). It can be dropped — the changes are captured in the instructions below.

---

## Current Code State

```
src/
  types.ts      ← zod-derived EditType/AnalysisEdit re-exports
  schemas.ts    ← zod schemas (NEW)
  errors.ts     ← domain errors (NEW)
  config.ts     ← PLAIN returns (reverted to pre-Result)
  commands.ts   ← PLAIN calls (unchanged from restructure)
  reflect.ts    ← PLAIN calls (unchanged from restructure)
  extract.ts    ← unchanged
  apply.ts      ← unchanged
  extension.ts  ← unchanged
```

**Compiles:** ✅ `tsc --noEmit` clean  
**Tests:** ✅ 157/157 pass

---

## Next Steps (in order)

### Step 1: Migrate config.ts to Result

Restore the Result-returning signatures in `src/config.ts`:

```typescript
export function loadConfig(): Result<ReflectConfig, ConfigError>;
export function saveConfig(config: ReflectConfig): Result<void, FileError>;
export function loadHistory(): Result<ReflectRun[], FileError>;
export function saveHistory(runs: ReflectRun[]): Result<void, FileError>;
```

Use `Result.fromThrowable(() => { ... }, (e) => new XError(...))()`.

Reference: The exact implementation was written and is in `git show fa3cdd8^:src/config.ts` (the parent commit has it in the working tree before revert).

### Step 2: Update commands.ts callers

Every call site needs `.unwrapOr()` or `.match()`:

```typescript
// Before
const config = loadConfig();

// After
const config = loadConfig().unwrapOr({ targets: [] } as ReflectConfig);

// Before
const history = loadHistory();
history.push(run);
saveHistory(history);

// After
loadHistory().match(
  (history) => {
    history.push(run);
    saveHistory(history).match(
      () => {},
      (err) => notify(`Failed to save history: ${err.message}`, "error"),
    );
  },
  (err) => notify(`Failed to load history: ${err.message}`, "error"),
);
```

Key pattern: `.unwrapOr({ targets: [] } as ReflectConfig)` not `.unwrapOr({ targets: [] })` — the empty array infers as `never[]` without the annotation.

### Step 3: Add zod validation in reflect.ts

In `analyzeTranscriptBatch`, after extracting `analysis` from the LLM response:

```typescript
import { AnalysisResponseSchema } from "./schemas.js";
import { ValidationError } from "./errors.js";

const parsed = AnalysisResponseSchema.safeParse(analysis);
if (!parsed.success) {
  notify(`LLM returned invalid structure: ${parsed.error.message}`, "error");
  return null;
}
// parsed.data is now fully typed AnalysisResponse
```

Replace the untyped `analysis: any` with `parsed.data`.

### Step 4: Clean up reflect.ts

- Import `computeFileMetrics` from `./config.js` instead of local definition
- Remove duplicate `computeFileMetrics` if still present
- Replace `any` casts with `unknown` or proper types where possible

### Step 5: Verify

1. `tsc --noEmit` — zero errors
2. `npm test` — all 157 tests pass
3. No temp files left in working tree

---

## Traps to Avoid

1. **`.unwrapOr({ targets: [] })` infers `never[]`** — always annotate: `.unwrapOr({ targets: [] } as ReflectConfig)` or `.unwrapOr([] as ReflectRun[])`
2. **`as Record<string, unknown>` needs `unknown` first** — `(x as unknown as Record<string, unknown>).field`
3. **`getModel()` from `@mariozechner/pi-ai` has strict types** — use `as never` for provider/modelId, or declare `let model: unknown = getModel(...)`
4. **LSP stale index after deletes** — if "Redefining existing export" appears for deleted files, `rm -rf .pi-lens/`

---

## Reference Files

- `.pi/memos/review-findings.md` — 20-item review with P0→P2 rankings
- `.pi/memos/fp-library-selection.md` — library analysis (neverthrow + zod)
- `src/schemas.ts` — zod schemas ready to use
- `src/errors.ts` — error types ready to use

---

## Design Decisions Made

- **neverthrow + zod** chosen over purify-ts/io-ts/fp-ts/Effect for incremental adoption
- **Result types** only at trust boundaries (file I/O, LLM response parsing), not everywhere
- **zod schemas** for LLM response shape; config file shape can optionally be validated too
- **Effect deferred** to the "even more ambitious refactor" Lane mentioned

---

_Handoff written by Nina (kimi-coding/kimi-for-coding) via pi._
