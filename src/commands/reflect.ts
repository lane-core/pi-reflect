import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, type ReflectTarget, saveConfig } from "../config/index.js";
import { loadHistory, saveHistory } from "../history/index.js";
import { resolvePath } from "../paths/resolver.js";
import { runReflection } from "../reflection/index.js";
import type { NotifyFn } from "../types.js";
import { targetLabel } from "./utils.js";

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
