import * as fs from "node:fs";
import * as path from "node:path";
import { SESSIONS_DIR } from "../paths/resolver.js";
import { extractTranscript } from "./extractor.js";
import { formatSessionTranscript } from "./formatter.js";
import { projectNameFromDir } from "./project.js";
import type { SessionData, TranscriptResult } from "./types.js";

export async function collectTranscripts(
	lookbackDays: number,
	maxBytes: number,
	sessionsDir?: string,
): Promise<TranscriptResult> {
	const targetDates: string[] = [];
	for (let i = 1; i <= lookbackDays; i++) {
		const d = new Date();
		d.setDate(d.getDate() - i);
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
	const interpolated = command.replace(/\{lookbackDays\}/g, String(lookbackDays));

	try {
		let output = execSync(interpolated, {
			encoding: "utf-8",
			timeout: 60_000,
			maxBuffer: maxBytes * 2,
		});

		if (output.length > maxBytes) {
			output = output.slice(0, maxBytes) + "\n\n[...truncated to fit context budget]";
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

	for (const dir of sessionDirs) {
		const project = projectNameFromDir(path.basename(dir));
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
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
			const exchanges = await extractTranscript(filepath);
			const userCount = exchanges.filter((e) => e.role === "user").length;

			if (userCount < 1 || exchanges.length < 3) continue;

			const sessionTime = file.slice(0, 19).replace("T", " ");
			const transcript = formatSessionTranscript(exchanges, sessionTime, project);

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
		return { transcripts: "", sessionCount: totalScanned, includedCount: 0, sessions: [] };
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

	const header =
		`# Session Transcripts\n` +
		`# Sessions scanned: ${totalScanned}, ${allSessions.length} with substantive conversation, ${included} included\n` +
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
