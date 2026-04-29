export type EditType = "strengthen" | "add" | "remove" | "merge";

export interface AnalysisEdit {
	type: EditType;
	section?: string;
	old_text?: string | null;
	new_text: string;
	after_text?: string | null;
	merge_sources?: string[];
	reason?: string;
}

export interface EditRecord {
	type: EditType;
	section: string;
	reason: string;
}

export interface EditResult {
	result: string;
	applied: number;
	skipped: string[];
}
