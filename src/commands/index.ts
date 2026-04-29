import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerReflectCommand } from "./reflect.js";
import { registerConfigCommand } from "./config.js";
import { registerHistoryCommand } from "./history.js";
import { registerStatsCommand } from "./stats.js";
import { registerBackfillCommand } from "./backfill.js";

export function registerCommands(pi: ExtensionAPI, getModelRegistry: () => any) {
	registerReflectCommand(pi, getModelRegistry);
	registerConfigCommand(pi);
	registerHistoryCommand(pi);
	registerStatsCommand(pi);
	registerBackfillCommand(pi, getModelRegistry);
}
