# pi-reflect Code Review — Post-Restructure

**Date:** 2026-04-29
**Scope:** 7 source files (`src/*.ts`), ~2,162 lines
**Mandate:** Ruthless. No sacred cows. An even more ambitious refactor is planned.

---

## Executive Summary

The restructure succeeded at the structural level — 35 files → 7 files, zero barrels, direct imports. But the code retains significant technical debt: rampant `any`, duplicated logic, functions that violate the single-responsibility principle by hundreds of lines, synchronous I/O in async contexts, and zero error propagation. The good news: these are all fixable, and the compact structure makes them visible.

Severity key: **P0** = blocks next refactor / causes bugs, **P1** = code smell / maintenance drag, **P2** = nicety / future-proofing.

---

## P0 — Structural / Correctness Issues

### 1. `runReflection` is a 350-line god function (`src/reflect.ts`)

**Problem:** One function handles file I/O, transcript collection, model resolution, batching, LLM calls, edit application, backup management, git commits, metrics computation, and dry-run logic. It is impossible to unit test any of these concerns in isolation. The batching and non-batching paths duplicate edit-application logic.

**Impact:** Every change to reflection logic risks regressions in unrelated subsystems. The function has 8+ distinct phases with their own error handling.

**Fix:** Extract phases into composable async functions with explicit `Result<T>` returns:

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function resolveModel(
  target,
  registry,
  deps,
): Promise<Result<ResolvedModel>>;
async function collectTranscripts(
  target,
  deps,
): Promise<Result<TranscriptResult>>;
async function analyzeBatches(
  target,
  model,
  transcripts,
  notify,
): Promise<Result<AnalysisResult[]>>;
async function applyReflectionEdits(
  targetPath,
  edits,
  options,
): Promise<Result<ApplyResult>>;
```

Then `runReflection` becomes a 40-line orchestrator.

### 2. Synchronous file I/O inside async functions (`src/reflect.ts`, `src/commands.ts`)

**Problem:** `fs.readFileSync`, `fs.writeFileSync`, `fs.copyFileSync`, `fs.mkdirSync`, `fs.existsSync`, `fs.statSync` are used throughout async functions. On large files or slow filesystems, these block the event loop.

**Fix:** Use `fs/promises` equivalents. This is a mechanical refactor but touches many call sites.

### 3. `any` is a pandemic — 40+ instances

**Problem:** `model: any`, `response.content: any`, `entry: any`, `parsed: any`, `toolCall: any`, `edit: any` in filter predicates. TypeScript is reduced to a fancy linter. The LLM integration surface (`completeFn`, `getModel`, `modelRegistry`) is entirely untyped.

**Impact:** No IntelliSense for LLM interactions. Refactoring is dangerous. Runtime errors from shape mismatches only surface in production.

**Fix:** Define minimal interfaces for the LLM surface. Even if `@mariozechner/pi-ai` lacks types, define local ones:

```ts
interface LLMModel {
  provider: string;
  id: string;
  cost?: { input: number; output: number };
}
interface LLMResponse {
  stopReason: string;
  errorMessage?: string;
  content: LLMContent[];
}
interface LLMContent {
  type: "text" | "toolCall";
  text?: string;
  name?: string;
  arguments?: unknown;
}
```

### 4. `applyEdits` has fragile text replacement logic (`src/apply.ts`)

**Problem:** The `remove` edit does `result.replace(edit.old_text + "\n", "")`, then falls back to `result.replace(edit.old_text, "")`. If the text doesn't end with a newline, the first replace silently fails and the second removes it anyway — but this means a remove edit that should delete "line\n" might accidentally delete just "line" embedded in another line. The `merge` type has the same fragility.

**Fix:** Use a structured approach: split content into lines, find the line(s) matching the text, remove/replace at line level. This is more robust than raw string surgery.

### 5. `extractTranscript` swallows all parse errors silently (`src/extract.ts`)

**Problem:** `try { entry = JSON.parse(line) } catch { continue }` — a malformed JSONL line is silently dropped. In a 10,000-line session file, a single bad line could go unnoticed and the transcript would be silently incomplete.

**Fix:** At minimum, count and report skipped lines. Better: log to `notify` or return metadata about parse failures.

---

## P1 — Design Smells / Duplication

### 6. `computeFileMetrics` duplicated (`src/reflect.ts` + `src/commands.ts`)

**Fix:** Move to `config.ts` or `types.ts` as a pure utility.

### 7. Default target object literal repeated inline 4+ times (`src/commands.ts`)

**Problem:** In `registerReflectCommand`, the fallback target object (with `path: "", schedule: "manual"`, etc.) is copy-pasted twice. If a field is added to `ReflectTarget`, these inline objects drift.

**Fix:** Export a `createFallbackTarget(path: string): ReflectTarget` from `config.ts`.

### 8. `analyzeTranscriptBatch` builds a 70-line JSON schema inline (`src/reflect.ts`)

**Problem:** The `reflectAnalysisTool` object is a massive inline literal that bloats the function and obscures the actual logic (calling the LLM and parsing the response).

**Fix:** Extract as a module-level constant `REFLECTION_TOOL_SCHEMA`.

### 9. `registerStatsCommand` is 250 lines of mixed computation + formatting (`src/commands.ts`)

**Problem:** Stats computation (aggregation, averaging, sorting) is interleaved with string formatting (Markdown generation, bar charts). Can't test the math without testing the Markdown.

**Fix:** Split into `computeStats(history)` → `StatsReport` and `formatStatsReport(report)` → `string`.

### 10. `buildReflectionPrompt` is a 100-line template literal (`src/reflect.ts`)

**Problem:** The prompt is embedded directly in code. It's the longest string literal in the codebase and mixes instructions, examples, and JSON schema.

**Fix:** Move to a separate file (e.g., `src/prompt.md` or `src/prompt.ts` as a single exported const). This makes the prompt editable without touching logic, and version-controllable independently.

### 11. `collectContext` has 8 levels of nesting (`src/extract.ts`)

**Problem:** Deeply nested try-catch, if-else, and for-loops make the function hard to reason about. The file-gathering logic (glob expansion, filtering, reading) is particularly dense.

**Fix:** Extract `collectFilesContext`, `collectCommandContext`, `collectUrlContext` as separate functions.

### 12. `collectSessionsForDates` mixes filesystem traversal with business logic (`src/extract.ts`)

**Problem:** The function walks directories, filters by date, parses filenames for hours, calls `extractTranscript`, then sorts and budgets. That's 4 distinct concerns.

**Fix:** Extract `scanSessionFiles(dates)` → `SessionFile[]`, then `filterAndExtract(files)` → `SessionData[]`, then `sortAndBudget(sessions, maxBytes)` → `TranscriptResult`.

### 13. `isWithinLookback` uses string comparison for dates (`src/extract.ts`)

**Problem:** `match[1] >= cutoff` relies on ISO date strings being lexicographically comparable. This happens to work but is a latent bug — a future maintainer might change the date format.

**Fix:** Parse to Date objects and compare timestamps.

---

## P2 — TypeScript Idioms / Polish

### 14. No `readonly` usage

Arrays and objects that are never mutated after creation (e.g., `batches`, `allSessions`, `parts`) should use `readonly` to communicate immutability and enable compiler optimizations.

### 15. `filter(Boolean)` instead of `filter((x): x is string => Boolean(x))`

In `computeFileMetrics`, `content.split(/\s+/).filter(Boolean)` returns `(string | undefined)[]` in strict mode without a type guard. The current code works because TS infers narrowly, but it's fragile.

### 16. `as const` assertions missing from literal objects

`reflectAnalysisTool.parameters` and enum arrays would benefit from `as const` for exact literal typing.

### 17. `Promise<any>` in `RunReflectionDeps`

The `completeSimple` signature returns `Promise<any>`. Even a minimal return type would help:

```ts
interface LLMCompletionResult {
  stopReason: string;
  errorMessage?: string;
  content: Array<{
    type: string;
    text?: string;
    name?: string;
    arguments?: unknown;
  }>;
}
```

### 18. `Date` mutations are side-effectful

`const d = new Date(); d.setDate(d.getDate() - i)` mutates the Date object. In `collectTranscripts`, this happens in a loop. Better:

```ts
const d = new Date();
d.setDate(d.getDate() - i);
const targetDate = d.toISOString().slice(0, 10);
```

Or use a pure function: `addDays(new Date(), -i)`.

### 19. `AbortSignal.timeout(15_000)` is modern but unguarded

`AbortSignal.timeout` was added in Node 17.3+. The `package.json` doesn't specify `engines`. If this runs on older Node, it throws.

**Fix:** Add `"engines": { "node": ">=18" }` to `package.json`, or polyfill.

### 20. No input validation on LLM response parsing

`analysis.edits ?? []` — if `analysis` is not an object, this throws at runtime. The `try-catch` only wraps the JSON parse, not the property access.

**Fix:** Use a validation function or schema (Zod, Valibot, or even a hand-rolled guard).

---

## Useful Abstractions to Consider

### A. Result/Either type for error propagation

Replace the `return null` pattern with explicit errors:

```ts
type Result<T, E = string> = { tag: "ok"; value: T } | { tag: "err"; error: E };

function ok<T>(value: T): Result<T> {
  return { tag: "ok", value };
}
function err<E>(error: E): Result<never, E> {
  return { tag: "err", error };
}
```

This makes error paths first-class and eliminates the "did this function return null or throw?" ambiguity.

### B. File IO effect wrapper

```ts
interface FileSystem {
  read(path: string): Promise<Result<string>>;
  write(path: string, content: string): Promise<Result<void>>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<Result<void>>;
}
```

This enables testing without mocking `node:fs` globally, and makes the sync→async migration mechanical.

### C. Prompt template engine

Instead of `target.prompt.replace(/\{fileName\}/g, ...)`, use a tiny tagged template:

```ts
const prompt = render(target.prompt, {
  fileName: path.basename(targetPath),
  targetContent,
  transcripts,
});
```

### D. Edit transaction log

`applyEdits` currently returns `{ result, applied, skipped }`. Consider returning a transaction log:

```ts
interface EditTransaction {
  original: string;
  result: string;
  operations: Array<{
    edit: AnalysisEdit;
    type: "applied" | "skipped";
    reason?: string;
  }>;
}
```

This would enable richer diagnostics and undo functionality.

---

## Recommended Fix Order

1. **Extract `runReflection` phases** — biggest payoff for testability and next refactor
2. **Replace `any` with minimal LLM interfaces** — unlocks IntelliSense and catches bugs
3. **Move sync I/O to async** — unblocks event loop, enables concurrent operations
4. **Extract prompt to separate file** — separates concerns, makes prompt editable
5. **Fix `applyEdits` fragility** — correctness issue that could corrupt user files
6. **Deduplicate `computeFileMetrics`** — mechanical, 2-minute fix
7. **Add `engines` to package.json** — documents runtime requirement
8. **Consider Result type** — architectural improvement for error handling

---

_Generated during review session. All findings verified against commit `c931f05`._
