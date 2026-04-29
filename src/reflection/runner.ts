import * as fs from "node:fs";
import * as path from "node:path";
import type { ReflectTarget } from "../config/schema.js";
import { applyEdits } from "../edit/engine.js";
import { collectContext } from "../evidence/collector.js";
import {
	DEFAULT_BACKUP_DIR,
	formatTimestamp,
	resolvePath,
} from "../paths/resolver.js";
import {
	collectTranscripts,
	collectTranscriptsFromCommand,
} from "../session/collector.js";
import type { NotifyFn } from "../types.js";
import { analyzeTranscriptBatch } from "./analyzer.js";
import { buildTranscriptBatches, formatBatchTranscripts } from "./batcher.js";
import type {
	ReflectionOptions,
	ReflectRun,
	RunReflectionDeps,
} from "./types.js";

function computeFileMetrics(content: string): {
	chars: number;
	words: number;
	lines: number;
	estTokens: number;
} {
	const chars = content.length;
	const words = content.split(/\s+/).filter(Boolean).length;
	const lines = content.split("\n").length;
	const estTokens = Math.round(chars / 4);
	return { chars, words, lines, estTokens };
}

export async function runReflection(
	target: ReflectTarget,
	modelRegistry: any,
	notify: NotifyFn,
	deps?: RunReflectionDeps,
	options?: ReflectionOptions,
): Promise<ReflectRun | null> {
	const targetPath = resolvePath(target.path);

	if (!fs.existsSync(targetPath)) {
		notify(`Target file not found: ${targetPath}`, "error");
		return null;
	}

	const targetContent = fs.readFileSync(targetPath, "utf-8");
	if (targetContent.length < 100) {
		notify(
			`Target file too small (${targetContent.length} bytes): ${targetPath}`,
			"error",
		);
		return null;
	}

	// Collect transcripts
	let transcripts: string;
	let sessionCount = 0;
	let includedCount = 0;
	let allSessions: import("../session/types.js").SessionData[] | undefined;

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

	// Resolve model
	let model: any;
	let apiKey: string | undefined;
	let modelLabel: string;

	if (options?.currentModel && options?.currentModelApiKey) {
		model = options.currentModel;
		apiKey = options.currentModelApiKey;
		modelLabel = `${model.provider}/${model.id}`;
	} else {
		const getModelFn =
			deps?.getModel ?? (await import("@mariozechner/pi-ai")).getModel;
		const [provider, modelId] = target.model.split("/", 2);
		model = getModelFn(provider as any, modelId as any);

		if (!model) {
			model = modelRegistry?.find(provider, modelId);
		}
		if (!model) {
			notify(`Model not found: ${target.model}`, "error");
			return null;
		}

		apiKey = await modelRegistry?.getApiKey(model);
		if (!apiKey) {
			notify(`No API key for model: ${target.model}`, "error");
			return null;
		}
		modelLabel = target.model;
	}

	// Collect additional context
	let context = "";
	if (target.context && target.context.length > 0) {
		notify(
			`Collecting context from ${target.context.length} source(s)...`,
			"info",
		);
		context = await collectContext(target.context, target.lookbackDays);
		if (context) {
			notify(
				`Collected ${(context.length / 1024).toFixed(0)}KB of additional context`,
				"info",
			);
		}
	}

	const completeFn =
		deps?.completeSimple ??
		(await import("@mariozechner/pi-ai")).completeSimple;

	const overhead = targetContent.length + (context?.length ?? 0) + 20_000;
	const batchBudget = Math.max(target.maxSessionBytes - overhead, 100_000);
	const needsBatching =
		allSessions && allSessions.length > 0 && totalBytes > batchBudget;

	let allEdits: import("../edit/types.js").AnalysisEdit[] = [];
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
				modelLabel,
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
			modelLabel,
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
		const editRecords = edits
			.filter((e: any) => e.section && e.reason)
			.map((e: any) => ({
				type: e.type ?? "add",
				section: e.section,
				reason: e.reason,
			}));

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
			const { execFileSync } = require("node:child_process");
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

	const editRecords = edits
		.filter((e: any) => e.section && e.reason)
		.map((e: any) => ({
			type: e.type ?? "add",
			section: e.section,
			reason: e.reason,
		}));

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
