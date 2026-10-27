// Spec 17 SC-070 / SC-071: the personal glossary routes (`/api/speech/glossary…`). Entry and file schemas, limits and
// the merge rules live in @jasper/project (`glossary/schema.ts`); request texts are bounded here and cleaned and
// checked by the engine (400 VALIDATION_FAILED / GLOSSARY_INVALID).
import { GLOSSARY_LIMITS, GlossaryEntrySchema, GlossaryLangSchema } from '@jasper/project';
import { z } from 'zod';

const Text = z.string().max(1024);
const Spellings = z.array(Text).max(GLOSSARY_LIMITS.maxSpellings * 4);

/** `GET /api/speech/glossary`. */
export const GlossaryLibraryResponseSchema = z.object({
	/** Bumped on every change (the `glossary.changed` event carries it). */
	revision: z.number().int().min(0),
	/** The file was written by a newer JasperEditor: listed, never changed (writes → 409 GLOSSARY_READ_ONLY). */
	readOnly: z.boolean(),
	/** What the engine repaired when it opened the file (an unreadable file moved aside, entries kept aside). */
	repairs: z.array(z.string()),
	limits: z.object({
		maxEntries: z.number().int(),
		maxSpellings: z.number().int(),
		maxChars: z.number().int(),
	}),
	entries: z.array(GlossaryEntrySchema),
});
export type GlossaryLibraryResponse = z.infer<typeof GlossaryLibraryResponseSchema>;

/**
 * `POST /api/speech/glossary` (save: add, or merge the spellings into the entry with the same `to` and `lang`;
 * idempotent) and `POST /api/speech/glossary/remember` (the same, counting one more teaching, SC-071).
 */
export const GlossarySaveRequestSchema = z
	.object({
		/** What the recogniser writes (one or more spellings; may be empty for a name-only entry). */
		from: Spellings,
		/** The right spelling. */
		to: Text,
		lang: GlossaryLangSchema.optional(),
	})
	.strict();
export type GlossarySaveRequest = z.infer<typeof GlossarySaveRequestSchema>;

export const GlossarySaveResponseSchema = z.object({
	revision: z.number().int().min(0),
	/** A new entry (201) or the merged existing one (200). */
	created: z.boolean(),
	/** Whether the library changed (false: it already held all of it). */
	changed: z.boolean(),
	entry: GlossaryEntrySchema,
});
export type GlossarySaveResponse = z.infer<typeof GlossarySaveResponseSchema>;

/** `PUT /api/speech/glossary/:entryId`: replaces the given fields (`lang: null` = any language). */
export const GlossaryUpdateRequestSchema = z
	.object({
		from: Spellings.optional(),
		to: Text.optional(),
		lang: GlossaryLangSchema.nullable().optional(),
	})
	.strict();
export type GlossaryUpdateRequest = z.infer<typeof GlossaryUpdateRequestSchema>;

export const GlossaryEntryResponseSchema = z.object({
	revision: z.number().int().min(0),
	entry: GlossaryEntrySchema,
});

export const GlossaryDeleteResponseSchema = z.object({
	ok: z.literal(true),
	removed: z.string(),
	revision: z.number().int().min(0),
});

/** `POST /api/speech/glossary/import`: an exported glossary or a list of `{from, to, lang?}` (parsed leniently). */
export const GlossaryImportRequestSchema = z.object({ file: z.unknown() }).strict();
export type GlossaryImportRequest = z.infer<typeof GlossaryImportRequestSchema>;

export const GlossaryImportResponseSchema = z.object({
	revision: z.number().int().min(0),
	added: z.number().int().min(0),
	merged: z.number().int().min(0),
	unchanged: z.number().int().min(0),
	/** Entries not imported (index in the file's list) and spellings left out, with the reason. */
	skipped: z.array(z.object({ index: z.number().int().min(0), reason: z.string() })),
});
export type GlossaryImportResponse = z.infer<typeof GlossaryImportResponseSchema>;
