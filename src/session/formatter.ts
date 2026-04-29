import { truncateText } from "../utils/text.js";
import type { SessionExchange } from "./types.js";

export const MAX_ASSISTANT_MSG_CHARS = 2000;
export const MAX_THINKING_MSG_CHARS = 1500;

export function formatSessionTranscript(
	exchanges: SessionExchange[],
	sessionTime: string,
	project: string,
): string {
	const lines: string[] = [];
	lines.push(`### Session: ${project} [${sessionTime}]`);
	lines.push("");

	for (const ex of exchanges) {
		if (ex.role === "user") {
			lines.push(`**USER:** ${ex.text}`);
			lines.push("");
		} else if (ex.role === "assistant") {
			if (ex.thinking) {
				lines.push(`**THINKING:** ${truncateText(ex.thinking, MAX_THINKING_MSG_CHARS)}`);
				lines.push("");
			}
			if (ex.text) {
				lines.push(`**AGENT:** ${truncateText(ex.text, MAX_ASSISTANT_MSG_CHARS)}`);
				lines.push("");
			}
		}
	}

	return lines.join("\n");
}
