// Transcript cleanup settings, presets, findings and the persisted `Sequence.cleanup` (spec 14 TC-010, TC-025,
// TC-030; docs/wp-notes/transcript-cleanup.md "Settings and presets", "Persisted state"). Every threshold of the
// detector and the planner is a setting; the built-in presets are Fast (measured on the user's edits, prototype
// `autocut.py` preset `fast`) and Natural (general use, prototype `calm` + spec 14 §2.3). Pure (zod only).
import { z } from 'zod';

const num = (min: number, max: number) => z.number().finite().min(min).max(max);

/** What a rule does with what it finds. */
export const RuleActionSchema = z.enum(['remove', 'review', 'off']);
export type RuleAction = z.infer<typeof RuleActionSchema>;

export const CleanupRulesSchema = z
	.object({
		/** Restart: an n-gram re-said shortly after (prototype rule 2). */
		restart: RuleActionSchema,
		/** Retake: a speech unit said again later; the earlier takes (prototype rule 1). */
		retake: RuleActionSchema,
		/** False start: 1–3 words re-said immediately. */
		falseStart: RuleActionSchema,
		/** Vocalic fillers (eh, em, mmm…) and drawn-out vowels. */
		fillerVocalic: RuleActionSchema,
		/** A phrase between pauses made only of lexical markers ("bueno", "a ver", "o sea"). */
		fillerPhrase: RuleActionSchema,
		/** A lexical marker at a clause start followed by a pause or comma ("Bueno, …"): never removed automatically. */
		fillerLexical: z.enum(['review', 'off']),
		/** Repeat / stutter: 1–3 words repeated with almost no gap, or a cut-off word restarted ("jue- juego"). */
		stutter: RuleActionSchema,
		/** Off-script phrase (needs a script). */
		offScript: RuleActionSchema,
		/** Head / tail: before the first / after the last scripted speech (needs a script). */
		headTail: RuleActionSchema,
		/** Non-speech longer than the gap policy allows (findings for review; the planner applies the gap policy). */
		pause: RuleActionSchema,
		/** Breath-like noise next to kept speech. */
		breath: RuleActionSchema,
		/** Speech frames with no word (dropped filler, laugh, mumble): review only, never removed automatically. */
		untranscribed: z.enum(['review', 'off']),
		/** Low confidence / implausible duration: review only. */
		asrSuspect: z.enum(['review', 'off']),
		/** Hallucination guard (TC-003): runs of identical tokens, words over non-speech, known phrases. */
		hallucination: RuleActionSchema,
	})
	.strict();
export type CleanupRules = z.infer<typeof CleanupRulesSchema>;

export const CleanupThresholdsSchema = z
	.object({
		/** Phrases (off-script, marker phrases, stutter context): split at pauses ≥ this (s). */
		phraseGapS: num(0.05, 5),
		/** Speech units (retakes): split at pauses ≥ this (s). */
		takeGapS: num(0.1, 10),
		/** A later take counts within this many seconds. */
		retakeWindowS: num(1, 3600),
		/** Share of an earlier unit's content words (LCS) a later unit must repeat. */
		retakeSimilarity: num(0.1, 1),
		/** Restart: a 3-gram repeated within this many words… */
		restartWindowWords: z.number().int().min(1).max(500),
		/** … or a 2-gram with a content word within this many words… */
		restartWindowWords2: z.number().int().min(1).max(500),
		/** … both within this many seconds. */
		restartWindowS: num(1, 3600),
		/** A content word for 2-gram restarts has at least this many letters. */
		restartContentLetters: z.number().int().min(1).max(20),
		/** False start: the next unit starts within this many seconds. */
		falseStartGapS: num(0.1, 60),
		/** Stutter: gap between the repeats below this (s). */
		stutterGapS: num(0, 5),
		/** Off-script: phrases with at least this many content tokens… */
		offScriptMinTokens: z.number().int().min(1).max(100),
		/** … of which fewer than this share occur in the script. */
		offScriptSimilarity: num(0, 1),
		/** Marker phrases: at most this many words. */
		markerPhraseMaxWords: z.number().int().min(1).max(10),
		/** A single drawn-out vowel held at least this long is a filler (s). */
		drawnVowelS: num(0.2, 10),
		/** ASR suspect: word confidence below this. */
		lowConfidence: num(0, 1),
		/** ASR suspect: words shorter than this (s)… */
		minWordS: num(0, 1),
		/** … or longer than this (s). */
		maxWordS: num(0.5, 60),
		/** Untranscribed voice: speech runs without words at least this long (s). */
		untranscribedMinS: num(0.03, 10),
		/** Hallucination guard: runs of at least this many identical tokens. */
		hallucinationRun: z.number().int().min(2).max(100),
		/** Hallucination guard: words whose frames are less than this share speech or breath. */
		hallucinationSpeechShare: num(0, 1),
		/** Script: an earlier take is preferred when it covers at least this much more of the line. */
		scriptPreferEarlier: num(0, 1),
		/** Script: a unit belongs to a script line when its content words match at least this share. */
		scriptLineSimilarity: num(0.1, 1),
	})
	.strict();
export type CleanupThresholds = z.infer<typeof CleanupThresholdsSchema>;

export const EDGE_MODES = ['level', 'speech', 'word'] as const;
export const CleanupEdgesSchema = z
	.object({
		/**
		 * `level`: out point where the decay falls below the reference + `outDb`, in point where the onset reaches the
		 * reference + `inDb` (TC-021); `speech`: speech-frame bounds of the words; `word`: transcript word bounds
		 * (no voice analysis). Pads apply in every mode.
		 */
		mode: z.enum(EDGE_MODES),
		/** Reference of `outDb` / `inDb`: the noise floor (dB above it) or the speech level (dB below it). */
		reference: z.enum(['floor', 'speech']),
		outDb: num(0, 80),
		inDb: num(0, 80),
		/** Air kept before an in point / after an out point (s). */
		padBeforeS: num(0, 2),
		padAfterS: num(0, 2),
		/** Frame boundaries within this window (s) of an edge compete on level; the quietest wins. */
		snapWindowS: num(0, 0.1),
	})
	.strict();
export type CleanupEdges = z.infer<typeof CleanupEdgesSchema>;

export const CleanupGapsSchema = z
	.object({
		/** Non-speech longer than this (s) inside or between kept speech is cut… */
		maxGapS: num(0, 30),
		/** … down to this much air (s) inside a sentence… */
		keepGapS: num(0, 30),
		/** … and this much between sentences (the previous word ends with . ? !). */
		keepGapSentenceS: num(0, 30),
		/** Breath-like noise just before an onset: removed, or kept up to `breathKeepMaxS`. */
		breath: z.enum(['remove', 'keep']),
		breathKeepMaxS: num(0, 2),
	})
	.strict();
export type CleanupGaps = z.infer<typeof CleanupGapsSchema>;

export const CleanupGuardsSchema = z
	.object({
		/** Kept pieces shorter than this (s) are dropped. */
		minPieceS: num(0, 10),
		/** Removed ranges shorter than this many sequence frames are not cut. */
		minCutFrames: z.number().int().min(0).max(100),
		/**
		 * Kept pieces shorter than this many sequence frames are slivers: joined to a neighbour across a short silent gap,
		 * else a `fragment` finding (removed when accepted, else grown over the silence beside it to this length).
		 */
		minSliverFrames: z.number().int().min(0).max(100),
		/** Skip a filler / stutter cut whose edges cannot land below reference + `inDb` within `harshWindowS`. */
		avoidHarshCuts: z.boolean(),
		harshWindowS: num(0, 0.5),
	})
	.strict();
export type CleanupGuards = z.infer<typeof CleanupGuardsSchema>;

/**
 * Join fade (ms) used when a fade is asked for without a length: Clean Up's "Fade joins" toggle, `audio.smoothJoins`,
 * `joinFades: true` on range cuts. Cuts are hard by default (the built-in presets' `joins.fadeMs` is 0).
 */
export const JOIN_FADE_MS = 4;

export const CleanupJoinsSchema = z
	.object({
		/** Equal-power micro-fade at every audio join (ms; 0 = none, the built-in presets' default: hard cuts). */
		fadeMs: num(0, 30),
		/** J / L offset of the sound at every join (frames; > 0 the incoming sound leads, < 0 the outgoing lags). */
		jlFrames: z.number().int().min(-30).max(30),
	})
	.strict();
export type CleanupJoins = z.infer<typeof CleanupJoinsSchema>;

export const CleanupSettingsSchema = z
	.object({
		rules: CleanupRulesSchema,
		thresholds: CleanupThresholdsSchema,
		edges: CleanupEdgesSchema,
		gaps: CleanupGapsSchema,
		guards: CleanupGuardsSchema,
		joins: CleanupJoinsSchema,
	})
	.strict();
export type CleanupSettings = z.infer<typeof CleanupSettingsSchema>;

/** Overrides of a preset: any subset of every group. */
export const CleanupOverridesSchema = z
	.object({
		rules: CleanupRulesSchema.partial().optional(),
		thresholds: CleanupThresholdsSchema.partial().optional(),
		edges: CleanupEdgesSchema.partial().optional(),
		gaps: CleanupGapsSchema.partial().optional(),
		guards: CleanupGuardsSchema.partial().optional(),
		joins: CleanupJoinsSchema.partial().optional(),
	})
	.strict();
export type CleanupOverrides = z.infer<typeof CleanupOverridesSchema>;

const COMMON_THRESHOLDS: CleanupThresholds = {
	phraseGapS: 0.3,
	takeGapS: 0.6,
	retakeWindowS: 120,
	retakeSimilarity: 0.6,
	restartWindowWords: 40,
	restartWindowWords2: 10,
	restartWindowS: 60,
	restartContentLetters: 4,
	falseStartGapS: 3,
	stutterGapS: 0.3,
	offScriptMinTokens: 3,
	offScriptSimilarity: 0.35,
	markerPhraseMaxWords: 2,
	drawnVowelS: 0.95,
	lowConfidence: 0.4,
	minWordS: 0.04,
	maxWordS: 2.5,
	untranscribedMinS: 0.15,
	hallucinationRun: 4,
	hallucinationSpeechShare: 0.2,
	scriptPreferEarlier: 0.2,
	scriptLineSimilarity: 0.6,
};

/** Fast: the user's measured style (prototype preset `fast`; FINDINGS §6.4, spec 14 TC-021…TC-025). */
export const FAST_SETTINGS: CleanupSettings = {
	rules: {
		restart: 'remove',
		retake: 'remove',
		falseStart: 'remove',
		fillerVocalic: 'remove',
		fillerPhrase: 'remove',
		fillerLexical: 'review',
		stutter: 'remove',
		offScript: 'remove',
		headTail: 'remove',
		pause: 'remove',
		breath: 'remove',
		untranscribed: 'review',
		asrSuspect: 'review',
		hallucination: 'remove',
	},
	thresholds: { ...COMMON_THRESHOLDS },
	edges: {
		mode: 'level',
		reference: 'floor',
		outDb: 20,
		inDb: 25,
		padBeforeS: 0,
		padAfterS: 0,
		snapWindowS: 0.01,
	},
	gaps: { maxGapS: 0.12, keepGapS: 0, keepGapSentenceS: 0, breath: 'remove', breathKeepMaxS: 0.6 },
	guards: { minPieceS: 0.25, minCutFrames: 2, minSliverFrames: 10, avoidHarshCuts: true, harshWindowS: 0.03 },
	joins: { fadeMs: 0, jlFrames: 0 },
};

/** Natural: calmer general preset (prototype `calm` + spec 14: gaps 0.25 / 0.5 s, breaths ≤ 600 ms kept). */
export const NATURAL_SETTINGS: CleanupSettings = {
	rules: {
		restart: 'remove',
		retake: 'review',
		falseStart: 'remove',
		fillerVocalic: 'remove',
		fillerPhrase: 'review',
		fillerLexical: 'review',
		stutter: 'review',
		offScript: 'review',
		headTail: 'review',
		pause: 'remove',
		breath: 'review',
		untranscribed: 'review',
		asrSuspect: 'review',
		hallucination: 'remove',
	},
	thresholds: { ...COMMON_THRESHOLDS },
	edges: {
		mode: 'speech',
		reference: 'floor',
		outDb: 20,
		inDb: 25,
		padBeforeS: 0.1,
		padAfterS: 0.15,
		snapWindowS: 0.01,
	},
	gaps: { maxGapS: 0.45, keepGapS: 0.25, keepGapSentenceS: 0.5, breath: 'keep', breathKeepMaxS: 0.6 },
	guards: { minPieceS: 0.4, minCutFrames: 2, minSliverFrames: 10, avoidHarshCuts: true, harshWindowS: 0.03 },
	joins: { fadeMs: 0, jlFrames: 0 },
};

export const CleanupPresetSchema = z
	.object({
		format: z.literal('jasper-cleanup-preset').optional(),
		version: z.literal(1).optional(),
		id: z.string().min(1).max(200),
		name: z.string().min(1).max(200),
		description: z.string().max(2000).optional(),
		builtIn: z.boolean().optional(),
		/** The preset this one started from (its values are the defaults of anything `settings` leaves out). */
		basedOn: z.enum(['builtin.fast', 'builtin.natural']).optional(),
		settings: CleanupOverridesSchema,
	})
	.strict();
export type CleanupPreset = z.infer<typeof CleanupPresetSchema>;

export const BUILTIN_CLEANUP_PRESETS: readonly CleanupPreset[] = [
	{
		id: 'builtin.fast',
		name: 'Fast',
		description: 'Fast-paced jump cuts: no dead air, edits inside the word decay, retakes keep the last take',
		builtIn: true,
		settings: FAST_SETTINGS,
	},
	{
		id: 'builtin.natural',
		name: 'Natural',
		description: 'Calm pacing: short pauses and breaths kept, retakes and off-script talk listed for review',
		builtIn: true,
		settings: NATURAL_SETTINGS,
	},
];

/** The built-in preset's settings by id (`builtin.fast` / `builtin.natural`), else null. */
export function builtinCleanupSettings(id: string | undefined): CleanupSettings | null {
	if (id === 'builtin.fast') return FAST_SETTINGS;
	if (id === 'builtin.natural') return NATURAL_SETTINGS;
	return null;
}

/** `base` with `overrides` applied group by group (a fresh object; neither input changes). */
export function mergeCleanupSettings(
	base: CleanupSettings,
	overrides?: CleanupOverrides | null,
): CleanupSettings {
	const o = overrides ?? {};
	return {
		rules: { ...base.rules, ...o.rules },
		thresholds: { ...base.thresholds, ...o.thresholds },
		edges: { ...base.edges, ...o.edges },
		gaps: { ...base.gaps, ...o.gaps },
		guards: { ...base.guards, ...o.guards },
		joins: { ...base.joins, ...o.joins },
	};
}

/**
 * The settings a preset gives: its `basedOn` built-in (Fast when absent) with its own values over it. Built-ins
 * resolve to themselves.
 */
export function resolvePresetSettings(p: CleanupPreset): CleanupSettings {
	const builtin = builtinCleanupSettings(p.id);
	if (builtin) return builtin;
	return mergeCleanupSettings(builtinCleanupSettings(p.basedOn) ?? FAST_SETTINGS, p.settings);
}

// ---------------------------------------------------------------------------------------------------------------
// Persisted per sequence (TC-030)

/** Script text attached to a sequence: at most 256 KB (UTF-8 bytes). */
export const CLEANUP_SCRIPT_MAX_BYTES = 256 * 1024;
/** Rejected finding fingerprints kept per sequence. */
export const CLEANUP_MAX_REJECTED = 20_000;
/** Entries per list (fillers / markers / allow) per language. */
export const CLEANUP_MAX_LIST_ENTRIES = 500;
/** Languages with edited lists per sequence. */
export const CLEANUP_MAX_LIST_LANGUAGES = 32;

/** UTF-8 byte length of a string (lone surrogates count 3 bytes, as an encoder writes U+FFFD). */
export function utf8Bytes(s: string): number {
	let n = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0)!;
		n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
	}
	return n;
}

/** The longest prefix of `s` (whole code points) of at most `max` UTF-8 bytes. */
function utf8Prefix(s: string, max: number): string {
	let n = 0;
	let end = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0)!;
		n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
		if (n > max) break;
		end += ch.length;
	}
	return s.slice(0, end);
}

export const CleanupScriptSchema = z
	.object({
		name: z.string().max(500),
		text: z.string().refine((s) => utf8Bytes(s) <= CLEANUP_SCRIPT_MAX_BYTES, {
			message: `The script is longer than ${CLEANUP_SCRIPT_MAX_BYTES / 1024} KB`,
		}),
	})
	.strict();
export type CleanupScript = z.infer<typeof CleanupScriptSchema>;

const ListEntry = z.string().min(1).max(100);
export const CleanupListsSchema = z
	.object({
		fillers: z.array(ListEntry).max(CLEANUP_MAX_LIST_ENTRIES).optional(),
		markers: z.array(ListEntry).max(CLEANUP_MAX_LIST_ENTRIES).optional(),
		allow: z.array(ListEntry).max(CLEANUP_MAX_LIST_ENTRIES).optional(),
	})
	.strict();
export type CleanupLists = z.infer<typeof CleanupListsSchema>;

/** A language key of the per-sequence lists: a BCP-47 primary subtag (`es`, `en`, `pt`…). */
export const CleanupListLanguageSchema = z
	.string()
	.regex(/^[a-z]{2,3}$/, 'a language code such as "es" or "en"');

export const FINGERPRINT_RE = /^[A-Za-z0-9_:.~-]{1,200}$/;
export const CleanupFingerprintSchema = z.string().regex(FINGERPRINT_RE, 'a finding fingerprint');

export const SequenceCleanupSchema = z
	.object({
		settings: z
			.object({
				/** `builtin.fast`, `builtin.natural` or a user preset id (`cup_…`); absent = Fast. */
				presetId: z.string().min(1).max(200).optional(),
				overrides: CleanupOverridesSchema.optional(),
			})
			.strict()
			.optional(),
		script: CleanupScriptSchema.optional(),
		rejected: z.array(CleanupFingerprintSchema).max(CLEANUP_MAX_REJECTED).optional(),
		lists: z
			.record(CleanupListLanguageSchema, CleanupListsSchema)
			.refine((r) => Object.keys(r).length <= CLEANUP_MAX_LIST_LANGUAGES, {
				message: `At most ${CLEANUP_MAX_LIST_LANGUAGES} languages`,
			})
			.optional(),
	})
	.strict();
export type SequenceCleanup = z.infer<typeof SequenceCleanupSchema>;

/** INV-CLEANUP: why a sequence's `cleanup` is unreadable, or null (absent is fine). */
export function sequenceCleanupIssue(value: unknown): string | null {
	if (value === undefined) return null;
	const r = SequenceCleanupSchema.safeParse(value);
	if (r.success) {
		const rej = r.data.rejected ?? [];
		if (new Set(rej).size !== rej.length) return 'rejected fingerprints are listed twice';
		return null;
	}
	const i = r.error.issues[0];
	return i ? `${i.path.join('.') || 'cleanup'}: ${i.message}` : 'unreadable';
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Conservative repair of an unreadable `Sequence.cleanup` (`repairDocument`): every readable part is kept — settings
 * (preset id, then each override group on its own, unknown keys and bad values dropped), the script (cut to 256 KB),
 * rejected fingerprints (malformed and duplicates dropped, at most 20 000), lists per language (bad entries dropped).
 * Null when nothing readable is left. Idempotent: its output passes `sequenceCleanupIssue`.
 */
export function repairSequenceCleanup(value: unknown): SequenceCleanup | null {
	if (!isObj(value)) return null;
	const out: SequenceCleanup = {};
	if (isObj(value.settings)) {
		const s: NonNullable<SequenceCleanup['settings']> = {};
		const pid = value.settings.presetId;
		if (typeof pid === 'string' && pid.length >= 1 && pid.length <= 200) s.presetId = pid;
		const ov = value.settings.overrides;
		if (isObj(ov)) {
			const groups = {
				rules: CleanupRulesSchema,
				thresholds: CleanupThresholdsSchema,
				edges: CleanupEdgesSchema,
				gaps: CleanupGapsSchema,
				guards: CleanupGuardsSchema,
				joins: CleanupJoinsSchema,
			} as const;
			const o: Record<string, Record<string, unknown>> = {};
			for (const [g, schema] of Object.entries(groups)) {
				const raw = ov[g];
				if (!isObj(raw)) continue;
				const kept: Record<string, unknown> = {};
				const shape = schema.shape as Record<string, z.ZodType>;
				for (const [k, v] of Object.entries(raw)) {
					const field = shape[k];
					if (field?.safeParse(v).success) kept[k] = v;
				}
				if (Object.keys(kept).length) o[g] = kept;
			}
			if (Object.keys(o).length) s.overrides = o as CleanupOverrides;
		}
		if (Object.keys(s).length) out.settings = s;
	}
	if (isObj(value.script) && typeof value.script.text === 'string') {
		let text = value.script.text;
		if (utf8Bytes(text) > CLEANUP_SCRIPT_MAX_BYTES) text = utf8Prefix(text, CLEANUP_SCRIPT_MAX_BYTES);
		const name = typeof value.script.name === 'string' ? value.script.name.slice(0, 500) : 'Script';
		out.script = { name, text };
	}
	if (Array.isArray(value.rejected)) {
		const seen = new Set<string>();
		for (const f of value.rejected)
			if (typeof f === 'string' && FINGERPRINT_RE.test(f) && !seen.has(f) && seen.size < CLEANUP_MAX_REJECTED)
				seen.add(f);
		if (seen.size) out.rejected = [...seen];
	}
	if (isObj(value.lists)) {
		const lists: Record<string, CleanupLists> = {};
		for (const [lang, l] of Object.entries(value.lists)) {
			if (Object.keys(lists).length >= CLEANUP_MAX_LIST_LANGUAGES) break;
			if (!CleanupListLanguageSchema.safeParse(lang).success || !isObj(l)) continue;
			const e: CleanupLists = {};
			for (const k of ['fillers', 'markers', 'allow'] as const) {
				const arr = l[k];
				if (!Array.isArray(arr)) continue;
				const ok = arr
					.filter((x): x is string => ListEntry.safeParse(x).success)
					.slice(0, CLEANUP_MAX_LIST_ENTRIES);
				e[k] = ok;
			}
			if (Object.keys(e).length) lists[lang] = e;
		}
		if (Object.keys(lists).length) out.lists = lists;
	}
	return Object.keys(out).length ? out : null;
}

/** A sequence's cleanup state (lenient: unreadable parts read as absent). */
export function readSequenceCleanup(seq: { cleanup?: unknown }): SequenceCleanup {
	const v = seq.cleanup;
	if (v === undefined) return {};
	const r = SequenceCleanupSchema.safeParse(v);
	if (r.success) return r.data;
	return repairSequenceCleanup(v) ?? {};
}

// ---------------------------------------------------------------------------------------------------------------
// Findings (TC-010)

export const FINDING_KINDS = [
	'pause',
	'breath',
	'filler-vocalic',
	'filler-phrase',
	'filler-lexical',
	'restart',
	'false-start',
	'retake',
	/** A restart, false start or retake inside a range the recogniser decoded again (a take it had written once). */
	'hidden-retake',
	'stutter',
	'off-script',
	'head-tail',
	'untranscribed',
	'asr-suspect',
	'hallucination',
	/**
	 * A kept piece shorter than `guards.minSliverFrames` between cuts that no silent gap joins to a neighbour (a flash
	 * of another take's picture): its own finding, made by the sequence planner (round 12).
	 */
	'fragment',
	/**
	 * A cut edge that cuts a word, moved to the word's whole decay / onset (the clip grows into its media) or off another
	 * word's onset: made by the sequence planner from the cut-edge audit (edge-findings.ts).
	 */
	'edge',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export type FindingSuggestion = 'remove' | 'review' | 'keep';

/** A localisable explanation: a stable key plus its parameters (the UI and agents format it). */
export type FindingReason = { key: string; params: Record<string, string | number> };

export type CleanupFinding = {
	/** Stable within one result: `f<index>`. */
	id: string;
	kind: FindingKind;
	/** Media time (flicks), half-open. */
	range: { start: number; end: number };
	/** Transcript word indices `[first, last]` (inclusive); null for non-word findings (pause, breath, voice). */
	words: [number, number] | null;
	confidence: number;
	reason: FindingReason;
	suggested: FindingSuggestion;
	/** Retake group id (`g<index>`). */
	group?: string;
	/** Media id + stream + rounded range + text hash (TC-013): survives re-runs, persists rejections. */
	fingerprint: string;
};

export type RetakeTake = {
	range: { start: number; end: number };
	words: [number, number];
	text: string;
	/** Index of the script line (0-based) this take says, when a script is attached. */
	scriptLine?: number;
	/** Mean word confidence (null when the words have none). */
	meanProb: number | null;
	/** Whether the take says the whole line (≥ 60 % of the group's longest take / of the script line). */
	complete: boolean;
	/** Share of the script line it covers (0…1) when a script is attached. */
	coverage?: number;
};

export type RetakeGroup = { id: string; takes: RetakeTake[]; chosen: number };
