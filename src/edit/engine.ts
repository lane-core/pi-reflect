import { escapeRegex } from "../utils/text.js";
import type { AnalysisEdit, EditResult } from "./types.js";

export function applyEdits(content: string, edits: AnalysisEdit[]): EditResult {
	let result = content;
	let applied = 0;
	const skipped: string[] = [];

	for (const edit of edits) {
		if (edit.type === "strengthen" && edit.old_text && edit.new_text) {
			if (!result.includes(edit.old_text)) {
				skipped.push(`Could not find text to strengthen: "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.old_text);
			const secondIdx = result.indexOf(edit.old_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous match (appears multiple times): "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			if (edit.old_text.length > 50) {
				const checkSnippet = edit.old_text.slice(0, 50);
				const occurrences = (edit.new_text.match(new RegExp(escapeRegex(checkSnippet), "g")) || []).length;
				if (occurrences > 1) {
					skipped.push(`Duplication detected in replacement text: "${edit.old_text.slice(0, 80)}..."`);
					continue;
				}
			}

			result = result.replace(edit.old_text, edit.new_text);
			applied++;
		} else if (edit.type === "add" && edit.new_text && edit.after_text) {
			if (!result.includes(edit.after_text)) {
				skipped.push(`Could not find insertion point: "${edit.after_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.after_text);
			const secondIdx = result.indexOf(edit.after_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous insertion point (appears multiple times): "${edit.after_text.slice(0, 80)}..."`);
				continue;
			}

			if (result.includes(edit.new_text.trim())) {
				skipped.push(`Text already exists in file: "${edit.new_text.trim().slice(0, 80)}..."`);
				continue;
			}

			result = result.replace(edit.after_text, edit.after_text + "\n" + edit.new_text);
			applied++;
		} else if (edit.type === "remove" && edit.old_text) {
			if (!result.includes(edit.old_text)) {
				skipped.push(`Could not find text to remove: "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.old_text);
			const secondIdx = result.indexOf(edit.old_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous match for removal (appears multiple times): "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			result = result.replace(edit.old_text + "\n", "");
			if (result.includes(edit.old_text)) {
				result = result.replace(edit.old_text, "");
			}
			applied++;
		} else if (edit.type === "merge" && edit.merge_sources && edit.merge_sources.length > 0 && edit.new_text) {
			let firstSourceIdx = Infinity;
			let firstSourceText = "";
			let allFound = true;

			for (const src of edit.merge_sources) {
				if (!result.includes(src)) {
					skipped.push(`Merge source not found: "${src.slice(0, 80)}..."`);
					allFound = false;
					break;
				}
				const idx = result.indexOf(src);
				if (idx < firstSourceIdx) {
					firstSourceIdx = idx;
					firstSourceText = src;
				}
			}
			if (!allFound) continue;

			result = result.replace(firstSourceText, edit.new_text);
			for (const src of edit.merge_sources) {
				if (src === firstSourceText) continue;
				result = result.replace(src + "\n", "");
				if (result.includes(src)) {
					result = result.replace(src, "");
				}
			}
			applied++;
		} else {
			skipped.push(`Invalid edit: ${JSON.stringify(edit).slice(0, 100)}`);
		}
	}

	return { result, applied, skipped };
}
