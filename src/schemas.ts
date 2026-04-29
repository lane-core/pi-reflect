/**
 * Zod schemas for runtime validation at trust boundaries.
 */

import { z } from "zod";

export const EditTypeSchema = z.enum(["strengthen", "add", "remove", "merge"]);
export type EditType = z.infer<typeof EditTypeSchema>;

export const AnalysisEditSchema = z.object({
	type: EditTypeSchema,
	section: z.string().optional(),
	old_text: z.string().nullable().optional(),
	new_text: z.string(),
	after_text: z.string().nullable().optional(),
	merge_sources: z.array(z.string()).nullable().optional(),
	reason: z.string().optional(),
});

export const AnalysisResponseSchema = z.object({
	corrections_found: z.number().int().min(0),
	sessions_with_corrections: z.number().int().min(0),
	edits: z.array(AnalysisEditSchema),
	patterns_not_added: z
		.array(
			z.object({
				pattern: z.string(),
				reason: z.string(),
			}),
		)
		.optional(),
	summary: z.string(),
});

export type AnalysisEdit = z.infer<typeof AnalysisEditSchema>;
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;
