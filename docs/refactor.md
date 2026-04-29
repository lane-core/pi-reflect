# pi-reflect v2.0: Declarative Memory Curator

> This specification refactors pi-reflect from a single-purpose behavioral-rule editor into a **layer-aware memory curator** that operates on pi-memory files with explicit persistence semantics. The core insight is that pi-memory handles _write_ and _recall_; pi-reflect handles _curation_ — supersession, promotion, decay, and contradiction resolution.

---

## 1. Motivation

### 1.1 The Category Error

pi-memory is excellent at persistence: it writes, reads, searches, and injects context across sessions. But it lacks _curation_. Per Roynard's "Missing Knowledge Layer" (arXiv 2604.11364), conflating knowledge with memory produces two predictable failure modes:

1. **Forgetting what should be remembered** — old decisions are silently dropped when `MEMORY.md` exceeds its 4K injection budget or when middle-truncation removes them.
2. **Remembering what should be forgotten** — daily observations accumulate forever, undecayed, polluting search results.

pi-reflect's current design targets _behavioral rule convergence_ (tighten AGENTS.md based on transcripts). This is one instance of a more general operation: **applying persistence-semantics edits to a substrate file based on evidence from other substrates.**

### 1.2 The Fix: Layer-Agnostic Curation

Instead of hardcoding "AGENTS.md gets behavioral edits" and "MEMORY.md gets fact edits," we define a **declarative layer type** that specifies:

- How entries persist (supersession, decay, revision-gating, ephemeral)
- What metadata they carry (provenance schema)
- How they interact with other layers (promotion, archival)
- What edit vocabulary the LLM may propose

A target then binds a file or directory to a layer type. The four Roynard layers are one configuration among infinitely many.

---

## 2. Core Concepts

### 2.1 Substrate

A substrate is a file or directory that stores entries. pi-memory already defines substrates:

| Substrate        | Path                               | Default Layer |
| ---------------- | ---------------------------------- | ------------- |
| Long-term memory | `~/.pi/agent/memory/MEMORY.md`     | `knowledge`   |
| Daily log        | `~/.pi/agent/memory/daily/*.md`    | `memory`      |
| Scratchpad       | `~/.pi/agent/memory/SCRATCHPAD.md` | `ephemeral`   |
| Behavioral rules | `~/.pi/agent/AGENTS.md`            | `wisdom`      |
| Identity         | `~/.pi/agent/SOUL.md`              | `ephemeral`   |

### 2.2 Layer Type

A `LayerType` is a reusable definition of persistence behavior. It is **not** a hardcoded enum. Users define layer types in `reflect.json` and can add, remove, or rename them freely.

### 2.3 Entry

An entry is a semantically meaningful unit within a substrate. In markdown files, entries are typically delimited by headers, timestamp comments, or tag lines. The layer type defines how entries are parsed and what fields they contain.

### 2.4 Evidence

Evidence is external material used to justify edits: session transcripts, daily logs, reference files, or outputs from other tools. Evidence collection is substrate-agnostic.

### 2.5 Edit

An edit is a proposed transformation of a substrate. The **edit vocabulary** is determined by the layer type's `persistence` engine — not by the LLM. The LLM proposes semantic edits; the engine validates and applies them deterministically.

---

## 3. Configuration Schema

### 3.1 Top-Level `reflect.json`

```json
{
  "$schema": "./reflect-schema.json",
  "layerTypes": {
    "knowledge": { "...": "see below" },
    "memory": { "...": "see below" },
    "wisdom": { "...": "see below" },
    "ephemeral": { "...": "see below" }
  },
  "targets": [
    {
      "path": "~/.pi/agent/memory/MEMORY.md",
      "layerType": "knowledge",
      "model": "anthropic/claude-sonnet-4-5",
      "schedule": "daily",
      "lookbackDays": 7,
      "transcripts": [
        { "type": "files", "paths": ["~/.pi/agent/memory/daily/*.md"] }
      ]
    }
  ]
}
```

### 3.2 Layer Type Definition

```typescript
interface LayerType {
  /** Human-readable description */
  description?: string;

  /** Persistence semantics engine */
  persistence:
    | "supersession"
    | "decay"
    | "revision-gated"
    | "ephemeral"
    | "append-only"
    | "replaceable"
    | string;

  /** How entries are identified and parsed */
  entrySchema: EntrySchema;

  /** What provenance metadata to track */
  provenance: ProvenanceConfig;

  /** How to handle conflicts between entries */
  conflictResolution: "link" | "gate" | "overwrite" | "flag";

  /** Promotion rules (this layer → another layer) */
  promotion?: PromotionConfig;

  /** Decay/archival rules (for decay layers) */
  decay?: DecayConfig;

  /** Revision gates (for revision-gated layers) */
  gates?: Record<string, GateConfig>;

  /** Hard limits on substrate size */
  constraints?: {
    maxEntries?: number;
    maxBytes?: number;
    maxAgeDays?: number;
  };
}
```

### 3.3 Entry Schema

```typescript
interface EntrySchema {
  /** Regex or delimiter that marks entry boundaries */
  boundary: string | { regex: string; flags?: string };

  /** How to extract the entry ID */
  idField: string | { regex: string; captureGroup: number };

  /** Required tags for entries in this layer */
  requiredTags?: string[];

  /** Optional tags that may appear */
  optionalTags?: string[];

  /** Additional metadata fields */
  fields?: FieldDef[];

  /** Whether entries must have a timestamp */
  requiresTimestamp?: boolean;
}

interface FieldDef {
  name: string;
  type: "string" | "date" | "number" | "boolean" | "link" | "list";
  required?: boolean;
  /** Regex or known values for validation */
  pattern?: string | string[];
  /** Default value */
  default?: unknown;
}
```

### 3.4 Provenance Config

```typescript
interface ProvenanceConfig {
  /** Include source file path */
  source?: boolean;
  /** Include creation timestamp */
  timestamp?: boolean;
  /** Include session ID */
  sessionId?: boolean;
  /** Include user attribution */
  user?: boolean;
  /** Track revision history */
  revisionLog?: boolean;
}
```

### 3.5 Promotion Config

```typescript
interface PromotionConfig {
  /** Target layer type for promoted entries */
  to: string;
  /** Gate criteria that must be met */
  gate: PromotionGate;
  /** How to transform the entry during promotion */
  transform: "promote" | "extract" | "summarize";
}

type PromotionGate =
  | { type: "corroboration"; minOccurrences: number; minAgeDays?: number }
  | { type: "explicit"; tag: string }
  | { type: "evidence"; minEvidenceScore: number }
  | { type: "manual" };
```

### 3.6 Decay Config

```typescript
interface DecayConfig {
  /** Exponential half-life in days */
  halfLifeDays: number;
  /** Where to move decayed entries */
  archiveTo?: string;
  /** Whether to extract durable facts before archiving */
  extractBeforeArchive?: boolean;
}
```

### 3.7 Gate Config (for Revision-Gated Layers)

```typescript
interface GateConfig {
  /** Minimum corroborating evidence */
  minCorroboration?: number;
  /** Minimum age in days */
  minAgeDays?: number;
  /** Minimum span across sessions */
  minSessionSpan?: number;
  /** Whether zero contradictions are required */
  noContradiction?: boolean;
  /** Maximum churn (revisions) before stabilization */
  maxChurn?: number;
}
```

---

## 4. Layer Type Examples

### 4.1 Roynard's Four-Layer Decomposition

```json
{
  "layerTypes": {
    "knowledge": {
      "description": "Factual claims about the world. Indefinite persistence via supersession.",
      "persistence": "supersession",
      "entrySchema": {
        "boundary": "^(#{1,3} )",
        "idField": { "regex": "\\[\\[([^\\]]+)\\]\\]", "captureGroup": 1 },
        "requiredTags": ["#fact", "#decision", "#preference", "#lesson"],
        "fields": [
          { "name": "supersedes", "type": "link" },
          { "name": "supersededBy", "type": "link" },
          { "name": "rationale", "type": "string" },
          { "name": "source", "type": "string" }
        ]
      },
      "provenance": { "source": true, "timestamp": true, "sessionId": true },
      "conflictResolution": "link",
      "constraints": { "maxEntries": 500, "maxBytes": 50000 }
    },
    "memory": {
      "description": "Experiential observations. Ebbinghaus decay by default.",
      "persistence": "decay",
      "entrySchema": {
        "boundary": "^<!-- ",
        "idField": {
          "regex": "<!-- ([0-9T:_-]+) \\[([a-f0-9]+)\\]",
          "captureGroup": 2
        },
        "requiredTags": ["#observation", "#event"],
        "fields": [{ "name": "promotedTo", "type": "link" }]
      },
      "provenance": { "source": true, "timestamp": true, "sessionId": true },
      "decay": { "halfLifeDays": 30, "archiveTo": "archive/daily" },
      "promotion": {
        "to": "knowledge",
        "gate": {
          "type": "corroboration",
          "minOccurrences": 2,
          "minAgeDays": 7
        },
        "transform": "promote"
      }
    },
    "wisdom": {
      "description": "Behavioral directives learned from experience. Evidence-gated revision.",
      "persistence": "revision-gated",
      "entrySchema": {
        "boundary": "^(#{1,3} )",
        "idField": { "regex": "\\[\\[([^\\]]+)\\]\\]", "captureGroup": 1 },
        "requiredTags": ["#directive", "#pattern"],
        "fields": [
          {
            "name": "tier",
            "type": "string",
            "pattern": ["prediction", "core", "anchor"]
          },
          { "name": "evidenceCount", "type": "number" },
          { "name": "sessionSpan", "type": "number" },
          { "name": "revisionLog", "type": "list" }
        ]
      },
      "provenance": { "source": true, "timestamp": true, "revisionLog": true },
      "gates": {
        "prediction": { "minCorroboration": 1, "maxChurn": 3 },
        "core": { "minCorroboration": 3, "minSessionSpan": 7 },
        "anchor": {
          "minCorroboration": 10,
          "minAgeDays": 30,
          "noContradiction": true
        }
      },
      "conflictResolution": "revision-gate"
    },
    "ephemeral": {
      "description": "Transient working state. Auto-cleared on completion.",
      "persistence": "ephemeral",
      "entrySchema": {
        "boundary": "^- \\[([ x])\\]",
        "idField": "line-number"
      },
      "provenance": { "timestamp": true },
      "decay": { "halfLifeDays": 14 }
    }
  }
}
```

### 4.2 Alternative: Three-Layer (Knowledge + Wisdom Merged)

```json
{
  "layerTypes": {
    "facts": {
      "description": "All durable claims: facts, decisions, and proven behavioral patterns.",
      "persistence": "supersession",
      "entrySchema": {
        "boundary": "^(#{1,3} )",
        "requiredTags": ["#fact", "#decision", "#preference", "#pattern"],
        "fields": [
          {
            "name": "stability",
            "type": "string",
            "pattern": ["fact", "pattern"],
            "default": "fact"
          },
          { "name": "supersedes", "type": "link" },
          { "name": "supersededBy", "type": "link" },
          { "name": "evidenceCount", "type": "number" }
        ]
      },
      "provenance": {
        "source": true,
        "timestamp": true,
        "sessionId": true,
        "revisionLog": true
      },
      "conflictResolution": "link"
    },
    "experiences": {
      "description": "Observations and events. Decay with optional promotion.",
      "persistence": "decay",
      "entrySchema": {
        "boundary": "^<!-- ",
        "requiredTags": ["#observation", "#event"]
      },
      "decay": {
        "halfLifeDays": 21,
        "archiveTo": "archive/daily",
        "extractBeforeArchive": true
      },
      "promotion": {
        "to": "facts",
        "gate": { "type": "corroboration", "minOccurrences": 2 },
        "transform": "extract"
      }
    },
    "context": {
      "description": "Per-session working memory.",
      "persistence": "ephemeral",
      "entrySchema": { "boundary": "^- \\[([ x])\\]" },
      "decay": { "halfLifeDays": 1 }
    }
  }
}
```

### 4.3 Alternative: Project-Scoped Memory

```json
{
  "layerTypes": {
    "project-memory": {
      "description": "Decay-scoped to project directory.",
      "persistence": "decay",
      "entrySchema": {
        "boundary": "^<!-- ",
        "requiredTags": ["#observation"],
        "fields": [
          { "name": "project", "type": "string", "required": true },
          { "name": "cwd", "type": "string" }
        ]
      },
      "decay": { "halfLifeDays": 90 }
    }
  }
}
```

---

## 5. Engine Interface

### 5.1 LayerEngine (Core Abstraction)

```typescript
/**
 * A LayerEngine implements persistence semantics for a layer type.
 * All engines are deterministic — no LLM calls inside apply/validate.
 */
interface LayerEngine {
  /** Unique engine identifier */
  readonly type: string;

  /** Parse raw content into structured entries */
  parse(content: string, schema: EntrySchema): ParsedEntry[];

  /** Serialize entries back to substrate format */
  serialize(entries: ParsedEntry[]): string;

  /** Validate a proposed edit against engine rules */
  validate(
    edit: LayerEdit,
    entries: ParsedEntry[],
    schema: EntrySchema,
  ): ValidationResult;

  /** Apply validated edits to content */
  apply(content: string, edits: LayerEdit[], schema: EntrySchema): EditResult;

  /** Compute decay plan for entries */
  computeDecay?(
    entries: ParsedEntry[],
    decay: DecayConfig,
    now: Date,
  ): DecayPlan;

  /** Check promotion eligibility */
  checkPromotion?(entry: ParsedEntry, gate: PromotionGate): PromotionResult;

  /** Find conflicts between entries */
  findConflicts?(entries: ParsedEntry[]): Conflict[];
}
```

### 5.2 Engine Registry

Engines are registered by name. The core distribution ships four engines. Users can add custom engines by implementing the interface and registering them.

```typescript
const ENGINE_REGISTRY = new Map<string, new () => LayerEngine>();

ENGINE_REGISTRY.set("supersession", SupersessionEngine);
ENGINE_REGISTRY.set("decay", DecayEngine);
ENGINE_REGISTRY.set("revision-gated", RevisionGatedEngine);
ENGINE_REGISTRY.set("ephemeral", EphemeralEngine);

export function registerEngine(
  name: string,
  ctor: new () => LayerEngine,
): void {
  ENGINE_REGISTRY.set(name, ctor);
}

export function getEngine(name: string): LayerEngine | undefined {
  const Ctor = ENGINE_REGISTRY.get(name);
  return Ctor ? new Ctor() : undefined;
}
```

### 5.3 Engine Implementations (Summary)

| Engine                | Persistence                           | Key Operations                     | Edit Vocabulary                    |
| --------------------- | ------------------------------------- | ---------------------------------- | ---------------------------------- |
| `SupersessionEngine`  | Indefinite; old preserved, new linked | `supersede`, `amend`, `retract`    | `supersede`, `add`, `remove`       |
| `DecayEngine`         | Time-based; archive or delete         | `archive`, `extract`, `refresh`    | `archive`, `extract`, `promote`    |
| `RevisionGatedEngine` | Tiered; requires evidence threshold   | `revise`, `promote-tier`, `demote` | `revise`, `promote-tier`, `demote` |
| `EphemeralEngine`     | Auto-clear on done/timeout            | `clear-done`, `expire`             | `clear-done`, `expire`             |

### 5.4 Edit Vocabulary by Engine

The LLM prompt is **constrained** to the engine's vocabulary. The LLM does not directly edit text.

**SupersessionEngine vocabulary:**

```typescript
type SupersessionEdit =
  | { type: "supersede"; targetId: string; newEntry: string; rationale: string }
  | { type: "add"; newEntry: string; afterId?: string }
  | { type: "remove"; targetId: string; reason: string }
  | {
      type: "amend";
      targetId: string;
      field: string;
      newValue: string;
      reason: string;
    };
```

**DecayEngine vocabulary:**

```typescript
type DecayEdit =
  | { type: "archive"; targetIds: string[]; reason: string }
  | {
      type: "extract";
      targetId: string;
      extractedFact: string;
      proposeFor: string;
    }
  | { type: "promote"; targetId: string; toLayer: string; reason: string }
  | { type: "refresh"; targetId: string; newTimestamp: string };
```

**RevisionGatedEngine vocabulary:**

```typescript
type RevisionEdit =
  | {
      type: "revise";
      targetId: string;
      field: string;
      newValue: string;
      evidence: string[];
    }
  | {
      type: "promote-tier";
      targetId: string;
      newTier: string;
      evidence: string[];
    }
  | { type: "demote"; targetId: string; newTier: string; reason: string };
```

---

## 6. The Reflect Loop (Layer-Agnostic)

```typescript
async function runReflection(target: Target): Promise<ReflectRun> {
  const layerType = resolveLayerType(target.layerType);
  const engine = getEngine(layerType.persistence);
  if (!engine) throw new Error(`Unknown engine: ${layerType.persistence}`);

  // 1. Read substrate
  const content = readFile(target.path);
  const entries = engine.parse(content, layerType.entrySchema);

  // 2. Collect evidence (substrate-agnostic)
  const evidence = await collectEvidence(target);

  // 3. Build LLM prompt constrained to engine vocabulary
  const prompt = buildPrompt(target, layerType, engine, entries, evidence);

  // 4. LLM proposes semantic edits (not raw text replacements)
  const proposed = await llmAnalyze(prompt);

  // 5. Validate proposals deterministically
  const validEdits = proposed.edits
    .map((e) => engine.validate(e, entries, layerType.entrySchema))
    .filter((v) => v.valid)
    .map((v) => v.edit);

  // 6. Apply via engine (handles linking, archiving, tiering, etc.)
  const result = engine.apply(content, validEdits, layerType.entrySchema);

  // 7. Write back + notify pi-memory to re-index
  writeFile(target.path, result.content);
  await notifyPiMemoryToReindex();

  return {
    timestamp: new Date().toISOString(),
    targetPath: target.path,
    editsApplied: result.applied.length,
    editsSkipped: result.skipped,
    summary: proposed.summary,
    // ...
  };
}
```

### 6.1 Prompt Construction

The LLM prompt includes:

1. **Layer type description** — what persistence semantics apply
2. **Entry schema** — what tags and fields are valid
3. **Current entries** — parsed substrate content
4. **Evidence** — transcripts, daily logs, context files
5. **Edit vocabulary** — the exact JSON schema the LLM must emit
6. **Constraints** — e.g., "Prefer supersede over add" for Knowledge layers

The LLM **never sees raw markdown manipulation**. It sees structured entries and proposes semantic operations.

---

## 7. Integration with pi-memory

### 7.1 Bidirectional Data Flow

```
pi-memory (write path)          pi-reflect (curation path)
    │                                    │
    ├─ User writes to daily/*.md ────────┤
    │                                    ├─ Reads as evidence
    │                                    ├─ Proposes edits to MEMORY.md
    │                                    └─ Applies supersession/promotion
    │                                    │
    │◄─ Reflect updates MEMORY.md ───────┘
    │                                    │
    ├─ qmd update (auto after write) ────┤
    │                                    ├─ qmd re-indexes for search
    └─ Injects curated context on next turn ◄┘
```

### 7.2 Context Injection Becomes Layer-Aware

pi-memory's `before_agent_start` hook should optionally read the reflect schema to know which layers exist and how to prioritize them:

```typescript
function buildMemoryContext(): string {
  const schema = loadReflectSchema();

  // Priority is derived from layer type persistence semantics
  const priority = [
    { path: SCRATCHPAD_FILE, layer: "ephemeral", budget: 2000 },
    { path: dailyPath(todayStr()), layer: "memory", budget: 3000 },
    { path: MEMORY_FILE, layer: "knowledge", budget: 4000 },
  ];

  // Knowledge layer: resolve supersession links so agent sees current truth
  const knowledge = readLayer("knowledge", { resolveLinks: true });

  // Memory layer: filter decayed entries (older than half-life with no refresh)
  const memory = readLayer("memory", { applyDecay: true });

  return assembleContext(priority, { knowledge, memory });
}
```

### 7.3 qmd Integration

pi-reflect should trigger `qmd update` after applying edits, just as pi-memory does after writes. The qmd collection `pi-memory` already indexes all memory files; reflect's edits are automatically searchable.

For contradiction detection, pi-reflect can query qmd directly:

```typescript
async function findContradictions(entry: ParsedEntry): Promise<QmdResult[]> {
  // Search for entries with similar semantic content but different claims
  return qmdSearch("deep", entry.content, 5, "pi-memory");
}
```

---

## 8. Implementation Phases

### Phase 1: Schema + SupersessionEngine

**Goal:** Establish the abstraction. One engine, one layer type, working end-to-end.

- [ ] Define `LayerType`, `EntrySchema`, `LayerEngine` interfaces
- [ ] Implement `SupersessionEngine` with `supersede`, `add`, `remove`, `amend`
- [ ] Update `reflect.json` schema to accept `layerTypes` and `layerType` on targets
- [ ] Backward-compat: targets without `layerType` default to `"wisdom"` (original behavior)
- [ ] Add `supersede` prompt template and validation
- [ ] Unit tests: parse, validate, apply for all SupersessionEngine operations

**Validation:** A target with `layerType: "knowledge"` can supersede an old decision in `MEMORY.md`, preserving the old entry with a `Superseded-by:` link.

### Phase 2: DecayEngine + DreamCycle

**Goal:** Memory → Knowledge promotion pipeline.

- [ ] Implement `DecayEngine` with `archive`, `extract`, `promote`, `refresh`
- [ ] Add `promotion.gate` config and validation
- [ ] Implement weekly `/reflect-promote` command
- [ ] Archive mechanics: move entries to `archive/daily/`, write promotion trail
- [ ] Integration test: daily observation corroborated 2× → promoted to MEMORY.md

**Validation:** After 7 days, a daily observation tagged `#observation` that appears in 2+ sessions is promoted to `MEMORY.md` with `#fact` tag and `promotedFrom:` link.

### Phase 3: RevisionGatedEngine

**Goal:** Behavioral rule curation with stability tiers.

- [ ] Implement `RevisionGatedEngine` with `revise`, `promote-tier`, `demote`
- [ ] Tier tracking: `prediction` → `core` → `anchor`
- [ ] Evidence counting across sessions
- [ ] `/reflect-audit` dry-run command for contradiction detection
- [ ] Update AGENTS.md target to use `layerType: "wisdom"`

**Validation:** A behavioral rule added from one session remains `prediction`. After 3+ sessions corroborate it without contradiction, it promotes to `core`.

### Phase 4: Contradiction Detection + qmd

**Goal:** Structural analysis beyond text editing.

- [ ] `findConflicts` implementation using qmd semantic search
- [ ] Contradiction report generation (no auto-fix — user/agent decides)
- [ ] BEAM-style benchmark: measure contradiction resolution accuracy
- [ ] Performance: cache parsed entries, incremental updates

**Validation:** `/reflect-audit` on `MEMORY.md` surfaces: "Entry A claims PostgreSQL; Entry B claims SQLite. Both are current (no supersession link)."

### Phase 5: Custom Engine Registration

**Goal:** User-extensible layer types.

- [ ] `registerEngine()` API exposed to extensions
- [ ] Document engine authoring guide
- [ ] Example: `append-only` engine for compliance logs, `replaceable` engine for config files

---

## 9. Migration Path

### From pi-reflect v1.x

Existing `reflect.json` configurations continue to work:

```json
{
  "targets": [
    {
      "path": "./AGENTS.md",
      "model": "anthropic/claude-sonnet-4-5",
      "lookbackDays": 1
    }
  ]
}
```

Without a `layerType`, the target defaults to the `wisdom` layer type (original behavioral-rules behavior). The edit vocabulary defaults to `strengthen|add|remove|merge`.

### From pi-memory-only setups

Users add pi-reflect and configure targets for their existing memory files:

```json
{
  "layerTypes": {
    "knowledge": { "...": "as defined above" }
  },
  "targets": [
    {
      "path": "~/.pi/agent/memory/MEMORY.md",
      "layerType": "knowledge",
      "transcripts": [
        { "type": "files", "paths": ["~/.pi/agent/memory/daily/*.md"] }
      ]
    }
  ]
}
```

No changes to pi-memory required. pi-reflect operates on the same files.

---

## 10. Open Questions

1. **Entry boundary parsing:** Should we use a generic regex approach, or integrate with qmd's chunking? qmd already understands markdown structure.

2. **LLM cost:** Validating and applying edits per-batch already exists. Layer-aware batching may need priority rules (e.g., always process `knowledge` before `memory` so promotions see updated state).

3. **Cross-substrate transactions:** If a promotion moves an entry from `daily/*.md` to `MEMORY.md`, should this be atomic? What if the daily log is locked by pi-memory's `memory_write`?

4. **Wiki-link validation:** Should `Superseded-by: [[tag]]` be validated at apply-time (check that `[[tag]]` exists) or lazily (resolve at read-time)?

5. **Custom engine distribution:** Should custom engines be npm packages, local files, or pi extensions?

---

## 11. References

- Roynard, Michaël. _The Missing Knowledge Layer in Cognitive Architectures for AI Agents._ arXiv:2604.11364, 2026.
- Sun, Lizheng. _MemX: A Local-First Long-Term Memory System for AI Assistants._ arXiv:2603.16171, 2025.
- pi-memory documentation: `/Users/lane/.pi/agent/git/github.com/jayzeng/pi-memory/README.md`
- pi-reflect v1.0: current implementation in `extensions/reflect.ts`
