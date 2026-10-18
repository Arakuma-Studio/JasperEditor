// Reference sound profiles (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"): "make it sound like the films I like",
// measured and without models. A profile is the statistics of 1–20 reference media or sequences the user chose —
// per metric the median, p10–p90, min–max and n, plus each reference's own numbers (for leave-one-out), title and
// fingerprint. It holds numbers only, never audio. Pure: the metric table, the file schema (every profile file is
// untrusted: it may be shared), the aggregation, the comparison of a measurement with a profile (a "Reference" row per
// metric) and the translatable texts. The measurement itself is `ProfileMeter` (@jasper/audio-fx), the store and the
// `sound-profile` job are the engine's (apps/engine/src/sound-design/profile.ts).
//
// Adapted from earshot `earshot/profile.py` (metric definitions, aggregation) and `earshot/critique.py` (the scorecard:
// per-metric weights, tolerances and sides, the window = the references' min–max widened by the tolerance with a floor
// for densities, leave-one-out by measurement match) — MIT, Copyright (c) 2026 Leon Lin; licenses/ported/earshot.md.
// Changes: no bundled profile (earshot ships a 7-film launch profile: one user's style, rejected — wp-note); integrated
// loudness and true peak are shown for context only (Sound Check's LOUDNESS / TRUE_PEAK follow the delivery preset); no
// realness, AudioSet music share, tempo or beat-grid rows (models / a beat tracker we do not run on references); rows
// are Sound Check findings of severity warning (earshot "major") or info ("minor"), never errors; leave-one-out also by
// the reference's identity (the same sequence), not only by measurements.
import { z } from 'zod';

export const REFERENCE_PROFILE_FORMAT = 'jasper-sound-profile';
export const REFERENCE_PROFILE_VERSION = 1;
/** Bump when a metric's definition changes: profiles of other versions are refused (rebuild them). */
export const REFERENCE_METRICS_VERSION = 1;
export const REFERENCE_PROFILE_ID_RE = /^sprf_[0-9a-f]{16}$/;

export const REFERENCE_PROFILE_LIMITS = {
	/** References per profile (spec: 1–20). */
	references: 20,
	name: 120,
	title: 200,
	fingerprint: 300,
	/** Largest profile file read or imported (bytes). */
	fileBytes: 1_000_000,
	/** Profiles kept per engine library. */
	profiles: 200,
	/** Shorter references are not measured (s); under `shortSec` the loudness-shape metrics are n.a. (earshot). */
	minSec: 3,
	shortSec: 10,
	/** Longest stretch of one reference measured (s); the rest is ignored with a warning. */
	maxSec: 3600,
	/** Fewer picture events than this: no sync shares (earshot). */
	minPictureEvents: 3,
	warnings: 40,
} as const;

export const REFERENCE_METRIC_GROUPS = [
	'loudness',
	'arc',
	'ending',
	'density',
	'sync',
	'spectrum',
	'stereo',
	'speech',
] as const;
export type ReferenceMetricGroup = (typeof REFERENCE_METRIC_GROUPS)[number];

/** How a metric is judged: 2 → a warning when out of range, 1 → an info, 0 → shown, never a finding. */
export type ReferenceWeight = 0 | 1 | 2;
export const REFERENCE_WEIGHT_NAMES = { 2: 'major', 1: 'minor', 0: 'info' } as const;
export type ReferenceWeightName = (typeof REFERENCE_WEIGHT_NAMES)[ReferenceWeight];

type MetricSpec = {
	group: ReferenceMetricGroup;
	/** English label (a model string the editor translates). */
	label: string;
	unit: 'LUFS' | 'dBTP' | 'LU' | 's' | '/s' | '/min' | 'share' | '0-1' | 'dB' | 'Hz' | 'r';
	decimals: number;
	weight: ReferenceWeight;
	/** Measurement tolerance the references' min–max is widened by (unit of the metric; earshot `critique.SPEC`). */
	tolerance: number;
	/** Which side of the window is judged. */
	sides: 'both' | 'lower' | 'upper';
	/** Why it matters (a model string). */
	why: string;
	/** Judged by the delivery preset (LOUDNESS / TRUE_PEAK), not the references. */
	delivery?: true;
};

/**
 * Every metric, in report order (earshot `profile.METRICS` and `critique.SPEC`, adapted; spec 12 §4 P6-E8). The weights,
 * tolerances and sides are earshot's, tuned by its author on 7–8 launch films ("earshot norm (n = 7–8)"): defaults.
 */
export const REFERENCE_METRICS = {
	lufs_i: {
		group: 'loudness',
		label: 'Integrated loudness',
		unit: 'LUFS',
		decimals: 1,
		weight: 0,
		tolerance: 1,
		sides: 'both',
		why: 'Follows the delivery target (LOUDNESS); the references are shown for context.',
		delivery: true,
	},
	true_peak: {
		group: 'loudness',
		label: 'True peak',
		unit: 'dBTP',
		decimals: 1,
		weight: 0,
		tolerance: 0.5,
		sides: 'upper',
		why: 'Follows the delivery target (TRUE_PEAK); the references are shown for context.',
		delivery: true,
	},
	lra: {
		group: 'loudness',
		label: 'Loudness range',
		unit: 'LU',
		decimals: 1,
		weight: 2,
		tolerance: 1,
		sides: 'both',
		why: 'How much the loudness swings between quiet and loud passages.',
	},
	crest_lu: {
		group: 'loudness',
		label: 'Loudest 3 s over integrated',
		unit: 'LU',
		decimals: 1,
		weight: 2,
		tolerance: 0.5,
		sides: 'both',
		why: 'How far the loudest moment stands out over the average level.',
	},
	intro_lu: {
		group: 'arc',
		label: 'Opening level (first 10 %)',
		unit: 'LU',
		decimals: 1,
		weight: 1,
		tolerance: 1.5,
		sides: 'both',
		why: 'How the piece opens against its body: at full level, or building up.',
	},
	end_lu: {
		group: 'arc',
		label: 'Closing level (last 10 %)',
		unit: 'LU',
		decimals: 1,
		weight: 1,
		tolerance: 1.5,
		sides: 'both',
		why: 'How the last 10 % sit against the body.',
	},
	peak_pos: {
		group: 'arc',
		label: 'Position of the loudest 3 s',
		unit: '0-1',
		decimals: 2,
		weight: 0,
		tolerance: 0,
		sides: 'both',
		why: 'Where the loudest moment sits (0 = the start, 1 = the end).',
	},
	first_sound_s: {
		group: 'arc',
		label: 'Time to first sound',
		unit: 's',
		decimals: 2,
		weight: 2,
		tolerance: 0.1,
		sides: 'upper',
		why: 'Silence at the start loses viewers; the references sound at once or soon.',
	},
	max_gap_s: {
		group: 'arc',
		label: 'Longest silent gap inside',
		unit: 's',
		decimals: 2,
		weight: 2,
		tolerance: 0.25,
		sides: 'upper',
		why: 'A silent hole in the middle reads as a mistake unless it is a deliberate stop-down.',
	},
	end_silence_s: {
		group: 'ending',
		label: 'Dead air at the end',
		unit: 's',
		decimals: 2,
		weight: 2,
		tolerance: 0.25,
		sides: 'upper',
		why: 'Dead air after the sound stops makes the ending feel unfinished.',
	},
	fade_s: {
		group: 'ending',
		label: 'Final fade length',
		unit: 's',
		decimals: 2,
		weight: 1,
		tolerance: 0.5,
		sides: 'both',
		why: 'How the sound ends: a hard out, a short ring-out or a long fade.',
	},
	final_lu: {
		group: 'ending',
		label: 'Final moment over integrated',
		unit: 'LU',
		decimals: 1,
		weight: 2,
		tolerance: 1.5,
		sides: 'both',
		why: 'Whether the last moment lands at body level or above, or fades away.',
	},
	tail_s: {
		group: 'ending',
		label: 'Final hit ring-out',
		unit: 's',
		decimals: 2,
		weight: 0,
		tolerance: 0,
		sides: 'both',
		why: 'How long the final hit rings out (none: no final hit).',
	},
	onset_rate: {
		group: 'density',
		label: 'Onset density',
		unit: '/s',
		decimals: 2,
		weight: 2,
		tolerance: 0.3,
		sides: 'both',
		why: 'Rhythmic activity: too sparse feels empty, too dense feels cluttered.',
	},
	hit_rate: {
		group: 'density',
		label: 'Salient hit density',
		unit: '/s',
		decimals: 2,
		weight: 2,
		tolerance: 0.2,
		sides: 'both',
		why: 'Punch: salient hits mark the key moments.',
	},
	stopdowns_min: {
		group: 'density',
		label: 'Stop-downs',
		unit: '/min',
		decimals: 1,
		weight: 0,
		tolerance: 0,
		sides: 'both',
		why: 'Short drop-outs that snap back to full level, often right before a hit.',
	},
	cut_rate: {
		group: 'sync',
		label: 'Picture events',
		unit: '/s',
		decimals: 2,
		weight: 0,
		tolerance: 0,
		sides: 'both',
		why: 'Edit pace: cuts and big picture changes per second.',
	},
	cuts_with_sound: {
		group: 'sync',
		label: 'Picture events with an onset within 100 ms',
		unit: 'share',
		decimals: 2,
		weight: 2,
		tolerance: 0.05,
		sides: 'lower',
		why: 'A cut with no sound under it can feel dead; compare with what chance would score.',
	},
	cut_frame_sync: {
		group: 'sync',
		label: 'Picture events with an onset within 1 frame',
		unit: 'share',
		decimals: 2,
		weight: 0,
		tolerance: 0,
		sides: 'both',
		why: 'Frame-accurate sync of sound to picture; compare with what chance would score.',
	},
	band_sub: {
		group: 'spectrum',
		label: 'Sub 20–60 Hz share',
		unit: 'dB',
		decimals: 1,
		weight: 1,
		tolerance: 1.5,
		sides: 'both',
		why: 'Sub weight under hits and music.',
	},
	band_low: {
		group: 'spectrum',
		label: 'Low 60–250 Hz share',
		unit: 'dB',
		decimals: 1,
		weight: 1,
		tolerance: 1.5,
		sides: 'both',
		why: 'Low-end body.',
	},
	band_lowmid: {
		group: 'spectrum',
		label: 'Low-mid 250 Hz–1 kHz share',
		unit: 'dB',
		decimals: 1,
		weight: 1,
		tolerance: 1.5,
		sides: 'both',
		why: 'Too much sounds muddy, too little hollow.',
	},
	band_mid: {
		group: 'spectrum',
		label: 'Mid 1–4 kHz share',
		unit: 'dB',
		decimals: 1,
		weight: 1,
		tolerance: 1.5,
		sides: 'both',
		why: 'Where clicks and the voice cut through small speakers.',
	},
	band_presence: {
		group: 'spectrum',
		label: 'Presence 4–8 kHz share',
		unit: 'dB',
		decimals: 1,
		weight: 1,
		tolerance: 1.5,
		sides: 'both',
		why: 'The bite of transients, clicks and typing.',
	},
	band_air: {
		group: 'spectrum',
		label: 'Air 8–16 kHz share',
		unit: 'dB',
		decimals: 1,
		weight: 1,
		tolerance: 1.5,
		sides: 'both',
		why: 'Openness: missing air sounds muffled or low-bitrate.',
	},
	brightness_hz: {
		group: 'spectrum',
		label: 'Brightness (median spectral centroid)',
		unit: 'Hz',
		decimals: 0,
		weight: 0,
		tolerance: 0,
		sides: 'both',
		why: 'How bright the mix sounds overall.',
	},
	side_to_mid_db: {
		group: 'stereo',
		label: 'Stereo width (side vs mid)',
		unit: 'dB',
		decimals: 1,
		weight: 1,
		tolerance: 1,
		sides: 'both',
		why: 'Near-mono sounds small; too wide collapses on phones.',
	},
	correlation: {
		group: 'stereo',
		label: 'Left/right correlation',
		unit: 'r',
		decimals: 2,
		weight: 0,
		tolerance: 0,
		sides: 'both',
		why: 'Left/right correlation (1 = mono).',
	},
	speech_frac: {
		group: 'speech',
		label: 'Speech share',
		unit: 'share',
		decimals: 2,
		weight: 0,
		tolerance: 0,
		sides: 'both',
		why: 'Share of 5 s windows that read as speech (voice activity, no model).',
	},
} as const satisfies Record<string, MetricSpec>;

export type ReferenceMetricKey = keyof typeof REFERENCE_METRICS;
export const REFERENCE_METRIC_KEYS = Object.keys(REFERENCE_METRICS) as ReferenceMetricKey[];
/** Sync shares that also carry their chance level. */
export const REFERENCE_CHANCE_KEYS = ['cuts_with_sound', 'cut_frame_sync'] as const;
export type ReferenceChanceKey = (typeof REFERENCE_CHANCE_KEYS)[number];
/** Loudness-shape metrics: n.a. for references and sequences under `shortSec` (they would measure a clip, not a piece). */
export const REFERENCE_SHAPE_KEYS: readonly ReferenceMetricKey[] = ['lra', 'crest_lu', 'intro_lu', 'end_lu', 'final_lu'];
/** A mono mix (identical channels) counts as this stereo width (dB; earshot). */
export const REFERENCE_MONO_DB = -40;
/** Points of the loudness arc (0 %, 10 % … 100 %). */
export const REFERENCE_ARC_POINTS = 11;

export type ReferenceMetricValues = Record<ReferenceMetricKey, number | null>;
export type ReferenceChanceValues = Record<ReferenceChanceKey, number | null>;

/** What `ProfileMeter` measures of one reference (or of the sequence a check compares). */
export type ReferenceMeasurement = {
	durationSec: number;
	hasPicture: boolean;
	fps: number | null;
	/** Identical channels (or one): stereo width reads `REFERENCE_MONO_DB`. */
	mono: boolean;
	metrics: ReferenceMetricValues;
	chance: ReferenceChanceValues;
	/** Loudness arc: LU against integrated at 0 %, 10 % … 100 % (null when too short). */
	arc: (number | null)[] | null;
};

export const REFERENCE_KINDS = ['media', 'sequence'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

const BIG = 1e7;
const metricNumber = z.number().min(-BIG).max(BIG);
const isoish = z.string().min(1).max(40);

const metricShape = Object.fromEntries(
	REFERENCE_METRIC_KEYS.map((k) => [k, metricNumber.nullable().optional()]),
) as Record<ReferenceMetricKey, z.ZodOptional<z.ZodNullable<typeof metricNumber>>>;
const chanceShape = Object.fromEntries(
	REFERENCE_CHANCE_KEYS.map((k) => [k, z.number().min(0).max(1).nullable().optional()]),
) as Record<ReferenceChanceKey, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;

/** One reference in a profile file: its numbers, title and fingerprint — never audio. */
export const ReferenceEntrySchema = z.strictObject({
	id: z.string().regex(/^ref_[0-9]{1,3}$/),
	title: z.string().max(REFERENCE_PROFILE_LIMITS.title),
	kind: z.enum(REFERENCE_KINDS),
	/**
	 * Media: the file's content fingerprint (as the media registry computes it); sequence: `<projectId>/<sequenceId>` and
	 * the mix fingerprint it was measured at (`…@<mixHash>`). Used for leave-one-out; never a path.
	 */
	fingerprint: z.string().max(REFERENCE_PROFILE_LIMITS.fingerprint),
	durationSec: z.number().min(0).max(86_400),
	hasPicture: z.boolean(),
	fps: z.number().positive().max(1000).nullable(),
	mono: z.boolean(),
	metrics: z.strictObject(metricShape),
	chance: z.strictObject(chanceShape),
	arc: z.array(metricNumber.nullable()).length(REFERENCE_ARC_POINTS).nullable(),
});
export type ReferenceEntryInput = z.infer<typeof ReferenceEntrySchema>;

/** A profile file (the store's `<id>.json`, an exported file). The aggregate is recomputed on every read. */
export const ReferenceProfileFileSchema = z.strictObject({
	format: z.literal(REFERENCE_PROFILE_FORMAT),
	version: z.literal(REFERENCE_PROFILE_VERSION),
	metricsVersion: z.literal(REFERENCE_METRICS_VERSION),
	id: z.string().regex(REFERENCE_PROFILE_ID_RE),
	name: z.string().trim().min(1).max(REFERENCE_PROFILE_LIMITS.name),
	createdAt: isoish,
	updatedAt: isoish,
	references: z.array(ReferenceEntrySchema).min(1).max(REFERENCE_PROFILE_LIMITS.references),
	warnings: z.array(z.string().max(400)).max(REFERENCE_PROFILE_LIMITS.warnings).optional(),
	// derived: accepted (an exported file carries them for people reading it) and ignored — recomputed from `references`
	n: z.number().optional(),
	metrics: z.unknown().optional(),
	chance: z.unknown().optional(),
	arc: z.unknown().optional(),
});

export type MetricStats = {
	n: number;
	median: number | null;
	p10: number | null;
	p90: number | null;
	min: number | null;
	max: number | null;
};

export type ReferenceEntry = {
	id: string;
	title: string;
	kind: ReferenceKind;
	fingerprint: string;
	durationSec: number;
	hasPicture: boolean;
	fps: number | null;
	mono: boolean;
	metrics: ReferenceMetricValues;
	chance: ReferenceChanceValues;
	arc: (number | null)[] | null;
};

export type ReferenceProfile = {
	format: typeof REFERENCE_PROFILE_FORMAT;
	version: typeof REFERENCE_PROFILE_VERSION;
	metricsVersion: typeof REFERENCE_METRICS_VERSION;
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	n: number;
	references: ReferenceEntry[];
	metrics: Record<ReferenceMetricKey, MetricStats>;
	chance: Record<ReferenceChanceKey, MetricStats>;
	arc: { median: (number | null)[]; p10: (number | null)[]; p90: (number | null)[] } | null;
	warnings: string[];
};

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Linear-interpolated percentile (NumPy's default) of finite values; null for none. */
export function percentileOf(xs: readonly number[], p: number): number | null {
	const v = xs.filter(fin).sort((a, b) => a - b);
	if (!v.length) return null;
	const q = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1);
	const lo = Math.floor(q);
	const hi = Math.min(v.length - 1, lo + 1);
	return v[lo]! + (v[hi]! - v[lo]!) * (q - lo);
}

/** Median, p10–p90, min–max and n of a metric's values (nulls left out; earshot `profile._stats`). */
export function metricStats(values: readonly (number | null | undefined)[]): MetricStats {
	const x = values.filter(fin);
	if (!x.length) return { n: 0, median: null, p10: null, p90: null, min: null, max: null };
	const q = (p: number) => r3(percentileOf(x, p)!);
	return {
		n: x.length,
		median: q(50),
		p10: q(10),
		p90: q(90),
		min: r3(Math.min(...x)),
		max: r3(Math.max(...x)),
	};
}

/** Every metric key with its value (absent or invalid → null). */
export function metricValuesOf(raw: Partial<Record<string, unknown>> | null | undefined): ReferenceMetricValues {
	const out = {} as ReferenceMetricValues;
	for (const k of REFERENCE_METRIC_KEYS) {
		const v = raw?.[k];
		out[k] = fin(v) && Math.abs(v) <= BIG ? v : null;
	}
	return out;
}

function chanceValuesOf(raw: Partial<Record<string, unknown>> | null | undefined): ReferenceChanceValues {
	const out = {} as ReferenceChanceValues;
	for (const k of REFERENCE_CHANCE_KEYS) {
		const v = raw?.[k];
		out[k] = fin(v) && v >= 0 && v <= 1 ? v : null;
	}
	return out;
}

/** The aggregate of a list of references (earshot `profile.aggregate`). */
export function aggregateReferences(
	refs: readonly Pick<ReferenceEntry, 'metrics' | 'chance' | 'arc'>[],
): Pick<ReferenceProfile, 'n' | 'metrics' | 'chance' | 'arc'> {
	const metrics = {} as Record<ReferenceMetricKey, MetricStats>;
	for (const k of REFERENCE_METRIC_KEYS) metrics[k] = metricStats(refs.map((r) => r.metrics[k]));
	const chance = {} as Record<ReferenceChanceKey, MetricStats>;
	for (const k of REFERENCE_CHANCE_KEYS) chance[k] = metricStats(refs.map((r) => r.chance[k]));
	const arcs = refs.map((r) => r.arc).filter((a): a is (number | null)[] => Array.isArray(a));
	const arcQ = (p: number) =>
		Array.from({ length: REFERENCE_ARC_POINTS }, (_, i) => {
			const v = percentileOf(
				arcs.map((a) => a[i]).filter(fin),
				p,
			);
			return v === null ? null : Math.round(v * 10) / 10;
		});
	return {
		n: refs.length,
		metrics,
		chance,
		arc: arcs.length ? { median: arcQ(50), p10: arcQ(10), p90: arcQ(90) } : null,
	};
}

/** A reference entry from a measurement. */
export function referenceEntryOf(
	index: number,
	m: ReferenceMeasurement,
	meta: { title: string; kind: ReferenceKind; fingerprint: string },
): ReferenceEntry {
	return {
		id: `ref_${index + 1}`,
		title: meta.title.slice(0, REFERENCE_PROFILE_LIMITS.title),
		kind: meta.kind,
		fingerprint: meta.fingerprint.slice(0, REFERENCE_PROFILE_LIMITS.fingerprint),
		durationSec: Math.max(0, Math.min(86_400, r3(m.durationSec))),
		hasPicture: m.hasPicture,
		fps: fin(m.fps) && m.fps > 0 && m.fps <= 1000 ? r3(m.fps) : null,
		mono: m.mono,
		metrics: metricValuesOf(m.metrics),
		chance: chanceValuesOf(m.chance),
		arc:
			Array.isArray(m.arc) && m.arc.length === REFERENCE_ARC_POINTS
				? m.arc.map((v) => (fin(v) && Math.abs(v) <= BIG ? v : null))
				: null,
	};
}

/** A profile with its aggregate (every field already valid). */
export function buildReferenceProfile(p: {
	id: string;
	name: string;
	createdAt: string;
	updatedAt?: string;
	references: readonly ReferenceEntry[];
	warnings?: readonly string[];
}): ReferenceProfile {
	const refs = p.references.slice(0, REFERENCE_PROFILE_LIMITS.references);
	return {
		format: REFERENCE_PROFILE_FORMAT,
		version: REFERENCE_PROFILE_VERSION,
		metricsVersion: REFERENCE_METRICS_VERSION,
		id: p.id,
		name: p.name.trim().slice(0, REFERENCE_PROFILE_LIMITS.name),
		createdAt: p.createdAt,
		updatedAt: p.updatedAt ?? p.createdAt,
		...aggregateReferences(refs),
		references: refs.map((r) => structuredClone(r)),
		warnings: (p.warnings ?? []).slice(0, REFERENCE_PROFILE_LIMITS.warnings).map((w) => w.slice(0, 400)),
	};
}

export type ReadProfileResult = { ok: true; profile: ReferenceProfile } | { ok: false; error: string };

/**
 * A profile file read from untrusted data (the store, an import): validated strictly, reference ids unique, the
 * aggregate recomputed from the references (a tampered aggregate cannot disagree with them). Never throws.
 */
export function readReferenceProfile(raw: unknown): ReadProfileResult {
	try {
		const r = ReferenceProfileFileSchema.safeParse(raw);
		if (!r.success) {
			const i = r.error.issues[0]!;
			return { ok: false, error: `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}` };
		}
		const d = r.data;
		const ids = new Set<string>();
		for (const ref of d.references) {
			if (ids.has(ref.id)) return { ok: false, error: `references: duplicate id ${ref.id}` };
			ids.add(ref.id);
		}
		const references: ReferenceEntry[] = d.references.map((ref) => ({
			id: ref.id,
			title: ref.title,
			kind: ref.kind,
			fingerprint: ref.fingerprint,
			durationSec: ref.durationSec,
			hasPicture: ref.hasPicture,
			fps: ref.fps,
			mono: ref.mono,
			metrics: metricValuesOf(ref.metrics),
			chance: chanceValuesOf(ref.chance),
			arc: ref.arc ? ref.arc.map((v) => v ?? null) : null,
		}));
		return {
			ok: true,
			profile: buildReferenceProfile({
				id: d.id,
				name: d.name,
				createdAt: d.createdAt,
				updatedAt: d.updatedAt,
				references,
				warnings: d.warnings ?? [],
			}),
		};
	} catch (e) {
		return { ok: false, error: `unreadable profile (${(e as Error).message?.slice(0, 200) ?? 'error'})` };
	}
}

// ── comparison ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReferenceRowStatus = 'ok' | 'low' | 'high' | 'n.a.';
export type ReferenceRowBasis = 'references' | 'delivery' | 'no reference data';

export type ReferenceRow = {
	metric: ReferenceMetricKey;
	group: ReferenceMetricGroup;
	label: string;
	unit: MetricSpec['unit'];
	decimals: number;
	value: number | null;
	/** The judged window: the references' min–max widened by the tolerance (one side may be open: null). */
	range: [number | null, number | null];
	typical: [number | null, number | null] | null;
	median: number | null;
	n: number;
	status: ReferenceRowStatus;
	weight: ReferenceWeightName;
	basis: ReferenceRowBasis;
	/** Sync shares: this measurement's chance level and the references' median chance. */
	chance?: number | null;
	refChance?: number | null;
	why: string;
};

export type ReferenceComparison = {
	profileId: string;
	name: string;
	/** References in the profile, and those the rows are judged against (leave-one-out: one fewer). */
	n: number;
	scoredAgainst: number;
	leaveOneOut: { referenceId: string; title: string; by: 'identity' | 'measurements' } | null;
	rows: ReferenceRow[];
	arc: {
		value: (number | null)[] | null;
		median: (number | null)[] | null;
		p10: (number | null)[] | null;
		p90: (number | null)[] | null;
	};
	counts: { ok: number; low: number; high: number; na: number; scored: number };
};

/** The judged window of a metric (earshot `critique._window`, without the web-practice loudness window). */
export function referenceWindow(
	key: ReferenceMetricKey,
	stats: MetricStats | undefined,
): { lo: number | null; hi: number | null; basis: ReferenceRowBasis } {
	const spec: MetricSpec = REFERENCE_METRICS[key];
	if (!stats || !stats.n || stats.min === null || stats.max === null)
		return { lo: null, hi: null, basis: 'no reference data' };
	let lo: number | null = r3(stats.min - spec.tolerance);
	const hi = r3(stats.max + spec.tolerance);
	// a density, duration or share window reaching 0 keeps a floor at half the sparsest reference (densities) or none
	if (lo <= 0 && (spec.unit === 's' || spec.unit === '/s' || spec.unit === '/min' || spec.unit === 'share'))
		lo = spec.unit === '/s' && stats.min > 0 ? r3(stats.min / 2) : null;
	return {
		lo: spec.sides === 'upper' ? null : lo,
		hi: spec.sides === 'lower' ? null : hi,
		basis: spec.delivery ? 'delivery' : 'references',
	};
}

function statusOf(v: number | null, lo: number | null, hi: number | null): ReferenceRowStatus {
	if (v === null) return 'n.a.';
	if (lo !== null && v < lo) return 'low';
	if (hi !== null && v > hi) return 'high';
	return 'ok';
}

/**
 * Which reference of the profile the measured piece is (leave-one-out, earshot `critique.reference_match`): the same
 * identity (a sequence reference of this very sequence), else the same duration within 50 ms and at least 3 of
 * integrated loudness ±0.15, true peak ±0.15, brightness ±15 Hz and mid share ±0.15 dB. Null: none.
 */
export function referenceMatch(
	m: Pick<ReferenceMeasurement, 'durationSec' | 'metrics'>,
	profile: Pick<ReferenceProfile, 'references'>,
	identity?: string | null,
): { referenceId: string; title: string; by: 'identity' | 'measurements' } | null {
	if (identity) {
		const own = profile.references.find(
			(r) => r.kind === 'sequence' && r.fingerprint.split('@')[0] === identity,
		);
		if (own) return { referenceId: own.id, title: own.title, by: 'identity' };
	}
	const tol: Partial<Record<ReferenceMetricKey, number>> = {
		lufs_i: 0.15,
		true_peak: 0.15,
		brightness_hz: 15,
		band_mid: 0.15,
	};
	for (const g of profile.references) {
		if (!(Math.abs(g.durationSec - m.durationSec) <= 0.05)) continue;
		const both = (Object.keys(tol) as ReferenceMetricKey[]).filter(
			(k) => fin(m.metrics[k]) && fin(g.metrics[k]),
		);
		if (both.length >= 3 && both.every((k) => Math.abs(m.metrics[k]! - g.metrics[k]!) <= tol[k]!))
			return { referenceId: g.id, title: g.title, by: 'measurements' };
	}
	return null;
}

/**
 * Compares a measurement with a profile: one row per metric with its value, window, typical band, median, status and
 * weight (earshot `critique.scorecard`). A piece that is one of the profile's references is judged against the others
 * (leave-one-out; needs at least two others, else against all of them).
 */
export function compareWithProfile(
	m: ReferenceMeasurement,
	profile: ReferenceProfile,
	opts: { identity?: string | null } = {},
): ReferenceComparison {
	const match = referenceMatch(m, profile, opts.identity ?? null);
	const others = match ? profile.references.filter((r) => r.id !== match.referenceId) : profile.references;
	const loo = !!match && others.length >= 2;
	const agg = loo ? aggregateReferences(others) : profile;
	const rows: ReferenceRow[] = [];
	const counts = { ok: 0, low: 0, high: 0, na: 0, scored: 0 };
	for (const key of REFERENCE_METRIC_KEYS) {
		const spec: MetricSpec = REFERENCE_METRICS[key];
		const stats = agg.metrics[key];
		const { lo, hi, basis } = referenceWindow(key, stats);
		const value = m.metrics[key];
		const status: ReferenceRowStatus = basis === 'no reference data' ? 'n.a.' : statusOf(value, lo, hi);
		const weight = REFERENCE_WEIGHT_NAMES[spec.weight];
		const row: ReferenceRow = {
			metric: key,
			group: spec.group,
			label: spec.label,
			unit: spec.unit,
			decimals: spec.decimals,
			value,
			range: [lo, hi],
			typical: stats.n ? [stats.p10, stats.p90] : null,
			median: stats.median,
			n: stats.n,
			status,
			weight,
			basis,
			why: spec.why,
		};
		if ((REFERENCE_CHANCE_KEYS as readonly string[]).includes(key)) {
			row.chance = m.chance[key as ReferenceChanceKey];
			row.refChance = agg.chance[key as ReferenceChanceKey].median;
		}
		rows.push(row);
		if (spec.weight > 0 && status !== 'n.a.') {
			counts.scored++;
			if (status === 'ok') counts.ok++;
			else if (status === 'low') counts.low++;
			else counts.high++;
		} else if (status === 'n.a.') counts.na++;
	}
	return {
		profileId: profile.id,
		name: profile.name,
		n: profile.n,
		scoredAgainst: loo ? others.length : profile.n,
		leaveOneOut: loo ? match : null,
		rows,
		arc: {
			value: m.arc,
			median: agg.arc?.median ?? null,
			p10: agg.arc?.p10 ?? null,
			p90: agg.arc?.p90 ?? null,
		},
		counts,
	};
}

/** The Sound Check severity of an out-of-range row: weight major → warning, minor → info; info rows → none. */
export function referenceSeverity(row: Pick<ReferenceRow, 'weight' | 'status'>): 'warning' | 'info' | null {
	if (row.status !== 'low' && row.status !== 'high') return null;
	return row.weight === 'major' ? 'warning' : row.weight === 'minor' ? 'info' : null;
}

/** A metric value as text with its unit ("−6.2 dB", "40 %", "1.25 s"); "n.a." for none. */
export function referenceValueText(key: ReferenceMetricKey, v: number | null | undefined): string {
	if (!fin(v)) return 'n.a.';
	const spec: MetricSpec = REFERENCE_METRICS[key];
	const sign = (s: string) => s.replace(/^-/, '−');
	if (spec.unit === 'share') return `${Math.round(v * 100)} %`;
	const n = sign(v.toFixed(spec.decimals));
	if (spec.unit === '0-1' || spec.unit === 'r') return n;
	return `${n} ${spec.unit}`;
}

// ── texts (model strings: the editor translates them; `{0}`… are numbers, times and labels) ─────────────────────────

/** Templates of the Reference rows' findings and of what to do. */
export const REFERENCE_MESSAGES = {
	low: '{0} is low: {1}, the references {2} … {3} (median {4})',
	high: '{0} is high: {1}, the references {2} … {3} (median {4})',
	lowOpen: '{0} is low: {1}, the references at least {2} (median {3})',
	highOpen: '{0} is high: {1}, the references at most {2} (median {3})',
	looNote: 'This sequence is reference {0} of the profile: it is judged against the other {1} (leave-one-out).',
	missing: 'The reference profile {0} is not in the sound library any more: no Reference comparison.',
	lraHigh:
		'The loudness swings {0} LU: the quietest stretch is around {1}, the loudest around {2}; lift the quiet parts or bring the loud ones down so the body holds.',
	lraLow: 'The level hardly moves ({0} LU): give the piece sections, a calmer passage and a lift into the main moment.',
	crestHigh: 'The loudest 3 s (around {0}) stand {1} LU over the whole: lift the body or tame that moment.',
	crestLow: 'Nothing stands out ({0} LU over the whole): let the main moment rise 2–3 LU over the body.',
	introLow: 'The opening ({0}) sits {1} LU under the body: start closer to full level or shorten the build-up.',
	introHigh: 'The opening ({0}) is {1} LU louder than the body: bring it down or lift the body.',
	endLow: 'The closing ({0}) sits {1} LU under the body: keep the energy up into the end and finish on a hit.',
	endHigh: 'The closing ({0}) is {1} LU louder than the body: bring it down or lift the body.',
	firstSoundHigh: 'Nothing reaches the body’s level until {0}: start the music, an ambience or a riser at the start.',
	gapHigh:
		'Silent holes inside: {0}; keep a music bed or room tone under them, or make each a deliberate stop-down that ends on a hit.',
	endSilenceHigh:
		'{0} s of dead air after the sound ends at {1}: trim the picture there or let the last sound ring out to the end.',
	fadeHigh: 'A {0} s fade-out: end on a hit with a short ring-out, or cut on the last picture cut.',
	fadeLow: 'The end is cut hard: let the last sound ring out briefly.',
	finalLow: 'The final moment sits {0} LU under the body: end on a hit at the last cut ({1}) instead of fading away.',
	finalLowNoCut: 'The final moment sits {0} LU under the body: end on a hit instead of fading away.',
	finalHigh: 'The final hit is {0} LU over the body: pull it down 2–3 dB.',
	onsetLow: 'Sparse ({0} onsets/s): add sounds on the on-screen actions, or use music with more drive.',
	onsetHigh: 'Busy ({0} onsets/s): thin out the sound effects and keep accents for the important moments.',
	hitLow: 'Few salient hits ({0}/s): add impacts or accents on the key moments.',
	hitLowAt: 'Few salient hits ({0}/s): add impacts or accents on the key moments, e.g. the cuts at {1}.',
	hitHigh: 'Too many salient hits ({0}/s): keep the biggest for the main moments and lower the rest by 3–6 dB.',
	cutsLow:
		'{0} of {1} picture events have no onset within 100 ms (chance {2}); no sound at all at {3}: add a whoosh into the cut, a hit or a click there.',
	cutsLowThrough:
		'{0} of {1} picture events have no onset within 100 ms (chance {2}): sound plays through them but nothing starts; add an accent on the ones that matter.',
	subLow: 'Thin bottom: add a sub layer under the main moments, or pick music with real low end.',
	subHigh: 'Too much 20–60 Hz rumble eats headroom: high-pass sound effects and ambience at 30–40 Hz, cut the music’s sub 2–4 dB.',
	lowLow: 'Weak low end: the music has no body; choose a fuller track or add a low layer.',
	lowHigh: 'Boomy: cut 100–200 Hz on the music and on heavy sound effects by 2–3 dB.',
	lowmidLow: 'Hollow: the 250 Hz–1 kHz body is scooped; lift it on the music or use fuller recordings.',
	lowmidHigh: 'Muddy or boxy: cut 300–500 Hz on the music and on roomy sound effects by 2–3 dB.',
	midLow: 'Recessed mids: clicks and the voice will not cut through small speakers; lift 1–3 kHz on effects or voice.',
	midHigh: 'Honky or harsh mids: cut 1–3 kHz on the loudest layer by 2 dB.',
	presenceLow: 'Dull: transients, clicks and typing lack bite; brighten the effects or use brighter recordings.',
	presenceHigh: 'Harsh or sibilant: cut 5–7 kHz or de-ess the brightest layer.',
	airLow: 'No air: it sounds muffled or low-bitrate; use full-band recordings (44.1 or 48 kHz, no low-pass).',
	airHigh: 'Hissy or fizzy: low-pass or de-noise the noisiest layer.',
	stereoLow: 'Nearly mono (side {0} dB under mid): use stereo music and ambience, pan sound effects with the motion.',
	stereoMono: 'The mix is mono (identical channels): use stereo music and ambience, pan sound effects with the motion.',
	stereoHigh: 'Very wide (side {0} dB against mid): check the mono fold-down, narrow wide ambiences and reverbs.',
} as const;
export type ReferenceMessageKey = keyof typeof REFERENCE_MESSAGES;

/** Every model string of this module (labels, why texts, finding and advice templates). */
export const REFERENCE_MODEL_STRINGS: readonly string[] = [
	...new Set([
		...REFERENCE_METRIC_KEYS.flatMap((k) => [REFERENCE_METRICS[k].label, REFERENCE_METRICS[k].why]),
		...Object.values(REFERENCE_MESSAGES),
	]),
];

export type ReferenceMessage = { key: string; params: (string | number)[]; text: string };

export function referenceMessage(key: ReferenceMessageKey, ...params: readonly (string | number)[]): ReferenceMessage {
	const template: string = REFERENCE_MESSAGES[key];
	const text = template.replace(/\{(\d+)\}/g, (m, i: string) =>
		Number(i) < params.length ? String(params[Number(i)]) : m,
	);
	return { key: template, params: [...params], text };
}

/** The finding text of an out-of-range row ("Air 8–16 kHz share is low: −24.0 dB, the references −19.5 dB … …"). */
export function referenceRowMessage(row: ReferenceRow): ReferenceMessage {
	const v = (x: number | null | undefined) => referenceValueText(row.metric, x);
	const [lo, hi] = row.range;
	const low = row.status === 'low';
	if (lo !== null && hi !== null) return referenceMessage(low ? 'low' : 'high', row.label, v(row.value), v(lo), v(hi), v(row.median));
	if (low) return referenceMessage('lowOpen', row.label, v(row.value), v(lo), v(row.median));
	return referenceMessage('highOpen', row.label, v(row.value), v(hi), v(row.median));
}

/** What the measured piece offers the advice: timecodes and moments (the engine fills it from its measurements). */
export type ReferenceAdviceContext = {
	/** Picture events with no sound at all (timecodes), and how many there are. */
	silentCuts?: string[];
	pictureEvents?: number;
	withoutOnset?: number;
	/** Silent gaps inside ("00:00:03:10–00:00:05:00"). */
	gaps?: string[];
	soundEndsAt?: string;
	quietestAt?: string;
	loudestAt?: string;
	lastCutAt?: string;
	openingSpan?: string;
	closingSpan?: string;
	firstSoundAt?: string;
	/** Picture events without a salient hit, biggest first (timecodes). */
	cutsWithoutHit?: string[];
};

/** Joins timecodes for a message: the first `k`, then "(+n more)". */
export function timecodeList(tcs: readonly string[], k = 8): string {
	const head = tcs.slice(0, k).join(', ');
	return tcs.length > k ? `${head} (+${tcs.length - k} more)` : head;
}

const BAND_ADVICE: Partial<Record<ReferenceMetricKey, [ReferenceMessageKey, ReferenceMessageKey]>> = {
	band_sub: ['subLow', 'subHigh'],
	band_low: ['lowLow', 'lowHigh'],
	band_lowmid: ['lowmidLow', 'lowmidHigh'],
	band_mid: ['midLow', 'midHigh'],
	band_presence: ['presenceLow', 'presenceHigh'],
	band_air: ['airLow', 'airHigh'],
};

/** What to do about an out-of-range row (earshot `critique._actions`, our wording), with timecodes. */
export function referenceAdvice(
	row: ReferenceRow,
	ctx: ReferenceAdviceContext,
	m?: Pick<ReferenceMeasurement, 'mono'>,
): ReferenceMessage[] {
	if (row.status !== 'low' && row.status !== 'high') return [];
	const low = row.status === 'low';
	const v = row.value ?? 0;
	const d1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1).replace(/^-/, '−');
	const d2 = (x: number) => (Math.round(x * 100) / 100).toFixed(2);
	const pct = (x: number | null | undefined) => (fin(x) ? `${Math.round(x * 100)} %` : 'n.a.');
	switch (row.metric) {
		case 'lra':
			return [
				low
					? referenceMessage('lraLow', d1(v))
					: referenceMessage('lraHigh', d1(v), ctx.quietestAt ?? '—', ctx.loudestAt ?? '—'),
			];
		case 'crest_lu':
			return [low ? referenceMessage('crestLow', d1(v)) : referenceMessage('crestHigh', ctx.loudestAt ?? '—', d1(v))];
		case 'intro_lu':
			return [referenceMessage(low ? 'introLow' : 'introHigh', ctx.openingSpan ?? '—', d1(Math.abs(v)))];
		case 'end_lu':
			return [referenceMessage(low ? 'endLow' : 'endHigh', ctx.closingSpan ?? '—', d1(Math.abs(v)))];
		case 'first_sound_s':
			return low ? [] : [referenceMessage('firstSoundHigh', ctx.firstSoundAt ?? `${d2(v)} s`)];
		case 'max_gap_s':
			return low ? [] : [referenceMessage('gapHigh', ctx.gaps?.length ? timecodeList(ctx.gaps, 6) : `${d2(v)} s`)];
		case 'end_silence_s':
			return low ? [] : [referenceMessage('endSilenceHigh', d1(v), ctx.soundEndsAt ?? '—')];
		case 'fade_s':
			return [low ? referenceMessage('fadeLow') : referenceMessage('fadeHigh', d1(v))];
		case 'final_lu':
			return [
				low
					? ctx.lastCutAt
						? referenceMessage('finalLow', d1(Math.abs(v)), ctx.lastCutAt)
						: referenceMessage('finalLowNoCut', d1(Math.abs(v)))
					: referenceMessage('finalHigh', d1(v)),
			];
		case 'onset_rate':
			return [referenceMessage(low ? 'onsetLow' : 'onsetHigh', d2(v))];
		case 'hit_rate':
			return [
				low
					? ctx.cutsWithoutHit?.length
						? referenceMessage('hitLowAt', d2(v), timecodeList(ctx.cutsWithoutHit, 6))
						: referenceMessage('hitLow', d2(v))
					: referenceMessage('hitHigh', d2(v)),
			];
		case 'cuts_with_sound': {
			if (!low) return [];
			const n = ctx.pictureEvents ?? 0;
			const without = ctx.withoutOnset ?? Math.round((1 - v) * n);
			return [
				ctx.silentCuts?.length
					? referenceMessage('cutsLow', without, n, pct(row.chance), timecodeList(ctx.silentCuts))
					: referenceMessage('cutsLowThrough', without, n, pct(row.chance)),
			];
		}
		case 'side_to_mid_db':
			return [
				low
					? m?.mono
						? referenceMessage('stereoMono')
						: referenceMessage('stereoLow', d1(Math.abs(v)))
					: referenceMessage('stereoHigh', d1(v)),
			];
		default: {
			const b = BAND_ADVICE[row.metric];
			return b ? [referenceMessage(low ? b[0] : b[1])] : [];
		}
	}
}

/** A new profile id (`sprf_` + 16 hex digits) from 8 random bytes. */
export function referenceProfileIdOf(bytes: Uint8Array): string {
	let hex = '';
	for (let i = 0; i < 8; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
	return `sprf_${hex}`;
}
