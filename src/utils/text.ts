/**
 * Pure text utilities.
 */

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

export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
