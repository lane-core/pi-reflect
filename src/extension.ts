import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCommands } from "./commands/index.js";

export default function (pi: ExtensionAPI) {
	let modelRegistryRef: any = null;

	pi.on("session_start", async (_event, ctx) => {
		modelRegistryRef = ctx.modelRegistry;
	});

	registerCommands(pi, () => modelRegistryRef);
}
