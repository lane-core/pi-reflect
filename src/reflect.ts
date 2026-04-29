import * as fs from "node:fs";
import * as path from "node:path";
import { applyEdits } from "./apply.js";
import {
	computeFileMetrics,
	DEFAULT_BACKUP_DIR,
	formatTimestamp,
	resolvePath,
} from "./config.js";
import {
	collectContext,
	collectTranscripts,
	collectTranscriptsFromCommand,
} from "./extract.js";
import { buildPromptForTarget } from "./prompt.js";
import { AnalysisResponseSchema } from "./schemas.js";
import type {
	AnalysisEdit,
	AnalysisResult,
	NotifyFn,
	ReflectionOptions,
	ReflectRun,
	ReflectTarget,
	RunReflectionDeps,
	SessionData,
} from "./types.js";

const REFLECTION_TOOL_SCHEMA = {
	name: "submit_analysis",
	description: "Submit the reflection analysis results",
	parameters: {
		type: "object" as const,
		properties: {
			corrections_found: {
				type: "number",
				description: "Number of facts/rules added, updated, or removed",
			},
			sessions_with_corrections: {
				type: "number",
				description:
					"Number of conversations containing new facts or corrections",
			},
			edits: {
				type: "array",
				items: {
					type: "object",
					properties: {
						type: {
							type: "string",
							enum: ["strengthen", "add", "remove", "merge"],
							description:
								"strengthen = update existing text, add = insert new text, remove = delete redundant text, merge = consolidate multiple rules into one",
						},
						section: {
							type: "string",
							description: "Which section of the file",
						},
						old_text: {
							type: ["string", "null"],
							description:
								"Exact text to find (for strengthen) or null (for add)",
						},
						new_text: {
							type: "string",
							description:
								"Replacement text (for strengthen) or new text to insert (for add)",
						},
						after_text: {
							type: ["string", "null"],
							description: "Text after which to insert (for add) or null",
						},
						merge_sources: {
							type: ["array", "null"],
							items: { type: "string" },
							description:
								"For merge: array of exact text strings to consolidate",
						},
						reason: {
							type: "string",
							description: "Brief reason for this edit",
						},
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
			summary: {
				type: "string",
				description: "2-3 sentence summary of what was added/updated",
			},
		},
		required: [
			"corrections_found",
			"sessions_with_corrections",
			"edits",
			"summary",
		],
	},
};

const ENTRY_SEPARATOR = "\n---\n\n";

export function buildTranscriptBatches(
	sessions: SessionData[],
	maxBytes: number,
): string[][] {
	const batches: string[][] = [];
	let currentBatch: string[] = [];
	let currentSize = 0;

	for (const sd of sessions) {
		const entry = sd.transcript + ENTRY_SEPARATOR;
		if (currentSize + entry.length > maxBytes && currentBatch.length > 0) {
			batches.push(currentBatch);
			currentBatch = [];
			currentSize = 0;
		}
		currentBatch.push(entry);
		currentSize += entry.length;
	}
	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}
	return batches;
}

export function formatBatchTranscripts(
	parts: string[],
	batchIndex: number,
	totalBatches: number,
	totalSessions: number,
): string {
	const header =
		`# Session Transcripts (batch ${batchIndex + 1}/${totalBatches})\n` +
		`# ${parts.length} sessions in this batch, ${totalSessions} total\n\n`;
	return header + parts.join("");
}

export async function analyzeTranscriptBatch(
	target: ReflectTarget,
	targetPath: string,
	targetContent: string,
	transcripts: string,
	context: string,
	model: any,
	apiKey: string,
	notify: NotifyFn,
	completeFn: (model: any, request: any, options: any) => Promise<any>,
): Promise<AnalysisResult | null> {
	const prompt = buildPromptForTarget(
		target,
		targetPath,
		targetContent,
		transcripts,
		context,
	);

	const response = await completeFn(
		model,
		{
			systemPrompt:
				"You are a behavioral analysis tool that prioritizes CONCISENESS. Your goal is to keep the target file short and scannable — prefer merging, removing, and tightening rules over adding new ones. The file should get shorter or stay the same size, not grow. Analyze the session transcripts and call the submit_analysis tool with your results. Always call the tool — never respond with plain text.",
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: prompt }],
					timestamp: Date.now(),
				},
			],
			tools: [REFLECTION_TOOL_SCHEMA],
		},
		{ apiKey, maxTokens: 16384 },
	);

	if (response.stopReason === "error") {
		notify(`LLM error: ${response.errorMessage ?? "unknown"}`, "error");
		return null;
	}

	let rawAnalysis: unknown;
	const toolCall = response.content.find(
		(c: unknown) =>
			(c as Record<string, unknown>).type === "toolCall" &&
			(c as Record<string, unknown>).name === "submit_analysis",
	);
	if (toolCall && (toolCall as Record<string, unknown>).arguments) {
		rawAnalysis = (toolCall as Record<string, unknown>).arguments;
	} else {
		const responseText = response.content
			.filter((c: unknown) => (c as Record<string, unknown>).type === "text")
			.map((c: unknown) => (c as Record<string, unknown>).text as string)
			.join("")
			.trim();
		try {
			const jsonStr = responseText
				.replace(/^```json?\s*\n?/m, "")
				.replace(/\n?```\s*$/m, "");
			rawAnalysis = JSON.parse(jsonStr);
		} catch {
			notify(
				`Failed to parse LLM response as JSON. Raw response:\n${responseText.slice(0, 500)}`,
				"error",
			);
			return null;
		}
	}

	const parsed = AnalysisResponseSchema.safeParse(rawAnalysis);
	if (!parsed.success) {
		notify(`LLM returned invalid structure: ${parsed.error.message}`, "error");
		return null;
	}

	return {
		edits: parsed.data.edits,
		correctionsFound: parsed.data.corrections_found,
		sessionsWithCorrections: parsed.data.sessions_with_corrections,
		summary: parsed.data.summary,
		patternsNotAdded: parsed.data.patterns_not_added,
	};
}

function toEditRecords(edits: AnalysisEdit[]) {
	return edits
		.filter(
			(e): e is AnalysisEdit & { section: string; reason: string } =>
				!!e.section && !!e.reason,
		)
		.map((e) => ({
			type: e.type ?? "add",
			section: e.section,
			reason: e.reason,
		}));
}

async function loadTarget(
	targetPath: string,
	notify: NotifyFn,
): Promise<{ path: string; content: string } | null> {
	if (!fs.existsSync(targetPath)) {
		notify(`Target file not found: ${targetPath}`, "error");
		return null;
	}

	const content = fs.readFileSync(targetPath, "utf-8");
	if (content.length < 100) {
		notify(
			`Target file too small (${content.length} bytes): ${targetPath}`,
			"error",
		);
		return null;
	}

	return { path: targetPath, content };
}

interface TranscriptCollection {
	transcripts: string;
	sessionCount: number;
	includedCount: number;
	allSessions?: SessionData[];
}

async function collectReflectionTranscripts(
	target: ReflectTarget,
	options: ReflectionOptions | undefined,
	deps: RunReflectionDeps | undefined,
	notify: NotifyFn,
): Promise<TranscriptCollection | null> {
	let transcripts: string;
	let sessionCount = 0;
	let includedCount = 0;
	let allSessions: SessionData[] | undefined;

	if (options?.transcriptsOverride) {
		({ transcripts, sessionCount, includedCount } =
			options.transcriptsOverride);
		allSessions = options.transcriptsOverride.sessions;
	} else if (target.transcripts && target.transcripts.length > 0) {
		notify(
			`Extracting transcripts from ${target.transcripts.length} source(s) (last ${target.lookbackDays} day(s))...`,
			"info",
		);
		transcripts = await collectContext(target.transcripts, target.lookbackDays);
		const headerMatches = transcripts.match(/^###\s/gm);
		sessionCount = headerMatches?.length ?? 1;
		includedCount = sessionCount;
	} else if (
		target.transcriptSource?.type === "command" &&
		target.transcriptSource.command
	) {
		notify(
			`Extracting transcripts (last ${target.lookbackDays} day(s))...`,
			"info",
		);
		const fn =
			deps?.collectTranscriptsFromCommandFn ?? collectTranscriptsFromCommand;
		const result = await fn(
			target.transcriptSource.command,
			target.lookbackDays,
			target.maxSessionBytes,
		);
		({ transcripts, sessionCount, includedCount } = result);
		allSessions = result.sessions;
	} else {
		notify(
			`Extracting transcripts (last ${target.lookbackDays} day(s))...`,
			"info",
		);
		const fn = deps?.collectTranscriptsFn ?? collectTranscripts;
		const result = await fn(target.lookbackDays, target.maxSessionBytes);
		({ transcripts, sessionCount, includedCount } = result);
		allSessions = result.sessions;
	}

	if (!transcripts || includedCount === 0) {
		notify(
			`No substantive sessions found (${sessionCount} scanned). Nothing to reflect on.`,
			"info",
		);
		return null;
	}

	const totalSessionCount = allSessions ? allSessions.length : includedCount;
	const totalBytes = allSessions
		? allSessions.reduce((sum, s) => sum + s.size, 0)
		: transcripts.length;
	notify(
		`Extracted ${totalSessionCount} sessions (${sessionCount} scanned, ${(totalBytes / 1024).toFixed(0)}KB)`,
		"info",
	);

	return { transcripts, sessionCount, includedCount, allSessions };
}

interface ResolvedModel {
	model: unknown;
	apiKey: string;
	modelLabel: string;
}

async function resolveReflectionModel(
	target: ReflectTarget,
	modelRegistry: unknown,
	options: ReflectionOptions | undefined,
	deps: RunReflectionDeps | undefined,
	notify: NotifyFn,
): Promise<ResolvedModel | null> {
	if (options?.currentModel && options?.currentModelApiKey) {
		const model = options.currentModel as { provider: string; id: string };
		return {
			model: options.currentModel,
			apiKey: options.currentModelApiKey,
			modelLabel: `${model.provider}/${model.id}`,
		};
	}

	const getModelFn =
		deps?.getModel ?? (await import("@mariozechner/pi-ai")).getModel;
	const [provider, modelId] = target.model.split("/", 2);
	let model = getModelFn(provider as never, modelId as never);

	if (!model) {
		model = (
			modelRegistry as Record<string, (p: string, m: string) => unknown>
		)?.find?.(provider, modelId);
	}
	if (!model) {
		notify(`Model not found: ${target.model}`, "error");
		return null;
	}

	const apiKey = await (
		modelRegistry as { getApiKey?: (m: unknown) => Promise<string | null> }
	)?.getApiKey?.(model);
	if (!apiKey) {
		notify(`No API key for model: ${target.model}`, "error");
		return null;
	}

	return { model, apiKey, modelLabel: target.model };
}

async function collectReflectionContext(
	target: ReflectTarget,
	notify: NotifyFn,
): Promise<string> {
	if (!target.context || target.context.length === 0) return "";

	notify(
		`Collecting context from ${target.context.length} source(s)...`,
		"info",
	);
	const context = await collectContext(target.context, target.lookbackDays);
	if (context) {
		notify(
			`Collected ${(context.length / 1024).toFixed(0)}KB of additional context`,
			"info",
		);
	}
	return context;
}

export async function runReflection(
	target: ReflectTarget,
	modelRegistry: unknown,
	notify: NotifyFn,
	deps?: RunReflectionDeps,
	options?: ReflectionOptions,
): Promise<ReflectRun | null> {
	const targetPath = resolvePath(target.path);

	const preflight = await loadTarget(targetPath, notify);
	if (!preflight) return null;
	const { content: targetContent } = preflight;

	const txResult = await collectReflectionTranscripts(
		target,
		options,
		deps,
		notify,
	);
	if (!txResult) return null;
	const { transcripts, includedCount, allSessions } = txResult;

	const totalSessionCount = allSessions ? allSessions.length : includedCount;
	const totalBytes = allSessions
		? allSessions.reduce((sum, s) => sum + s.size, 0)
		: transcripts.length;

	const modelResult = await resolveReflectionModel(
		target,
		modelRegistry,
		options,
		deps,
		notify,
	);
	if (!modelResult) return null;
	const { model, apiKey, modelLabel } = modelResult;

	const context = await collectReflectionContext(target, notify);

	const completeFn =
		deps?.completeSimple ??
		(await import("@mariozechner/pi-ai")).completeSimple;

	const overhead = targetContent.length + (context?.length ?? 0) + 20_000;
	const batchBudget = Math.max(target.maxSessionBytes - overhead, 100_000);
	const needsBatching =
		allSessions && allSessions.length > 0 && totalBytes > batchBudget;

	let allEdits: AnalysisEdit[] = [];
	let totalCorrectionsFound = 0;
	const allSummaries: string[] = [];

	if (needsBatching) {
		const batches = buildTranscriptBatches(allSessions!, batchBudget);
		notify(
			`Sessions exceed context budget — splitting into ${batches.length} batches`,
			"info",
		);

		for (let i = 0; i < batches.length; i++) {
			const batchTranscripts = formatBatchTranscripts(
				batches[i],
				i,
				batches.length,
				totalSessionCount,
			);
			const currentContent =
				i === 0 ? targetContent : fs.readFileSync(targetPath, "utf-8");
			notify(
				`Analyzing batch ${i + 1}/${batches.length} (${batches[i].length} sessions, ${(batchTranscripts.length / 1024).toFixed(0)}KB) with ${modelLabel}...`,
				"info",
			);

			const result = await analyzeTranscriptBatch(
				target,
				targetPath,
				currentContent,
				batchTranscripts,
				context,
				model,
				apiKey!,
				notify,
				completeFn,
			);

			if (!result) continue;

			allEdits.push(...result.edits);
			totalCorrectionsFound += result.correctionsFound;
			if (result.summary) allSummaries.push(result.summary);

			if (result.edits.length > 0) {
				const currentForApply = fs.readFileSync(targetPath, "utf-8");
				const { result: updated, applied } = applyEdits(
					currentForApply,
					result.edits,
				);
				if (applied > 0) {
					if (i === 0) {
						const bkDir = resolvePath(target.backupDir || DEFAULT_BACKUP_DIR);
						fs.mkdirSync(bkDir, { recursive: true });
						const bkPath = path.join(
							bkDir,
							`${path.basename(targetPath, ".md")}_${formatTimestamp()}.md`,
						);
						fs.copyFileSync(targetPath, bkPath);
					}
					fs.writeFileSync(targetPath, updated, "utf-8");
					notify(`Batch ${i + 1}: applied ${applied} edit(s)`, "info");
				}
			}
		}
	} else {
		notify(`Analyzing with ${modelLabel}...`, "info");
		const result = await analyzeTranscriptBatch(
			target,
			targetPath,
			targetContent,
			transcripts,
			context,
			model,
			apiKey!,
			notify,
			completeFn,
		);
		if (!result) return null;
		allEdits = result.edits;
		totalCorrectionsFound = result.correctionsFound;
		if (result.summary) allSummaries.push(result.summary);
	}

	const edits = allEdits;
	const correctionsFound = totalCorrectionsFound;
	const correctionRate =
		totalSessionCount > 0 ? correctionsFound / totalSessionCount : 0;

	let sourceDateStr: string;
	if (options?.sourceDateOverride) {
		sourceDateStr = options.sourceDateOverride;
	} else {
		const sourceDate = new Date();
		sourceDate.setDate(sourceDate.getDate() - target.lookbackDays);
		sourceDateStr = sourceDate.toISOString().slice(0, 10);
	}

	const combinedSummary =
		allSummaries.join(" ") ||
		`${edits.length} edits from ${totalSessionCount} sessions.`;

	if (edits.length === 0) {
		notify(`No edits needed. ${combinedSummary}`, "info");
		return {
			timestamp: new Date().toISOString(),
			targetPath,
			sessionsAnalyzed: totalSessionCount,
			correctionsFound,
			editsApplied: 0,
			summary: combinedSummary,
			diffLines: 0,
			correctionRate,
			edits: [],
			sourceDate: sourceDateStr,
			fileSize: computeFileMetrics(fs.readFileSync(targetPath, "utf-8")),
		};
	}

	if (options?.dryRun) {
		const editRecords = toEditRecords(edits);

		notify(`[dry run] ${combinedSummary}`, "info");
		return {
			timestamp: new Date().toISOString(),
			targetPath,
			sessionsAnalyzed: totalSessionCount,
			correctionsFound,
			editsApplied: 0,
			summary: combinedSummary,
			diffLines: 0,
			correctionRate,
			edits: editRecords,
			sourceDate: sourceDateStr,
			fileSize: computeFileMetrics(fs.readFileSync(targetPath, "utf-8")),
		};
	}

	// Apply edits
	const backupDir = resolvePath(target.backupDir || DEFAULT_BACKUP_DIR);
	let totalApplied = 0;

	if (needsBatching) {
		totalApplied = edits.length;
	} else {
		fs.mkdirSync(backupDir, { recursive: true });
		const backupPath = path.join(
			backupDir,
			`${path.basename(targetPath, ".md")}_${formatTimestamp()}.md`,
		);
		fs.copyFileSync(targetPath, backupPath);

		const { result, applied, skipped } = applyEdits(targetContent, edits);

		if (applied === 0) {
			notify(
				`All ${edits.length} edits failed to apply. Skipped: ${skipped.join("; ")}`,
				"warning",
			);
			try {
				fs.unlinkSync(backupPath);
			} catch {}
			return null;
		}

		if (result.length < targetContent.length * 0.5) {
			notify(
				`Result is suspiciously small (${result.length} vs ${targetContent.length} bytes). Aborting.`,
				"error",
			);
			return null;
		}

		fs.writeFileSync(targetPath, result, "utf-8");
		totalApplied = applied;

		if (skipped.length > 0) {
			notify(
				`Applied ${applied}/${edits.length} edits (${skipped.length} skipped). Backup: ${backupPath}`,
				"warning",
			);
		} else {
			notify(`Applied ${applied} edit(s). Backup: ${backupPath}`, "info");
		}
	}

	// Compute final diff
	const finalContent = fs.readFileSync(targetPath, "utf-8");
	const originalLines = targetContent.split("\n");
	const resultLines = finalContent.split("\n");
	let diffLines = 0;
	const maxLen = Math.max(originalLines.length, resultLines.length);
	for (let i = 0; i < maxLen; i++) {
		if (originalLines[i] !== resultLines[i]) diffLines++;
	}

	notify(combinedSummary, "info");

	// Git commit
	try {
		const realPath = fs.realpathSync(targetPath);
		const repoDir = path.dirname(realPath);
		if (fs.existsSync(path.join(repoDir, ".git"))) {
			const { execFileSync } = await import("node:child_process");
			execFileSync("git", ["add", "-A"], {
				cwd: repoDir,
				stdio: "ignore",
				timeout: 5000,
			});
			execFileSync(
				"git",
				[
					"commit",
					"-m",
					`reflect: ${path.basename(realPath)} — ${totalApplied} edits from ${totalSessionCount} sessions`,
					"--no-verify",
				],
				{ cwd: repoDir, stdio: "ignore", timeout: 5000 },
			);
			notify(`Committed to ${path.basename(repoDir)}`, "info");
		}
	} catch {}

	const editRecords = toEditRecords(edits);

	return {
		timestamp: new Date().toISOString(),
		targetPath,
		sessionsAnalyzed: totalSessionCount,
		correctionsFound,
		editsApplied: totalApplied,
		summary: combinedSummary,
		diffLines,
		correctionRate,
		edits: editRecords,
		sourceDate: sourceDateStr,
		fileSize: computeFileMetrics(fs.readFileSync(targetPath, "utf-8")),
	};
}
