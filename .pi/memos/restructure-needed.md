# Memo: Refactor the Refactor

**Date:** 2026-04-29  
**Context:** Session concluded after structural reorganization of pi-reflect. Lane correctly identified that the result is over-engineered.

## The Problem

The refactor produced **25+ files across 10 directories** with **10 `index.ts` barrel files** for a codebase whose core logic is ~2,000 lines doing three things: extract sessions, call LLM, apply string edits. The net TypeScript line count went from 4,442 to 4,995 (+553 lines) for zero new functionality.

This is abstraction theater, not good design.

## What's Wrong

| Anti-pattern                                 | Where                                                                    | Fix                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` barrel files                      | 10 of them across `src/*/`                                               | Delete all. Import directly from concrete files.                                                                                                                    |
| `types.ts` per directory                     | `src/edit/types.ts`, `src/session/types.ts`, etc.                        | Consolidate shared types into one `src/types.ts`. Keep domain-specific types in the file that owns them.                                                            |
| 6 separate command files                     | `src/commands/{reflect,config,history,stats,backfill,utils}.ts`          | Merge into one `src/commands.ts`. Each command is 20-30 lines of wrapper.                                                                                           |
| `src/utils/` directory                       | 2 functions (`truncateText`, `escapeRegex`)                              | `escapeRegex` is used only in `src/edit/engine.ts` — move it there. `truncateText` is used only in `src/session/formatter.ts` — move it there. Delete `src/utils/`. |
| `src/history/` directory                     | 18 lines of JSON read/write                                              | Merge into `src/config.ts` or `src/persistence.ts`.                                                                                                                 |
| `src/paths/` directory                       | `resolvePath` + constants                                                | `resolvePath` is trivial (`~` expansion). Inline it where used. Constants can live in `src/config.ts`.                                                              |
| `src/evidence/` directory                    | `collectContext()` used only by `src/reflection/runner.ts`               | Inline into `src/reflect.ts`.                                                                                                                                       |
| `src/session/` split into 5 files            | `extractor.ts`, `formatter.ts`, `project.ts`, `collector.ts`, `types.ts` | Merge into `src/extract.ts` (single file: parse JSONL, format transcripts, scan directories).                                                                       |
| `src/reflection/` split into 5 files         | `types.ts`, `prompt.ts`, `batcher.ts`, `analyzer.ts`, `runner.ts`        | Merge into `src/reflect.ts`. The batcher is 36 lines used only by runner. The analyzer is used only by runner.                                                      |
| `src/edit/` split into 2 files               | `types.ts`, `engine.ts`                                                  | Merge types into `engine.ts` or `src/types.ts`.                                                                                                                     |
| `extensions/reflect.ts` backward-compat shim | Re-exports for tests                                                     | Update tests to import directly from `src/`. Then delete the shim.                                                                                                  |

## Target Structure

```
src/
  types.ts          # Shared types: NotifyFn, EditType, AnalysisEdit,
                    #   EditRecord, EditResult, ReflectRun, SessionExchange,
                    #   SessionData, TranscriptResult, ReflectTarget,
                    #   ContextSource, TranscriptSource, ReflectConfig,
                    #   RunReflectionDeps, ReflectionOptions, AnalysisResult
  config.ts         # loadConfig, saveConfig, DEFAULT_TARGET,
                    #   loadHistory, saveHistory, path constants
  extract.ts        # extractTranscript, formatSessionTranscript,
                    #   projectNameFromDir, collectTranscripts,
                    #   collectTranscriptsForDate, getAvailableSessionDates
  reflect.ts        # buildReflectionPrompt, buildPromptForTarget,
                    #   buildTranscriptBatches, formatBatchTranscripts,
                    #   analyzeTranscriptBatch, runReflection
  apply.ts          # applyEdits (with escapeRegex inlined)
  commands.ts       # All 5 slash commands + targetLabel helper
  extension.ts      # pi ExtensionAPI entry point
```

**7 files. No barrels. No re-export noise.**

## What This Achieves

- TypeScript line count drops from ~5,000 toward ~3,500
- You can read the entire codebase in one sitting
- No import indirection: every import points to the file that defines the symbol
- The structure mirrors the actual data flow: `extract.ts` → `reflect.ts` → `apply.ts`

## Verification Steps for Next Session

1. `tsc --noEmit` — must report zero errors
2. `npm test` — all 157 tests must pass
3. Delete `extensions/reflect.ts` and update test imports to point to `src/` directly
4. Update `package.json` `pi.extensions` if needed (currently `./src/extension.ts`)
5. Commit with clear message about simplification

## Reference Material

- `docs/refactor.md` — v2 architecture spec (declarative layer types, LayerEngine interface)
- `HANDOFF.md` — previous session's handoff (documents the over-engineered structure)
- Current commit: `f5f9392` on `lane-core/pi-reflect@main`
