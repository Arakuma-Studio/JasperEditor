// Cue grammar and variation policy (spec 12 P6-E10; wp-note "Phase 6 → WP-E6"): the rules that make a sound pass sound
// designed rather than random, in ONE pure module every path uses — the engine's plan job (Auto Sound Pass…, Fill
// Unfilled Cues), Suggest Cues… and find_sound_cues (cue derivation), MCP place_sound type picks, the search route
// (personality and palette ranking) and variation cycling (web and MCP):
//   - variation per type (taxonomy `variation`): ui / click keep ONE voice per sequence at one level (no varispeed, no
//     gain jitter); key / tick / tap rotate takes and sounds with ±1 dB and no varispeed; the rest ±2 % and ±1 dB;
//   - runs climb: ≥ 3 consecutive appear / emphasis cues ≤ 0.6 s apart filled with pop, ui, chime or tick are pitched
//     +1 st per step (varispeed), capped at +4 st;
//   - typing: above 25 typed units per second one key per word start;
//   - music carries the cuts: a cut inside unmuted music, outside dialogue, has its confidence halved;
//   - personality: Refine preferences, type boosts and exclusions, preferred materials and a default density;
//   - palette coherence: a ranking bonus for sounds that share the dominant material of the sequence's placed sounds
//     of the same family ("one material family per film").
// The ideas and the launch-film norms are from earshot (github.com/Leonxlnx/earshot, MIT, Copyright (c) 2026 Leon Lin,
// commit 9721326: its skills' launch-video grammar and motion-SFX study): reimplemented, nothing copied
// (licenses/ported/earshot.md). Every number below is a default the user can change through the style, not a truth.
// Agents cannot hear: these rules encode the craft for them. Pure; never throws.
import { readEssentialSound } from '../essential/model.ts';
import type { Sequence } from '../schema/sequence.ts';
import {
	readSoundDesignSettings,
	SOUND_PERSONALITIES,
	type SoundDensity,
	type SoundDesignStyle,
	type SoundPersonality,
	type SoundRunMode,
	type SoundTypingMode,
} from '../schema/sound.ts';
import { isSoundMaterial, SOUND_MATERIALS, type SoundMaterial } from './materials.ts';
import { parseTakeId, SOUND_REF_RE, takeIdOf } from './provenance.ts';
import type { RankDescriptors } from './rank.ts';
import {
	isSoundTypeId,
	SOUND_TYPES,
	type SoundFamily,
	type SoundTypeId,
	type SoundVariation,
} from './taxonomy.ts';

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------------------------------------------
// Style (the settings' `style`, a request's own values on top)

export type ResolvedSoundStyle = {
	personality: SoundPersonality | null;
	runs: SoundRunMode;
	typing: SoundTypingMode;
	musicCarriesCuts: boolean;
	duckUnderTyping: boolean;
};

/** Defaults of the grammar (spec 12 P6-E10): runs climb, typing auto, music carries the cuts, no duck under typing. */
export const SOUND_STYLE_DEFAULTS: Readonly<ResolvedSoundStyle> = Object.freeze({
	personality: null,
	runs: 'climb',
	typing: 'auto',
	musicCarriesCuts: true,
	duckUnderTyping: false,
});

/** A layer of style values: undefined = not set here; `personality: null` = explicitly none. */
export type SoundStyleLayer = {
	personality?: SoundPersonality | null;
	runs?: SoundRunMode;
	typing?: SoundTypingMode;
	musicCarriesCuts?: boolean;
	duckUnderTyping?: boolean;
};

/** The style of the first layer that sets each field (a request first, then the sequence's settings), else defaults. */
export function resolveSoundStyle(
	...layers: readonly (SoundStyleLayer | null | undefined)[]
): ResolvedSoundStyle {
	const out: ResolvedSoundStyle = { ...SOUND_STYLE_DEFAULTS };
	const pick = <K extends keyof ResolvedSoundStyle>(k: K, ok: (v: unknown) => boolean) => {
		for (const l of layers) {
			const v = l && typeof l === 'object' ? (l as Record<string, unknown>)[k] : undefined;
			if (v !== undefined && ok(v)) {
				out[k] = v as ResolvedSoundStyle[K];
				return;
			}
		}
	};
	pick('personality', (v) => v === null || (SOUND_PERSONALITIES as readonly unknown[]).includes(v));
	pick('runs', (v) => v === 'climb' || v === 'flat');
	pick('typing', (v) => v === 'auto' || v === 'keys' || v === 'words' || v === 'silent');
	pick('musicCarriesCuts', (v) => typeof v === 'boolean');
	pick('duckUnderTyping', (v) => typeof v === 'boolean');
	return out;
}

/** The style stored on a sequence (`soundDesign.settings.style`), lenient. */
export function sequenceSoundStyle(seq: { soundDesign?: unknown } | null | undefined): SoundDesignStyle {
	const sd = seq?.soundDesign as { settings?: unknown } | undefined;
	return readSoundDesignSettings(sd && typeof sd === 'object' ? sd.settings : undefined).style ?? {};
}

// ---------------------------------------------------------------------------------------------------------------
// Variation policy

/** The type a sound fills a cue as: the first of the cue's types it has, else its own first known type. */
export function fillTypeOf(
	soundTypes: readonly unknown[] | null | undefined,
	cueTypes: readonly unknown[] = [],
): SoundTypeId | null {
	const own = (Array.isArray(soundTypes) ? soundTypes : []).filter(isSoundTypeId);
	for (const t of Array.isArray(cueTypes) ? cueTypes : []) if (isSoundTypeId(t) && own.includes(t)) return t;
	return own[0] ?? null;
}

/** The variation policy of a type (`vary` for unknown types). */
export function variationOfType(type: unknown): SoundVariation {
	return isSoundTypeId(type) ? SOUND_TYPES[type].variation : 'vary';
}

/** The variation policy of a sound filling a cue (its fill type's). */
export function variationForFill(
	soundTypes: readonly unknown[] | null | undefined,
	cueTypes: readonly unknown[] = [],
): SoundVariation {
	return variationOfType(fillTypeOf(soundTypes, cueTypes));
}

/** A placed sound of the sequence (frame order), as the voice and palette rules read it. */
export type PlacedSound = {
	soundId: string | null;
	types: readonly string[];
	materials?: readonly string[] | null;
};

/**
 * The voice of a `voice` type (ui, click) in a sequence: a palette sound of that type among the candidates (rank order),
 * else the first placed sound of that type (`placed` in frame order, the plan's own earlier picks after the clips
 * already in the sequence). Null when there is none yet: the best candidate becomes the voice.
 */
export function voiceFor(
	type: SoundTypeId,
	opts: {
		candidates: readonly { id: string; types: readonly string[] }[];
		palette: ReadonlySet<string> | readonly string[];
		placed: readonly PlacedSound[];
	},
): { soundId: string; from: 'palette' | 'placed' } | null {
	const pal = opts.palette instanceof Set ? opts.palette : new Set(opts.palette as readonly string[]);
	for (const c of opts.candidates)
		if (pal.has(c.id) && Array.isArray(c.types) && c.types.includes(type))
			return { soundId: c.id, from: 'palette' };
	for (const p of opts.placed)
		if (p.soundId && Array.isArray(p.types) && p.types.includes(type))
			return { soundId: p.soundId, from: 'placed' };
	return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Runs climb

/** A run is at least this many consecutive cues (earshot launch grammar: staggered cards, successive notifications). */
export const RUN_MIN_LENGTH = 3;
/** Members of a run are at most this far apart (seconds). */
export const RUN_MAX_GAP_SEC = 0.6;
/** Each step of a climbing run is pitched this much higher (semitones, varispeed). */
export const RUN_STEP_ST = 1;
/** The climb stops rising here (semitones). */
export const RUN_MAX_ST = 4;
export const RUN_KINDS: readonly string[] = ['appear', 'emphasis'];
export const RUN_TYPES: readonly SoundTypeId[] = ['pop', 'ui', 'chime', 'tick'];

export type RunCandidate = {
	frame: number;
	kind: string;
	/** The type the cue is filled with (`fillTypeOf`). */
	type: string | null;
	/** The cue has its own pitch (an explicit pitchSt): never re-pitched, it ends a run. */
	fixedPitch?: boolean;
};

export type RunStep = {
	/** Run number in the sequence order (1…). */
	run: number;
	/** Position in the run (1…) and its length. */
	index: number;
	of: number;
	/** Semitones of this step: (index − 1) × 1, capped at +4 (`climb`); 0 when `flat`. */
	st: number;
};

/**
 * The runs among `items` (frame order): ≥ 3 consecutive appear / emphasis cues ≤ 0.6 s apart filled with pop, ui,
 * chime or tick. One entry per item: its step, or null outside a run.
 */
export function findRuns(
	items: readonly RunCandidate[],
	fps: number,
	mode: SoundRunMode = 'climb',
): (RunStep | null)[] {
	const out: (RunStep | null)[] = items.map(() => null);
	const rate = fin(fps) && fps > 0 ? fps : 30;
	const maxGap = RUN_MAX_GAP_SEC * rate + 1e-9;
	const fits = (c: RunCandidate | undefined) =>
		!!c &&
		fin(c.frame) &&
		RUN_KINDS.includes(c.kind) &&
		typeof c.type === 'string' &&
		(RUN_TYPES as readonly string[]).includes(c.type) &&
		!c.fixedPitch;
	let run = 0;
	let i = 0;
	while (i < items.length) {
		if (!fits(items[i])) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < items.length && fits(items[j]) && items[j]!.frame - items[j - 1]!.frame <= maxGap) j++;
		const n = j - i;
		if (n >= RUN_MIN_LENGTH) {
			run++;
			for (let k = 0; k < n; k++)
				out[i + k] = {
					run,
					index: k + 1,
					of: n,
					st: mode === 'climb' ? Math.min(RUN_MAX_ST, k * RUN_STEP_ST) : 0,
				};
		}
		i = j;
	}
	return out;
}

/** The varispeed rate of a pitch shift in semitones (2^(st/12), 6 decimals). */
export function rateOfSemitones(st: number): number {
	return fin(st) ? round6(2 ** (st / 12)) : 1;
}

/** "run 3 of 5: +2 st" (or "run 2 of 4: flat"). */
export function runReason(step: RunStep, mode: SoundRunMode = 'climb'): string {
	return mode === 'climb'
		? `run ${step.index} of ${step.of}: +${step.st} st`
		: `run ${step.index} of ${step.of}: flat`;
}

// ---------------------------------------------------------------------------------------------------------------
// Typing

/** Above this many typed units per second, one key per word start (earshot norm; a default, not a truth). */
export const TYPING_WORDS_ABOVE_PER_SEC = 25;

/** What a typing pattern of `unitsPerSec` gets under a typing mode: one key per unit, one per word start, or none. */
export function typingChoice(mode: SoundTypingMode, unitsPerSec: number): 'keys' | 'words' | 'silent' {
	if (mode === 'silent') return 'silent';
	if (mode === 'keys' || mode === 'words') return mode;
	return fin(unitsPerSec) && unitsPerSec > TYPING_WORDS_ABOVE_PER_SEC ? 'words' : 'keys';
}

// ---------------------------------------------------------------------------------------------------------------
// Music carries the cuts

/** A cut inside music has its confidence multiplied by this (earshot norm: most cuts of the measured films are silent). */
export const MUSIC_CUT_CONFIDENCE_FACTOR = 0.5;
export const MUSIC_CARRIES_CUT_REASON = 'music carries the cut';

/**
 * Whether music plays at `frame`: an enabled audio clip of Essential Sound (or Auto Tag) type music covering it, on an
 * audio track that is not muted. Pure; false on damaged data.
 */
export function musicPlaysAt(seq: Sequence, frame: number): boolean {
	try {
		const muted = new Set((seq.audioTracks ?? []).filter((t) => t?.mute === true).map((t) => t.id));
		for (const c of Object.values(seq.clips ?? {})) {
			if (c?.kind !== 'audio' || c.enabled === false || muted.has(c.trackId)) continue;
			if (!(c.start <= frame && frame < c.start + c.duration)) continue;
			if (readEssentialSound((c as { essential?: unknown }).essential)?.type === 'music') return true;
		}
	} catch {
		return false;
	}
	return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Personality

export type PersonalityProfile = {
	/** One line for the selects and the tool docs. */
	description: string;
	tone?: 'dark' | 'bright';
	attack?: 'punchy' | 'soft';
	weight?: 'light' | 'heavy';
	texture?: 'clean' | 'noisy';
	/** Types ranked up (and tried first among a cue's types). */
	boost: readonly SoundTypeId[];
	/** Types left out of a cue's types whenever another type fits. */
	exclude: readonly SoundTypeId[];
	/** Materials ranked up. */
	materials: readonly SoundMaterial[];
	/** The density a pass of this personality uses when the request names none. */
	density: SoundDensity;
};

/** The personality table (a decision recorded in the wp-note "Phase 6 → WP-E6"). */
export const SOUND_PERSONALITY_PROFILES: Readonly<Record<SoundPersonality, PersonalityProfile>> =
	Object.freeze({
		calm: {
			description: 'Soft, dark and sparse: no booms or hits, gentle attacks, wood and paper',
			tone: 'dark',
			attack: 'soft',
			weight: 'light',
			texture: 'clean',
			boost: ['swish', 'chime', 'shimmer', 'paper', 'tap'],
			exclude: ['boom', 'hit', 'glitch', 'zap'],
			materials: ['wood', 'paper', 'cloth', 'air'],
			density: 'sparse',
		},
		energetic: {
			description: 'Punchy, bright and rich: whooshes, hits and risers, metal and air',
			tone: 'bright',
			attack: 'punchy',
			weight: 'heavy',
			boost: ['whoosh', 'hit', 'riser', 'pop', 'transition'],
			exclude: [],
			materials: ['metal', 'electronic', 'air'],
			density: 'rich',
		},
		bright: {
			description: 'Light and sparkling: chimes, pops and UI blips, glass and metal, no low booms',
			tone: 'bright',
			attack: 'punchy',
			weight: 'light',
			texture: 'clean',
			boost: ['chime', 'shimmer', 'pop', 'ui', 'click'],
			exclude: ['boom', 'thump'],
			materials: ['glass', 'metal', 'ceramic'],
			density: 'balanced',
		},
		precise: {
			description: 'Tight and clean interface sounds: clicks, ticks and taps, no swells',
			attack: 'punchy',
			weight: 'light',
			texture: 'clean',
			boost: ['click', 'tick', 'ui', 'key', 'tap'],
			exclude: ['boom', 'riser', 'shimmer', 'reverse'],
			materials: ['plastic', 'electronic', 'metal'],
			density: 'balanced',
		},
		mechanical: {
			description: 'Hard, gritty mechanisms: keys, clicks and thumps, metal and plastic',
			tone: 'dark',
			attack: 'punchy',
			weight: 'heavy',
			texture: 'noisy',
			boost: ['click', 'key', 'tick', 'thump', 'hit'],
			exclude: ['shimmer', 'chime'],
			materials: ['metal', 'plastic'],
			density: 'balanced',
		},
		warm: {
			description: 'Round, soft and full: thumps, taps and paper, wood and cloth',
			tone: 'dark',
			attack: 'soft',
			weight: 'heavy',
			texture: 'clean',
			boost: ['thump', 'tap', 'paper', 'chime', 'swish'],
			exclude: ['glitch', 'zap'],
			materials: ['wood', 'cloth', 'paper'],
			density: 'balanced',
		},
	});

/** The largest score change a personality makes (added to the ranking score; ±0.15 of 1). */
export const PERSONALITY_WEIGHT = 0.15;

export function isSoundPersonality(v: unknown): v is SoundPersonality {
	return typeof v === 'string' && (SOUND_PERSONALITIES as readonly string[]).includes(v);
}

/** +1 at or under `lo`, −1 at or over `hi`, linear in between (in the scale `f`). */
function towardsLow(x: number, lo: number, hi: number, f: (v: number) => number = (v) => v): number {
	const t = clamp((f(x) - f(lo)) / (f(hi) - f(lo)), 0, 1);
	return 1 - 2 * t;
}

/**
 * How well a sound suits a personality, −1…1 (null without a personality): the mean of its Refine preferences (tone by
 * centroid 1 → 3 kHz, attack by rise 10 → 50 ms, weight by the share under 150 Hz 0.05 → 0.3, texture by flatness 0.1 →
 * 0.25, each +1 on the preferred side), a type boost (+1 when one of its types is boosted, else 0) and its materials
 * (+1 naming a preferred one, −0.5 naming only others; not counted when it names none). A sound whose every type the
 * personality excludes scores −1.
 */
export function personalityScore(
	e: {
		types?: readonly unknown[];
		descriptors?: Partial<RankDescriptors> | null;
		materials?: readonly unknown[] | null;
	},
	personality: SoundPersonality | null | undefined,
): number | null {
	if (!personality || !isSoundPersonality(personality)) return null;
	const p = SOUND_PERSONALITY_PROFILES[personality];
	const types = (Array.isArray(e?.types) ? e.types : []).filter(isSoundTypeId);
	if (types.length && types.every((t) => p.exclude.includes(t))) return -1;
	const d = (e?.descriptors ?? {}) as Partial<RankDescriptors>;
	const parts: number[] = [];
	if (p.tone && fin(d.centroidHz) && d.centroidHz > 0) {
		const dark = towardsLow(d.centroidHz, 1000, 3000, Math.log2);
		parts.push(p.tone === 'dark' ? dark : -dark);
	}
	if (p.attack && fin(d.riseMs) && d.riseMs >= 0) {
		const punchy = towardsLow(d.riseMs + 1, 11, 51, Math.log10);
		parts.push(p.attack === 'punchy' ? punchy : -punchy);
	}
	if (p.weight && fin(d.below150Share)) {
		const light = towardsLow(d.below150Share, 0.05, 0.3);
		parts.push(p.weight === 'light' ? light : -light);
	}
	if (p.texture && fin(d.flatness)) {
		const clean = towardsLow(d.flatness, 0.1, 0.25);
		parts.push(p.texture === 'clean' ? clean : -clean);
	}
	parts.push(types.some((t) => p.boost.includes(t)) ? 1 : 0);
	const mats = (Array.isArray(e?.materials) ? e.materials : []).filter(isSoundMaterial);
	if (mats.length) parts.push(mats.some((m) => p.materials.includes(m)) ? 1 : -0.5);
	return round6(parts.reduce((s, v) => s + v, 0) / parts.length);
}

/** The ranking adjustment of a personality: `PERSONALITY_WEIGHT` × its score (null without one). */
export function personalityAdjustment(
	e: Parameters<typeof personalityScore>[0],
	personality: SoundPersonality | null | undefined,
): number | null {
	const s = personalityScore(e, personality);
	return s === null ? null : round6(PERSONALITY_WEIGHT * s);
}

/**
 * A cue's types under a personality: its excluded types left out (unless that leaves none: the cue's request wins),
 * its boosted types first (stable). Without a personality the types as given.
 */
export function styleCueTypes(
	types: readonly SoundTypeId[],
	personality: SoundPersonality | null | undefined,
): SoundTypeId[] {
	const list = [...types];
	if (!personality || !isSoundPersonality(personality)) return list;
	const p = SOUND_PERSONALITY_PROFILES[personality];
	const kept = list.filter((t) => !p.exclude.includes(t));
	const base = kept.length ? kept : list;
	return [...base.filter((t) => p.boost.includes(t)), ...base.filter((t) => !p.boost.includes(t))];
}

/** The density of a pass: the request's, else the personality's default when the request names one, else `fallback`. */
export function personalityDensity(
	personality: SoundPersonality | null | undefined,
	fallback: SoundDensity,
): SoundDensity {
	return personality && isSoundPersonality(personality)
		? SOUND_PERSONALITY_PROFILES[personality].density
		: fallback;
}

// ---------------------------------------------------------------------------------------------------------------
// Palette coherence (materials)

/** The ranking bonus of a sound sharing its family's dominant material (added to the score). */
export const MATERIAL_BONUS = 0.08;

/** The family of a sound's first known type. */
export function familyOfTypes(types: readonly unknown[] | null | undefined): SoundFamily | null {
	for (const t of Array.isArray(types) ? types : []) if (isSoundTypeId(t)) return SOUND_TYPES[t].family;
	return null;
}

export type PaletteMaterials = Partial<Record<SoundFamily, SoundMaterial>>;

/**
 * The dominant material per family of the placed sounds (`placed` in frame order): the material most of them name
 * (ties: the one named first). Sounds without a `materials` field or naming none do not count. Pure.
 */
export function paletteMaterials(placed: readonly PlacedSound[]): PaletteMaterials {
	const counts = new Map<SoundFamily, Map<SoundMaterial, { n: number; first: number }>>();
	placed.forEach((p, i) => {
		if (!p || !Array.isArray(p.materials)) return;
		const fam = familyOfTypes(p.types);
		if (!fam) return;
		let m = counts.get(fam);
		if (!m) counts.set(fam, (m = new Map()));
		for (const mat of new Set(p.materials.filter(isSoundMaterial))) {
			const c = m.get(mat);
			if (c) c.n++;
			else m.set(mat, { n: 1, first: i });
		}
	});
	const out: PaletteMaterials = {};
	for (const [fam, m] of counts) {
		let best: SoundMaterial | null = null;
		let bc = { n: 0, first: Number.POSITIVE_INFINITY };
		for (const mat of SOUND_MATERIALS) {
			const c = m.get(mat);
			if (c && (c.n > bc.n || (c.n === bc.n && c.first < bc.first))) {
				best = mat;
				bc = c;
			}
		}
		if (best) out[fam] = best;
	}
	return out;
}

/**
 * The palette bonus of a sound: `MATERIAL_BONUS` when it names its family's dominant material, 0 when it names others
 * or none, null when its family has no dominant material or it has no `materials` field (the bonus applies only when
 * the field is present).
 */
export function materialBonusOf(
	e: { types?: readonly unknown[]; materials?: readonly unknown[] | null },
	palette: PaletteMaterials | null | undefined,
): number | null {
	if (!palette || !e || !Array.isArray(e.materials)) return null;
	const fam = familyOfTypes(e.types);
	const want = fam ? palette[fam] : undefined;
	if (!want) return null;
	return e.materials.includes(want) ? MATERIAL_BONUS : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Variation cycling ("vary the take, not the pitch")

/** The offered (clean) take ids of a recording entry, in take order. */
export function offeredTakeIds(recording: {
	id: string;
	takes?: readonly { index: number; flags?: readonly unknown[] }[] | null;
}): string[] {
	if (!recording || typeof recording.id !== 'string' || parseTakeId(recording.id)) return [];
	const out: string[] = [];
	for (const t of Array.isArray(recording.takes) ? recording.takes : [])
		if (t && Number.isInteger(t.index) && t.index >= 1 && t.index <= 64 && !(t.flags?.length ?? 0))
			out.push(takeIdOf(recording.id, t.index));
	return out;
}

/**
 * The variation list of a clip (web Next / Previous Variation, MCP swap_sound next / previous): the anchor (the sound
 * first placed), its ring (alternatives), then — when the anchor is a take — its sibling takes, then sounds of the same
 * family, then the nearest descriptors. Deduplicated, valid sound ids only, ≤ 32.
 */
export function variationCycle(parts: {
	anchor: string | null;
	ring?: readonly string[];
	siblings?: readonly string[];
	family?: readonly string[];
	similar?: readonly string[];
}): string[] {
	const out: string[] = [];
	for (const id of [
		parts.anchor,
		...(parts.ring ?? []),
		...(parts.siblings ?? []),
		...(parts.family ?? []),
		...(parts.similar ?? []),
	])
		if (typeof id === 'string' && SOUND_REF_RE.test(id) && !out.includes(id)) out.push(id);
	return out.slice(0, 32);
}
