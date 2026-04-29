import * as path from "node:path";
import type { ReflectTarget } from "../config/schema.js";

export function buildReflectionPrompt(targetPath: string, targetContent: string, transcripts: string): string {
	const fileName = path.basename(targetPath);
	const charCount = targetContent.length;
	const lineCount = targetContent.split("\n").length;
	return `You are reviewing recent agent session transcripts to improve ${fileName}.

## CRITICAL: Conciseness

The target file is ${lineCount} lines / ${charCount} chars. Your #1 job is to keep it CONCISE.
- Every rule should be 1-2 sentences max. If a rule is longer, condense it.
- Remove session counts, escalating repetition tallies, and "this happened N times" histories — the rule itself is what matters, not how many times it was violated.
- Remove verbose examples when the rule is self-explanatory.
- Merge rules that say the same thing in different words.
- Remove rules that are subsumed by other, better-worded rules.
- A good rule file is SHORT and scannable. Walls of text get ignored by agents.

## Input

### Target file: ${fileName}
<target_file>
${targetContent}
</target_file>

### Session transcripts
<transcripts>
${transcripts}
</transcripts>

## Step 1: Identify Correction Patterns

Read the transcripts for genuine corrections — user redirecting the agent, expressing frustration, repeating themselves, or correcting approach. Ignore normal flow ("no worries", "actually that looks good").

For each correction: what the agent did wrong, what the user wanted, and which rule (if any) already covers it.

## Step 2: Propose Edits (prioritize conciseness)

Four edit types available:
1. **strengthen**: Tighten an existing rule's wording (make it clearer/shorter, not longer).
2. **add**: Add a new rule for a pattern with 2+ occurrences. Keep it to 1-2 sentences.
3. **remove**: Delete a rule that is redundant (covered by another rule), obsolete, or overly verbose noise.
4. **merge**: Consolidate 2+ rules that overlap into one concise rule.

Guidelines:
- Prefer strengthen/merge/remove over add. The file should get SHORTER or stay the same size, not grow.
- When strengthening, make the rule SHORTER and CLEARER — don't add history or examples unless essential.
- Strip "This happened in N sessions", "RECURRING", session dates, escalating violation counts. The rule text is enough.
- Don't reorganize or restructure the file. Minimal, targeted edits only.
- Don't add one-off rules. Only patterns with 2+ occurrences.

## Step 3: Output

IMPORTANT: Your ENTIRE response must be a single JSON object. No markdown, no preamble.

For "strengthen": old_text = COMPLETE bullet/rule copied exactly. new_text = shorter/clearer replacement.
For "add": after_text = COMPLETE bullet/line copied exactly. new_text = concise new bullet (1-2 sentences).
For "remove": old_text = COMPLETE bullet/rule to delete. new_text = "" (empty string).
For "merge": merge_sources = array of COMPLETE bullets to consolidate. new_text = single concise replacement. The merged text replaces the first source; others are removed.

{
  "corrections_found": <number>,
  "sessions_with_corrections": <number>,
  "edits": [
    {
      "type": "strengthen" | "add" | "remove" | "merge",
      "section": "which section of the file",
      "old_text": "exact text to find (strengthen/remove) or null (add/merge)",
      "new_text": "replacement/new text, or empty string for remove",
      "after_text": "insertion point (add only) or null",
      "merge_sources": ["exact text 1", "exact text 2"] or null (merge only),
      "reason": "brief reason for this edit"
    }
  ],
  "patterns_not_added": [
    { "pattern": "description", "reason": "why not added" }
  ],
  "summary": "2-3 sentence summary"
}`;
}

export function buildPromptForTarget(
	target: ReflectTarget,
	targetPath: string,
	targetContent: string,
	transcripts: string,
	context?: string,
): string {
	if (!target.prompt) {
		return buildReflectionPrompt(targetPath, targetContent, transcripts);
	}
	const fileName = path.basename(targetPath);
	return target.prompt
		.replace(/\{fileName\}/g, fileName)
		.replace(/\{targetContent\}/g, targetContent)
		.replace(/\{transcripts\}/g, transcripts)
		.replace(/\{context\}/g, context ?? "");
}
