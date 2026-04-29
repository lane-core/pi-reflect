import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { SessionExchange } from "./types.js";

export async function extractTranscript(filepath: string): Promise<SessionExchange[]> {
	const exchanges: SessionExchange[] = [];
	try {
		const rl = createInterface({ input: createReadStream(filepath), crlfDelay: Infinity });
		for await (const line of rl) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;
			const role = msg.role;
			if (role !== "user" && role !== "assistant") continue;

			const content = msg.content;
			if (!Array.isArray(content)) continue;

			const textParts: string[] = [];
			const thinkingParts: string[] = [];

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				if (part.type === "text" && part.text?.trim()) {
					textParts.push(part.text.trim());
				} else if (part.type === "thinking" && part.thinking?.trim()) {
					thinkingParts.push(part.thinking.trim());
				}
			}

			if (textParts.length === 0 && thinkingParts.length === 0) continue;

			exchanges.push({
				role,
				text: textParts.length > 0 ? textParts.join("\n") : null,
				thinking: thinkingParts.length > 0 ? thinkingParts.join("\n") : null,
			});
		}
	} catch {
		// Skip unreadable files
	}
	return exchanges;
}
