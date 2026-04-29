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

export class ValidationError extends Error {
	constructor(
		message: string,
		public readonly cause: unknown,
	) {
		super(message);
		this.name = "ValidationError";
	}
}

export class LLMError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LLMError";
	}
}

export class ReflectionError extends Error {
	constructor(message: string) {
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
