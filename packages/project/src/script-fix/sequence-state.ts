// Spec 17 SC-055: `Sequence.scriptFix` — the sequence's Fix Transcript settings and the fixes the user rejected
// (fingerprints, SC-026), persisted with the project. An optional, leniently read field of schema v10 (no bump: v10
// builds that predate it keep unknown Sequence keys on load and save — docs/project-files.md "Optional fields added
// since v10"). INV-SCRIPTFIX checks it; `repairDocument` keeps its readable parts; `scriptFix.configure` writes it.
import { z } from 'zod';

export const SCRIPT_FIX_MAX_REJECTED = 10_000;
export const SCRIPT_FIX_STRICTNESS = ['careful', 'standard', 'generous'] as const;
export const SCRIPT_FIX_SOURCES = ['script', 'glossary'] as const;
/** Whole recordings (default) / only what the sequence uses / the In–Out range (SC-063). */
export const SCRIPT_FIX_SCOPES = ['recordings', 'used', 'inOut'] as const;

export type ScriptFixStrictness = (typeof SCRIPT_FIX_STRICTNESS)[number];
export type ScriptFixSource = (typeof SCRIPT_FIX_SOURCES)[number];
export type ScriptFixScope = (typeof SCRIPT_FIX_SCOPES)[number];

/** A fix fingerprint (made by the aligner, SC-026): 1–512 characters, no control characters. */
export const ScriptFixFingerprintSchema = z
	.string()
	.min(1)
	.max(512)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
	.regex(/^[^\u0000-\u001f\u007f]+$/, 'a fix fingerprint (no control characters)');

const distinct = (list: readonly string[]) => new Set(list).size === list.length;

export const ScriptFixSettingsSchema = z.strictObject({
	strictness: z.enum(SCRIPT_FIX_STRICTNESS).optional().describe('careful | standard (default) | generous'),
	sources: z
		.array(z.enum(SCRIPT_FIX_SOURCES))
		.min(1)
		.max(SCRIPT_FIX_SOURCES.length)
		.refine(distinct, 'sources are listed once')
		.optional()
		.describe('What the fixes come from: script, glossary (default both)'),
	scope: z
		.enum(SCRIPT_FIX_SCOPES)
		.optional()
		.describe(
			'recordings (whole recordings, default) | used (what the sequence uses) | inOut (In–Out range)',
		),
});
export type ScriptFixSettings = z.infer<typeof ScriptFixSettingsSchema>;

export const SequenceScriptFixSchema = z.strictObject({
	rejected: z
		.array(ScriptFixFingerprintSchema)
		.max(SCRIPT_FIX_MAX_REJECTED)
		.refine(distinct, 'rejected fingerprints are listed once')
		.optional(),
	settings: ScriptFixSettingsSchema.optional(),
});
export type SequenceScriptFix = z.infer<typeof SequenceScriptFixSchema>;

export const DEFAULT_SCRIPT_FIX_SETTINGS: Required<ScriptFixSettings> = {
	strictness: 'standard',
	sources: ['script', 'glossary'],
	scope: 'recordings',
};

/** INV-SCRIPTFIX: why a sequence's `scriptFix` is unreadable, or null (absent is fine). */
export function sequenceScriptFixIssue(value: unknown): string | null {
	if (value === undefined) return null;
	const r = SequenceScriptFixSchema.safeParse(value);
	if (r.success) return null;
	const i = r.error.issues[0];
	return i ? `${i.path.join('.') || 'scriptFix'}: ${i.message}` : 'unreadable';
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Conservative repair of an unreadable `Sequence.scriptFix` (`repairDocument`): each readable setting kept, unknown
 * keys dropped; malformed and repeated fingerprints dropped, at most 10 000 kept (the first ones). Null when nothing
 * readable is left. Idempotent: its output passes `sequenceScriptFixIssue`.
 */
export function repairSequenceScriptFix(value: unknown): SequenceScriptFix | null {
	if (!isObj(value)) return null;
	const out: SequenceScriptFix = {};
	if (Array.isArray(value.rejected)) {
		const seen = new Set<string>();
		for (const f of value.rejected) {
			if (seen.size >= SCRIPT_FIX_MAX_REJECTED) break;
			if (ScriptFixFingerprintSchema.safeParse(f).success) seen.add(f as string);
		}
		if (seen.size) out.rejected = [...seen];
	}
	if (isObj(value.settings)) {
		const s: ScriptFixSettings = {};
		const shape = ScriptFixSettingsSchema.shape;
		if (
			shape.strictness.safeParse(value.settings.strictness).success &&
			value.settings.strictness !== undefined
		)
			s.strictness = value.settings.strictness as ScriptFixStrictness;
		if (Array.isArray(value.settings.sources)) {
			const src = [
				...new Set(
					value.settings.sources.filter((x): x is ScriptFixSource => SCRIPT_FIX_SOURCES.includes(x)),
				),
			];
			if (src.length) s.sources = src;
		}
		if (shape.scope.safeParse(value.settings.scope).success && value.settings.scope !== undefined)
			s.scope = value.settings.scope as ScriptFixScope;
		if (Object.keys(s).length) out.settings = s;
	}
	return Object.keys(out).length ? out : null;
}

/** The readable state of a sequence (unreadable parts read as absent). Never throws. */
export function readSequenceScriptFix(seq: { scriptFix?: unknown }): SequenceScriptFix {
	const v = seq?.scriptFix;
	if (v === undefined) return {};
	const r = SequenceScriptFixSchema.safeParse(v);
	if (r.success) return r.data;
	return repairSequenceScriptFix(v) ?? {};
}

/** The Fix Transcript settings of a sequence with the defaults filled in. */
export function scriptFixSettingsOf(seq: { scriptFix?: unknown }): Required<ScriptFixSettings> {
	const s = readSequenceScriptFix(seq).settings ?? {};
	return {
		strictness: s.strictness ?? DEFAULT_SCRIPT_FIX_SETTINGS.strictness,
		sources: s.sources ? [...s.sources] : [...DEFAULT_SCRIPT_FIX_SETTINGS.sources],
		scope: s.scope ?? DEFAULT_SCRIPT_FIX_SETTINGS.scope,
	};
}

/** The fingerprints of the fixes rejected in a sequence (not offered again unless "Show rejected"). */
export function scriptFixRejected(seq: { scriptFix?: unknown }): Set<string> {
	return new Set(readSequenceScriptFix(seq).rejected ?? []);
}
