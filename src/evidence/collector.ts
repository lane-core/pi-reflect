import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextSource } from "./types.js";

function lookbackCutoff(lookbackDays: number): string {
	const d = new Date();
	d.setDate(d.getDate() - lookbackDays);
	return d.toISOString().slice(0, 10);
}

function isWithinLookback(filename: string, cutoff: string): boolean {
	const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
	if (!match) return true;
	return match[1] >= cutoff;
}

export async function collectContext(sources: ContextSource[], lookbackDays: number): Promise<string> {
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
					const expanded = pattern.replace(/\{lookbackDays\}/g, String(lookbackDays));
					let candidates: { name: string; full: string }[] = [];

					if (expanded.includes("*")) {
						const dir = path.dirname(expanded);
						const filePattern = path.basename(expanded);
						const regex = new RegExp(
							"^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
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
				const interpolated = source.command.replace(/\{lookbackDays\}/g, String(lookbackDays));
				content = execSync(interpolated, {
					encoding: "utf-8",
					timeout: 30_000,
					maxBuffer: maxBytes * 2,
				});
			} else if (source.type === "url" && source.url) {
				const interpolated = source.url.replace(/\{lookbackDays\}/g, String(lookbackDays));
				const response = await fetch(interpolated, { signal: AbortSignal.timeout(15_000) });
				if (response.ok) {
					content = await response.text();
				}
			}
		} catch {}

		if (content) {
			if (content.length > maxBytes) {
				content = content.slice(0, maxBytes) + "\n\n[...truncated to fit context budget]";
			}
			parts.push(`## ${label}\n${content}`);
		}
	}

	return parts.join("\n\n---\n\n");
}
