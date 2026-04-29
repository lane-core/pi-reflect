import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadHistory } from "../history/index.js";
import { resolvePath } from "../paths/resolver.js";
import type { ReflectRun } from "../reflection/types.js";
import { targetLabel } from "./utils.js";

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
					{ count: number; types: string[]; reasons: string[]; dates: string[] }
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
