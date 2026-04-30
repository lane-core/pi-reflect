import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { err, ok, type Result } from "neverthrow";
import { SESSIONS_DIR } from "./config.js";
import {
	CommandError,
	type ContextError,
	DirectoryScanError,
	FileAccessError,
	NetworkError,
	SessionReadError,
} from "./errors.js";
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
): Promise<Result<ExtractResult, SessionReadError>> {
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
	} catch (e) {
		return err(
			new SessionReadError(
				`Failed to read session transcript: ${filepath}`,
				filepath,
				e,
			),
		);
	}
	return ok({ exchanges, parseFailures });
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
): Promise<Result<TranscriptResult, DirectoryScanError | SessionReadError>> {
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
): Promise<Result<TranscriptResult, DirectoryScanError | SessionReadError>> {
	return collectSessionsForDates([targetDate], maxBytes, sessionsDir);
}

export async function collectTranscriptsFromCommand(
	command: string,
	lookbackDays: number,
	maxBytes: number,
): Promise<Result<TranscriptResult, CommandError>> {
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

		return ok({
			transcripts: output,
			sessionCount: count,
			includedCount: count,
		});
	} catch (e) {
		return err(
			new CommandError(`Command failed: ${interpolated}`, interpolated, e),
		);
	}
}

interface DateRange {
	allDates: Set<string>;
	targetDateSet: Set<string>;
}

function resolveDateRanges(targetDates: string[]): DateRange {
	const nextDates = targetDates.map((d) => {
		const next = new Date(d + "T00:00:00Z");
		next.setDate(next.getDate() + 1);
		return next.toISOString().slice(0, 10);
	});
	return {
		allDates: new Set([...targetDates, ...nextDates]),
		targetDateSet: new Set(targetDates),
	};
}

async function scanProjectDirs(
	sessionsDir: string,
): Promise<Result<string[], DirectoryScanError>> {
	const dirs: string[] = [];
	try {
		for (const dir of await fs.readdir(sessionsDir)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(sessionsDir, dir);
			const st = await fs.stat(fullDir);
			if (st.isDirectory()) {
				dirs.push(fullDir);
			}
		}
	} catch (e) {
		return err(
			new DirectoryScanError(
				`Failed to scan sessions directory: ${sessionsDir}`,
				sessionsDir,
				e,
			),
		);
	}
	return ok(dirs);
}

interface CandidateFile {
	filepath: string;
	project: string;
	sessionTime: string;
}

async function collectCandidateFiles(
	dirs: string[],
	allDates: Set<string>,
	targetDateSet: Set<string>,
): Promise<Result<CandidateFile[], DirectoryScanError>> {
	const candidates: CandidateFile[] = [];

	for (const dir of dirs) {
		const project = projectNameFromDir(path.basename(dir));
		let files: string[];
		try {
			files = (await fs.readdir(dir))
				.filter((f) => f.endsWith(".jsonl"))
				.sort();
		} catch (e) {
			return err(
				new DirectoryScanError(
					`Failed to read project directory: ${dir}`,
					dir,
					e,
				),
			);
		}

		for (const file of files) {
			const fileDate = file.slice(0, 10);
			if (!allDates.has(fileDate)) continue;

			if (!targetDateSet.has(fileDate)) {
				try {
					const hour = parseInt(file.slice(11, 13));
					if (hour >= 8) continue;
				} catch (e) {
					return err(
						new DirectoryScanError(
							`Failed to parse hour from filename: ${file}`,
							dir,
							e,
						),
					);
				}
			}

			candidates.push({
				filepath: path.join(dir, file),
				project,
				sessionTime: file.slice(0, 19).replace("T", " "),
			});
		}
	}

	return ok(candidates);
}

interface ExtractionResult {
	sessions: SessionData[];
	totalScanned: number;
	totalParseFailures: number;
}

async function extractSessions(
	candidates: CandidateFile[],
): Promise<Result<ExtractionResult, SessionReadError>> {
	const sessions: SessionData[] = [];
	let totalScanned = 0;
	let totalParseFailures = 0;

	for (const c of candidates) {
		totalScanned++;
		const transcriptResult = await extractTranscript(c.filepath);
		if (transcriptResult.isErr()) {
			return err(transcriptResult.error);
		}
		const { exchanges, parseFailures } = transcriptResult.value;
		totalParseFailures += parseFailures;
		const userCount = exchanges.filter((e) => e.role === "user").length;

		if (userCount < 1 || exchanges.length < 3) continue;

		const transcript = formatSessionTranscript(
			exchanges,
			c.sessionTime,
			c.project,
		);

		sessions.push({
			userCount,
			exchangeCount: exchanges.length,
			transcript,
			size: transcript.length,
			project: c.project,
			time: c.sessionTime,
		});
	}

	return ok({ sessions, totalScanned, totalParseFailures });
}

function rankSessions(sessions: SessionData[]): SessionData[] {
	return sessions.sort((a, b) => {
		const densityA = a.userCount / Math.max(a.exchangeCount, 1);
		const densityB = b.userCount / Math.max(b.exchangeCount, 1);
		if (densityB !== densityA) return densityB - densityA;
		return b.userCount - a.userCount;
	});
}

interface BudgetResult {
	parts: string[];
	included: number;
}

function selectWithinBudget(
	sessions: SessionData[],
	maxBytes: number,
): BudgetResult {
	const parts: string[] = [];
	let currentSize = 0;
	let included = 0;

	for (const sd of sessions) {
		const entry = sd.transcript + "\n---\n\n";
		if (currentSize + entry.length > maxBytes) continue;
		parts.push(entry);
		currentSize += entry.length;
		included++;
	}

	return { parts, included };
}

function buildTranscriptResult(
	parts: string[],
	included: number,
	totalScanned: number,
	sessions: SessionData[],
	totalParseFailures: number,
): TranscriptResult {
	const parseNote =
		totalParseFailures > 0
			? `, ${totalParseFailures} malformed line(s) skipped`
			: "";
	const header =
		`# Session Transcripts\n` +
		`# Sessions scanned: ${totalScanned}, ${sessions.length} with substantive conversation, ${included} included${parseNote}\n` +
		`# Total user messages: ${sessions.reduce((s, sd) => s + sd.userCount, 0)}\n\n`;

	return {
		transcripts: header + parts.join(""),
		sessionCount: totalScanned,
		includedCount: included,
		sessions,
	};
}

async function collectSessionsForDates(
	targetDates: string[],
	maxBytes: number,
	sessionsDir?: string,
): Promise<Result<TranscriptResult, DirectoryScanError | SessionReadError>> {
	const effectiveSessionsDir = sessionsDir ?? SESSIONS_DIR;
	const { allDates, targetDateSet } = resolveDateRanges(targetDates);

	const dirsResult = await scanProjectDirs(effectiveSessionsDir);
	if (dirsResult.isErr()) {
		return err(dirsResult.error);
	}
	const dirs = dirsResult.value;

	if (dirs.length === 0) {
		return ok({ transcripts: "", sessionCount: 0, includedCount: 0 });
	}

	const candidatesResult = await collectCandidateFiles(
		dirs,
		allDates,
		targetDateSet,
	);
	if (candidatesResult.isErr()) {
		return err(candidatesResult.error);
	}
	const candidates = candidatesResult.value;

	const extractionResult = await extractSessions(candidates);
	if (extractionResult.isErr()) {
		return err(extractionResult.error);
	}
	const { sessions, totalScanned, totalParseFailures } = extractionResult.value;

	if (sessions.length === 0) {
		return ok({
			transcripts: "",
			sessionCount: totalScanned,
			includedCount: 0,
			sessions: [],
		});
	}

	const ranked = rankSessions(sessions);
	const { parts, included } = selectWithinBudget(ranked, maxBytes);

	return ok(
		buildTranscriptResult(
			parts,
			included,
			totalScanned,
			ranked,
			totalParseFailures,
		),
	);
}

export async function getAvailableSessionDates(): Promise<
	Result<string[], DirectoryScanError>
> {
	const dates = new Set<string>();
	try {
		for (const dir of await fs.readdir(SESSIONS_DIR)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(SESSIONS_DIR, dir);
			const st = await fs.stat(fullDir);
			if (!st.isDirectory()) continue;
			for (const file of await fs.readdir(fullDir)) {
				if (!file.endsWith(".jsonl")) continue;
				const fileDate = file.slice(0, 10);
				if (/^\d{4}-\d{2}-\d{2}$/.test(fileDate)) {
					dates.add(fileDate);
				}
			}
		}
	} catch (e) {
		return err(
			new DirectoryScanError(
				`Failed to scan available session dates in: ${SESSIONS_DIR}`,
				SESSIONS_DIR,
				e,
			),
		);
	}
	return ok([...dates].sort());
}

function lookbackCutoff(lookbackDays: number): string {
	return new Date(Date.now() - lookbackDays * 86_400_000)
		.toISOString()
		.slice(0, 10);
}

function isWithinLookback(filename: string, cutoff: string): boolean {
	const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
	if (!match) return true;
	const fileDate = new Date(match[1] + "T00:00:00Z");
	const cutoffDate = new Date(cutoff + "T00:00:00Z");
	return fileDate >= cutoffDate;
}

async function collectFilesContext(
	source: ContextSource,
	lookbackDays: number,
	maxBytes: number,
	cutoff: string,
): Promise<Result<string, FileAccessError | DirectoryScanError>> {
	const fileParts: string[] = [];
	let totalBytes = 0;

	for (const pattern of source.paths!) {
		const expanded = pattern.replace(/\{lookbackDays\}/g, String(lookbackDays));
		let candidates: { name: string; full: string }[] = [];

		if (expanded.includes("*")) {
			const dir = path.dirname(expanded);
			const filePattern = path.basename(expanded);
			const regex = new RegExp(
				"^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
			);
			try {
				candidates = (await fs.readdir(dir))
					.filter((f) => regex.test(f))
					.map((f) => ({ name: f, full: path.join(dir, f) }));
			} catch (e) {
				return err(
					new DirectoryScanError(
						`Failed to read directory for pattern: ${pattern}`,
						dir,
						e,
					),
				);
			}
		} else {
			try {
				await fs.access(expanded);
				candidates = [{ name: path.basename(expanded), full: expanded }];
			} catch (e) {
				return err(
					new FileAccessError(`File not accessible: ${expanded}`, expanded, e),
				);
			}
		}

		candidates = candidates
			.filter((c) => isWithinLookback(c.name, cutoff))
			.sort((a, b) => b.name.localeCompare(a.name));

		for (const c of candidates) {
			try {
				const st = await fs.stat(c.full);
				if (!st.isFile()) continue;
				const fileContent = await fs.readFile(c.full, "utf-8");
				if (totalBytes + fileContent.length > maxBytes) break;
				fileParts.push(`### ${c.name}\n${fileContent}`);
				totalBytes += fileContent.length;
			} catch (e) {
				return err(
					new FileAccessError(`Failed to read file: ${c.full}`, c.full, e),
				);
			}
		}
	}

	return ok(fileParts.join("\n\n"));
}

async function collectCommandContext(
	source: ContextSource,
	lookbackDays: number,
	maxBytes: number,
): Promise<Result<string, CommandError>> {
	const { execSync } = await import("node:child_process");
	const interpolated = source.command!.replace(
		/\{lookbackDays\}/g,
		String(lookbackDays),
	);
	try {
		const output = execSync(interpolated, {
			encoding: "utf-8",
			timeout: 30_000,
			maxBuffer: maxBytes * 2,
		});
		return ok(output);
	} catch (e) {
		return err(
			new CommandError(`Command failed: ${interpolated}`, interpolated, e),
		);
	}
}

async function collectUrlContext(
	source: ContextSource,
	lookbackDays: number,
): Promise<Result<string, NetworkError>> {
	const interpolated = source.url!.replace(
		/\{lookbackDays\}/g,
		String(lookbackDays),
	);
	try {
		const response = await fetch(interpolated, {
			signal: AbortSignal.timeout(15_000),
		});
		if (response.ok) {
			return ok(await response.text());
		}
		return err(
			new NetworkError(
				`HTTP error ${response.status} fetching ${interpolated}`,
				interpolated,
				new Error(`HTTP ${response.status}`),
			),
		);
	} catch (e) {
		return err(
			new NetworkError(`Failed to fetch URL: ${interpolated}`, interpolated, e),
		);
	}
}

export async function collectContext(
	sources: readonly ContextSource[],
	lookbackDays: number,
): Promise<Result<string, ContextError>> {
	const parts: string[] = [];
	const cutoff = lookbackCutoff(lookbackDays);

	for (const source of sources) {
		const maxBytes = source.maxBytes ?? 100 * 1024;
		const label = source.label ?? source.type;
		let contentResult: Result<string, ContextError> | undefined;

		if (source.type === "files" && source.paths) {
			contentResult = await collectFilesContext(
				source,
				lookbackDays,
				maxBytes,
				cutoff,
			);
		} else if (source.type === "command" && source.command) {
			contentResult = await collectCommandContext(
				source,
				lookbackDays,
				maxBytes,
			);
		} else if (source.type === "url" && source.url) {
			contentResult = await collectUrlContext(source, lookbackDays);
		}

		if (!contentResult) continue;
		if (contentResult.isErr()) {
			return err(contentResult.error);
		}
		let content = contentResult.value;

		if (content) {
			if (content.length > maxBytes) {
				content =
					content.slice(0, maxBytes) +
					"\n\n[...truncated to fit context budget]";
			}
			parts.push(`## ${label}\n${content}`);
		}
	}

	return ok(parts.join("\n\n---\n\n"));
}
