// Spec 17 SC-091: the personal speech glossary for agents — the same app-level glossary as Edit ▸ Preferences ▸
// Transcription ▸ Glossary (`<appdir>/speech/glossary.json`, shared by every project and editor window).
// list_glossary reads it; save_glossary_entry adds an entry or merges spellings into the entry with the same right
// spelling (idempotent); remove_glossary_entry deletes one (not undoable: the user approves it in an open editor
// window).
import type { GlossaryEntry } from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT_IDEMPOTENT,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const GLOSSARY_GUIDE = `Personal glossary (Edit ▸ Preferences ▸ Transcription ▸ Glossary): the user's own list of names and words the recogniser gets wrong — each entry is a right spelling ("to", e.g. "NovaPlay Studio") with the spellings Whisper writes for it ("from", e.g. ["nova play studio", "novaplei estudio"]) and optionally a language. It lives on this computer and is shared by every project; "count" says how often the user taught an entry. list_glossary reads it (query filters by spelling). save_glossary_entry {to, from, lang?} adds an entry, or merges the new spellings into the entry that already has that right spelling and language (calling it again changes nothing); texts are 1–64 characters, at most 20 spellings per entry and 2,000 entries. remove_glossary_entry {entryId} deletes one (not undoable; only when the user asks: they approve it in an open editor window). A glossary written by a newer JasperEditor is read-only (E_READ_ONLY).`;

const Text = z.string().min(1).max(64);

function summary(e: GlossaryEntry) {
	return {
		entryId: e.id,
		to: e.to,
		from: e.from,
		...(e.lang ? { lang: e.lang } : {}),
		count: e.count,
		updatedAt: e.updatedAt,
	};
}

/** Engine refusals of the glossary as tool errors with a next step. */
function glossaryError(e: unknown): never {
	const err = e as { code?: string; message?: string };
	const message = err?.message ?? 'The glossary refused the change';
	switch (err?.code) {
		case 'GLOSSARY_READ_ONLY':
			throw new ToolError(
				'E_READ_ONLY',
				message,
				'The glossary was written by a newer JasperEditor; ask the user to update this one. Nothing was changed.',
			);
		case 'GLOSSARY_LIMIT':
			throw new ToolError(
				'E_LIMIT',
				message,
				'At most 2,000 entries and 20 spellings per entry: ask the user which entries or spellings to remove.',
			);
		case 'GLOSSARY_INVALID':
		case 'VALIDATION_FAILED':
			throw new ToolError(
				'E_INVALID_PARAM',
				message,
				'Texts are 1–64 characters with at least one letter or digit; lang is a language code such as "es".',
			);
		case 'GLOSSARY_NOT_FOUND':
			throw new ToolError('E_NOT_FOUND', message, 'Use list_glossary for entry ids.');
		default:
			throw e;
	}
}

export function registerGlossaryTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_glossary',
		{
			title: 'List personal glossary',
			description:
				"The user's personal speech glossary: entries {entryId, to (right spelling), from (spellings the recogniser writes), lang?, count (times taught), updatedAt}, whether it is read-only, and what the engine repaired when it opened it. query keeps entries whose spellings contain it (case-insensitive).",
			input: {
				query: z
					.string()
					.max(64)
					.optional()
					.describe('Text to look for in the right spelling or the spellings'),
				lang: z.string().max(3).optional().describe('Only entries for this language (and those for any)'),
			},
			annotations: READ_ONLY,
		},
		async ({ query, lang }) => {
			const g = await ctx.engine((c) => c.listGlossary());
			const q = query?.trim().toLowerCase();
			const entries = g.entries
				.filter((e) => !lang || !e.lang || e.lang === lang)
				.filter((e) => !q || [e.to, ...e.from].some((s) => s.toLowerCase().includes(q)));
			return jsonResult({
				revision: g.revision,
				readOnly: g.readOnly,
				...(g.repairs.length ? { repairs: g.repairs } : {}),
				total: g.entries.length,
				limits: g.limits,
				entries: entries.map(summary),
			});
		},
	);

	defineTool(
		ctx,
		'save_glossary_entry',
		{
			title: 'Save personal glossary entry',
			description:
				'Adds an entry to the personal glossary, or merges the given spellings into the entry that already has this right spelling (and language). Idempotent: saving the same again changes nothing. Returns the entry and whether it was created or changed.',
			input: {
				to: Text.describe('The right spelling, e.g. "NovaPlay Studio"'),
				from: z
					.array(Text)
					.max(20)
					.describe('Spellings the recogniser writes for it, e.g. ["nova play studio"] (may be empty)'),
				lang: z
					.string()
					.regex(/^[a-z]{2,3}$/)
					.optional()
					.describe('Only for speech in this language (ISO 639-1, e.g. "es"); omit for any language'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ to, from, lang }) => {
			try {
				const r = await ctx.engine((c) => c.saveGlossaryEntry({ to, from, ...(lang ? { lang } : {}) }));
				return jsonResult({
					created: r.created,
					changed: r.changed,
					revision: r.revision,
					entry: summary(r.entry),
				});
			} catch (e) {
				glossaryError(e);
			}
		},
	);

	defineTool(
		ctx,
		'remove_glossary_entry',
		{
			title: 'Remove personal glossary entry',
			description:
				"Deletes an entry from the user's personal glossary (not undoable). Only when the user asks: it needs their approval in an open JasperEditor window (E_APPROVAL_DENIED without one).",
			input: { entryId: z.string().min(1).max(64).describe('Entry id from list_glossary') },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ entryId }) => {
			try {
				const r = await ctx.engine((c) => c.removeGlossaryEntry(entryId));
				return jsonResult({ ok: true, removed: r.removed, revision: r.revision });
			} catch (e) {
				glossaryError(e);
			}
		},
	);
}
