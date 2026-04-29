import * as fs from "node:fs";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { SESSIONS_DIR } from "./config.js";
import type {
	ContextSource,
	SessionData,
	SessionExchange,
	TranscriptResult,
} from "./types.js";

interface ExtractResult {
	exchanges: SessionExchange[];
	parseFailures: number;
}

export async function extractTranscript(
	filepath: string,
): Promise<ExtractResult> {
	const exchanges: SessionExchange[] = [];
	let parseFailures = 0;
	try {
		const rl = createInterface({
			input: createReadStream(filepath),
			crlfDelay: Infinity,
		});
		for await (const line of rl) {
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				parseFailures++;
				continue;
			}

			if (!isRecord(entry) || entry.type !== "message") continue;
			const msg = entry.message;
			if (!isRecord(msg)) continue;
			const role = msg.role;
			if (role !== "user" && role !== "assistant") continue;

			const content = msg.content;
			if (!Array.isArray(content)) continue;

			const textParts: string[] = [];
			const thinkingParts: string[] = [];

			for (const part of content) {
				if (!isRecord(part)) continue;
				if (
					part.type === "text" &&
					typeof part.text === "string" &&
					part.text.trim()
				) {
					textParts.push(part.text.trim());
				} else if (
					part.type === "thinking" &&
					typeof part.thinking === "string" &&
					part.thinking.trim()
				) {
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
	return { exchanges, parseFailures };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const MAX_ASSISTANT_MSG_CHARS = 2000;
const MAX_THINKING_MSG_CHARS = 1500;

export function truncateText(
	text: string | null,
	limit: number,
): string | null {
	if (!text) return text;
	if (text.length > limit) {
		return (
			text.slice(0, limit) +
			`\n[...truncated, ${text.length - limit} chars omitted]`
		);
	}
	return text;
}

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
				lines.push(
					`**THINKING:** ${truncateText(ex.thinking, MAX_THINKING_MSG_CHARS)}`,
				);
				lines.push("");
			}
			if (ex.text) {
				lines.push(
					`**AGENT:** ${truncateText(ex.text, MAX_ASSISTANT_MSG_CHARS)}`,
				);
				lines.push("");
			}
		}
	}

	return lines.join("\n");
}

const USER = process.env.USER ?? "user";

export function projectNameFromDir(dirname: string): string {
	let name = dirname;
	const homePrefix = `--Users-${USER}-`;
	if (name.startsWith(homePrefix)) {
		name = name.slice(homePrefix.length);
	}
	const linuxPrefix = `--home-${USER}-`;
	if (name.startsWith(linuxPrefix)) {
		name = name.slice(linuxPrefix.length);
	}
	name = name.replace(/--/g, "/").replace(/^[-/]+|[-/]+$/g, "");
	return name || "workspace";
}

export async function collectTranscripts(
	lookbackDays: number,
	maxBytes: number,
	sessionsDir?: string,
): Promise<TranscriptResult> {
	const targetDates: string[] = [];
	for (let i = 1; i <= lookbackDays; i++) {
		const d = new Date(Date.now() - i * 86_400_000);
		targetDates.push(d.toISOString().slice(0, 10));
	}
	return collectSessionsForDates(targetDates, maxBytes, sessionsDir);
}

export async function collectTranscriptsForDate(
	targetDate: string,
	maxBytes: number,
	sessionsDir?: string,
): Promise<TranscriptResult> {
	return collectSessionsForDates([targetDate], maxBytes, sessionsDir);
}

export async function collectTranscriptsFromCommand(
	command: string,
	lookbackDays: number,
	maxBytes: number,
): Promise<TranscriptResult> {
	const { execSync } = await import("node:child_process");
	const interpolated = command.replace(
		/\{lookbackDays\}/g,
		String(lookbackDays),
	);

	try {
		let output = execSync(interpolated, {
			encoding: "utf-8",
			timeout: 60_000,
			maxBuffer: maxBytes * 2,
		});

		if (output.length > maxBytes) {
			output =
				output.slice(0, maxBytes) + "\n\n[...truncated to fit context budget]";
		}

		const sessionMatches = output.match(/^### Session:/gm);
		const count = sessionMatches?.length ?? 1;

		return { transcripts: output, sessionCount: count, includedCount: count };
	} catch {
		return { transcripts: "", sessionCount: 0, includedCount: 0 };
	}
}

async function collectSessionsForDates(
	targetDates: string[],
	maxBytes: number,
	sessionsDir?: string,
): Promise<TranscriptResult> {
	const effectiveSessionsDir = sessionsDir ?? SESSIONS_DIR;

	const nextDates = targetDates.map((d) => {
		const next = new Date(d + "T00:00:00Z");
		next.setDate(next.getDate() + 1);
		return next.toISOString().slice(0, 10);
	});
	const allDates = new Set([...targetDates, ...nextDates]);
	const targetDateSet = new Set(targetDates);

	const sessionDirs: string[] = [];
	try {
		for (const dir of fs.readdirSync(effectiveSessionsDir)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(effectiveSessionsDir, dir);
			if (fs.statSync(fullDir).isDirectory()) {
				sessionDirs.push(fullDir);
			}
		}
	} catch {
		return { transcripts: "", sessionCount: 0, includedCount: 0 };
	}

	const allSessions: SessionData[] = [];
	let totalScanned = 0;
	let totalParseFailures = 0;

	for (const dir of sessionDirs) {
		const project = projectNameFromDir(path.basename(dir));
		let files: string[];
		try {
			files = fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".jsonl"))
				.sort();
		} catch {
			continue;
		}

		for (const file of files) {
			const fileDate = file.slice(0, 10);
			if (!allDates.has(fileDate)) continue;

			if (!targetDateSet.has(fileDate)) {
				try {
					const hour = parseInt(file.slice(11, 13));
					if (hour >= 8) continue;
				} catch {
					continue;
				}
			}

			totalScanned++;
			const filepath = path.join(dir, file);
			const { exchanges, parseFailures } = await extractTranscript(filepath);
			totalParseFailures += parseFailures;
			const userCount = exchanges.filter((e) => e.role === "user").length;

			if (userCount < 1 || exchanges.length < 3) continue;

			const sessionTime = file.slice(0, 19).replace("T", " ");
			const transcript = formatSessionTranscript(
				exchanges,
				sessionTime,
				project,
			);

			allSessions.push({
				userCount,
				exchangeCount: exchanges.length,
				transcript,
				size: transcript.length,
				project,
				time: sessionTime,
			});
		}
	}

	if (allSessions.length === 0) {
		return {
			transcripts: "",
			sessionCount: totalScanned,
			includedCount: 0,
			sessions: [],
		};
	}

	allSessions.sort((a, b) => {
		const densityA = a.userCount / Math.max(a.exchangeCount, 1);
		const densityB = b.userCount / Math.max(b.exchangeCount, 1);
		if (densityB !== densityA) return densityB - densityA;
		return b.userCount - a.userCount;
	});

	const parts: string[] = [];
	let currentSize = 0;
	let included = 0;

	for (const sd of allSessions) {
		const entry = sd.transcript + "\n---\n\n";
		if (currentSize + entry.length > maxBytes) continue;
		parts.push(entry);
		currentSize += entry.length;
		included++;
	}

	const parseNote =
		totalParseFailures > 0
			? `, ${totalParseFailures} malformed line(s) skipped`
			: "";
	const header =
		`# Session Transcripts\n` +
		`# Sessions scanned: ${totalScanned}, ${allSessions.length} with substantive conversation, ${included} included${parseNote}\n` +
		`# Total user messages: ${allSessions.reduce((s, sd) => s + sd.userCount, 0)}\n\n`;

	return {
		transcripts: header + parts.join(""),
		sessionCount: totalScanned,
		includedCount: included,
		sessions: allSessions,
	};
}

export function getAvailableSessionDates(): string[] {
	const dates = new Set<string>();
	try {
		for (const dir of fs.readdirSync(SESSIONS_DIR)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(SESSIONS_DIR, dir);
			if (!fs.statSync(fullDir).isDirectory()) continue;
			for (const file of fs.readdirSync(fullDir)) {
				if (!file.endsWith(".jsonl")) continue;
				const fileDate = file.slice(0, 10);
				if (/^\d{4}-\d{2}-\d{2}$/.test(fileDate)) {
					dates.add(fileDate);
				}
			}
		}
	} catch {}
	return [...dates].sort();
}

function lookbackCutoff(lookbackDays: number): string {
	return new Date(Date.now() - lookbackDays * 86_400_000)
		.toISOString()
		.slice(0, 10);
}

function isWithinLookback(filename: string, cutoff: string): boolean {
	const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
	if (!match) return true;
	return match[1] >= cutoff;
}

export async function collectContext(
	sources: ContextSource[],
	lookbackDays: number,
): Promise<string> {
	const parts: string[] = [];
	const cutoff = lookbackCutoff(lookbackDays);

	for (const source of sources) {
		const maxBytes = source.maxBytes ?? 100 * 1024;
		const label = source.label ?? source.type;
		let content = "";
		let totalBytes = 0;

		try {
			if (source.type === "files" && source.paths) {
				const fileParts: string[] = [];
				for (const pattern of source.paths) {
					const expanded = pattern.replace(
						/\{lookbackDays\}/g,
						String(lookbackDays),
					);
					let candidates: { name: string; full: string }[] = [];

					if (expanded.includes("*")) {
						const dir = path.dirname(expanded);
						const filePattern = path.basename(expanded);
						const regex = new RegExp(
							"^" +
								filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") +
								"$",
						);
						try {
							candidates = fs
								.readdirSync(dir)
								.filter((f) => regex.test(f))
								.map((f) => ({ name: f, full: path.join(dir, f) }));
						} catch {}
					} else if (fs.existsSync(expanded)) {
						candidates = [{ name: path.basename(expanded), full: expanded }];
					}

					candidates = candidates
						.filter((c) => isWithinLookback(c.name, cutoff))
						.sort((a, b) => b.name.localeCompare(a.name));

					for (const c of candidates) {
						try {
							if (!fs.statSync(c.full).isFile()) continue;
							const fileContent = fs.readFileSync(c.full, "utf-8");
							if (totalBytes + fileContent.length > maxBytes) break;
							fileParts.push(`### ${c.name}\n${fileContent}`);
							totalBytes += fileContent.length;
						} catch {}
					}
				}
				content = fileParts.join("\n\n");
			} else if (source.type === "command" && source.command) {
				const { execSync } = await import("node:child_process");
				const interpolated = source.command.replace(
					/\{lookbackDays\}/g,
					String(lookbackDays),
				);
				content = execSync(interpolated, {
					encoding: "utf-8",
					timeout: 30_000,
					maxBuffer: maxBytes * 2,
				});
			} else if (source.type === "url" && source.url) {
				const interpolated = source.url.replace(
					/\{lookbackDays\}/g,
					String(lookbackDays),
				);
				const response = await fetch(interpolated, {
					signal: AbortSignal.timeout(15_000),
				});
				if (response.ok) {
					content = await response.text();
				}
			}
		} catch {}

		if (content) {
			if (content.length > maxBytes) {
				content =
					content.slice(0, maxBytes) +
					"\n\n[...truncated to fit context budget]";
			}
			parts.push(`## ${label}\n${content}`);
		}
	}

	return parts.join("\n\n---\n\n");
}
