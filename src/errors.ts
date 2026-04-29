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

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}
