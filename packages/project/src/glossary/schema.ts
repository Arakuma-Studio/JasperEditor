// The personal glossary (spec 17 SC-070; docs/wp-notes/script-correction.md "Personal glossary"): the user's own
// "the recogniser writes X, the right spelling is Y" list, one per app dir (`<appdir>/speech/glossary.json`), shared by
// every project and agent. This module is the pure part: the entry and file schemas, the text rules, the limits, the
// lenient import parser and the merge rules the engine's library applies. Nothing here touches the disk.
//
// Text rules: entry texts are NFC, single-spaced, trimmed, 1–64 characters (code points) with at least one letter or
// digit; control characters and line breaks become spaces. `from` holds up to 20 distinct misspellings (compared
// without case: the recogniser's casing is not a spelling) and never the target itself. Entries are keyed by their
// target spelling `to` (exact, case-sensitive: "NovaPlay" and "Novaplay" are different spellings) and `lang`:
// saving a target that exists merges its spellings into that entry instead of adding a second one.
import { z } from 'zod';
import { CROCKFORD_ALPHABET } from '../ids.ts';

export const GLOSSARY_FORMAT = 'jasper-speech-glossary';
export const GLOSSARY_VERSION = 1;

export const GLOSSARY_LIMITS = {
	/** Entries in one glossary. */
	maxEntries: 2000,
	/** Misspellings (`from`) of one entry. */
	maxSpellings: 20,
	/** Characters (code points) of one spelling or target. */
	maxChars: 64,
	/** Entries an import file may hold; the rest are skipped (allocation cap for untrusted input). */
	maxImportEntries: 10_000,
} as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being replaced
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A glossary text as stored: NFC, control characters and line breaks as spaces, single spaces, trimmed. */
export function cleanGlossaryText(s: string): string {
	return s.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
}

/** Why `s` (already cleaned) cannot be a glossary text, or null. */
export function glossaryTextProblem(s: string): string | null {
	if (!s) return 'is empty';
	if ([...s].length > GLOSSARY_LIMITS.maxChars)
		return `is longer than ${GLOSSARY_LIMITS.maxChars} characters`;
	if (!/[\p{L}\p{N}]/u.test(s)) return 'has no letters or digits';
	return null;
}

/** The key two misspellings are the same by: the recogniser's casing is not a spelling. */
export function glossarySpellingKey(s: string): string {
	return cleanGlossaryText(s).toLowerCase();
}

const GlossaryTextSchema = z
	.string()
	.max(1024)
	.superRefine((s, ctx) => {
		const p = cleanGlossaryText(s) !== s ? 'is not normalised (extra spaces or control characters)' : null;
		const problem = p ?? glossaryTextProblem(s);
		if (problem) ctx.addIssue({ code: 'custom', message: `text ${problem}` });
	});

/** A Whisper language code (`es`, `en`, `haw`…). */
export const GlossaryLangSchema = z.string().regex(/^[a-z]{2,3}$/);

export const GLOSSARY_ID_RE = /^gle_[0-9A-HJKMNP-TV-Z]{16}$/;

const entryShape = {
	id: z.string().regex(GLOSSARY_ID_RE),
	/** What the recogniser writes (≤ 20 distinct spellings, none equal to `to`). */
	from: z.array(GlossaryTextSchema).max(GLOSSARY_LIMITS.maxSpellings),
	/** The right spelling. */
	to: GlossaryTextSchema,
	/** Only for speech in this language (absent: any). */
	lang: GlossaryLangSchema.optional(),
	/** How many times the user taught it ("Remember"). */
	count: z.number().int().min(0).max(1_000_000_000),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
};

function checkSpellings(e: { from: string[]; to: string }, ctx: z.RefinementCtx): void {
	const seen = new Set<string>();
	for (const [i, f] of e.from.entries()) {
		const k = glossarySpellingKey(f);
		if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['from', i], message: 'duplicate spelling' });
		seen.add(k);
		if (f === e.to)
			ctx.addIssue({ code: 'custom', path: ['from', i], message: 'a spelling equals the target' });
	}
}

/** A stored entry (strict: what this version writes). */
export const GlossaryEntrySchema = z.object(entryShape).strict().superRefine(checkSpellings);
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

/** An entry of a file written by a newer version: unknown keys are dropped for display (the file is never rewritten). */
export const GlossaryEntryReadSchema = z.object(entryShape).superRefine(checkSpellings);

/** The library file and the export file (`GET /api/speech/glossary/export`). */
export const GlossaryFileSchema = z.object({
	format: z.literal(GLOSSARY_FORMAT),
	version: z.literal(GLOSSARY_VERSION),
	revision: z.number().int().min(0),
	entries: z.array(GlossaryEntrySchema).max(GLOSSARY_LIMITS.maxEntries),
});
export type GlossaryFile = z.infer<typeof GlossaryFileSchema>;

/** A refusal of the merge rules; the engine maps `code` to its HTTP error. */
export class GlossaryError extends Error {
	constructor(
		readonly code: 'GLOSSARY_INVALID' | 'GLOSSARY_LIMIT' | 'GLOSSARY_DUPLICATE' | 'GLOSSARY_NOT_FOUND',
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'GlossaryError';
	}
}

/** What a caller asks to save: raw texts (cleaned and checked here). */
export type GlossaryInput = { from: readonly string[]; to: string; lang?: string | null };

/** Cleaned, checked and deduplicated input; throws `GlossaryError('GLOSSARY_INVALID')`. */
export function normalizeGlossaryInput(input: GlossaryInput): { from: string[]; to: string; lang?: string } {
	const to = cleanGlossaryText(String(input.to ?? ''));
	const p = glossaryTextProblem(to);
	if (p) throw new GlossaryError('GLOSSARY_INVALID', `The right spelling ${p}`);
	const lang = input.lang ?? undefined;
	if (lang !== undefined && !GlossaryLangSchema.safeParse(lang).success)
		throw new GlossaryError('GLOSSARY_INVALID', `Unknown language code: ${String(lang).slice(0, 16)}`);
	const from: string[] = [];
	const seen = new Set<string>();
	for (const raw of input.from ?? []) {
		const f = cleanGlossaryText(String(raw));
		const fp = glossaryTextProblem(f);
		if (fp) throw new GlossaryError('GLOSSARY_INVALID', `A spelling ${fp}`);
		const k = glossarySpellingKey(f);
		if (f === to || seen.has(k)) continue;
		seen.add(k);
		from.push(f);
	}
	if (from.length > GLOSSARY_LIMITS.maxSpellings)
		throw new GlossaryError(
			'GLOSSARY_LIMIT',
			`An entry holds at most ${GLOSSARY_LIMITS.maxSpellings} spellings`,
		);
	return { from, to, ...(lang !== undefined ? { lang } : {}) };
}

const sameKey = (e: { to: string; lang?: string }, to: string, lang: string | undefined) =>
	e.to === to && (e.lang ?? null) === (lang ?? null);

/** Spellings of `a` followed by the new ones of `b` (by spelling key), never the target. */
function unionSpellings(a: readonly string[], b: readonly string[], to: string): string[] {
	const out = [...a];
	const seen = new Set(a.map(glossarySpellingKey));
	for (const f of b) {
		const k = glossarySpellingKey(f);
		if (f === to || seen.has(k)) continue;
		seen.add(k);
		out.push(f);
	}
	return out;
}

/** A new entry id (`gle_` + 16 Crockford characters) from 16 random bytes. */
export function glossaryIdFrom(bytes: ArrayLike<number>): string {
	let out = '';
	for (let i = 0; i < 16; i++) out += CROCKFORD_ALPHABET[(bytes[i] ?? 0) & 31];
	return `gle_${out}`;
}

export type GlossaryContext = { now: string; newId: () => string };

export type GlossaryUpsert = {
	entries: GlossaryEntry[];
	entry: GlossaryEntry;
	/** A new entry (no entry had this target and language). */
	created: boolean;
	/** Whether anything changed (false: the library need not be written). */
	changed: boolean;
};

/**
 * Adds an entry, or merges the spellings into the entry with the same target and language (SC-070). `remember`
 * (the Transcript tab's "Remember", SC-071) also counts one more teaching. Saving the same input twice without
 * `remember` changes nothing the second time (idempotent).
 */
export function upsertGlossaryEntry(
	entries: readonly GlossaryEntry[],
	input: GlossaryInput,
	ctx: GlossaryContext & { remember?: boolean },
): GlossaryUpsert {
	const n = normalizeGlossaryInput(input);
	const i = entries.findIndex((e) => sameKey(e, n.to, n.lang));
	if (i < 0) {
		if (entries.length >= GLOSSARY_LIMITS.maxEntries)
			throw new GlossaryError(
				'GLOSSARY_LIMIT',
				`The glossary holds at most ${GLOSSARY_LIMITS.maxEntries} entries; remove some first`,
			);
		const entry = GlossaryEntrySchema.parse({
			id: ctx.newId(),
			from: n.from,
			to: n.to,
			...(n.lang ? { lang: n.lang } : {}),
			count: ctx.remember ? 1 : 0,
			createdAt: ctx.now,
			updatedAt: ctx.now,
		});
		return { entries: [...entries, entry], entry, created: true, changed: true };
	}
	const old = entries[i]!;
	const from = unionSpellings(old.from, n.from, old.to);
	if (from.length > GLOSSARY_LIMITS.maxSpellings)
		throw new GlossaryError(
			'GLOSSARY_LIMIT',
			`“${old.to}” already has ${old.from.length} spellings; an entry holds at most ${GLOSSARY_LIMITS.maxSpellings}`,
			{ entryId: old.id },
		);
	const changed = ctx.remember === true || from.length !== old.from.length;
	if (!changed) return { entries: [...entries], entry: old, created: false, changed: false };
	const entry: GlossaryEntry = {
		...old,
		from,
		count: Math.min(1_000_000_000, old.count + (ctx.remember ? 1 : 0)),
		updatedAt: ctx.now,
	};
	const next = [...entries];
	next[i] = entry;
	return { entries: next, entry, created: false, changed: true };
}

export type GlossaryPatch = { from?: readonly string[]; to?: string; lang?: string | null };

/**
 * Edits an entry (Preferences ▸ Transcription ▸ Glossary): `from` replaces the spellings, `to` the target, `lang`
 * the language (`null` = any). A target and language another entry already has is refused (`GLOSSARY_DUPLICATE`).
 */
export function updateGlossaryEntry(
	entries: readonly GlossaryEntry[],
	id: string,
	patch: GlossaryPatch,
	now: string,
): { entries: GlossaryEntry[]; entry: GlossaryEntry; changed: boolean } {
	const i = entries.findIndex((e) => e.id === id);
	if (i < 0) throw new GlossaryError('GLOSSARY_NOT_FOUND', `Glossary entry not found: ${id.slice(0, 40)}`);
	const old = entries[i]!;
	const n = normalizeGlossaryInput({
		from: patch.from ?? old.from,
		to: patch.to ?? old.to,
		lang: patch.lang === undefined ? old.lang : patch.lang,
	});
	const other = entries.find((e, j) => j !== i && sameKey(e, n.to, n.lang));
	if (other)
		throw new GlossaryError('GLOSSARY_DUPLICATE', `Another entry already corrects to “${n.to}”`, {
			entryId: other.id,
		});
	const { lang: _l, ...rest } = old;
	const entry: GlossaryEntry = { ...rest, from: n.from, to: n.to, ...(n.lang ? { lang: n.lang } : {}) };
	const changed =
		entry.to !== old.to ||
		entry.lang !== old.lang ||
		entry.from.length !== old.from.length ||
		entry.from.some((f, k) => f !== old.from[k]);
	if (!changed) return { entries: [...entries], entry: old, changed: false };
	entry.updatedAt = now;
	const next = [...entries];
	next[i] = entry;
	return { entries: next, entry, changed: true };
}

/** One entry read from an import file (before merging). */
export type GlossaryImportEntry = {
	from: string[];
	to: string;
	lang?: string;
	count: number;
	createdAt?: string;
	updatedAt?: string;
};

export type GlossaryImportParse =
	| {
			ok: true;
			entries: GlossaryImportEntry[];
			/** Position in the file's list of each entry of `entries`. */
			indices: number[];
			skipped: Array<{ index: number; reason: string }>;
	  }
	| { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const isoOrUndefined = (v: unknown) =>
	typeof v === 'string' && z.iso.datetime().safeParse(v).success ? v : undefined;

/** One entry of an import file, leniently: `from` may be one string; ids, unknown keys and bad dates are ignored. */
function readImportEntry(v: unknown): GlossaryImportEntry | string {
	if (!isObject(v)) return 'not an object';
	if (typeof v.to !== 'string') return 'no right spelling (“to”)';
	const rawFrom = typeof v.from === 'string' ? [v.from] : Array.isArray(v.from) ? v.from : v.from == null ? [] : null;
	if (!rawFrom) return '“from” is not a list of spellings';
	if (rawFrom.length > GLOSSARY_LIMITS.maxSpellings * 4) return 'too many spellings';
	if (rawFrom.some((f) => typeof f !== 'string')) return '“from” is not a list of spellings';
	let n: ReturnType<typeof normalizeGlossaryInput>;
	try {
		n = normalizeGlossaryInput({
			from: rawFrom as string[],
			to: v.to,
			lang: typeof v.lang === 'string' ? v.lang : v.lang == null ? undefined : String(v.lang),
		});
	} catch (e) {
		return e instanceof GlossaryError ? e.message : 'invalid entry';
	}
	const count =
		typeof v.count === 'number' && Number.isInteger(v.count) && v.count >= 0
			? Math.min(v.count, 1_000_000_000)
			: 0;
	const createdAt = isoOrUndefined(v.createdAt);
	const updatedAt = isoOrUndefined(v.updatedAt);
	return {
		...n,
		count,
		...(createdAt ? { createdAt } : {}),
		...(updatedAt ? { updatedAt } : {}),
	};
}

/**
 * Reads an import file (SC-070 import): an exported glossary (`{format: "jasper-speech-glossary", version: 1,
 * entries}`) or a bare list of entries `[{from, to, lang?}]`. Never throws: unusable entries are skipped with their
 * reason, a file written by a newer version or of another format is refused as a whole. At most
 * `GLOSSARY_LIMITS.maxImportEntries` entries are read.
 */
export function parseGlossaryImport(raw: unknown): GlossaryImportParse {
	let list: unknown[];
	if (Array.isArray(raw)) list = raw;
	else if (isObject(raw)) {
		if (raw.format !== GLOSSARY_FORMAT)
			return { ok: false, reason: 'This is not a JasperEditor glossary file (format jasper-speech-glossary)' };
		if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1)
			return { ok: false, reason: 'The glossary file has no valid version' };
		if (raw.version > GLOSSARY_VERSION)
			return {
				ok: false,
				reason: `The glossary file was written by a newer JasperEditor (version ${raw.version}); update to import it`,
			};
		if (!Array.isArray(raw.entries)) return { ok: false, reason: 'The glossary file has no entries list' };
		list = raw.entries;
	} else return { ok: false, reason: 'A glossary file is a JSON object or a list of entries' };
	const entries: GlossaryImportEntry[] = [];
	const indices: number[] = [];
	const skipped: Array<{ index: number; reason: string }> = [];
	const n = Math.min(list.length, GLOSSARY_LIMITS.maxImportEntries);
	for (let i = 0; i < n; i++) {
		const r = readImportEntry(list[i]);
		if (typeof r === 'string') skipped.push({ index: i, reason: r });
		else {
			entries.push(r);
			indices.push(i);
		}
	}
	if (list.length > n)
		skipped.push({
			index: n,
			reason: `${list.length - n} more entries were not read (at most ${GLOSSARY_LIMITS.maxImportEntries} per file)`,
		});
	return { ok: true, entries, indices, skipped };
}

export type GlossaryImportResult = {
	entries: GlossaryEntry[];
	added: number;
	merged: number;
	unchanged: number;
	skipped: Array<{ index: number; reason: string }>;
};

/**
 * Merges imported entries into the library: an entry whose target and language exist gains its new spellings (up to
 * 20; the rest are reported), keeps the larger count and the earlier creation date; others are added while there is
 * room. Never removes or renames anything (import is additive). `index` of a skip refers to `imported`.
 */
export function importGlossaryEntries(
	entries: readonly GlossaryEntry[],
	imported: readonly GlossaryImportEntry[],
	ctx: GlossaryContext,
): GlossaryImportResult {
	const next = [...entries];
	let added = 0;
	let merged = 0;
	let unchanged = 0;
	const skipped: Array<{ index: number; reason: string }> = [];
	for (const [index, e] of imported.entries()) {
		const i = next.findIndex((x) => sameKey(x, e.to, e.lang));
		if (i < 0) {
			if (next.length >= GLOSSARY_LIMITS.maxEntries) {
				skipped.push({ index, reason: `the glossary is full (${GLOSSARY_LIMITS.maxEntries} entries)` });
				continue;
			}
			const createdAt = e.createdAt ?? ctx.now;
			next.push(
				GlossaryEntrySchema.parse({
					id: ctx.newId(),
					from: e.from,
					to: e.to,
					...(e.lang ? { lang: e.lang } : {}),
					count: e.count,
					createdAt,
					updatedAt: e.updatedAt && Date.parse(e.updatedAt) >= Date.parse(createdAt) ? e.updatedAt : createdAt,
				}),
			);
			added++;
			continue;
		}
		const old = next[i]!;
		const all = unionSpellings(old.from, e.from, old.to);
		const from = all.slice(0, Math.max(GLOSSARY_LIMITS.maxSpellings, old.from.length));
		if (all.length > from.length)
			skipped.push({
				index,
				reason: `${all.length - from.length} spellings of “${old.to}” were left out (at most ${GLOSSARY_LIMITS.maxSpellings})`,
			});
		const count = Math.max(old.count, e.count);
		const createdAt =
			e.createdAt && Date.parse(e.createdAt) < Date.parse(old.createdAt) ? e.createdAt : old.createdAt;
		if (from.length === old.from.length && count === old.count && createdAt === old.createdAt) {
			unchanged++;
			continue;
		}
		next[i] = { ...old, from, count, createdAt, updatedAt: ctx.now };
		merged++;
	}
	return { entries: next, added, merged, unchanged, skipped };
}
