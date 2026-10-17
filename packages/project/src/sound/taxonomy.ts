// Sound-effect taxonomy (spec 12 §2.1): the 19 effect types plus the two bed types, what each is for (category, UI
// family, default alignment and weight, the visual events it suits, the lengths that fit) and the judge profile its
// sounds are checked against. Pure data and helpers; no DOM, no Node.
//
// The judge itself lives in `@jasper/audio-fx` (`judgeSound`), which this package may not import (ARCHITECTURE §3.1:
// audio-fx depends on project, not the reverse). `SoundTypeProfile` is therefore duplicated here field for field, and
// `packages/audio-fx/test/sound-taxonomy-profiles.test.ts` asserts that these profiles deep-equal audio-fx's
// `DEFAULT_TYPE_PROFILES`, so the two copies cannot drift.

/** The 19 sound-effect types (spec 12 §2.1), in the spec's order. */
export const SOUND_EFFECT_TYPES = [
	'hit',
	'boom',
	'riser',
	'reverse',
	'transition',
	'whoosh',
	'swish',
	'glitch',
	'ui',
	'click',
	'key',
	'tick',
	'tap',
	'pop',
	'thump',
	'paper',
	'chime',
	'shimmer',
	'zap',
] as const;
/** Beds: long backgrounds rather than events. */
export const SOUND_BED_TYPES = ['ambience', 'roomtone'] as const;
/** Every type id: the effect types, then the beds (the same list and order as `@jasper/audio-fx` `SOUND_TYPE_IDS`). */
export const SOUND_TYPE_IDS = [...SOUND_EFFECT_TYPES, ...SOUND_BED_TYPES] as const;
export type SoundTypeId = (typeof SOUND_TYPE_IDS)[number];

const TYPE_SET: ReadonlySet<string> = new Set(SOUND_TYPE_IDS);
export function isSoundTypeId(v: unknown): v is SoundTypeId {
	return typeof v === 'string' && TYPE_SET.has(v);
}

/** What a type does in a mix. */
export type SoundCategory = 'impact' | 'movement' | 'build' | 'interface' | 'texture' | 'tonal' | 'bed';
/** The groups of type chips in the Sound Library panel (spec 12 §2.7). */
export const SOUND_FAMILIES = ['impacts', 'movement', 'digital', 'tactile', 'tonal', 'beds'] as const;
export type SoundFamily = (typeof SOUND_FAMILIES)[number];
/** Which point of the sound lands on the cue (spec 12 §2.3). */
export type SoundAlign = 'peak' | 'start' | 'end';
/** Role of a cue (spec 12 §2.2 `SoundCue.weight`). */
export type SoundWeight = 'hero' | 'support' | 'ambient';
/** Visual events a cue can mark (spec 12 §2.2 `SoundCue.kind`, minus `manual` and `silence`). */
export const VISUAL_KINDS = [
	'cut',
	'transition',
	'move',
	'land',
	'appear',
	'exit',
	'emphasis',
	'reveal',
	'beat',
] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

/**
 * Judge thresholds for one type: the same shape as `@jasper/audio-fx` `SoundTypeProfile` (pass these to `judgeSound`).
 * Plain numbers; `null` = not checked.
 */
export interface SoundTypeProfile {
	/** Shortest acceptable `durationSec`. */
	minDurSec: number;
	/** Longest acceptable `durationSec`. */
	maxDurSec: number;
	/** Slowest acceptable `riseMs`; null = any. */
	maxRiseMs: number | null;
	/** The sound must fall 20 dB below its peak (`decays`). */
	mustDecay: boolean;
	/** Largest acceptable `below150Share` (more is boomy). */
	maxBelow150Share: number;
	/** Largest acceptable `above6kShare` (more is hissy). */
	maxAbove6kShare: number;
	/** Largest acceptable `flatness` (more is noisy); null = any. */
	maxFlatness: number | null;
	/** One onset only (`onsetCount` ≤ 1). */
	singleHit: boolean;
	/** Smallest acceptable `maxMomentaryLufs` (less is quiet). */
	minMaxMomentaryLufs: number;
	/** The type needs air: a band-limit cliff (`cutoffHz`) under 12 kHz in a ≥ 44.1 kHz file is `lowpassed` (P6-E9). */
	needsAir?: boolean;
	/** Loudest acceptable `floorDb` between events (`noisy-floor`, P6-E9); null = not checked. */
	maxFloorDb?: number | null;
}

/**
 * Lengths that fit a type. Without a cue window the ranking prefers sounds near `idealSec` (log distance) and inside
 * `minSec … maxSec`. With a window (a transition's length, a build before a hero), `window` says what must fit it:
 * `lead` = the part before the aligned point (a riser's whole length, a whoosh's run-up to its peak), `span` = the
 * whole sound, `null` = windows do not apply (one-shots).
 */
export interface DurationFit {
	minSec: number;
	idealSec: number;
	maxSec: number;
	window: 'lead' | 'span' | null;
}

export interface SoundTypeInfo {
	id: SoundTypeId;
	category: SoundCategory;
	family: SoundFamily;
	defaultAlign: SoundAlign;
	defaultWeight: SoundWeight;
	/** Visual events the type suits, best first (empty for beds). */
	visualKinds: readonly VisualKind[];
	durationFit: DurationFit;
	profile: SoundTypeProfile;
}

const P = (
	minDurSec: number,
	maxDurSec: number,
	maxRiseMs: number | null,
	mustDecay: boolean,
	maxBelow150Share: number,
	maxAbove6kShare: number,
	maxFlatness: number | null,
	singleHit: boolean,
	minMaxMomentaryLufs: number,
	needsAir: boolean,
	maxFloorDb: number | null,
): SoundTypeProfile =>
	Object.freeze({
		minDurSec,
		maxDurSec,
		maxRiseMs,
		mustDecay,
		maxBelow150Share,
		maxAbove6kShare,
		maxFlatness,
		singleHit,
		minMaxMomentaryLufs,
		needsAir,
		maxFloorDb,
	});

/** The floor between events most one-shot types accept (dBFS; `@jasper/audio-fx` `NOISY_FLOOR_DB`). */
const NOISY_FLOOR_DB = -55;

const D = (minSec: number, idealSec: number, maxSec: number, window: DurationFit['window']): DurationFit =>
	Object.freeze({ minSec, idealSec, maxSec, window });

const T = (
	id: SoundTypeId,
	category: SoundCategory,
	family: SoundFamily,
	defaultAlign: SoundAlign,
	defaultWeight: SoundWeight,
	visualKinds: readonly VisualKind[],
	durationFit: DurationFit,
	profile: SoundTypeProfile,
): SoundTypeInfo =>
	Object.freeze({
		id,
		category,
		family,
		defaultAlign,
		defaultWeight,
		visualKinds: Object.freeze([...visualKinds]),
		durationFit,
		profile,
	});

/**
 * The taxonomy. Profiles are identical to `@jasper/audio-fx` `DEFAULT_TYPE_PROFILES` (reasons for each value in
 * docs/wp-notes/sound-design.md "WP1.1b"); the other fields are decisions recorded in "WP1.1a".
 */
export const SOUND_TYPES: Readonly<Record<SoundTypeId, SoundTypeInfo>> = Object.freeze({
	//                                                                    profile: minDur maxDur rise decay <150 >6k flat single momentary air floor
	hit: T(
		'hit',
		'impact',
		'impacts',
		'peak',
		'hero',
		['land', 'cut', 'emphasis', 'reveal', 'beat'],
		D(0.15, 1.2, 4, null),
		P(0.05, 6, 25, true, 0.6, 0.5, null, true, -40, false, NOISY_FLOOR_DB),
	),
	boom: T(
		'boom',
		'impact',
		'impacts',
		'peak',
		'hero',
		['reveal', 'cut', 'emphasis', 'land'],
		D(0.5, 2.5, 8, null),
		P(0.2, 10, 60, true, 1, 0.25, null, true, -45, false, null),
	),
	riser: T(
		'riser',
		'build',
		'movement',
		'end',
		'support',
		['reveal', 'transition'],
		D(1, 3, 12, 'lead'),
		P(0.5, 30, null, false, 0.6, 0.6, null, false, -45, false, null),
	),
	reverse: T(
		'reverse',
		'build',
		'movement',
		'end',
		'support',
		['transition', 'reveal', 'appear'],
		D(0.4, 1.5, 6, 'lead'),
		P(0.3, 12, null, false, 0.6, 0.6, null, false, -45, false, null),
	),
	transition: T(
		'transition',
		'movement',
		'movement',
		'peak',
		'support',
		['transition', 'cut'],
		D(0.4, 1.5, 6, 'span'),
		P(0.2, 12, null, false, 0.7, 0.6, null, false, -45, false, null),
	),
	whoosh: T(
		'whoosh',
		'movement',
		'movement',
		'peak',
		'support',
		['move', 'transition', 'exit', 'appear'],
		D(0.3, 1, 3, 'lead'),
		P(0.15, 6, null, false, 0.5, 0.7, null, false, -45, false, null),
	),
	swish: T(
		'swish',
		'movement',
		'movement',
		'peak',
		'support',
		['move', 'exit', 'appear', 'transition'],
		D(0.1, 0.35, 1.2, 'lead'),
		P(0.05, 3, null, false, 0.3, 0.85, null, false, -45, true, null),
	),
	glitch: T(
		'glitch',
		'texture',
		'digital',
		'peak',
		'support',
		['cut', 'transition', 'appear', 'exit', 'emphasis'],
		D(0.1, 0.4, 2, 'span'),
		P(0.03, 5, null, false, 0.5, 0.7, null, false, -45, false, null),
	),
	ui: T(
		'ui',
		'interface',
		'digital',
		'start',
		'support',
		['appear', 'emphasis'],
		D(0.03, 0.25, 1, null),
		P(0.01, 2, 30, true, 0.3, 0.6, null, false, -50, false, null),
	),
	click: T(
		'click',
		'interface',
		'digital',
		'peak',
		'support',
		['appear', 'cut', 'beat'],
		D(0.01, 0.08, 0.5, null),
		P(0.002, 1, 6, true, 0.3, 0.85, null, true, -55, true, NOISY_FLOOR_DB),
	),
	key: T(
		'key',
		'interface',
		'tactile',
		'peak',
		'support',
		['appear'],
		D(0.02, 0.12, 0.5, null),
		P(0.005, 1, 10, true, 0.4, 0.7, null, true, -55, true, NOISY_FLOOR_DB),
	),
	tick: T(
		'tick',
		'interface',
		'tactile',
		'peak',
		'support',
		['appear', 'beat'],
		D(0.01, 0.06, 0.4, null),
		P(0.002, 1, 6, true, 0.3, 0.85, null, true, -55, true, NOISY_FLOOR_DB),
	),
	tap: T(
		'tap',
		'impact',
		'tactile',
		'peak',
		'support',
		['land', 'appear', 'beat'],
		D(0.03, 0.25, 1, null),
		P(0.01, 1.5, 12, true, 0.5, 0.6, null, true, -55, true, NOISY_FLOOR_DB),
	),
	pop: T(
		'pop',
		'impact',
		'tactile',
		'peak',
		'support',
		['appear', 'emphasis'],
		D(0.03, 0.15, 0.8, null),
		P(0.01, 1.5, 15, true, 0.5, 0.5, null, true, -50, false, NOISY_FLOOR_DB),
	),
	thump: T(
		'thump',
		'impact',
		'impacts',
		'peak',
		'support',
		['land', 'cut', 'beat', 'emphasis'],
		D(0.1, 0.5, 2, null),
		P(0.05, 3, 25, true, 0.95, 0.25, null, true, -45, false, NOISY_FLOOR_DB),
	),
	paper: T(
		'paper',
		'texture',
		'tactile',
		'peak',
		'support',
		['appear', 'exit', 'move'],
		D(0.15, 0.8, 3, 'span'),
		P(0.05, 6, null, false, 0.3, 0.85, null, false, -50, true, null),
	),
	chime: T(
		'chime',
		'tonal',
		'tonal',
		'peak',
		'support',
		['reveal', 'appear', 'emphasis'],
		D(0.4, 2, 6, null),
		P(0.2, 10, 40, true, 0.3, 0.5, 0.3, false, -45, false, null),
	),
	shimmer: T(
		'shimmer',
		'tonal',
		'tonal',
		'peak',
		'support',
		['reveal', 'appear'],
		D(0.5, 2, 6, 'span'),
		P(0.3, 12, null, false, 0.2, 0.85, 0.5, false, -50, true, null),
	),
	zap: T(
		'zap',
		'interface',
		'digital',
		'peak',
		'support',
		['appear', 'transition', 'emphasis', 'exit'],
		D(0.1, 0.35, 1.5, null),
		P(0.05, 3, 30, false, 0.5, 0.6, null, false, -45, false, null),
	),
	ambience: T(
		'ambience',
		'bed',
		'beds',
		'start',
		'ambient',
		[],
		D(5, 60, 3600, 'span'),
		P(2, 3600, null, false, 0.8, 0.6, null, false, -60, false, null),
	),
	roomtone: T(
		'roomtone',
		'bed',
		'beds',
		'start',
		'ambient',
		[],
		D(5, 30, 3600, 'span'),
		P(2, 3600, null, false, 0.9, 0.6, null, false, -75, false, null),
	),
});

/** The judge profiles by type (the same values as `@jasper/audio-fx` `DEFAULT_TYPE_PROFILES`). */
export const SOUND_TYPE_PROFILES: Readonly<Record<SoundTypeId, SoundTypeProfile>> = Object.freeze(
	Object.fromEntries(SOUND_TYPE_IDS.map((id) => [id, SOUND_TYPES[id].profile])) as Record<
		SoundTypeId,
		SoundTypeProfile
	>,
);

/** Types of a family, in taxonomy order (the chip groups). */
export function typesOfFamily(family: SoundFamily): SoundTypeId[] {
	return SOUND_TYPE_IDS.filter((t) => SOUND_TYPES[t].family === family);
}

/**
 * How well a type suits a visual event, 0…1: 1 for its first (best) kind, 0.1 less per later position (floor 0.6),
 * 0 when the type does not list the kind. Unknown types score 0.
 */
export function typeFitForVisualKind(type: string, kind: VisualKind): number {
	if (!isSoundTypeId(type)) return 0;
	const i = SOUND_TYPES[type].visualKinds.indexOf(kind);
	return i < 0 ? 0 : Math.max(0.6, 1 - 0.1 * i);
}

/** Types that suit a visual event, best first (ties in taxonomy order). */
export function typesForVisualKind(kind: VisualKind): SoundTypeId[] {
	return SOUND_TYPE_IDS.filter((t) => typeFitForVisualKind(t, kind) > 0).sort(
		(a, b) => typeFitForVisualKind(b, kind) - typeFitForVisualKind(a, kind),
	);
}

/**
 * Words (lower-case, single spaces; several words = a phrase) that name a type in folder and file names, titles and
 * search queries. The type ids themselves are included. Deliberately left out: words that are too ambiguous on their
 * own (`drop`, `type`, `build`, `app`, `select`, `error`); `sweep` is kept (libraries use it for transition passes).
 */
export const TYPE_SYNONYMS: Readonly<Record<string, SoundTypeId>> = Object.freeze({
	// impacts
	hit: 'hit',
	hits: 'hit',
	impact: 'hit',
	impacts: 'hit',
	strike: 'hit',
	smash: 'hit',
	slam: 'hit',
	'door slam': 'hit',
	punch: 'hit',
	bang: 'hit',
	crash: 'hit',
	clang: 'hit',
	knockout: 'hit',
	stinger: 'hit',
	'cinematic hit': 'hit',
	boom: 'boom',
	booms: 'boom',
	'sub drop': 'boom',
	subdrop: 'boom',
	'bass drop': 'boom',
	'sub boom': 'boom',
	'low boom': 'boom',
	braam: 'boom',
	brahm: 'boom',
	explosion: 'boom',
	explosions: 'boom',
	blast: 'boom',
	rumble: 'boom',
	thump: 'thump',
	thumps: 'thump',
	thud: 'thump',
	thuds: 'thump',
	'body fall': 'thump',
	bodyfall: 'thump',
	kick: 'thump',
	'low hit': 'thump',
	// builds and movement
	riser: 'riser',
	risers: 'riser',
	rise: 'riser',
	rising: 'riser',
	uplifter: 'riser',
	uplift: 'riser',
	'build up': 'riser',
	buildup: 'riser',
	tension: 'riser',
	swell: 'riser',
	crescendo: 'riser',
	reverse: 'reverse',
	reversed: 'reverse',
	reverses: 'reverse',
	backwards: 'reverse',
	'suck back': 'reverse',
	suckback: 'reverse',
	'reverse cymbal': 'reverse',
	'rev cymbal': 'reverse',
	inhale: 'reverse',
	transition: 'transition',
	transitions: 'transition',
	trans: 'transition',
	sweep: 'transition',
	sweeps: 'transition',
	'scene change': 'transition',
	whoosh: 'whoosh',
	whooshes: 'whoosh',
	woosh: 'whoosh',
	wooshes: 'whoosh',
	swoosh: 'whoosh',
	swooshes: 'whoosh',
	wush: 'whoosh',
	'pass by': 'whoosh',
	passby: 'whoosh',
	'fly by': 'whoosh',
	flyby: 'whoosh',
	'air pass': 'whoosh',
	swoop: 'whoosh',
	swish: 'swish',
	swishes: 'swish',
	swipe: 'swish',
	swipes: 'swish',
	swing: 'swish',
	flick: 'swish',
	'whip pan': 'swish',
	whip: 'swish',
	slide: 'swish',
	// digital
	glitch: 'glitch',
	glitches: 'glitch',
	glitchy: 'glitch',
	stutter: 'glitch',
	bitcrush: 'glitch',
	'bit crush': 'glitch',
	'data corrupt': 'glitch',
	corrupt: 'glitch',
	malfunction: 'glitch',
	'digital error': 'glitch',
	ui: 'ui',
	'user interface': 'ui',
	interface: 'ui',
	button: 'ui',
	buttons: 'ui',
	menu: 'ui',
	menus: 'ui',
	notification: 'ui',
	notifications: 'ui',
	notify: 'ui',
	alert: 'ui',
	alerts: 'ui',
	beep: 'ui',
	beeps: 'ui',
	blip: 'ui',
	blips: 'ui',
	confirm: 'ui',
	confirmation: 'ui',
	cancel: 'ui',
	hover: 'ui',
	click: 'click',
	clicks: 'click',
	'mouse click': 'click',
	mouse: 'click',
	switch: 'click',
	toggle: 'click',
	latch: 'click',
	zap: 'zap',
	zaps: 'zap',
	laser: 'zap',
	lasers: 'zap',
	electric: 'zap',
	electricity: 'zap',
	spark: 'zap',
	sparks: 'zap',
	shock: 'zap',
	taser: 'zap',
	'force field': 'zap',
	// tactile
	key: 'key',
	keys: 'key',
	keyboard: 'key',
	typing: 'key',
	typewriter: 'key',
	keystroke: 'key',
	keystrokes: 'key',
	keypress: 'key',
	'key press': 'key',
	tick: 'tick',
	ticks: 'tick',
	ticking: 'tick',
	clock: 'tick',
	metronome: 'tick',
	'tick tock': 'tick',
	tap: 'tap',
	taps: 'tap',
	knock: 'tap',
	knocks: 'tap',
	'finger tap': 'tap',
	'table tap': 'tap',
	pop: 'pop',
	pops: 'pop',
	bubble: 'pop',
	bubbles: 'pop',
	cork: 'pop',
	plop: 'pop',
	bloop: 'pop',
	blop: 'pop',
	paper: 'paper',
	papers: 'paper',
	page: 'paper',
	'page turn': 'paper',
	'page flip': 'paper',
	crumple: 'paper',
	crinkle: 'paper',
	rustle: 'paper',
	cardboard: 'paper',
	envelope: 'paper',
	// tonal
	chime: 'chime',
	chimes: 'chime',
	bell: 'chime',
	bells: 'chime',
	ding: 'chime',
	dings: 'chime',
	glockenspiel: 'chime',
	'music box': 'chime',
	celesta: 'chime',
	shimmer: 'shimmer',
	shimmers: 'shimmer',
	sparkle: 'shimmer',
	sparkles: 'shimmer',
	twinkle: 'shimmer',
	glimmer: 'shimmer',
	glitter: 'shimmer',
	magic: 'shimmer',
	fairy: 'shimmer',
	// beds
	ambience: 'ambience',
	ambiences: 'ambience',
	ambiance: 'ambience',
	ambient: 'ambience',
	amb: 'ambience',
	atmosphere: 'ambience',
	atmos: 'ambience',
	atmo: 'ambience',
	background: 'ambience',
	soundscape: 'ambience',
	'room tone': 'roomtone',
	roomtone: 'roomtone',
	'room noise': 'roomtone',
	'noise floor': 'roomtone',
	presence: 'roomtone',
	'air tone': 'roomtone',
});

/** The type a synonym phrase names, or undefined (own properties only: `constructor`, `__proto__` name nothing). */
export function synonymType(phrase: unknown): SoundTypeId | undefined {
	return typeof phrase === 'string' && Object.hasOwn(TYPE_SYNONYMS, phrase)
		? TYPE_SYNONYMS[phrase]
		: undefined;
}

/** Synonym phrases by their word count, longest first (phrases win over their single words). */
const SYNONYM_PHRASES: readonly [string[], SoundTypeId][] = Object.entries(TYPE_SYNONYMS)
	.map(([k, v]) => [k.split(' '), v] as [string[], SoundTypeId])
	.sort((a, b) => b[0].length - a[0].length || a[0].join(' ').localeCompare(b[0].join(' ')));

/** Indices into SYNONYM_PHRASES (ascending) by the phrase's first word: only phrases whose first word occurs can match. */
const PHRASES_BY_FIRST_WORD: ReadonlyMap<string, readonly number[]> = (() => {
	const m = new Map<string, number[]>();
	SYNONYM_PHRASES.forEach(([words], i) => {
		const first = words[0]!;
		const list = m.get(first);
		if (list) list.push(i);
		else m.set(first, [i]);
	});
	return m;
})();

/**
 * Splits text into lower-case word tokens: diacritics folded, camelCase and letter/digit boundaries split, everything
 * that is not a letter or digit a separator. Pure and total (any string; at most 256 tokens).
 */
export function tokenizeSoundText(text: string): string[] {
	if (typeof text !== 'string' || text.length === 0) return [];
	const s = text
		.slice(0, 4096)
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Za-z])(\d)/g, '$1 $2')
		.replace(/(\d)([A-Za-z])/g, '$1 $2')
		.toLowerCase();
	const out: string[] = [];
	for (const t of s.split(/[^\p{L}\p{N}]+/u)) {
		if (t) out.push(t);
		if (out.length >= 256) break;
	}
	return out;
}

/**
 * Types named by a list of tokens, in order of appearance: phrases (`sub drop`) are matched before single words and
 * consume them. Pure.
 */
export function typesInTokens(tokens: readonly string[]): SoundTypeId[] {
	// The phrases that can match (their first word occurs), in SYNONYM_PHRASES order: the same greedy claims as
	// trying every phrase, without looping over the ~200 phrases for every call.
	const candidates: number[] = [];
	const seen = new Set<string>();
	for (const t of tokens) {
		if (typeof t !== 'string' || seen.has(t)) continue;
		seen.add(t);
		const list = PHRASES_BY_FIRST_WORD.get(t);
		if (list) for (const i of list) candidates.push(i);
	}
	if (candidates.length === 0) return [];
	candidates.sort((a, b) => a - b);
	const used = new Array<boolean>(tokens.length).fill(false);
	const hits: [number, SoundTypeId][] = [];
	for (const c of candidates) {
		const [words, type] = SYNONYM_PHRASES[c]!;
		for (let i = 0; i + words.length <= tokens.length; i++) {
			let ok = true;
			for (let j = 0; j < words.length; j++)
				if (used[i + j] || tokens[i + j] !== words[j]) {
					ok = false;
					break;
				}
			if (!ok) continue;
			for (let j = 0; j < words.length; j++) used[i + j] = true;
			hits.push([i, type]);
		}
	}
	hits.sort((a, b) => a[0] - b[0]);
	const out: SoundTypeId[] = [];
	for (const [, t] of hits) if (!out.includes(t)) out.push(t);
	return out;
}

/** At most this many types are inferred from a name. */
export const MAX_INFERRED_TYPES = 4;

/**
 * Types a file's path suggests (folder indexing, spec 12 §2.1 `TYPE_SYNONYMS`): the file name first (without its
 * extension), then its folders from the deepest up; at most {@link MAX_INFERRED_TYPES}. Accepts `/` and `\`
 * separators. Pure; never throws.
 */
export function inferTypesFromName(path: string): SoundTypeId[] {
	if (typeof path !== 'string' || !path) return [];
	const parts = path
		.slice(-4096)
		.split(/[\\/]+/)
		.filter(Boolean);
	if (parts.length === 0) return [];
	const file = parts[parts.length - 1]!.replace(/\.[A-Za-z0-9]{1,5}$/, '');
	const segments = [file, ...parts.slice(0, -1).reverse()];
	const out: SoundTypeId[] = [];
	for (const seg of segments) {
		for (const t of typesInTokens(tokenizeSoundText(seg))) {
			if (!out.includes(t)) out.push(t);
			if (out.length >= MAX_INFERRED_TYPES) return out;
		}
	}
	return out;
}
