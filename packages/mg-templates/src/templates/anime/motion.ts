// Sound-design motion of the anime templates (spec 12 §2.2; wp-note "Phase 6 → WP6.5b", item 16): where an anime
// template's intro settles and its outro starts, measured on its own animation — like the fframes templates'
// `svgTemplateSpeed` — so their land / exit cues sit on the frame the picture lands / leaves (± 1), not on the declared
// `introFrames` / `outroFrames` (1–3 frames late: the eases' tails come to rest before the window ends).
//
// This package may not import anime.js (ARCHITECTURE §3.1); the React implementations in `@jasper/motion/templates`
// may. So the timing lives HERE and both sides use it: the phases (`*_PHASES`, `phaseTimes`) and the text units the
// implementations build their timelines from are exported from this package, and the model below evaluates the same
// tweens with the anime.js ease curves (`eases.ts`). @jasper/motion's tests seek the real anime.js timelines and
// check the model's values at every frame of every template, at several rates and lengths.
//
// The model of a template: its animated values as tracks (one property of one target, its tweens in time order), each
// with how one unit shows on screen at the template's layout — design pixels (`px`: a translate, a radius, a drawn
// length, a wipe), an opacity, or a scale factor — and, for the counter, the displayed number. The picture speed of a
// frame is the largest change of any value from the frame before, in the units of the keyframed-clip sampler
// (`svgTemplateSpeed`'s rule: px ÷ canvas diagonal, K_OPACITY · Δopacity, K_SCALE · |Δ ln scale|, per second); a new
// displayed number counts as TEXT_CHANGE_SPEED.
import { K_SCALE, MAX_SAMPLES_PER_CLIP, type MgTemplateMotionTiming } from '@jasper/project';
import { CANVASES, estimateTextWidth, fitCanvas } from '../../core.ts';
import { K_OPACITY } from '../../motion.ts';
import { formatCount, socialCommentParamsSchema } from '../../social/index.ts';
import { needsShaping, segmentText } from '../../text-units.ts';
import type { AnyAnimeMgTemplate } from '../../types.ts';
import { calloutParams } from './callout.ts';
import { counterParams, formatCounterValue } from './counter.ts';
import { animeEase, animeTemplateEaseName, easeFunction } from './eases.ts';
import { lowerThirdAnimParams } from './lower-third-anim.ts';
import {
	SOCIAL_CARD_REF_WIDTH,
	socialCardScale,
	socialCommentSchedule,
	socialCommentSegments,
	socialLikesTick,
	socialTickCount,
} from './social-comment.ts';
import { animeTemplateTiming } from './timing.ts';
import { titleRevealParams } from './title-reveal.ts';

// ------------------------------------------------------------------------------------------------ phases (shared)

/** Timing every template build receives (ms of content time; see `animeTemplateTiming`). */
export type TemplateTiming = { totalMs: number; introMs: number; outroMs: number };

export type Phase = {
	/** Start and length as fractions of the intro window (the outro mirrors them inside its own window). */
	at: number;
	dur: number;
	ease?: string;
	/** Outro ease (default `in`: the mirror of an `out`-type intro). */
	outEase?: string;
};

/** Shortest tween (anime.js 4.5.0 mishandles zero-duration tweens, R-ANM §7 #1013). */
export const ANIME_MIN_TWEEN_MS = 1;

/**
 * Where a phase lands on the content timeline: the intro tween at `at·introMs` for `dur·introMs`; the outro tween
 * mirrored inside the outro window (`outroStart` null when the template has no outro), never before the intro tween
 * ends (one property is never driven by two overlapping tweens, S11:ANM-008).
 */
export function phaseTimes(
	t: TemplateTiming,
	phase: Pick<Phase, 'at' | 'dur'>,
): { introStart: number; introDur: number; outroStart: number | null; outroDur: number } {
	const introStart = Math.max(0, Math.min(phase.at * t.introMs, Math.max(0, t.introMs)));
	const introDur = Math.max(ANIME_MIN_TWEEN_MS, phase.dur * t.introMs);
	const outroDur = Math.max(ANIME_MIN_TWEEN_MS, phase.dur * t.outroMs);
	if (t.outroMs <= 0) return { introStart, introDur, outroStart: null, outroDur };
	const window = Math.max(introStart + introDur, t.totalMs - t.outroMs);
	const outroStart = Math.max(window, window + (1 - phase.at - phase.dur) * t.outroMs);
	return { introStart, introDur, outroStart, outroDur };
}

/** title-reveal@1: the characters use the first 75 % of the intro; subtitle and underline follow. */
export const TITLE_REVEAL_PHASES = {
	charWindow: 0.75,
	subtitle: { at: 0.35, dur: 0.55 },
	underline: { at: 0.45, dur: 0.55, ease: 'inOut', outEase: 'inOut' },
} as const;

/** title-reveal@1 character phases: each lasts `dur`, their starts spread over the rest of the window by rank. */
export function titleRevealCharPhase(stagger: number): { dur: number; spread: number } {
	const s = Math.min(1, Math.max(0, stagger));
	const dur = TITLE_REVEAL_PHASES.charWindow * (1 - 0.75 * s);
	return { dur, spread: TITLE_REVEAL_PHASES.charWindow - dur };
}

/** lower-third-anim@1: the bar grows, the panel wipes open, the name and role words stagger in. */
export const LOWER_THIRD_ANIM_PHASES = {
	bar: { at: 0, dur: 0.3, ease: 'outExpo', outEase: 'inExpo' },
	panel: { at: 0.15, dur: 0.5, outEase: 'inOut' },
	names: { from: 0.35, to: 0.85 },
	roles: { from: 0.5, to: 1 },
	wordDur: 0.35,
} as const;

/** Phase of word `i` of `n` staggered over `[from, to]` of the intro (lower-third-anim@1). */
export function lowerThirdWordPhase(
	i: number,
	n: number,
	from: number,
	to: number,
): { at: number; dur: number } {
	const dur = Math.min(LOWER_THIRD_ANIM_PHASES.wordDur, to - from);
	return { at: n > 1 ? from + (i / (n - 1)) * (to - from - dur) : from, dur };
}

/** lower-third-anim@1: the bar's width (design px). */
export const LOWER_THIRD_ANIM_BAR_W = 10;

/** callout@1: dot pop, pulse ring, leader line (and the label's motion path in the same window), label box. */
export const CALLOUT_PHASES = {
	dot: { at: 0, dur: 0.25, ease: 'outBack', outEase: 'in' },
	/** The pulse ring grows (and fades out) in this phase; it fades in from content 0 up to its start. */
	pulse: { at: 0.08, dur: 0.45, ease: 'out' },
	/** The phase of the leader line draw-on (the label's motion path runs in the same window). */
	line: { at: 0.2, dur: 0.5, outEase: 'inOut' },
	labelWithPath: { at: 0.2, dur: 0.2, ease: 'out' },
	label: { at: 0.68, dur: 0.32, ease: 'outBack' },
} as const satisfies Record<string, Phase>;

/** counter@1: the number and its label fade / rise in (the count runs on its own timeline). */
export const COUNTER_PHASES = {
	number: { at: 0, dur: 0.3, ease: 'out' },
	label: { at: 0.15, dur: 0.35, ease: 'out' },
} as const satisfies Record<string, Phase>;

/** counter@1 count length: `countSeconds`, at most up to the outro (and at least 1 ms). */
export function counterCountMs(p: { countSeconds: number }, t: TemplateTiming): number {
	return Math.max(1, Math.min(p.countSeconds * 1000, t.totalMs - t.outroMs));
}

type Pt = { x: number; y: number };

/** callout@1's leader line from the target to the label anchor (design px), arc-length parametrised. */
export function calloutGeometry(
	p: { targetX: number; targetY: number; labelX: number; labelY: number; path: 'straight' | 'curve' },
	size: { w: number; h: number },
	round: (n: number) => number = (n) => n,
) {
	const a: Pt = { x: p.targetX * size.w, y: p.targetY * size.h };
	const b: Pt = { x: p.labelX * size.w, y: p.labelY * size.h };
	const c: Pt | null = p.path === 'curve' ? { x: a.x, y: b.y } : null;
	const d = c
		? `M ${round(a.x)} ${round(a.y)} Q ${round(c.x)} ${round(c.y)} ${round(b.x)} ${round(b.y)}`
		: `M ${round(a.x)} ${round(a.y)} L ${round(b.x)} ${round(b.y)}`;
	const at = (t: number): Pt => {
		if (!c) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		const u = 1 - t;
		return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
	};
	// Arc-length table (64 segments) so the motion path moves at the line's drawing speed.
	const N = 64;
	const lengths = [0];
	let prev = at(0);
	for (let i = 1; i <= N; i++) {
		const q = at(i / N);
		lengths.push(lengths[i - 1]! + Math.hypot(q.x - prev.x, q.y - prev.y));
		prev = q;
	}
	const total = lengths[N]!;
	/** The point at fraction `f` (0…1) of the length. */
	const pointAt = (f: number): Pt => {
		const target = Math.min(1, Math.max(0, f)) * total;
		let i = 1;
		while (i < N && lengths[i]! < target) i++;
		const l0 = lengths[i - 1]!;
		const l1 = lengths[i]!;
		const k = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
		return at((i - 1 + k) / N);
	};
	return { a, b, d, length: total, pointAt };
}

// ------------------------------------------------------------------------------------------------------- model

/** One tween of a value: from `from` to `to` over `[start, start + dur)` ms of content time, eased. */
export type AnimeTween = { start: number; dur: number; from: number; to: number; ease: string };

/**
 * One animated value (a property of one target of the template's timeline: `target` / `prop` name the anime.js
 * target it mirrors), its tweens in time order (never overlapping), and how a unit of it shows on screen.
 */
export type AnimeTrack = {
	target: number;
	prop: string;
	initial: number;
	tweens: AnimeTween[];
	/** `px`: design px per unit (`perUnit`); `point`: a position along a path (`pointAt`); opacity; scale factor. */
	show:
		| { kind: 'px'; perUnit: number; clamp01?: boolean }
		| { kind: 'point'; pointAt: (v: number) => Pt }
		| { kind: 'opacity' }
		| { kind: 'scale' };
};

export type AnimeMotionModel = {
	/** The timeline the model follows (`anime/timing.ts`): content length and the intro / outro windows in ms. */
	timing: TemplateTiming;
	tracks: AnimeTrack[];
	/** The text the template shows at a content time, when it changes (the counter's number); null otherwise. */
	textAt: ((ms: number) => string) | null;
	/** Design px → canvas px. */
	scale: number;
	canvas: { width: number; height: number };
};

/** anime.js hands the values to React rounded to 1e-6 (`roundValue` of @jasper/motion `useAnimeValues`). */
const round6 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 + 0 : v);

/** The value of a track at content time `ms` (anime.js seek semantics: before a tween its from-value holds). */
export function trackValueAt(track: Pick<AnimeTrack, 'initial' | 'tweens'>, ms: number): number {
	let v = track.initial;
	for (const tw of track.tweens) {
		if (ms < tw.start) break;
		const p = tw.dur > 0 ? (ms - tw.start) / tw.dur : 1;
		v = p >= 1 ? tw.to : tw.from + (tw.to - tw.from) * easeFunction(tw.ease)(Math.max(0, p));
	}
	return round6(v);
}

/** Intro tween + mirrored outro tween of one value (`addInOut` of @jasper/motion). */
function inOut(
	t: TemplateTiming,
	phase: Phase,
	from: number,
	to: number,
	opts: { outro?: boolean } = {},
): AnimeTween[] {
	const pt = phaseTimes(t, phase);
	const out: AnimeTween[] = [{ start: pt.introStart, dur: pt.introDur, from, to, ease: phase.ease ?? 'out' }];
	if (opts.outro !== false && pt.outroStart !== null)
		out.push({ start: pt.outroStart, dur: pt.outroDur, from: to, to: from, ease: phase.outEase ?? 'in' });
	return out;
}

/** Ranks of the units in the stagger order (title-reveal@1; `staggerRanks` of @jasper/motion): forward / centre. */
function forwardOrCentreStarts(n: number, order: string, spread: number): number[] | null {
	if (order === 'random') return null; // a seeded permutation: the set of starts is the same, see below
	const perm = Array.from({ length: n }, (_, i) => i);
	if (order === 'center') {
		const mid = (n - 1) / 2;
		perm.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
	}
	const at = new Array<number>(n);
	perm.forEach((unit, rank) => {
		at[unit] = n > 1 ? (rank / (n - 1)) * spread : 0;
	});
	return at;
}

function titleRevealModel(
	params: unknown,
	t: TemplateTiming,
): Omit<AnimeMotionModel, 'scale' | 'canvas' | 'timing'> {
	const p = titleRevealParams.parse(params);
	const segs = segmentText(p.title, needsShaping(p.title) ? 'word' : 'char');
	const n = segs.filter((s) => !s.space).length;
	const ease = animeTemplateEaseName(p.ease);
	const { dur, spread } = titleRevealCharPhase(p.stagger);
	// The speed is a maximum over the units, so their order does not matter (a random order has the same starts).
	const starts =
		forwardOrCentreStarts(n, p.order, spread) ??
		Array.from({ length: n }, (_, r) => (n > 1 ? (r / (n - 1)) * spread : 0));
	const size = p.titleSize;
	const subSize = size * 0.4;
	const fit = fitCanvas(CANVASES[0]!.width, CANVASES[0]!.height);
	const textW = fit.designW - fit.designW * 0.08 * 2;
	const lineW = Math.min(textW, Math.max(size, estimateTextWidth(p.title, size, 700) * 0.6));
	const tracks: AnimeTrack[] = [];
	starts.forEach((at, i) => {
		const phase: Phase = { at, dur, ease, outEase: 'in' };
		tracks.push(
			{ target: i, prop: 'o', initial: 0, tweens: inOut(t, phase, 0, 1), show: { kind: 'opacity' } },
			{
				target: i,
				prop: 'y',
				initial: 0.5,
				tweens: inOut(t, phase, 0.5, 0),
				show: { kind: 'px', perUnit: size },
			},
		);
	});
	const sub: Phase = { ...TITLE_REVEAL_PHASES.subtitle, ease };
	if (p.subtitle)
		tracks.push(
			{ target: n, prop: 'o', initial: 0, tweens: inOut(t, sub, 0, 1), show: { kind: 'opacity' } },
			{
				target: n,
				prop: 'y',
				initial: 0.6,
				tweens: inOut(t, sub, 0.6, 0),
				show: { kind: 'px', perUnit: subSize },
			},
		);
	if (p.underline)
		tracks.push({
			target: n + 1,
			prop: 'd',
			initial: 0,
			tweens: inOut(t, TITLE_REVEAL_PHASES.underline, 0, 1),
			show: { kind: 'px', perUnit: lineW },
		});
	return { tracks, textAt: null };
}

function lowerThirdAnimModel(
	params: unknown,
	t: TemplateTiming,
): Omit<AnimeMotionModel, 'scale' | 'canvas' | 'timing'> {
	const p = lowerThirdAnimParams.parse(params);
	const ease = animeTemplateEaseName(p.ease);
	const names = segmentText(p.name, 'word').filter((s) => !s.space).length;
	const roles = segmentText(p.role, 'word').filter((s) => !s.space).length;
	const nameSize = p.nameSize;
	const roleSize = nameSize * 0.55;
	const padX = nameSize * 0.6;
	const textW = Math.max(
		estimateTextWidth(p.name, nameSize, 700),
		p.role ? estimateTextWidth(p.role, roleSize, 400) : 0,
	);
	const panelW = textW + padX * 2;
	const P = LOWER_THIRD_ANIM_PHASES;
	const tracks: AnimeTrack[] = [
		{ target: 0, prop: 's', initial: 0, tweens: inOut(t, P.bar, 0, 1), show: { kind: 'scale' } },
		{
			target: 1,
			prop: 'w',
			initial: 0,
			tweens: inOut(t, { ...P.panel, ease }, 0, 1),
			// the wipe is drawn clamped to 0…1 (an overshooting ease does not open it further)
			show: { kind: 'px', perUnit: panelW, clamp01: true },
		},
	];
	const words = (offset: number, n: number, from: number, to: number) => {
		for (let i = 0; i < n; i++) {
			const phase: Phase = { ...lowerThirdWordPhase(i, n, from, to), ease, outEase: 'in' };
			tracks.push(
				{
					target: offset + i,
					prop: 'o',
					initial: 0,
					tweens: inOut(t, phase, 0, 1),
					show: { kind: 'opacity' },
				},
				{
					target: offset + i,
					prop: 'x',
					initial: -24,
					tweens: inOut(t, phase, -24, 0),
					show: { kind: 'px', perUnit: 1 },
				},
			);
		}
	};
	words(2, names, P.names.from, P.names.to);
	// the role words are drawn only with a role (an empty role has no words)
	words(2 + names, roles, P.roles.from, P.roles.to);
	return { tracks, textAt: null };
}

function calloutModel(
	params: unknown,
	t: TemplateTiming,
): Omit<AnimeMotionModel, 'scale' | 'canvas' | 'timing'> {
	const p = calloutParams.parse(params);
	const ease = animeTemplateEaseName(p.ease);
	const fit = fitCanvas(CANVASES[0]!.width, CANVASES[0]!.height);
	const geo = calloutGeometry(p, { w: fit.designW, h: fit.designH });
	const dotR = p.dotSize / 2;
	const C = CALLOUT_PHASES;
	const pulse = phaseTimes(t, C.pulse);
	const fadeIn = Math.max(1, pulse.introStart);
	const tracks: AnimeTrack[] = [
		{ target: 0, prop: 's', initial: 0, tweens: inOut(t, C.dot, 0, 1), show: { kind: 'px', perUnit: dotR } },
		{
			target: 1,
			prop: 'o',
			initial: 0,
			tweens: [
				{ start: 0, dur: fadeIn, from: 0, to: 0.8, ease: 'out' },
				{ start: fadeIn, dur: pulse.introDur, from: 0.8, to: 0, ease: 'out' },
			],
			show: { kind: 'opacity' },
		},
		{
			target: 1,
			prop: 's',
			initial: 1,
			tweens: inOut(t, C.pulse, 1, 2.6, { outro: false }),
			show: { kind: 'px', perUnit: dotR },
		},
	];
	if (p.motionPath) {
		tracks.push(
			{
				target: 2,
				prop: 'm',
				initial: 0,
				tweens: inOut(t, { ...C.line, ease }, 0, 1, { outro: false }),
				show: { kind: 'point', pointAt: geo.pointAt },
			},
			{
				target: 2,
				prop: 'o',
				initial: 0,
				tweens: inOut(t, C.labelWithPath, 0, 1),
				show: { kind: 'opacity' },
			},
			{
				target: 2,
				prop: 's',
				initial: 0.85,
				tweens: inOut(t, C.labelWithPath, 0.85, 1),
				show: { kind: 'scale' },
			},
		);
	} else {
		tracks.push(
			{ target: 2, prop: 'o', initial: 0, tweens: inOut(t, C.label, 0, 1), show: { kind: 'opacity' } },
			{ target: 2, prop: 's', initial: 0.85, tweens: inOut(t, C.label, 0.85, 1), show: { kind: 'scale' } },
		);
	}
	// the leader line: drawn on (its end 0 → 1), undrawn from its start in the outro (the drawn length shrinks)
	const line = phaseTimes(t, C.line);
	tracks.push({
		target: 3,
		prop: 'draw',
		initial: 0,
		tweens: [
			{ start: line.introStart, dur: line.introDur, from: 0, to: 1, ease },
			...(line.outroStart !== null
				? [{ start: line.outroStart, dur: line.outroDur, from: 1, to: 0, ease: 'inOut' }]
				: []),
		],
		show: { kind: 'px', perUnit: geo.length },
	});
	return { tracks, textAt: null };
}

function counterModel(
	params: unknown,
	t: TemplateTiming,
): Omit<AnimeMotionModel, 'scale' | 'canvas' | 'timing'> {
	const p = counterParams.parse(params);
	const ease = animeTemplateEaseName(p.ease);
	const tracks: AnimeTrack[] = [
		{
			target: 0,
			prop: 'o',
			initial: 0,
			tweens: inOut(t, COUNTER_PHASES.number, 0, 1),
			show: { kind: 'opacity' },
		},
		{
			target: 0,
			prop: 'y',
			initial: 0.25,
			tweens: inOut(t, COUNTER_PHASES.number, 0.25, 0),
			show: { kind: 'px', perUnit: p.size },
		},
	];
	if (p.label)
		tracks.push(
			{
				target: 1,
				prop: 'o',
				initial: 0,
				tweens: inOut(t, COUNTER_PHASES.label, 0, 1),
				show: { kind: 'opacity' },
			},
			{
				target: 1,
				prop: 'y',
				initial: 0.4,
				tweens: inOut(t, COUNTER_PHASES.label, 0.4, 0),
				show: { kind: 'px', perUnit: p.size * 0.3 },
			},
		);
	const countMs = counterCountMs(p, t);
	const fn = animeEase(ease);
	const textAt = (ms: number) => {
		const raw = ms <= 0 ? 0 : ms >= countMs ? 1 : fn(ms / countMs);
		const r = round6(raw);
		const progress = r === 0 || r === 1 ? r : raw;
		const value = progress === 0 ? p.from : progress === 1 ? p.to : p.from + (p.to - p.from) * progress;
		return formatCounterValue(value, p);
	};
	return { tracks, textAt };
}

/**
 * social-comment@1: the schedule the implementation builds its timeline from (`socialCommentSchedule`). The card's
 * scale and opacity show as such, its drop in design px, its tilt as the arc its far corner travels (a nominal card of
 * 420 × 160 reference px at the 16:9 card scale); a word's or the heart's scale as px of a nominal word / heart size.
 * The like tick is the displayed count (`textAt`), formatted the way the variant shows it.
 */
function socialCommentModel(
	params: unknown,
	t: TemplateTiming,
): Omit<AnimeMotionModel, 'scale' | 'canvas' | 'timing'> {
	const p = socialCommentParamsSchema.parse(params);
	const units = p.wordReveal ? socialCommentSegments(p.text, p.variant).units : 0;
	const s = socialCommentSchedule({ ...t, entrance: p.entrance, units, tick: socialLikesTick(p) });
	const k = socialCardScale(CANVASES[0]!);
	const cornerArc = (Math.hypot(SOCIAL_CARD_REF_WIDTH, 160) * k * Math.PI) / 180;
	const tracks: AnimeTrack[] = s.tracks.map((tr) => {
		let show: AnimeTrack['show'];
		if (tr.prop === 'o' || tr.prop === 'f') show = { kind: 'opacity' };
		else if (tr.target === 0)
			show = tr.prop === 's' ? { kind: 'scale' } : { kind: 'px', perUnit: tr.prop === 'r' ? cornerArc : 1 };
		else show = { kind: 'px', perUnit: (tr.target === s.heartTarget ? 20 : 24) * k };
		return { ...tr, show };
	});
	const tick = s.tick;
	let textAt: AnimeMotionModel['textAt'] = null;
	if (tick) {
		const fn = easeFunction(tick.ease);
		textAt = (ms: number) => {
			const raw = ms <= tick.start ? 0 : ms >= tick.start + tick.dur ? 1 : fn((ms - tick.start) / tick.dur);
			const r = round6(raw);
			return formatCount(p.variant, socialTickCount(p.likes, r === 0 || r === 1 ? r : raw), 'likes');
		};
	}
	return { tracks, textAt };
}

const MODELS: Record<
	string,
	(params: unknown, t: TemplateTiming) => Omit<AnimeMotionModel, 'scale' | 'canvas' | 'timing'>
> = {
	'title-reveal@1': titleRevealModel,
	'lower-third-anim@1': lowerThirdAnimModel,
	'callout@1': calloutModel,
	'counter@1': counterModel,
	'social-comment@1': socialCommentModel,
};

/** Whether a model exists for an anime template (every shipped one). */
export function hasAnimeMotionModel(def: Pick<AnyAnimeMgTemplate, 'id' | 'version'>): boolean {
	return Object.hasOwn(MODELS, `${def.id}@${def.version}`);
}

/**
 * The motion model of an anime template clip (content `timing.totalFrames` at `timing.fps`), on the default
 * 1920×1080 canvas; null for unknown templates or params its schema rejects.
 */
export function animeMotionModel(
	def: Pick<AnyAnimeMgTemplate, 'id' | 'version' | 'introFrames' | 'outroFrames'>,
	params: unknown,
	timing: MgTemplateMotionTiming,
): AnimeMotionModel | null {
	const build = MODELS[`${def.id}@${def.version}`];
	if (!build || !(timing.fps > 0) || !Number.isFinite(timing.fps)) return null;
	const total = Math.max(1, Math.round(timing.totalFrames));
	const at = animeTemplateTiming(def, {
		fps: timing.fps,
		localFrame: 0,
		durationFrames: total,
		sourceInFrames: 0,
	});
	const t: TemplateTiming = { totalMs: at.totalMs, introMs: at.introMs, outroMs: at.outroMs };
	let m: ReturnType<typeof build>;
	try {
		m = build(params ?? {}, t);
	} catch {
		return null;
	}
	const canvas = CANVASES[0]!;
	return { ...m, timing: t, scale: fitCanvas(canvas.width, canvas.height).scale, canvas };
}

/** A new displayed number (the counter) moves like this many canvas diagonals per second (above MOVE_ON 0.12). */
export const TEXT_CHANGE_SPEED = 0.25;

/**
 * Picture speed of an anime template clip over its content frames `0 … totalFrames − 1` (`speed[i]`: from frame
 * i − 1 to i, `speed[0]` = 0), in the units of `svgTemplateSpeed`; null when it cannot be measured (unknown template,
 * rejected params, too long).
 */
export function animeTemplateSpeed(
	def: Pick<AnyAnimeMgTemplate, 'id' | 'version' | 'introFrames' | 'outroFrames'>,
	params: Record<string, unknown>,
	timing: MgTemplateMotionTiming,
): number[] | null {
	const total = Math.round(timing.totalFrames);
	if (!(total >= 1) || total > MAX_SAMPLES_PER_CLIP) return null;
	const m = animeMotionModel(def, params, timing);
	if (!m) return null;
	const fps = timing.fps;
	const diag = Math.hypot(m.canvas.width, m.canvas.height);
	const speed = new Array<number>(total).fill(0);
	const valueAt = (tr: AnimeTrack, f: number) => trackValueAt(tr, (f * 1000) / fps);
	let prev = m.tracks.map((tr) => valueAt(tr, 0));
	let prevText = m.textAt ? m.textAt(0) : '';
	for (let f = 1; f < total; f++) {
		let px = 0;
		let other = 0;
		const cur = m.tracks.map((tr) => valueAt(tr, f));
		m.tracks.forEach((tr, i) => {
			const a = prev[i]!;
			const b = cur[i]!;
			if (a === b) return;
			const s = tr.show;
			if (s.kind === 'px') {
				const c = (v: number) => (s.clamp01 ? Math.min(1, Math.max(0, v)) : v);
				px = Math.max(px, Math.abs(c(b) - c(a)) * s.perUnit * m.scale);
			} else if (s.kind === 'point') {
				const pa = s.pointAt(a);
				const pb = s.pointAt(b);
				px = Math.max(px, Math.hypot(pb.x - pa.x, pb.y - pa.y) * m.scale);
			} else if (s.kind === 'opacity') other = Math.max(other, K_OPACITY * Math.abs(b - a));
			else if (a > 0 && b > 0) other = Math.max(other, K_SCALE * Math.abs(Math.log(b / a)));
			else other = Math.max(other, K_SCALE * 5);
		});
		let v = Math.max(px / diag, other) * fps;
		if (m.textAt) {
			const text = m.textAt((f * 1000) / fps);
			if (text !== prevText) v = Math.max(v, TEXT_CHANGE_SPEED);
			prevText = text;
		}
		speed[f] = Number.isFinite(v) ? v : 0;
		prev = cur;
	}
	return speed;
}
