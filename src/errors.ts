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

/**
 * The following error classes are not yet wired into the control flow.
 * They are scaffolding for the neverthrow Result<T,E> propagation that
 * will replace the ad-hoc `notify(..., "error"); return null` pattern in
 * src/reflect.ts once runReflection is fully decomposed into phases.
 *
 * TODO: Adopt these (or refined variants) after the monolithic refactor
 * reveals the actual error boundaries between preflight, transcript
 * collection, model resolution, analysis, and edit application.
 */

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
