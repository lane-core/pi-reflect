/**
 * Domain errors for pi-reflect.
 *
 * All errors extend Error and carry structured context so callers can
 * match on error types and render user-facing messages.
 */

export class FileError extends Error {
	constructor(
		message: string,
		public readonly path: string,
	) {
		super(message);
		this.name = "FileError";
	}
}

export class ReflectionError extends Error {
	constructor(
		message: string,
		public readonly level: "error" | "warning" = "error",
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "ReflectionError";
	}
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/* ------------------------------------------------------------------ */
/* Error types for previously-silent catch blocks                     */
/* ------------------------------------------------------------------ */

export class SessionReadError extends FileError {
	constructor(
		message: string,
		path: string,
		public readonly cause?: unknown,
	) {
		super(message, path);
		this.name = "SessionReadError";
	}
}

export class DirectoryScanError extends Error {
	constructor(
		message: string,
		public readonly dir: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "DirectoryScanError";
	}
}

export class FileAccessError extends FileError {
	constructor(
		message: string,
		path: string,
		public readonly cause?: unknown,
	) {
		super(message, path);
		this.name = "FileAccessError";
	}
}

export class GitCommitError extends Error {
	constructor(
		message: string,
		public readonly repoDir: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "GitCommitError";
	}
}

export class BackupCleanupError extends FileError {
	constructor(
		message: string,
		path: string,
		public readonly cause?: unknown,
	) {
		super(message, path);
		this.name = "BackupCleanupError";
	}
}

export class CommandError extends Error {
	constructor(
		message: string,
		public readonly command: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "CommandError";
	}
}

export class NetworkError extends Error {
	constructor(
		message: string,
		public readonly url: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "NetworkError";
	}
}

export type ContextError =
	| DirectoryScanError
	| FileAccessError
	| CommandError
	| NetworkError;
