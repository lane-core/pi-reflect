# FP Library Selection for pi-reflect

**Date:** 2026-04-29
**Context:** Post-restructure (~2,162 lines, 7 files). Adopting FP patterns incrementally.
**Goal:** Pick libraries that maximize safety and expressiveness with minimum weight and learning curve.

---

## The Short Answer

**Use `neverthrow` + `zod`.** This is the practical sweet spot for a codebase of this size.

If you want to explore a more adventurous path: **Effect** is genuinely transformative but amounts to a rewrite, not a refactor. Save it for the "even more ambitious refactor" Lane mentioned.

---

## Analysis by Library

### `neverthrow` — ⭐ Use This

**What it is:** The de facto standard `Result<T, E>` type for TypeScript. Zero dependencies, ~1KB gzipped.

**API (the 5 functions you actually need):**

```typescript
import { ok, err, Result, ResultAsync } from "neverthrow";

// Creating
ok(42); // Result<number, never>
err("boom"); // Result<never, string>

// Chaining (sync)
ok(5).map((x) => x * 2); // Ok(10)
ok(5).andThen((x) => ok(x * 2)); // Ok(10)
ok(5).andThen((x) => err("nope")); // Err("nope")
err("boom").map((x) => x * 2); // Err("boom") — skipped

// Unwrapping
result.unwrapOr(defaultValue);
result.match(okFn, errFn);

// Async (this is where it shines)
ResultAsync.fromPromise(promise, errorMapper)
  .andThen((val) => asyncOperation(val))
  .map((final) => transform(final));

// Wrapping throwable functions
Result.fromThrowable(fn, errorMapper);
```

**Why it fits pi-reflect:**

- The codebase's biggest problem is `return null` for errors and `any` everywhere. `Result` makes error paths explicit and type-safe.
- `runReflection` currently mixes 8 phases with ad-hoc error handling. `ResultAsync` chains would turn it into a readable pipeline.
- `fromThrowable` is perfect for wrapping `fs` operations and JSON parsing — the two biggest sources of swallowed exceptions.
- No new concepts to learn beyond "functions can return errors as values." The API mirrors Rust's `Result`, which is familiar to many developers.

**Specific pi-reflect use cases:**

```typescript
// Replace: let model: any; ... if (!model) return null;
const modelResult = resolveModel(target, registry);
// modelResult is Result<LLMModel, ModelError> — can't accidentally use undefined

// Replace: try { fs.readFileSync(...) } catch { return { targets: [] }; }
const configResult = Result.fromThrowable(
  () => fs.readFileSync(CONFIG_FILE, "utf-8"),
  (e) => new ConfigError(`Failed to read config: ${e}`),
)();
// configResult is Result<string, ConfigError>
```

---

### `zod` — ⭐ Use This

**What it is:** Schema-first runtime validation with static type inference. 2KB gzipped, zero deps.

**API (the pattern you use 90% of the time):**

```typescript
import { z } from "zod";

const UserSchema = z.object({
  name: z.string(),
  age: z.number().min(0),
});

type User = z.infer<typeof UserSchema>; // { name: string; age: number }

// Safe parse (returns a Result-like shape)
const result = UserSchema.safeParse(unknownData);
if (result.success) {
  result.data; // typed as User
} else {
  result.error; // ZodError with details
}
```

**Why it fits pi-reflect:**

- The LLM returns `analysis: any` — the most dangerous `any` in the codebase. Zod schemas would validate the LLM response at the trust boundary.
- The `EditType` union (`"strengthen" | "add" | "remove" | "merge"`) is currently a bare string union. A zod enum would validate it at runtime.
- `safeParse` returns a discriminated union that pairs naturally with `neverthrow`:
  ```typescript
  const parsed = AnalysisSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err(new ValidationError(parsed.error));
  ```

**Specific pi-reflect use case — LLM response validation:**

```typescript
const AnalysisEditSchema = z.object({
  type: z.enum(["strengthen", "add", "remove", "merge"]),
  section: z.string().optional(),
  old_text: z.string().nullable().optional(),
  new_text: z.string(),
  after_text: z.string().nullable().optional(),
  merge_sources: z.array(z.string()).nullable().optional(),
  reason: z.string().optional(),
});

const AnalysisResponseSchema = z.object({
  corrections_found: z.number(),
  sessions_with_corrections: z.number(),
  edits: z.array(AnalysisEditSchema),
  patterns_not_added: z
    .array(
      z.object({
        pattern: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  summary: z.string(),
});

// In analyzeTranscriptBatch, replace the untyped analysis extraction:
const parseResult = AnalysisResponseSchema.safeParse(analysis);
if (!parseResult.success) {
  notify(
    `LLM returned invalid structure: ${parseResult.error.message}`,
    "error",
  );
  return null;
}
// parseResult.data is now fully typed — no more `any`
```

---

### `purify-ts` — Consider, But Not the Best Fit

**What it is:** Either, Maybe, EitherAsync, MaybeAsync, and Codec (validation) in one library. Fantasy Land conformant. ~3KB gzipped.

**Why it's appealing:** One library covers everything — no need for neverthrow + zod.

**Why it's not the best fit for pi-reflect:**

- `Either` uses `Left`/`Right` terminology instead of `Ok`/`Err`. For a team adopting FP incrementally, this is cognitive overhead. When something fails, `Left("boom")` is less intuitive than `Err("boom")`.
- The `Codec` validation API is less ergonomic than zod's. Compare:
  ```typescript
  // purify
  Codec.interface({ name: string, age: number });
  // zod
  z.object({ name: z.string(), age: z.number() });
  ```
  Zod's API is more discoverable and has better error messages.
- Smaller community than neverthrow + zod combined. Fewer Stack Overflow answers, fewer ecosystem integrations.

**When to choose purify instead:** If you specifically want Haskell/Elm-style ADTs and don't mind the terminology shift. It's a valid choice, just a steeper ramp.

---

### `runtypes` — Skip

**What it is:** Composable runtime validators. Similar to zod but older and less popular.

**Why skip:** Zod is strictly better — smaller bundle, better TypeScript inference, larger ecosystem, more active development. Runtypes throws by default (`check()`), while zod's `safeParse` is designed for error-as-values. No advantage over zod for this codebase.

---

### `io-ts` — Skip

**What it is:** Runtime type validation built on `fp-ts` primitives. Full codec composability.

**Why skip:** Requires `fp-ts` as a peer dependency. That's bringing in a heavy FP framework just for validation. The API is elegant but verbose. Maintenance mode — gcanti has shifted focus to `effect`.

---

### `fp-ts` — Skip (For Now)

**What it is:** The grandfather of FP in TypeScript. Full HKT-style category theory primitives.

**Why skip:**

- Verbose. What neverthrow does in `ok(5).andThen(fn)`, fp-ts does in `pipe(5, E.chain(fn))` with imports from 3 modules.
- Steep learning curve. You need to understand functors, applicatives, monads, and HKT workarounds.
- Would dominate the codebase. A 2,000-line project would become "an fp-ts project that happens to do reflection."
- Worth learning for intellectual growth, but not for incremental adoption in a small codebase.

**When to use:** If you're building a library that other FP developers will consume, or if you genuinely need the algebraic machinery (laws, type class derivation, etc.).

---

### `effect` — ⭐ Use For the Next Major Refactor

**What it is:** ZIO for TypeScript. Structured concurrency, resource management, dependency injection, tracing, retries, streams, and a full effect system.

**Why it's genuinely excellent:**

- The `Effect<Success, Error, Requirements>` type encodes everything a function can do. No `any`. No hidden exceptions.
- `Effect.gen` (generator syntax) makes async/await-style code composable:
  ```typescript
  const program = Effect.gen(function* () {
    const config = yield* loadConfig;
    const model = yield* resolveModel(config);
    const transcripts = yield* collectTranscripts(config);
    const analysis = yield* analyzeBatch(model, transcripts);
    yield* applyEdits(analysis);
  });
  ```
- Built-in retries, timeouts, interruption, and metrics. The `retry` combinator alone would eliminate a lot of hand-rolled logic.
- The `Layer` system for dependency injection would make testing trivial — swap real `fs` for test doubles at the layer level.

**Why skip it for this refactor:**

- It's a rewrite, not a refactor. Every function signature changes. Every async operation becomes an `Effect`. The whole program needs `Effect.runPromise(program)` at the entry point.
- 15KB core (tree-shaken) + ecosystem. For a 2,000-line extension, the runtime overhead is non-trivial relative to the business logic.
- Learning curve. Effect has its own idioms: `Layer`, `Tag`, `Ref`, `Fiber`, `Hub`, `Queue`. Mastering them takes weeks.
- The user explicitly said "there is an even more ambitious refactor planned." Effect belongs in _that_ refactor, not this cleanup.

**Recommendation:** Use neverthrow + zod now. Migrate to Effect in the ambitious refactor, when you're ready to commit to the Effect programming model holistically.

---

## Adoption Strategy for pi-reflect

### Phase 1: neverthrow (errors as values)

1. Add `neverthrow` to dependencies
2. Define error types:
   ```typescript
   // src/errors.ts
   export class FileError extends Error {
     constructor(
       message: string,
       public readonly path: string,
     ) {
       super(message);
     }
   }
   export class ValidationError extends Error {
     constructor(
       message: string,
       public readonly cause: unknown,
     ) {
       super(message);
     }
   }
   export class LLMError extends Error {
     constructor(message: string) {
       super(message);
     }
   }
   ```
3. Convert file operations to `Result`:
   ```typescript
   export function readConfig(): Result<ReflectConfig, FileError> {
     return Result.fromThrowable(
       () => JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")),
       (e) => new FileError(`Failed to read config: ${e}`, CONFIG_FILE),
     )().map((parsed) => ({
       targets: (parsed.targets ?? []).map((t: unknown) => ({
         ...DEFAULT_TARGET,
         ...t,
       })),
     }));
   }
   ```
4. Convert `runReflection` to return `ResultAsync<ReflectRun, ReflectionError>`
5. Replace all `return null` on error paths with `err(new SpecificError(...))`

### Phase 2: zod (trust boundaries)

1. Add `zod` to dependencies
2. Define schemas for LLM responses:
   ```typescript
   const AnalysisResponseSchema = z.object({ ... });
   ```
3. In `analyzeTranscriptBatch`, validate the LLM output:
   ```typescript
   const validated = AnalysisResponseSchema.safeParse(rawAnalysis);
   return validated.success
     ? ok(validated.data)
     : err(
         new ValidationError("LLM returned invalid structure", validated.error),
       );
   ```
4. Consider adding schemas for config file and command arguments

### Phase 3: Functional patterns (natural extensions)

- Use `Result.andThen` for sequential operations that might fail
- Use `Result.map` for transforms on success values
- Use `Result.match` at the edge (command handlers) to unwrap and report
- Consider `Result.combine` for parallel validations
- Use `Result.fromThrowable` to wrap any third-party function that throws

---

## Installation

```bash
npm install neverthrow zod
```

Both have zero dependencies and are fully tree-shakeable.

---

## Summary Table

| Library        | Weight     | Use Case                               | Verdict                        |
| -------------- | ---------- | -------------------------------------- | ------------------------------ |
| **neverthrow** | ~1KB       | Result<T,E>, error chaining            | **Use now**                    |
| **zod**        | ~2KB       | Runtime validation at trust boundaries | **Use now**                    |
| purify-ts      | ~3KB       | Either + Maybe + Codec                 | Consider, but steeper ramp     |
| runtypes       | ~2KB       | Runtime validation                     | Skip — zod is better           |
| io-ts          | ~5KB+fp-ts | Runtime validation                     | Skip — heavy, maintenance mode |
| fp-ts          | ~20KB      | Full FP machinery                      | Skip — overkill for this size  |
| effect         | ~15KB+     | Effect system, concurrency, DI         | **Use in next major refactor** |

---

_Recommendation: Start with neverthrow + zod. They're the smallest, most intuitive, and most widely adopted libraries in their categories. They solve the exact problems pi-reflect has (scattered errors, untrusted LLM input) without imposing a new programming paradigm. Save Effect for the ambitious refactor where its full power (structured concurrency, resource management, Layers) becomes justified._
