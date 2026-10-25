// Premiere Pro's built-in Pitch Shifter audio effect (Audio Effects ▸ Time and Pitch; Spanish "Desfasador de tono")
// ↔ JasperEditor's Pitch Shifter (`jasper.audio.pitch-shifter`: semitones + cents, phase vocoder). No VST hosting:
// Premiere's parameters are converted. Research, decoded value distributions and assumptions:
// docs/wp-notes/premiere-pitch-shifter.md.
//
// The effect is Adobe's VST plug-in (Audition 3 user guide: "Pitch Shifter is VST-based"), so documents store its
// parameters as normalised 0…1 values (`.prproj` AudioComponentParam values and the plug-in state ParamList,
// Audition `.sesx` parameterValue, ExtendScript `setValue`):
//   Transpose Ratio  n → ratio = 0.5 + 1.5·n (linear; 0 = 0.5 an octave down, 1/3 = 1 no shift, 1 = 2 an octave up);
//                    cents = 1200·log2(ratio). Verified on integer-semitone values (e.g. 0.2272643 = −3 st).
//   Precision        three steps (Low / Medium / High assumed in that order) → 0, ½, 1; every default instance has 1.
//   Splicing Frequency (Hz), Overlapping (0…50 %): Adobe's splicing (chunk) algorithm's settings; derived from the
//                    ratio while "Use Appropriate Default Settings" is on.
//   Use Appropriate Default Settings, Use Positive Cents: two-state switches stored as 0.25 (off) / 0.75 (on).
//   "Use Positive Cents" only chooses how the ratio is displayed as semitones + cents (−1 st +10 c vs 0 st −90 c).
// JasperEditor's phase vocoder reproduces the transposition exactly (the pitch ratio); Adobe's chunk-splicing quality
// settings have no counterpart and are reported when the document chose non-default ones.
import {
	type Animatable,
	defaultEffectRegistry,
	evaluateKeyframes,
	INTERPOLATIONS,
	type Interpolation,
	type Keyframe,
	PITCH_SHIFTER_EFFECT_ID,
} from '@jasper/project';
import type { PremiereParam } from './premiere-transitions.ts';
import type { Report, ReportSubject } from './report.ts';

/** Premiere's Pitch Shifter `FilterMatchName` (the VST3 class id; also Audition's `componentID`). */
export const PREMIERE_PITCH_SHIFTER_MATCH_NAME = '164b4e8a-7105-406b-b23b-1ef2cc4d8957';
/** The component match name ExtendScript reports for the Pitch Shifter (its parameters are "ADBE Pitch Shifter-000i"). */
export const PREMIERE_PITCH_SHIFTER_SCRIPT_NAME = 'ADBE Pitch Shifter';
/** Display names Premiere gives the effect (English, Spanish). */
export const PREMIERE_PITCH_SHIFTER_NAMES: readonly string[] = ['Pitch Shifter', 'Desfasador de tono'];
/** The pitch the converted curves follow Premiere's within (cents). */
export const PITCH_TOLERANCE_CENTS = 0.1;

/** Normalised value of a two-state switch that is on / off (Premiere and Audition write 0.75 / 0.25). */
const SWITCH_ON = 0.75;
const SWITCH_OFF = 0.25;
/** Normalised Transpose Ratio of no shift (ratio 1). */
const RATIO_NEUTRAL = 1 / 3;
const MAX_KEYS = 10_000;
const MAX_DEPTH = 8;

export type PremierePitchField =
	| 'bypass'
	| 'ratio'
	| 'precision'
	| 'splicing'
	| 'overlapping'
	| 'useDefaults'
	| 'positiveCents';
/** Premiere's parameter order (`.prproj` Param Index 0…6; ExtendScript "ADBE Pitch Shifter-000i"). */
const PARAM_ORDER: readonly PremierePitchField[] = [
	'bypass',
	'ratio',
	'precision',
	'splicing',
	'overlapping',
	'useDefaults',
	'positiveCents',
];
/** The plug-in state ParamList order (no bypass; Version 1 lists five values, Version 2 adds Use Positive Cents). */
const STATE_ORDER: readonly PremierePitchField[] = PARAM_ORDER.slice(1);

const fold = (s: string) =>
	s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, ' ');

/** Parameter names documents use: Premiere English / Spanish, Audition `.sesx`, ExtendScript match names. */
const FIELD_NAMES: Record<string, PremierePitchField> = {
	bypass: 'bypass',
	derivar: 'bypass',
	'transpose ratio': 'ratio',
	'transponer proporcion': 'ratio',
	precision: 'precision',
	'splicing frequency': 'splicing',
	frequency: 'splicing',
	lineatura: 'splicing',
	overlapping: 'overlapping',
	superposicion: 'overlapping',
	'use appropriate default settings': 'useDefaults',
	'use default settings': 'useDefaults',
	'use default setting': 'useDefaults',
	'usar ajuste predeterminado': 'useDefaults',
	'use positive cents': 'positiveCents',
	'utilizar centenas positivas': 'positiveCents',
	...Object.fromEntries(PARAM_ORDER.map((f, i) => [`adbe pitch shifter-000${i}`, f])),
};
/** Names only Premiere's Pitch Shifter uses (JasperEditor's own effect has `semitones` / `cents`). */
const PREMIERE_ONLY = new Set(
	Object.entries(FIELD_NAMES)
		.filter(([k, f]) => f !== 'bypass' && f !== 'precision' && k !== 'frequency' && k !== 'overlapping')
		.map(([k]) => k),
);
const LABEL: Record<PremierePitchField, string> = {
	bypass: 'Bypass',
	ratio: 'Transpose Ratio',
	precision: 'Precision',
	splicing: 'Splicing Frequency',
	overlapping: 'Overlapping',
	useDefaults: 'Use Appropriate Default Settings',
	positiveCents: 'Use Positive Cents',
};

/** A Pitch Shifter parameter as a document carries it: its display name, else its id or Premiere's index. */
export type PremierePitchParam = PremiereParam & { id?: string; index?: number };

export type PremierePitchShifterInput = {
	params: readonly PremierePitchParam[];
	/** The component's Bypass flag (`.prproj` `<Bypass>`; FCP7 `<enabled>FALSE</enabled>`). */
	bypass?: boolean | null;
	/** Effect Controls ▸ Rename (`.prproj` `<InstanceName>`), e.g. "VOZ UWU". */
	instanceName?: string | null;
	/** The plug-in state (`.prproj` OpaqueData `prop.map` with a `ParamList`): values the parameter list leaves out. */
	pluginState?: string | null;
	/**
	 * How Transpose Ratio values are written: `normalized` 0…1 (what `.prproj`, `.sesx` and ExtendScript carry),
	 * `ratio` 0.5…2 (the displayed ratio). Default `normalized`; a value above 1 is read as a ratio.
	 */
	ratioScale?: 'normalized' | 'ratio';
	/** Moves added keyframe times onto a grid (e.g. frames); original keyframe times are kept as they are. */
	snap?: (t: number) => number;
};

export type PremierePitchPrecision = 'low' | 'medium' | 'high';

export type PremierePitchShifterMapping = {
	effectId: string;
	effectVersion: number;
	enabled: boolean;
	/** The instance name, when the document renamed it. */
	name?: string;
	params: { semitones: Animatable<number>; cents: Animatable<number> };
	/** What the document said, decoded (static values; for reports and callers). */
	decoded: {
		ratio: number;
		totalCents: number;
		precision: PremierePitchPrecision;
		useDefaults: boolean;
		positiveCents: boolean;
		/** Normalised 0…1 values as stored (their Hz / % ranges are not documented); null when absent. */
		splicing: number | null;
		overlapping: number | null;
	};
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round3 = (v: number) => {
	const r = Math.round(v * 1000) / 1000;
	return Object.is(r, -0) ? 0 : r;
};

/** Transpose Ratio: normalised 0…1 → frequency ratio 0.5…2 (linear). Non-finite → 1. */
export function premiereRatioOf(normalized: number): number {
	return Number.isFinite(normalized) ? 0.5 + 1.5 * clamp01(normalized) : 1;
}

/** Frequency ratio → normalised Transpose Ratio (clamped to 0.5…2). Non-finite → no shift. */
export function premiereNormalizedOf(ratio: number): number {
	return Number.isFinite(ratio) ? clamp01((ratio - 0.5) / 1.5) : RATIO_NEUTRAL;
}

/** Cents of a frequency ratio, rounded to 0.001 cent (undoes the float32 noise of stored values). */
export function centsOfRatio(ratio: number): number {
	return ratio > 0 && Number.isFinite(ratio) ? round3(1200 * Math.log2(ratio)) : 0;
}

/** Frequency ratio of a shift in cents. */
export function ratioOfCents(cents: number): number {
	return Number.isFinite(cents) ? 2 ** (cents / 1200) : 1;
}

/**
 * A total shift in cents as whole semitones + cents, as Premiere displays it: with Use Positive Cents the cents are
 * 0…100 (−90 → −1 st +10 c), otherwise they take the shift's sign (−90 → 0 st −90 c). The sum is exact.
 */
export function splitCents(total: number, positiveCents: boolean): { semitones: number; cents: number } {
	const t = Number.isFinite(total) ? round3(Math.min(1200, Math.max(-1200, total))) : 0;
	const st = positiveCents ? Math.floor(t / 100) : Math.trunc(t / 100);
	const semitones = Object.is(st, -0) ? 0 : st;
	return { semitones, cents: round3(t - semitones * 100) };
}

/** The Pitch Shifter setting a parameter name or id stands for (`ratio`, `precision`, …), or null. */
export function premierePitchField(nameOrId: string | null | undefined): PremierePitchField | null {
	return typeof nameOrId === 'string' ? (FIELD_NAMES[fold(nameOrId)] ?? null) : null;
}

const fieldOf = (p: PremierePitchParam): PremierePitchField | null => {
	for (const n of [p.name, p.id]) {
		const f = typeof n === 'string' ? FIELD_NAMES[fold(n)] : undefined;
		if (f) return f;
	}
	return typeof p.index === 'number' && Number.isInteger(p.index) ? (PARAM_ORDER[p.index] ?? null) : null;
};

/**
 * Whether an effect a document names is Premiere's Pitch Shifter: by its match name / effect id, its Spanish display
 * name, or a parameter only Premiere's Pitch Shifter has ("Transpose Ratio", …). JasperEditor's own effect id and
 * a bare "Pitch Shifter" without Premiere parameters are not.
 */
export function isPremierePitchShifter(
	effectId: string | null | undefined,
	name: string | null | undefined,
	paramNames: readonly (string | null | undefined)[] = [],
): boolean {
	const id = fold(effectId ?? '');
	if (id === PITCH_SHIFTER_EFFECT_ID) return false;
	if (id === PREMIERE_PITCH_SHIFTER_MATCH_NAME || id === fold(PREMIERE_PITCH_SHIFTER_SCRIPT_NAME))
		return true;
	if (fold(name ?? '') === 'desfasador de tono') return true;
	return paramNames.slice(0, 256).some((n) => typeof n === 'string' && PREMIERE_ONLY.has(fold(n)));
}

/** Whether a display name is one of the effect's own (not an instance name). */
function isEffectName(name: string): boolean {
	const n = fold(name);
	return (
		n === '' ||
		PREMIERE_PITCH_SHIFTER_NAMES.some((x) => fold(x) === n) ||
		n === PREMIERE_PITCH_SHIFTER_MATCH_NAME ||
		n === fold(PREMIERE_PITCH_SHIFTER_SCRIPT_NAME)
	);
}

/** The ParamList floats of a plug-in state `prop.map` (bounded; anything unreadable → []). */
export function premierePluginParamList(xml: string | null | undefined): number[] {
	if (typeof xml !== 'string' || xml.length > 1_000_000) return [];
	const m = /<key>\s*ParamList\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
	if (!m) return [];
	const out: number[] = [];
	for (const f of m[1]!.matchAll(/<float>([^<]{0,64})<\/float>/g)) {
		const v = Number(f[1]!.trim());
		out.push(f[1]!.trim() !== '' && Number.isFinite(v) ? v : Number.NaN);
		if (out.length >= 64) break;
	}
	return out;
}

type Scalar = number | boolean | string;
const toNumber = (v: Scalar | null | undefined): number | null => {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'boolean') return v ? SWITCH_ON : SWITCH_OFF;
	if (typeof v === 'string') {
		const s = v.trim().toLowerCase();
		if (s === 'true') return SWITCH_ON;
		if (s === 'false') return SWITCH_OFF;
		const n = Number(s);
		return s !== '' && Number.isFinite(n) ? n : null;
	}
	return null;
};
const switchOf = (v: number) => v >= 0.5;
const precisionOf = (v: number): PremierePitchPrecision =>
	(['low', 'medium', 'high'] as const)[Math.min(2, Math.max(0, Math.round(clamp01(v) * 2)))]!;

type Raw = { value: number | null; keys: { time: number; value: number; interpolation: Interpolation }[] };

/**
 * Converts Premiere's Pitch Shifter to JasperEditor's Pitch Shifter: Transpose Ratio → semitones + cents (exact; each
 * keyframe keeps its time, and keyframed ratios get intermediate keys so the pitch follows Premiere's linear-ratio
 * interpolation within PITCH_TOLERANCE_CENTS), bypass → disabled, the instance name → `name`. Settings without an
 * equivalent (custom Splicing Frequency / Overlapping, a Precision other than the default) are reported. Never throws.
 */
export function premierePitchShifterToJasper(
	input: PremierePitchShifterInput,
	report: Report,
	subject: ReportSubject = { kind: 'effect', name: 'Pitch Shifter' },
): PremierePitchShifterMapping {
	const extra = { subject };
	const raw = new Map<PremierePitchField, Raw>();
	const params = Array.isArray(input?.params) ? input.params.slice(0, 256) : [];
	for (const p of params) {
		if (!p || typeof p !== 'object') continue;
		const f = fieldOf(p);
		if (!f) {
			report.info(
				`parameter "${String(p.name ?? p.id ?? p.index)}" of Premiere's Pitch Shifter is not known and was ignored`,
				extra,
			);
			continue;
		}
		const keys: Raw['keys'] = [];
		for (const k of Array.isArray(p.keyframes) ? p.keyframes.slice(0, MAX_KEYS) : []) {
			const v = toNumber(k?.value);
			if (v === null || typeof k.time !== 'number' || !Number.isFinite(k.time)) continue;
			const interpolation: Interpolation = (INTERPOLATIONS as readonly unknown[]).includes(k.interpolation)
				? (k.interpolation as Interpolation)
				: 'linear';
			keys.push({
				time: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(k.time))),
				value: v,
				interpolation,
			});
		}
		const value = toNumber(p.value);
		if (value === null && p.value !== null && p.value !== undefined)
			report.warn(
				`parameter "${LABEL[f]}" of Premiere's Pitch Shifter has an unreadable value (${String(p.value).slice(0, 40)}); its default is used`,
				extra,
			);
		raw.set(f, { value, keys });
	}
	// Values the parameter list leaves out (Premiere stores none for a parameter at its default) from the plug-in state.
	const state = premierePluginParamList(input?.pluginState);
	STATE_ORDER.forEach((f, i) => {
		const v = state[i];
		if (v === undefined || !Number.isFinite(v)) return;
		const r = raw.get(f);
		if (!r) raw.set(f, { value: v, keys: [] });
		else if (r.value === null && !r.keys.length) r.value = v;
	});
	const staticOf = (f: PremierePitchField, def: number): number => {
		const r = raw.get(f);
		return r?.keys[0]?.value ?? r?.value ?? def;
	};

	// Transpose Ratio → normalised (a ratio-scaled document, or any value above 1, is a ratio).
	const ratioRaw = raw.get('ratio');
	const asRatio =
		input?.ratioScale === 'ratio' ||
		(input?.ratioScale !== 'normalized' &&
			[ratioRaw?.value ?? 0, ...(ratioRaw?.keys ?? []).map((k) => k.value)].some((v) => v > 1));
	let clamped = false;
	const norm = (v: number): number => {
		const n = asRatio ? (v - 0.5) / 1.5 : v;
		if (n < -1e-6 || n > 1 + 1e-6) clamped = true;
		return clamp01(n);
	};
	const nValue = norm(ratioRaw?.value ?? (asRatio ? 1 : RATIO_NEUTRAL));
	const nKeys = finishKeys((ratioRaw?.keys ?? []).map((k) => ({ ...k, value: norm(k.value) })));
	if (clamped)
		report.warn("Premiere's Pitch Shifter Transpose Ratio was outside 0.5…2 and was clamped", {
			...extra,
			instead: 'the nearest ratio (an octave down or up)',
		});

	const positiveCents = switchOf(staticOf('positiveCents', SWITCH_ON));
	if (raw.get('positiveCents')?.keys.length)
		report.info(
			'the keyframes of Premiere\'s Pitch Shifter "Use Positive Cents" were ignored: it only changes how the ratio is displayed',
			extra,
		);
	const cents = (n: number) => centsOfRatio(premiereRatioOf(n));
	const semitones: Animatable<number> = { value: 0, keyframes: [] };
	const centsAnim: Animatable<number> = { value: 0, keyframes: [] };
	const push = (time: number, total: number, interpolation: Interpolation) => {
		const s = splitCents(total, positiveCents);
		semitones.keyframes.push(key(time, s.semitones, interpolation));
		centsAnim.keyframes.push(key(time, s.cents, interpolation));
	};
	let added = 0;
	if (nKeys.length) {
		const na: Animatable<number> = { value: nKeys[0]!.value, keyframes: nKeys };
		const g = (t: number) => cents(evaluateKeyframes(na, t));
		const snap = typeof input?.snap === 'function' ? input.snap : (t: number) => t;
		for (let i = 0; i < nKeys.length; i++) {
			const a = nKeys[i]!;
			const b = nKeys[i + 1];
			if (!b || a.interpolation === 'hold') {
				push(a.time, cents(a.value), b ? 'hold' : 'linear');
				continue;
			}
			push(a.time, cents(a.value), 'linear');
			const extraKeys: number[] = [];
			subdivide(
				a.time,
				b.time,
				g,
				(t0, t1) => (g(t0) + g(t1)) / 2,
				snap,
				extraKeys,
				0,
				MAX_KEYS - nKeys.length,
			);
			for (const t of extraKeys) push(t, g(t), 'linear');
			added += extraKeys.length;
		}
		sortKeys(semitones);
		sortKeys(centsAnim);
		semitones.value = semitones.keyframes[0]!.value;
		centsAnim.value = centsAnim.keyframes[0]!.value;
		if (added)
			report.info(
				`the keyframes of Premiere's Pitch Shifter Transpose Ratio were converted with ${added} intermediate keyframe(s), so the pitch follows Premiere's linear-ratio interpolation within ${PITCH_TOLERANCE_CENTS} cent`,
				extra,
			);
	} else {
		const s = splitCents(cents(nValue), positiveCents);
		semitones.value = s.semitones;
		centsAnim.value = s.cents;
	}

	// Adobe's splicing settings: automatic (derived from the ratio) unless "Use Appropriate Default Settings" is off.
	const useDefaultsRaw = raw.get('useDefaults');
	const useDefaults = [
		staticOf('useDefaults', SWITCH_ON),
		...(useDefaultsRaw?.keys ?? []).map((k) => k.value),
	].every(switchOf);
	const splicing = raw.get('splicing') ? staticOf('splicing', Number.NaN) : null;
	const overlapping = raw.get('overlapping') ? staticOf('overlapping', Number.NaN) : null;
	if (!useDefaults)
		report.warn(
			"the custom Splicing Frequency / Overlapping of Premiere's Pitch Shifter have no equivalent: JasperEditor's Pitch Shifter is a phase vocoder that does not splice audio into chunks",
			{ ...extra, instead: 'the same transposition with phase-vocoder processing' },
		);
	const precisionRaw = raw.get('precision');
	const precisions = [staticOf('precision', 1), ...(precisionRaw?.keys ?? []).map((k) => k.value)].map(
		precisionOf,
	);
	const precision = precisions[0]!;
	if (precisions.some((p) => p !== 'high'))
		report.warn(
			`Premiere's Pitch Shifter Precision "${precisions.find((p) => p !== 'high')}" (assumed from its stored value) has no equivalent: JasperEditor's Pitch Shifter has one quality`,
			{ ...extra, instead: "JasperEditor's phase-vocoder quality" },
		);

	const bypassed = input?.bypass === true || switchOf(staticOf('bypass', 0));
	if (raw.get('bypass')?.keys.length)
		report.info(
			"the keyframes of Premiere's Pitch Shifter Bypass were ignored; its first state is used",
			extra,
		);
	const instance = typeof input?.instanceName === 'string' ? input.instanceName.trim().slice(0, 256) : '';
	const spec = defaultEffectRegistry.get(PITCH_SHIFTER_EFFECT_ID);
	const totalCents = cents(nKeys[0]?.value ?? nValue);
	return {
		effectId: PITCH_SHIFTER_EFFECT_ID,
		effectVersion: spec?.version ?? 1,
		enabled: !bypassed,
		...(instance && !isEffectName(instance) ? { name: instance } : {}),
		params: { semitones, cents: centsAnim },
		decoded: {
			ratio: premiereRatioOf(nKeys[0]?.value ?? nValue),
			totalCents,
			precision,
			useDefaults,
			positiveCents,
			splicing: splicing !== null && Number.isFinite(splicing) ? splicing : null,
			overlapping: overlapping !== null && Number.isFinite(overlapping) ? overlapping : null,
		},
	};
}

/** Premiere's representation of JasperEditor Pitch Shifter params (for exporters). */
export type PremierePitchShifterExport = {
	/** Transpose Ratio as normalised 0…1 values with keyframes (linear or hold). */
	ratio: Animatable<number>;
	/** Use Positive Cents (from the sign of the cents, so the split reads back as written). */
	positiveCents: boolean;
};

/**
 * JasperEditor Pitch Shifter params (semitones, cents; keyframed or not) → Premiere's normalised Transpose Ratio.
 * Keyframes are written at every key time of either param, with intermediate keys where JasperEditor's
 * cents-linear curve and Premiere's ratio-linear one would differ by more than PITCH_TOLERANCE_CENTS. Shifts beyond
 * an octave are clamped (reported). Never throws.
 */
export function jasperPitchToPremiere(
	params: Readonly<Record<string, unknown>>,
	report: Report,
	subject: ReportSubject = { kind: 'effect', name: 'Pitch Shifter' },
	snap: (t: number) => number = (t) => t,
): PremierePitchShifterExport {
	const st = numberAnim(params?.semitones);
	const ce = numberAnim(params?.cents);
	let clamped = false;
	const total = (t: number) => {
		const c = (evaluateKeyframes(st, t) + evaluateKeyframes(ce, t) / 100) * 100;
		if (!Number.isFinite(c)) return 0;
		if (c < -1200 - 1e-9 || c > 1200 + 1e-9) clamped = true;
		return Math.min(1200, Math.max(-1200, c));
	};
	const nOf = (c: number) => premiereNormalizedOf(ratioOfCents(c));
	const positiveCents = (ce.keyframes[0]?.value ?? ce.value) >= 0;
	const times = [...new Set([...st.keyframes, ...ce.keyframes].map((k) => k.time))]
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b)
		.slice(0, MAX_KEYS);
	const ratio: Animatable<number> = { value: nOf(total(times[0] ?? 0)), keyframes: [] };
	if (times.length) {
		const holdAt = (t: number) =>
			[st, ce].every((a) => {
				if (!a.keyframes.length) return true;
				let k: Keyframe<number> | undefined;
				for (const x of a.keyframes) if (x.time <= t) k = x;
				return !k || k.interpolation === 'hold' || k === a.keyframes[a.keyframes.length - 1];
			});
		// Premiere's curve between two written keys: linear in the normalised ratio.
		const premiereMid = (t0: number, t1: number) =>
			centsOfRatio(premiereRatioOf((nOf(total(t0)) + nOf(total(t1))) / 2));
		const out: Keyframe<number>[] = [];
		for (let i = 0; i < times.length; i++) {
			const a = times[i]!;
			const b = times[i + 1];
			const hold = b !== undefined && holdAt(a);
			out.push(key(a, nOf(total(a)), hold ? 'hold' : 'linear'));
			if (b === undefined || hold) continue;
			const extraKeys: number[] = [];
			subdivide(a, b, total, premiereMid, snap, extraKeys, 0, MAX_KEYS - times.length);
			for (const t of extraKeys) out.push(key(t, nOf(total(t)), 'linear'));
		}
		out.sort((x, y) => x.time - y.time);
		ratio.keyframes = out;
		ratio.value = out[0]!.value;
	}
	if (clamped)
		report.warn(
			"the Pitch Shifter shift beyond ±12 semitones was clamped: Premiere's Pitch Shifter reaches one octave",
			{
				subject,
				instead: 'a shift of one octave',
			},
		);
	return { ratio, positiveCents };
}

/**
 * Adds intermediate key times in (t0, t1) until the written (linear) curve's midpoint `chordMid(t0, t1)` is within the
 * tolerance of the target `target(mid)` (bisection, bounded depth and count).
 */
function subdivide(
	t0: number,
	t1: number,
	target: (t: number) => number,
	chordMid: (t0: number, t1: number) => number,
	snap: (t: number) => number,
	out: number[],
	depth: number,
	budget: number,
): void {
	if (depth >= MAX_DEPTH || out.length >= budget) return;
	let mid = snap(Math.round((t0 + t1) / 2));
	if (!Number.isFinite(mid) || mid <= t0 || mid >= t1) mid = Math.round((t0 + t1) / 2);
	if (mid <= t0 || mid >= t1) return;
	const err = Math.abs(chordMid(t0, t1) - target(mid));
	if (!(err > PITCH_TOLERANCE_CENTS)) return;
	subdivide(t0, mid, target, chordMid, snap, out, depth + 1, budget);
	if (out.length < budget) out.push(mid);
	subdivide(mid, t1, target, chordMid, snap, out, depth + 1, budget);
}

function key(time: number, value: number, interpolation: Interpolation): Keyframe<number> {
	const slope = interpolation === 'bezier' ? 0 : 1;
	return {
		id: `kf${time}`,
		time,
		value,
		interpolation,
		easeIn: { influence: 1 / 3, slope },
		easeOut: { influence: 1 / 3, slope },
	};
}

/** Sorted keys with unique times (the later wins). */
function finishKeys(
	list: { time: number; value: number; interpolation: Interpolation }[],
): Keyframe<number>[] {
	const sorted = [...list].sort((a, b) => a.time - b.time);
	const out: Keyframe<number>[] = [];
	for (const k of sorted) {
		const kf = key(k.time, k.value, k.interpolation);
		if (out.length && out[out.length - 1]!.time === k.time) out[out.length - 1] = kf;
		else out.push(kf);
	}
	return out;
}

function sortKeys(a: Animatable<number>): void {
	a.keyframes.sort((x, y) => x.time - y.time);
	a.keyframes = a.keyframes.filter((k, i, l) => i === l.length - 1 || l[i + 1]!.time !== k.time);
}

/** A number Animatable from an unknown param value (anything else → 0, no keys). */
function numberAnim(v: unknown): Animatable<number> {
	const a = v as Partial<Animatable<number>> | null | undefined;
	const value = typeof a?.value === 'number' && Number.isFinite(a.value) ? a.value : 0;
	const keyframes = Array.isArray(a?.keyframes)
		? a.keyframes
				.filter(
					(k): k is Keyframe<number> =>
						!!k && typeof k.value === 'number' && Number.isFinite(k.value) && Number.isFinite(k.time),
				)
				.slice(0, MAX_KEYS)
				.sort((x, y) => x.time - y.time)
		: [];
	return { value, keyframes };
}
