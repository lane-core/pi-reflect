# Handoff: pi-reflect Fork Refactor

> Written by Nina for the next session agent. This memo documents the structural refactor completed on 2026-04-29 and the current state of the codebase.

---

## What Just Happened

The upstream `pi-reflect` codebase (`@askjo/pi-reflect` v1.1.0) was a single-purpose behavioral-rule editor: two files (`extensions/index.ts` + `extensions/reflect.ts`, ~1,300 lines combined) that analyzed session transcripts and applied `strengthen|add|remove|merge` edits to `AGENTS.md`.

We refactored it into a **modular, layered codebase** under `src/` that separates concerns and prepares the ground for the **declarative memory curator** architecture described in `docs/refactor.md`.

---

## Directory Layout

```
src/
  config/          # Schema types + config I/O
    schema.ts      – ReflectTarget, ContextSource, DEFAULT_TARGET
    loader.ts      – loadConfig(), saveConfig()
    index.ts       – barrel exports

  history/         # reflect-history.json persistence
    store.ts       – loadHistory(), saveHistory()
    index.ts

  paths/           # Path resolution + constants
    resolver.ts    – HOME, CONFIG_FILE, resolvePath(), formatTimestamp()
    index.ts

  session/         # pi session JSONL extraction + collection
    types.ts       – SessionExchange, SessionData, TranscriptResult
    extractor.ts   – extractTranscript() from JSONL
    formatter.ts   – formatSessionTranscript()
    project.ts     – projectNameFromDir()
    collector.ts   – collectTranscripts(), collectTranscriptsForDate(), getAvailableSessionDates()
    index.ts

  evidence/        # Context source collection (files, commands, URLs)
    types.ts       – ContextSource (now the canonical definition)
    collector.ts   – collectContext()
    index.ts

  edit/            # Edit engine (deterministic, zero LLM)
    types.ts       – EditType, AnalysisEdit, EditRecord, EditResult
    engine.ts      – applyEdits() with strengthen/add/remove/merge
    index.ts

  reflection/      # The reflect loop: prompt → LLM → validate → apply
    types.ts       – AnalysisResult, ReflectionOptions, RunReflectionDeps, ReflectRun
    prompt.ts      – buildReflectionPrompt(), buildPromptForTarget()
    batcher.ts     – buildTranscriptBatches(), formatBatchTranscripts()
    analyzer.ts    – analyzeTranscriptBatch() (LLM call + tool-call parsing)
    runner.ts      – runReflection() (orchestrates the full pipeline)
    index.ts

  commands/        # Slash-command handlers (one per command)
    utils.ts       – targetLabel()
    reflect.ts     – /reflect
    config.ts      – /reflect-config
    history.ts     – /reflect-history
    stats.ts       – /reflect-stats
    backfill.ts    – /reflect-backfill
    index.ts       – registerCommands()

  utils/           # Pure cross-cutting utilities
    text.ts        – truncateText(), escapeRegex()
    index.ts

  extension.ts     # pi ExtensionAPI entry point (registers commands, captures modelRegistry)
  types.ts         # Shared types (NotifyFn)

extensions/
  index.ts         # Re-exports src/extension.ts (pi entry point)
  reflect.ts       # Backward-compat barrel: re-exports public API for tests
```

---

## Key Design Decisions

1. **Layered by concern, not by layer type.** The v2 architecture (in `docs/refactor.md`) will add `LayerEngine` and `LayerType` abstractions. For now, the code is organized by _function_ (config, session, edit, reflection) so the transition is incremental.

2. **Backward compatibility.** All existing tests import from `../extensions/reflect.js`. The `extensions/reflect.ts` barrel re-exports the public API so no test imports changed.

3. **Deterministic core, LLM at the edge.** `applyEdits()` and `collectTranscripts()` are pure/deterministic. The LLM lives only in `analyzeTranscriptBatch()`.

4. **Injectable dependencies.** `runReflection()` accepts a `deps?: RunReflectionDeps` object with `completeSimple`, `getModel`, `collectTranscriptsFn`, etc. This is how tests mock the LLM and session collection.

5. **TypeScript strict mode enabled.** `tsconfig.json` has `strict: true`, `noUnusedLocals: true`, `esModuleInterop: true`. `tsc --noEmit` reports zero errors.

---

## Tooling

| Tool               | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `npm test`         | Node test runner (`node --import tsx --test tests/*.test.ts`) |
| `npx tsc --noEmit` | Type-check the entire project                                 |
| `nix develop`      | Enter the dev shell (Node 24, TypeScript, git)                |

---

## What Still Needs Work

1. **The v2 spec in `docs/refactor.md` is not yet implemented.** The `LayerEngine`, `SupersessionEngine`, `DecayEngine`, etc. are design documents only. The current code is still the v1 behavioral-rules engine, just reorganized.

2. **`extensions/reflect.ts` should be removed once tests are updated.** It's a backward-compat shim. Tests should eventually import from `../src/reflection/index.js`, etc.

3. **The `config/schema.ts` types will need `layerType` and `layerTypes` fields** once the v2 config schema is wired in. Currently `ReflectTarget` has the v1 shape only.

4. **`src/reflection/runner.ts` still has a `require("node:child_process")` call** for the optional git auto-commit. This should be an `await import()` for ESM cleanliness.

5. **No CI is configured.** The fork has no GitHub Actions workflow. Tests are run manually.

---

## How to Continue

To implement the v2 architecture from `docs/refactor.md`:

1. Start with the `LayerEngine` interface and the `SupersessionEngine` implementation (Phase 1 of the spec).
2. Update `config/schema.ts` to include `layerType` on targets.
3. Evolve `ReflectTarget` to support the new schema while maintaining backward compatibility.
4. Add the `supersede` edit type to `edit/types.ts` and `edit/engine.ts`.
5. Update the LLM prompt in `reflection/prompt.ts` to emit `supersede` when the target is a Knowledge layer.

---

## Testing

All 157 tests pass. The test suite covers:

- Edit engine edge cases (apply-edits, realistic-edits)
- Session extraction and formatting (session-extraction)
- Transcript collection with date filtering and density sorting (session-extraction)
- Config and history serialization (config-and-history)
- Prompt construction (prompt-building)
- Full `runReflection()` flow with mocked LLM (run-reflection, batching)
- Command-source transcript collection (command-source)
- Utility functions (helpers-and-utils)

---

## Repo Context

- **Upstream:** `jo-inc/pi-reflect` (appears unmaintained)
- **This fork:** `lane-core/pi-reflect`
- **Branch:** `main`
- **Goal:** Evolve into a companion to `pi-memory` that provides Knowledge-layer curation (supersession, promotion, decay, contradiction detection)
