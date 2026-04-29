import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config/index.js";
import { CONFIG_FILE } from "../paths/resolver.js";
import { targetLabel } from "./utils.js";

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
				ctx.ui.notify("No targets configured. Use /reflect <path> to add one.", "info");
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
