import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadHistory } from "../history/index.js";
import { targetLabel } from "./utils.js";

export function registerHistoryCommand(pi: ExtensionAPI) {
	pi.registerCommand("reflect-history", {
		description: "Show recent reflection runs",
		handler: async (_args, ctx) => {
			const history = loadHistory();

			if (history.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify("No reflection runs yet. Use /reflect to run one.", "info");
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
