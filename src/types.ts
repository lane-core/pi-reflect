/**
 * Cross-cutting domain types.
 */

export type NotifyFn = (
	msg: string,
	level: "info" | "warning" | "error",
) => void;
