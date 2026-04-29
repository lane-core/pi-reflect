import type { SessionData } from "../session/types.js";

const ENTRY_SEPARATOR = "\n---\n\n";

export function buildTranscriptBatches(sessions: SessionData[], maxBytes: number): string[][] {
	const batches: string[][] = [];
	let currentBatch: string[] = [];
	let currentSize = 0;

	for (const sd of sessions) {
		const entry = sd.transcript + ENTRY_SEPARATOR;
		if (currentSize + entry.length > maxBytes && currentBatch.length > 0) {
			batches.push(currentBatch);
			currentBatch = [];
			currentSize = 0;
		}
		currentBatch.push(entry);
		currentSize += entry.length;
	}
	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}
	return batches;
}

export function formatBatchTranscripts(
	parts: string[],
	batchIndex: number,
	totalBatches: number,
	totalSessions: number,
): string {
	const header =
		`# Session Transcripts (batch ${batchIndex + 1}/${totalBatches})\n` +
		`# ${parts.length} sessions in this batch, ${totalSessions} total\n\n`;
	return header + parts.join("");
}
