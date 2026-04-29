import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	CONFIG_FILE,
	loadConfig,
	loadHistory,
	resolvePath,
	saveConfig,
	saveHistory,
} from "./config.js";
import {
	collectTranscriptsForDate,
	getAvailableSessionDates,
} from "./extract.js";
import { runReflection } from "./reflect.js";
import type { NotifyFn, ReflectRun, ReflectTarget } from "./types.js";

export function targetLabel(filePath: string): string {
	const dir = path.basename(path.dirname(filePath));
	return `${dir}/${path.basename(filePath)}`;
}

export function registerReflectCommand(
	pi: ExtensionAPI,
	getModelRegistry: () => any,
) {
	pi.registerCommand("reflect", {
		description:
			"Reflect on recent sessions and improve a behavioral markdown file",
		handler: async (args, ctx) => {
			const modelRegistryRef = getModelRegistry();
			const targetPath = args?.trim();

			let target: ReflectTarget;

			if (targetPath) {
				const config = loadConfig();
				const existing = config.targets.find(
					(t) => resolvePath(t.path) === resolvePath(targetPath),
				);
				target = existing ?? {
					...(loadConfig().targets[0] ?? {
						path: "",
						schedule: "manual",
						model: "",
						lookbackDays: 1,
						maxSessionBytes: 614400,
						backupDir: "",
						transcriptSource: { type: "pi-sessions" },
					}),
					path: targetPath,
				};
			} else {
				const config = loadConfig();
				if (config.targets.length === 0) {
					if (ctx.hasUI) {
						const filePath = await ctx.ui.input(
							"No targets configured. Enter path to a markdown file to reflect on:",
						);
						if (!filePath) return;
						target = {
							...(config.targets[0] ?? {
								path: "",
								schedule: "manual",
								model: "",
								lookbackDays: 1,
								maxSessionBytes: 614400,
								backupDir: "",
								transcriptSource: { type: "pi-sessions" },
							}),
							path: filePath,
						};

						const save = await ctx.ui.confirm(
							"Save target?",
							`Save ${filePath} as a reflection target for next time?`,
						);
						if (save) {
							config.targets.push(target);
							saveConfig(config);
							ctx.ui.notify("Saved to reflect.json", "info");
						}
					} else {
						console.error("No targets configured. Use: /reflect <path>");
						return;
					}
				} else if (config.targets.length === 1) {
					target = config.targets[0];
				} else if (ctx.hasUI) {
					const choice = await ctx.ui.select(
						"Which target?",
						config.targets.map((t) => targetLabel(t.path)),
					);
					if (choice === undefined || choice === null) return;
					const chosenTarget = config.targets.find(
						(t) => targetLabel(t.path) === choice,
					);
					if (!chosenTarget) return;
					target = chosenTarget;
				} else {
					target = config.targets[0];
				}
			}

			const notify: NotifyFn = ctx.hasUI
				? (msg, level) => ctx.ui.notify(msg, level)
				: (msg, level) => console.log(`[reflect] [${level}] ${msg}`);

			let currentModel: any;
			let currentModelApiKey: string | undefined;
			if (ctx.model) {
				const key = await ctx.modelRegistry.getApiKey(ctx.model);
				if (key) {
					currentModel = ctx.model;
					currentModelApiKey = key;
				}
			}

			const run = await runReflection(
				target,
				modelRegistryRef,
				notify,
				undefined,
				{
					currentModel,
					currentModelApiKey,
				},
			);

			if (run) {
				const history = loadHistory();
				history.push(run);
				saveHistory(history);
			}
		},
	});
}

export function registerConfigCommand(pi: ExtensionAPI) {
	pi.registerCommand("reflect-config", {
		description: "Show and manage reflection targets",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			if (!ctx.hasUI) {
				console.log(JSON.stringify(config, null, 2));
				return;
			}

			if (config.targets.length === 0) {
				ctx.ui.notify(
					"No targets configured. Use /reflect <path> to add one.",
					"info",
				);
				return;
			}

			const lines = config.targets.map((t, i) => {
				return `${i + 1}. **${targetLabel(t.path)}** — ${t.schedule}, ${t.model}, ${t.lookbackDays}d lookback\n   ${t.path}`;
			});

			ctx.ui.notify(
				`Reflection targets:\n${lines.join("\n")}\n\nEdit: ${CONFIG_FILE}`,
				"info",
			);
		},
	});
}

export function registerHistoryCommand(pi: ExtensionAPI) {
	pi.registerCommand("reflect-history", {
		description: "Show recent reflection runs",
		handler: async (_args, ctx) => {
			const history = loadHistory();

			if (history.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"No reflection runs yet. Use /reflect to run one.",
						"info",
					);
				}
				return;
			}

			const recent = history.slice(-10).reverse();
			const lines = recent.map((r) => {
				const date = r.timestamp.slice(0, 16).replace("T", " ");
				const file = targetLabel(r.targetPath);
				return `- **${date}** ${file}: ${r.editsApplied} edits, ${r.correctionsFound} corrections (${r.sessionsAnalyzed} sessions)\n  ${r.summary}`;
			});

			if (ctx.hasUI) {
				ctx.ui.notify(`Recent reflections:\n${lines.join("\n")}`, "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});
}

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

export function registerStatsCommand(pi: ExtensionAPI) {
	pi.registerCommand("reflect-stats", {
		description:
			"Show reflection impact metrics: correction rate trend and rule recidivism, grouped by target file",
		handler: async (args, ctx) => {
			const history = loadHistory();

			if (history.length < 2) {
				const msg =
					"Need at least 2 reflection runs for stats. Use /reflect to build history.";
				if (ctx.hasUI) {
					ctx.ui.notify(msg, "info");
				} else {
					console.log(msg);
				}
				return;
			}

			function getDate(r: ReflectRun): string {
				return r.sourceDate ?? (r as any).date ?? r.timestamp.slice(0, 10);
			}

			const byTarget = new Map<string, ReflectRun[]>();
			for (const run of history) {
				const list = byTarget.get(run.targetPath) ?? [];
				list.push(run);
				byTarget.set(run.targetPath, list);
			}

			if (byTarget.size > 1 && ctx.hasUI) {
				const options = [
					"All targets",
					...Array.from(byTarget.keys()).map((p) => targetLabel(p)),
				];
				const choice = await ctx.ui.select(
					"Show stats for which target?",
					options,
				);
				if (choice === undefined || choice === null) return;
				if (choice !== "All targets") {
					const chosenPath = Array.from(byTarget.keys()).find(
						(p) => targetLabel(p) === choice,
					);
					if (chosenPath) {
						const runs = byTarget.get(chosenPath)!;
						byTarget.clear();
						byTarget.set(chosenPath, runs);
					}
				}
			}

			const output: string[] = [];
			let targetIdx = 0;

			for (const [targetPath, runs] of byTarget) {
				const fileName = targetLabel(targetPath);
				if (targetIdx > 0) output.push("", "---", "");
				output.push(`# ${fileName}`);
				output.push(`_${targetPath}_`);
				output.push("");

				const resolvedPath = resolvePath(targetPath);
				if (fs.existsSync(resolvedPath)) {
					const current = computeFileMetrics(
						fs.readFileSync(resolvedPath, "utf-8"),
					);
					output.push(`### Current Size`);
					output.push(
						`${current.chars.toLocaleString()} chars · ${current.words.toLocaleString()} words · ${current.lines.toLocaleString()} lines · ~${current.estTokens.toLocaleString()} tokens`,
					);
					output.push("");
				}

				const runsWithSize = runs
					.filter((r) => r.fileSize)
					.sort((a, b) => getDate(a).localeCompare(getDate(b)));
				if (runsWithSize.length >= 2) {
					output.push("### File Size Trend");
					output.push("");
					for (const r of runsWithSize) {
						const sz = r.fileSize!;
						const date = getDate(r);
						const bar = "\u2588".repeat(Math.round(sz.estTokens / 1000));
						output.push(
							`${date}  ${sz.chars.toLocaleString().padStart(7)} chars  ${sz.words.toLocaleString().padStart(6)} words  ~${sz.estTokens.toLocaleString().padStart(6)} tok  ${bar}`,
						);
					}

					const first = runsWithSize[0].fileSize!;
					const last = runsWithSize[runsWithSize.length - 1].fileSize!;
					const charDelta = last.chars - first.chars;
					const pct =
						first.chars > 0
							? ((charDelta / first.chars) * 100).toFixed(0)
							: "N/A";
					output.push("");
					if (charDelta > 0) {
						output.push(
							`Trend: \u2191 grew ${charDelta.toLocaleString()} chars (+${pct}%) over ${runsWithSize.length} runs`,
						);
					} else if (charDelta < 0) {
						output.push(
							`Trend: \u2193 shrank ${Math.abs(charDelta).toLocaleString()} chars (${pct}%) over ${runsWithSize.length} runs`,
						);
					} else {
						output.push(`Trend: \u2194 unchanged`);
					}
					output.push("");
				}

				output.push("### Correction Rate (corrections per session)");
				output.push("");

				const ratesWithDates = runs.map((r) => ({
					sourceDate: getDate(r),
					rate:
						r.correctionRate ??
						(r.sessionsAnalyzed > 0
							? r.correctionsFound / r.sessionsAnalyzed
							: 0),
					corrections: r.correctionsFound,
					sessions: r.sessionsAnalyzed,
				}));
				ratesWithDates.sort((a, b) => a.sourceDate.localeCompare(b.sourceDate));

				for (const r of ratesWithDates) {
					const bar = "\u2588".repeat(Math.round(r.rate * 10));
					const rateStr = r.rate.toFixed(2);
					output.push(
						`${r.sourceDate}  ${rateStr}  ${bar}  (${r.corrections}/${r.sessions} sessions)`,
					);
				}

				if (ratesWithDates.length >= 3) {
					const firstHalf = ratesWithDates.slice(
						0,
						Math.floor(ratesWithDates.length / 2),
					);
					const secondHalf = ratesWithDates.slice(
						Math.floor(ratesWithDates.length / 2),
					);
					const avgFirst =
						firstHalf.reduce((s, r) => s + r.rate, 0) / firstHalf.length;
					const avgSecond =
						secondHalf.reduce((s, r) => s + r.rate, 0) / secondHalf.length;
					const delta = avgSecond - avgFirst;
					const pct =
						avgFirst > 0
							? Math.abs((delta / avgFirst) * 100).toFixed(0)
							: "N/A";

					output.push("");
					if (delta < -0.01) {
						output.push(
							`Trend: \u2193 improving (${pct}% fewer corrections per session)`,
						);
					} else if (delta > 0.01) {
						output.push(
							`Trend: \u2191 worsening (${pct}% more corrections per session)`,
						);
					} else {
						output.push(`Trend: \u2194 flat`);
					}
				}

				output.push("");
				output.push("### Rule Recidivism (sections edited multiple times)");
				output.push("");

				const sectionCounts = new Map<
					string,
					{
						count: number;
						types: string[];
						reasons: string[];
						dates: string[];
					}
				>();

				for (const run of runs) {
					if (!run.edits) continue;
					for (const edit of run.edits) {
						const key = edit.section.toLowerCase().trim();
						const existing = sectionCounts.get(key) ?? {
							count: 0,
							types: [],
							reasons: [],
							dates: [],
						};
						existing.count++;
						existing.types.push(edit.type);
						existing.reasons.push(edit.reason);
						existing.dates.push(getDate(run));
						sectionCounts.set(key, existing);
					}
				}

				if (sectionCounts.size === 0) {
					output.push(
						"No per-edit data yet. Run /reflect to start collecting.",
					);
				} else {
					const sorted = [...sectionCounts.entries()].sort(
						(a, b) => b[1].count - a[1].count,
					);
					const recidivists = sorted.filter(([, v]) => v.count >= 2);
					const resolved = sorted.filter(([, v]) => v.count === 1);

					if (recidivists.length > 0) {
						output.push("**Recurring (not sticking):**");
						for (const [section, data] of recidivists) {
							const strengthened = data.types.filter(
								(t) => t === "strengthen",
							).length;
							const added = data.types.filter((t) => t === "add").length;
							const dateRange = `${data.dates[0]} \u2192 ${data.dates[data.dates.length - 1]}`;
							output.push(
								`- **${section}** \u00d7${data.count} (${strengthened} strengthen, ${added} add) [${dateRange}]`,
							);
							const lastReason = data.reasons[data.reasons.length - 1];
							if (lastReason) {
								output.push(
									`  Last: ${lastReason.length > 120 ? lastReason.slice(0, 120) + "..." : lastReason}`,
								);
							}
						}
					} else {
						output.push(
							"**No recurring violations.** All rules stuck after first edit.",
						);
					}

					if (resolved.length > 0) {
						output.push("");
						output.push(
							`**Resolved (edited once, not repeated):** ${resolved.length} rule(s)`,
						);
						for (const [section] of resolved.slice(0, 5)) {
							output.push(`- ${section}`);
						}
						if (resolved.length > 5) {
							output.push(`  ...and ${resolved.length - 5} more`);
						}
					}
				}

				targetIdx++;
			}

			const text = output.join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(text, "info");
			} else {
				console.log(text);
			}
		},
	});
}

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

export function registerCommands(
	pi: ExtensionAPI,
	getModelRegistry: () => any,
) {
	registerReflectCommand(pi, getModelRegistry);
	registerConfigCommand(pi);
	registerHistoryCommand(pi);
	registerStatsCommand(pi);
	registerBackfillCommand(pi, getModelRegistry);
}
