import type { ReflectTarget } from "../config/schema.js";
import type { NotifyFn } from "../types.js";
import type { AnalysisResult } from "./types.js";
import { buildPromptForTarget } from "./prompt.js";

export async function analyzeTranscriptBatch(
	target: ReflectTarget,
	targetPath: string,
	targetContent: string,
	transcripts: string,
	context: string,
	model: any,
	apiKey: string,
	modelLabel: string,
	notify: NotifyFn,
	completeFn: (model: any, request: any, options: any) => Promise<any>,
): Promise<AnalysisResult | null> {
	const prompt = buildPromptForTarget(target, targetPath, targetContent, transcripts, context);

	const reflectAnalysisTool = {
		name: "submit_analysis",
		description: "Submit the reflection analysis results",
		parameters: {
			type: "object" as const,
			properties: {
				corrections_found: { type: "number", description: "Number of facts/rules added, updated, or removed" },
				sessions_with_corrections: { type: "number", description: "Number of conversations containing new facts or corrections" },
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: {
							type: { type: "string", enum: ["strengthen", "add", "remove", "merge"], description: "strengthen = update existing text, add = insert new text, remove = delete redundant text, merge = consolidate multiple rules into one" },
							section: { type: "string", description: "Which section of the file" },
							old_text: { type: ["string", "null"], description: "Exact text to find (for strengthen) or null (for add)" },
							new_text: { type: "string", description: "Replacement text (for strengthen) or new text to insert (for add)" },
							after_text: { type: ["string", "null"], description: "Text after which to insert (for add) or null" },
							merge_sources: { type: ["array", "null"], items: { type: "string" }, description: "For merge: array of exact text strings to consolidate" },
							reason: { type: "string", description: "Brief reason for this edit" },
						},
						required: ["type", "new_text"],
					},
				},
				patterns_not_added: {
					type: "array",
					items: {
						type: "object",
						properties: {
							pattern: { type: "string" },
							reason: { type: "string" },
						},
					},
				},
				summary: { type: "string", description: "2-3 sentence summary of what was added/updated" },
			},
			required: ["corrections_found", "sessions_with_corrections", "edits", "summary"],
		},
	};

	const response = await completeFn(
		model,
		{
			systemPrompt: "You are a behavioral analysis tool that prioritizes CONCISENESS. Your goal is to keep the target file short and scannable — prefer merging, removing, and tightening rules over adding new ones. The file should get shorter or stay the same size, not grow. Analyze the session transcripts and call the submit_analysis tool with your results. Always call the tool — never respond with plain text.",
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: prompt }],
					timestamp: Date.now(),
				},
			],
			tools: [reflectAnalysisTool],
		},
		{ apiKey, maxTokens: 16384 },
	);

	if (response.stopReason === "error") {
		notify(`LLM error: ${response.errorMessage ?? 'unknown'}`, "error");
		return null;
	}

	let analysis: any;
	const toolCall = response.content.find((c: any) => c.type === "toolCall" && c.name === "submit_analysis");
	if (toolCall && (toolCall as any).arguments) {
		analysis = (toolCall as any).arguments;
	} else {
		const responseText = response.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("")
			.trim();
		try {
			const jsonStr = responseText.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
			analysis = JSON.parse(jsonStr);
		} catch {
			notify(`Failed to parse LLM response as JSON. Raw response:\n${responseText.slice(0, 500)}`, "error");
			return null;
		}
	}

	return {
		edits: analysis.edits ?? [],
		correctionsFound: analysis.corrections_found ?? 0,
		sessionsWithCorrections: analysis.sessions_with_corrections ?? 0,
		summary: analysis.summary ?? "",
		patternsNotAdded: analysis.patterns_not_added,
	};
}
