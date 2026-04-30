import * as fs from "node:fs/promises";
import * as path from "node:path";
import { err, ok, type Result } from "neverthrow";
import { applyEdits } from "./apply.js";
import {
	computeFileMetrics,
	DEFAULT_BACKUP_DIR,
	formatTimestamp,
	resolvePath,
} from "./config.js";
import {
	BackupCleanupError,
	GitCommitError,
	ReflectionError,
} from "./errors.js";
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
	CompleteFn,
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
		type: "object",
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
} as const;

const ENTRY_SEPARATOR = "\n---\n\n";

export function buildTranscriptBatches(
	sessions: readonly SessionData[],
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
	parts: readonly string[],
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
	model: unknown,
	apiKey: string,
	_notify: NotifyFn,
	completeFn: CompleteFn,
): Promise<Result<AnalysisResult, ReflectionError>> {
	const prompt = buildPromptForTarget(
		target,
		targetPath,
		targetContent,
		transcripts,
		context,
	);

	let response;
	try {
		response = await completeFn(
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
	} catch (e) {
		return err(new ReflectionError(`LLM request failed: ${e}`));
	}

	if (response.stopReason === "error") {
		return err(
			new ReflectionError(`LLM error: ${response.errorMessage ?? "unknown"}`),
		);
	}

	let rawAnalysis: unknown;
	const toolCall = response.content.find(
		(c): c is import("./types.js").LLMToolCallContent =>
			c.type === "toolCall" && c.name === "submit_analysis",
	);
	if (toolCall && toolCall.arguments) {
		rawAnalysis = toolCall.arguments;
	} else {
		const responseText = response.content
			.filter(
				(c): c is import("./types.js").LLMTextContent => c.type === "text",
			)
			.map((c) => c.text)
			.join("")
			.trim();
		try {
			const jsonStr = responseText
				.replace(/^```json?\s*\n?/m, "")
				.replace(/\n?```\s*$/m, "");
			rawAnalysis = JSON.parse(jsonStr);
		} catch (e) {
			return err(
				new ReflectionError(
					`Failed to parse LLM response as JSON. Raw response:\n${responseText.slice(0, 500)}`,
					"error",
					e,
				),
			);
		}
	}

	const parsed = AnalysisResponseSchema.safeParse(rawAnalysis);
	if (!parsed.success) {
		return err(
			new ReflectionError(
				`LLM returned invalid structure: ${parsed.error.message}`,
			),
		);
	}

	return ok({
		edits: parsed.data.edits,
		correctionsFound: parsed.data.corrections_found,
		sessionsWithCorrections: parsed.data.sessions_with_corrections,
		summary: parsed.data.summary,
		patternsNotAdded: parsed.data.patterns_not_added,
	});
}

function toEditRecords(edits: readonly AnalysisEdit[]) {
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
): Promise<Result<{ path: string; content: string }, ReflectionError>> {
	let content: string;
	try {
		content = await fs.readFile(targetPath, "utf-8");
	} catch (e) {
		return err(
			new ReflectionError(`Target file not found: ${targetPath}`, "error", e),
		);
	}

	if (content.length < 100) {
		return err(
			new ReflectionError(
				`Target file too small (${content.length} bytes): ${targetPath}`,
			),
		);
	}

	return ok({ path: targetPath, content });
}

interface TranscriptCollection {
	transcripts: string;
	sessionCount: number;
	includedCount: number;
	allSessions?: readonly SessionData[];
}

async function collectReflectionTranscripts(
	target: ReflectTarget,
	options: ReflectionOptions | undefined,
	deps: RunReflectionDeps | undefined,
	notify: NotifyFn,
): Promise<Result<TranscriptCollection, ReflectionError>> {
	let transcripts: string;
	let sessionCount = 0;
	let includedCount = 0;
	let allSessions: readonly SessionData[] | undefined;

	if (options?.transcriptsOverride) {
		({ transcripts, sessionCount, includedCount } =
			options.transcriptsOverride);
		allSessions = options.transcriptsOverride.sessions;
	} else if (target.transcripts && target.transcripts.length > 0) {
		notify(
			`Extracting transcripts from ${target.transcripts.length} source(s) (last ${target.lookbackDays} day(s))...`,
			"info",
		);
		const ctxResult = await collectContext(
			target.transcripts,
			target.lookbackDays,
		);
		if (ctxResult.isErr()) {
			return err(
				new ReflectionError(
					`Failed to collect transcripts: ${ctxResult.error.message}`,
				),
			);
		}
		transcripts = ctxResult.value;
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
		if (result.isErr()) {
			return err(
				new ReflectionError(
					`Failed to collect transcripts from command: ${result.error.message}`,
				),
			);
		}
		({ transcripts, sessionCount, includedCount } = result.value);
		allSessions = result.value.sessions;
	} else {
		notify(
			`Extracting transcripts (last ${target.lookbackDays} day(s))...`,
			"info",
		);
		const fn = deps?.collectTranscriptsFn ?? collectTranscripts;
		const result = await fn(target.lookbackDays, target.maxSessionBytes);
		if (result.isErr()) {
			return err(
				new ReflectionError(
					`Failed to collect transcripts: ${result.error.message}`,
				),
			);
		}
		({ transcripts, sessionCount, includedCount } = result.value);
		allSessions = result.value.sessions;
	}

	if (!transcripts || includedCount === 0) {
		return err(
			new ReflectionError(
				`No substantive sessions found (${sessionCount} scanned). Nothing to reflect on.`,
			),
		);
	}

	const totalSessionCount = allSessions ? allSessions.length : includedCount;
	const totalBytes = allSessions
		? allSessions.reduce((sum, s) => sum + s.size, 0)
		: transcripts.length;
	notify(
		`Extracted ${totalSessionCount} sessions (${sessionCount} scanned, ${(totalBytes / 1024).toFixed(0)}KB)`,
		"info",
	);

	return ok({ transcripts, sessionCount, includedCount, allSessions });
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
): Promise<Result<ResolvedModel, ReflectionError>> {
	if (options?.currentModel && options?.currentModelApiKey) {
		const model = options.currentModel as { provider: string; id: string };
		return ok({
			model: options.currentModel,
			apiKey: options.currentModelApiKey,
			modelLabel: `${model.provider}/${model.id}`,
		});
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
		return err(new ReflectionError(`Model not found: ${target.model}`));
	}

	const apiKey = await (
		modelRegistry as { getApiKey?: (m: unknown) => Promise<string | null> }
	)?.getApiKey?.(model);
	if (!apiKey) {
		return err(new ReflectionError(`No API key for model: ${target.model}`));
	}

	return ok({ model, apiKey, modelLabel: target.model });
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
	const ctxResult = await collectContext(target.context, target.lookbackDays);
	if (ctxResult.isErr()) {
		notify(`Context collection failed: ${ctxResult.error.message}`, "warning");
		return "";
	}
	const context = ctxResult.value;
	if (context) {
		notify(
			`Collected ${(context.length / 1024).toFixed(0)}KB of additional context`,
			"info",
		);
	}
	return context;
}

function computeSourceDate(
	target: ReflectTarget,
	options: ReflectionOptions | undefined,
): string {
	if (options?.sourceDateOverride) return options.sourceDateOverride;
	return new Date(Date.now() - target.lookbackDays * 86_400_000)
		.toISOString()
		.slice(0, 10);
}

interface AnalysisLoopResult {
	edits: AnalysisEdit[];
	correctionsFound: number;
	summaries: string[];
}

async function runAnalysisLoop(
	target: ReflectTarget,
	targetPath: string,
	targetContent: string,
	context: string,
	model: unknown,
	apiKey: string,
	modelLabel: string,
	notify: NotifyFn,
	completeFn: CompleteFn,
	allSessions: readonly SessionData[] | undefined,
	transcripts: string,
	totalSessionCount: number,
	batchBudget: number,
	needsBatching: boolean | undefined,
): Promise<Result<AnalysisLoopResult, ReflectionError>> {
	const allEdits: AnalysisEdit[] = [];
	let totalCorrectionsFound = 0;
	const allSummaries: string[] = [];

	if (needsBatching && allSessions) {
		const batches = buildTranscriptBatches(allSessions, batchBudget);
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
				i === 0 ? targetContent : await fs.readFile(targetPath, "utf-8");
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
				apiKey,
				notify,
				completeFn,
			);

			if (result.isErr()) {
				notify(result.error.message, result.error.level);
				continue;
			}
			const r = result.value;

			allEdits.push(...r.edits);
			totalCorrectionsFound += r.correctionsFound;
			if (r.summary) allSummaries.push(r.summary);

			if (r.edits.length > 0) {
				const currentForApply = await fs.readFile(targetPath, "utf-8");
				const { result: updated, applied } = applyEdits(
					currentForApply,
					r.edits,
				);
				if (applied > 0) {
					if (i === 0) {
						const bkDir = resolvePath(target.backupDir || DEFAULT_BACKUP_DIR);
						await fs.mkdir(bkDir, { recursive: true });
						const bkPath = path.join(
							bkDir,
							`${path.basename(targetPath, ".md")}_${formatTimestamp()}.md`,
						);
						await fs.copyFile(targetPath, bkPath);
					}
					await fs.writeFile(targetPath, updated, "utf-8");
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
			apiKey,
			notify,
			completeFn,
		);
		if (result.isErr()) return err(result.error);
		const r = result.value;
		allEdits.push(...r.edits);
		totalCorrectionsFound += r.correctionsFound;
		if (r.summary) allSummaries.push(r.summary);
	}

	return ok({
		edits: allEdits,
		correctionsFound: totalCorrectionsFound,
		summaries: allSummaries,
	});
}

interface EditApplicationResult {
	result: string;
	applied: number;
	skipped: string[];
	backupPath: string;
}

async function applyEditsWithBackup(
	targetPath: string,
	targetContent: string,
	edits: AnalysisEdit[],
	backupDir: string,
): Promise<
	Result<EditApplicationResult, ReflectionError | BackupCleanupError>
> {
	await fs.mkdir(backupDir, { recursive: true });
	const backupPath = path.join(
		backupDir,
		`${path.basename(targetPath, ".md")}_${formatTimestamp()}.md`,
	);
	await fs.copyFile(targetPath, backupPath);

	const { result, applied, skipped } = applyEdits(targetContent, edits);

	if (applied === 0) {
		try {
			await fs.unlink(backupPath);
		} catch (e) {
			return err(
				new BackupCleanupError(
					`Failed to clean up backup after failed edits: ${backupPath}`,
					backupPath,
					e,
				),
			);
		}
		return err(
			new ReflectionError(
				`All ${edits.length} edits failed to apply. Skipped: ${skipped.join("; ")}`,
				"warning",
			),
		);
	}

	if (result.length < targetContent.length * 0.5) {
		return err(
			new ReflectionError(
				`Result is suspiciously small (${result.length} vs ${targetContent.length} bytes). Aborting.`,
			),
		);
	}

	await fs.writeFile(targetPath, result, "utf-8");
	return ok({ result, applied, skipped, backupPath });
}

function computeDiffLines(original: string, final: string): number {
	const originalLines = original.split("\n");
	const resultLines = final.split("\n");
	let diffLines = 0;
	const maxLen = Math.max(originalLines.length, resultLines.length);
	for (let i = 0; i < maxLen; i++) {
		if (originalLines[i] !== resultLines[i]) diffLines++;
	}
	return diffLines;
}

async function gitCommitReflection(
	targetPath: string,
	totalApplied: number,
	totalSessionCount: number,
	_notify: NotifyFn,
): Promise<Result<void, GitCommitError>> {
	let repoDir: string;
	try {
		const realPath = await fs.realpath(targetPath);
		repoDir = path.dirname(realPath);
		await fs.access(path.join(repoDir, ".git"));
	} catch {
		return ok(void 0);
	}
	try {
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
				`reflect: ${path.basename(repoDir)} — ${totalApplied} edits from ${totalSessionCount} sessions`,
				"--no-verify",
			],
			{ cwd: repoDir, stdio: "ignore", timeout: 5000 },
		);
		return ok(void 0);
	} catch (e) {
		return err(
			new GitCommitError(`Git commit failed in ${repoDir}`, repoDir, e),
		);
	}
}

export async function runReflection(
	target: ReflectTarget,
	modelRegistry: unknown,
	notify: NotifyFn,
	deps?: RunReflectionDeps,
	options?: ReflectionOptions,
): Promise<ReflectRun | null> {
	const targetPath = resolvePath(target.path);

	const preflight = await loadTarget(targetPath);
	if (preflight.isErr()) {
		notify(preflight.error.message, preflight.error.level);
		return null;
	}
	const { content: targetContent } = preflight.value;

	const txResult = await collectReflectionTranscripts(
		target,
		options,
		deps,
		notify,
	);
	if (txResult.isErr()) {
		notify(txResult.error.message, "info");
		return null;
	}
	const { transcripts, includedCount, allSessions } = txResult.value;

	const totalSessionCount = allSessions ? allSessions.length : includedCount;
	const totalBytes = allSessions
		? allSessions.reduce((sum, s) => sum + s.size, 0)
		: transcripts.length;

	const modelResult = await resolveReflectionModel(
		target,
		modelRegistry,
		options,
		deps,
	);
	if (modelResult.isErr()) {
		notify(modelResult.error.message, modelResult.error.level);
		return null;
	}
	const { model, apiKey, modelLabel } = modelResult.value;

	const context = await collectReflectionContext(target, notify);

	const completeFn: CompleteFn =
		deps?.completeSimple ??
		((await import("@mariozechner/pi-ai")).completeSimple as CompleteFn);

	const overhead = targetContent.length + (context?.length ?? 0) + 20_000;
	const batchBudget = Math.max(target.maxSessionBytes - overhead, 100_000);
	const needsBatching =
		allSessions && allSessions.length > 0 && totalBytes > batchBudget;

	const analysis = await runAnalysisLoop(
		target,
		targetPath,
		targetContent,
		context,
		model,
		apiKey,
		modelLabel,
		notify,
		completeFn,
		allSessions,
		transcripts,
		totalSessionCount,
		batchBudget,
		needsBatching,
	);
	if (analysis.isErr()) {
		notify(analysis.error.message, analysis.error.level);
		return null;
	}
	const { edits, correctionsFound, summaries } = analysis.value;

	const correctionRate =
		totalSessionCount > 0 ? correctionsFound / totalSessionCount : 0;
	const sourceDateStr = computeSourceDate(target, options);
	const combinedSummary =
		summaries.join(" ") ||
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
			fileSize: computeFileMetrics(await fs.readFile(targetPath, "utf-8")),
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
			fileSize: computeFileMetrics(await fs.readFile(targetPath, "utf-8")),
		};
	}

	const backupDir = resolvePath(target.backupDir || DEFAULT_BACKUP_DIR);
	let totalApplied = 0;

	if (needsBatching) {
		totalApplied = edits.length;
	} else {
		const applied = await applyEditsWithBackup(
			targetPath,
			targetContent,
			edits,
			backupDir,
		);
		if (applied.isErr()) {
			const level = "level" in applied.error ? applied.error.level : "error";
			notify(applied.error.message, level);
			return null;
		}
		totalApplied = applied.value.applied;
		if (applied.value.skipped.length > 0) {
			notify(
				`Applied ${applied.value.applied}/${edits.length} edits (${applied.value.skipped.length} skipped). Backup: ${applied.value.backupPath}`,
				"warning",
			);
		} else {
			notify(
				`Applied ${applied.value.applied} edit(s). Backup: ${applied.value.backupPath}`,
				"info",
			);
		}
	}

	const finalContent = await fs.readFile(targetPath, "utf-8");
	const diffLines = computeDiffLines(targetContent, finalContent);

	notify(combinedSummary, "info");
	const commitResult = await gitCommitReflection(
		targetPath,
		totalApplied,
		totalSessionCount,
		notify,
	);
	if (commitResult.isErr()) {
		notify(commitResult.error.message, "warning");
	}

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
		fileSize: computeFileMetrics(finalContent),
	};
}
