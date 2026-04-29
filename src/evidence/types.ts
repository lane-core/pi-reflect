export interface ContextSource {
	type: "files" | "command" | "url";
	label?: string;
	paths?: string[];
	command?: string;
	url?: string;
	maxBytes?: number;
}
