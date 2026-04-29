import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config/index.js";
import type { ReflectTarget } from "../config/schema.js";
import { loadHistory, saveHistory } from "../history/index.js";
import { resolvePath } from "../paths/resolver.js";
import { runReflection } from "../reflection/index.js";
import { collectTranscriptsForDate } from "../session/index.js";
import type { NotifyFn } from "../types.js";
import { targetLabel } from "./utils.js";

export function registerBackfillCommand(
	pi: ExtensionAPI,
	getModelRegistry: () => any,
) {
	pi.registerCommand("reflect-backfill", {
		description:
			"Backfill reflection stats for all available session dates (dry run — no file edits)",
		handler: async (_args, ctx) => {
			const modelRegistryRef = getModelRegistry();

			if (!ctx.hasUI) {
				console.error("reflect-backfill requires interactive mode.");
				return;
			}

			const config = loadConfig();
			if (config.targets.length === 0) {
				ctx.ui.notify(
					"No targets configured. Use /reflect <path> to add one.",
					"info",
				);
				return;
			}

			const piSessionTargets = config.targets.filter(
				(t) => !t.transcriptSource || t.transcriptSource.type === "pi-sessions",
			);

			if (piSessionTargets.length === 0) {
				ctx.ui.notify(
					"No pi-sessions targets to backfill. Command-based transcript sources are not supported for backfill.",
					"info",
				);
				return;
			}

			const { getAvailableSessionDates } = await import("../session/index.js");
			const allDates = getAvailableSessionDates();
			if (allDates.length === 0) {
				ctx.ui.notify("No session files found.", "info");
				return;
			}

			const history = loadHistory();
			const plan: { target: ReflectTarget; dates: string[] }[] = [];

			for (const target of piSessionTargets) {
				const targetPath = resolvePath(target.path);
				const coveredDates = new Set(
					history
						.filter((r) => r.targetPath === targetPath)
						.map((r) => r.sourceDate ?? (r as any).date)
						.filter(Boolean),
				);
				const missingDates = allDates.filter((d) => !coveredDates.has(d));
				if (missingDates.length > 0) {
					plan.push({ target, dates: missingDates });
				}
			}

			if (plan.length === 0) {
				ctx.ui.notify(
					"All dates already covered. Nothing to backfill.",
					"info",
				);
				return;
			}

			const { getModel } = await import("@mariozechner/pi-ai");
			const target0 = plan[0].target;
			const [provider, modelId] = target0.model.split("/", 2);
			let model = getModel(provider as any, modelId as any);
			if (!model) {
				model = modelRegistryRef?.find(provider, modelId);
			}

			const totalCalls = plan.reduce((s, p) => s + p.dates.length, 0);
			const estInputTokensPerCall = 150_000;
			const estOutputTokensPerCall = 2_000;

			let costEstimate = "unknown";
			if (model?.cost) {
				const inputCost =
					(totalCalls * estInputTokensPerCall * model.cost.input) / 1_000_000;
				const outputCost =
					(totalCalls * estOutputTokensPerCall * model.cost.output) / 1_000_000;
				costEstimate = `$${(inputCost + outputCost).toFixed(2)}`;
			}

			const planLines: string[] = [];
			planLines.push("**Backfill plan (dry run — no file edits):**");
			planLines.push("");
			for (const p of plan) {
				const fileName = targetLabel(p.target.path);
				planLines.push(
					`- **${fileName}**: ${p.dates.length} date(s) [${p.dates[0]} \u2192 ${p.dates[p.dates.length - 1]}]`,
				);
			}
			planLines.push("");
			planLines.push(
				`**Total:** ${totalCalls} LLM call(s) using ${target0.model}`,
			);
			planLines.push(`**Estimated cost:** ${costEstimate}`);

			ctx.ui.notify(planLines.join("\n"), "info");

			const proceed = await ctx.ui.confirm(
				"Run backfill?",
				`This will make ${totalCalls} LLM calls (~${costEstimate}). No files will be modified — only stats history is updated.`,
			);

			if (!proceed) {
				ctx.ui.notify("Backfill cancelled.", "info");
				return;
			}

			let completed = 0;
			let failed = 0;
			const updatedHistory = loadHistory();

			for (const p of plan) {
				const fileName = targetLabel(p.target.path);

				for (const date of p.dates) {
					ctx.ui.notify(
						`[${completed + failed + 1}/${totalCalls}] ${fileName} — ${date}...`,
						"info",
					);

					const transcriptResult = await collectTranscriptsForDate(
						date,
						p.target.maxSessionBytes,
					);

					if (
						!transcriptResult.transcripts ||
						transcriptResult.includedCount === 0
					) {
						ctx.ui.notify(
							`  ${date}: no substantive sessions, skipping`,
							"info",
						);
						failed++;
						continue;
					}

					const notify: NotifyFn = (msg, level) => {
						ctx.ui.notify(`  ${date}: ${msg}`, level);
					};

					const run = await runReflection(
						p.target,
						modelRegistryRef,
						notify,
						undefined,
						{
							sourceDateOverride: date,
							transcriptsOverride: transcriptResult,
							dryRun: true,
						},
					);

					if (run) {
						updatedHistory.push(run);
						saveHistory(updatedHistory);
						completed++;
					} else {
						failed++;
					}
				}
			}

			ctx.ui.notify(
				`Backfill complete: ${completed} succeeded, ${failed} skipped/failed out of ${totalCalls} dates.`,
				completed > 0 ? "info" : "warning",
			);
		},
	});
}
