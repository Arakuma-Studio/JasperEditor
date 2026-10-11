// Text animator implementations (S11:TXA-003, ANM-004): one value-engine build per catalogue preset. Every build
// animates fresh plain objects (one `UnitValues` per unit) with explicit [from, to] tweens on a paused timeline
// `durationMs` long; a unit's start values are also its values before its tween starts. Builds describe the In
// motion; Out plays it mirrored in time (`textAnimationSeekMs`).
import { getTextAnimationSpec, type TEXT_ANIMATION_ORDERS } from '@jasper/project';
import type { EasingParam } from 'animejs';
import { spring, steps } from 'animejs/easings';
import {
	createPausedTimeline,
	resolveEase,
	seededRandom,
	type TextUnit,
	type Timeline,
} from '../runtime/index.ts';
import {
	REST_UNIT_VALUES,
	type TextAnimationBuildContext,
	type TextAnimationImpl,
	type TextCaretContext,
	type UnitValues,
} from './types.ts';

type Order = (typeof TEXT_ANIMATION_ORDERS)[number];
type Params = TextAnimationBuildContext['params'];

/** Shortest unit tween as a fraction of the window (stagger 1 keeps every unit moving for this long). */
const MIN_UNIT_FRACTION = 0.1;

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Start rank in [0, 1] of every unit for an order (0 = starts first). `random` is a seeded permutation, so it
 * is the same for every frame, render worker and visit order (S11:ANM-007).
 */
export function orderRanks(units: number, order: Order | string, seed: number): number[] {
	if (units <= 1) return Array.from({ length: units }, () => 0);
	const last = units - 1;
	const centre = last / 2;
	switch (order) {
		case 'backward':
			return Array.from({ length: units }, (_, i) => (last - i) / last);
		case 'center':
			return Array.from({ length: units }, (_, i) => Math.abs(i - centre) / centre);
		case 'edges':
			return Array.from({ length: units }, (_, i) => 1 - Math.abs(i - centre) / centre);
		case 'random': {
			// Fisher–Yates with the clip's seeded generator.
			const rng = seededRandom(seed);
			const perm = Array.from({ length: units }, (_, i) => i);
			for (let i = last; i > 0; i--) {
				const j = Math.floor(rng() * (i + 1));
				[perm[i], perm[j]] = [perm[j]!, perm[i]!];
			}
			const ranks = new Array<number>(units);
			perm.forEach((unit, position) => {
				ranks[unit] = position / last;
			});
			return ranks;
		}
		default:
			return Array.from({ length: units }, (_, i) => i / last);
	}
}

/** One animated property of a unit: start value, ease, and the part of the unit's tween it occupies. */
type Channel = { prop: keyof UnitValues; from: number; ease: EasingParam; span?: readonly [number, number] };

/** Fresh targets at their start values and a paused timeline staggering `channels` over the units. */
function staggered(
	ctx: TextAnimationBuildContext,
	channels: readonly Channel[],
	stagger: number,
	order: Order | string,
): { timeline: Timeline; targets: UnitValues[] } {
	const n = Math.max(0, Math.floor(ctx.units));
	const total = Math.max(1, ctx.durationMs);
	const spread = n > 1 ? total * clamp01(stagger) * (1 - MIN_UNIT_FRACTION) : 0;
	const unitMs = total - spread;
	const ranks = orderRanks(n, order, ctx.seed);
	const start: UnitValues = { ...REST_UNIT_VALUES };
	for (const c of channels) start[c.prop] = c.from;
	const targets = Array.from({ length: n }, () => ({ ...start }));
	const timeline = createPausedTimeline();
	targets.forEach((target, i) => {
		const at = spread * ranks[i]!;
		for (const c of channels) {
			const [a, b] = c.span ?? [0, 1];
			timeline.add(
				target,
				{ [c.prop]: [c.from, REST_UNIT_VALUES[c.prop]], duration: unitMs * (b - a), ease: c.ease },
				at + unitMs * a,
			);
		}
	});
	return { timeline, targets };
}

/** Opacity of entering units: reaches 1 early so the motion itself carries the rest of the window. */
const fadeIn = (portion = 0.6): Channel => ({ prop: 'opacity', from: 0, ease: 'out', span: [0, portion] });

const common = (p: Params, ease: string) => ({
	stagger: num(p.stagger, 0),
	order: typeof p.order === 'string' ? p.order : 'forward',
	ease: resolveEase(typeof p.ease === 'string' ? p.ease : ease),
});

type Build = (ctx: TextAnimationBuildContext, p: Params) => { timeline: Timeline; targets: UnitValues[] };

function impl(
	id: string,
	unitDefault: TextUnit,
	build: Build,
	extra: Pick<TextAnimationImpl, 'lineMasks' | 'caret' | 'caretVisible'> = {},
	version = 1,
): TextAnimationImpl {
	const defaults = getTextAnimationSpec(id, version)?.defaults ?? {};
	return {
		key: `${id}@${version}`,
		unitDefault,
		build: (ctx) => build(ctx, { ...defaults, ...ctx.params }),
		...extra,
	};
}

/**
 * Keystroke times of a typewriter window: unit `i` is typed at `start + slot·i` (shown from the first frame after
 * it). `delay` / `typing` are fractions of the window (typewriter@2; @1 has neither: delay 0, typing 1).
 */
export function typewriterSchedule(
	units: number,
	durationMs: number,
	p: Params,
): { start: number; slot: number } {
	const total = Math.max(1, durationMs);
	const delay = Math.min(0.9, Math.max(0, num(p.delay, 0)));
	const typing = Math.min(1 - delay, Math.max(0.05, num(p.typing, 1)));
	return { start: total * delay, slot: (total * typing) / Math.max(1, Math.floor(units)) };
}

/** One unit after another, each shown at the start of its slot (step ease from the start). */
function typewriter(ctx: TextAnimationBuildContext, s: { start: number; slot: number }) {
	const n = Math.max(0, Math.floor(ctx.units));
	const targets = Array.from({ length: n }, () => ({ ...REST_UNIT_VALUES, opacity: 0, reveal: 0 }));
	const timeline = createPausedTimeline();
	targets.forEach((target, i) => {
		timeline.add(
			target,
			{ reveal: [0, 1], opacity: [0, 1], duration: s.slot, ease: steps(1, true) },
			s.start + s.slot * i,
		);
	});
	return { timeline, targets };
}

/**
 * Blinking caret of typewriter@2, a pure function of the frame (S11:ANM-003) like a text editor's: lit for the
 * first half of every blink period (`1 / blinkRate` s) counted from its anchor, so it is solid while units follow
 * each other faster than half a period, lit on every frame where a unit was just typed (or deleted), and blinks
 * while typing pauses. The anchor is the last keystroke in the window's own playing direction:
 * - In: the time the last shown unit was typed (`start + slot·(shown − 1)`), or the window start before the first;
 * - Out (deletes backwards): the time the last deleted unit went (`start + slot·shown` on the In timeline, which
 *   Out plays backwards), or the Out window's first frame before the first deletion.
 * `caretBlink: false` keeps the caret solid. The caret only exists inside a window (never at rest, S11:ANM-009).
 */
export function typewriterCaretVisible(c: TextCaretContext): boolean {
	const p = c.params;
	if (p.caret === false) return false;
	if (p.caretBlink === false) return true;
	const rate = Math.min(4, Math.max(0.5, num(p.blinkRate, 2)));
	const n = Math.max(0, Math.floor(c.units));
	const shown = Math.min(n, Math.max(0, Math.floor(c.shown)));
	const { start, slot } = typewriterSchedule(n, c.durationMs, p);
	let elapsed: number;
	if (c.side === 'in') elapsed = c.ms - (shown > 0 ? start + slot * (shown - 1) : 0);
	else {
		// The Out window's first frame seeks the In timeline at its last frame (`durationMs − 1 frame`).
		const anchor = shown < n ? start + slot * shown : c.durationMs - 1000 / Math.max(1, c.fps);
		elapsed = anchor - c.ms;
	}
	// Half periods since the anchor; a hair of tolerance so frame times that land on a boundary are stable.
	const halves = Math.floor((Math.max(0, elapsed) * 2 * rate) / 1000 + 1e-9);
	return halves % 2 === 0;
}

const slide = (id: string, axis: 'x' | 'y', sign: 1 | -1) =>
	impl(id, 'word', (ctx, p) => {
		const c = common(p, 'outExpo');
		const from = sign * num(p.distance, 60);
		return staggered(ctx, [{ prop: axis, from, ease: c.ease }, fadeIn()], c.stagger, c.order);
	});

const PRESETS: readonly TextAnimationImpl[] = [
	impl('fade', 'word', (ctx, p) => {
		const c = common(p, 'out');
		return staggered(ctx, [{ prop: 'opacity', from: 0, ease: c.ease }], c.stagger, c.order);
	}),
	// Units travel towards the named direction: slide-up starts below its place.
	slide('slide-up', 'y', 1),
	slide('slide-down', 'y', -1),
	slide('slide-left', 'x', 1),
	slide('slide-right', 'x', -1),
	impl('pop', 'char', (ctx, p) => {
		const c = common(p, 'outBack');
		// The spring's ease function (not the Spring object, whose settling time would replace the window).
		const ease = spring({ bounce: Math.min(0.9, Math.max(0, num(p.bounce, 0.5))) }).ease;
		return staggered(ctx, [{ prop: 'scale', from: num(p.scale, 0), ease }, fadeIn(0.3)], c.stagger, c.order);
	}),
	impl('blur', 'word', (ctx, p) => {
		const c = common(p, 'out');
		return staggered(
			ctx,
			[
				{ prop: 'blur', from: num(p.blur, 16), ease: c.ease },
				{ prop: 'opacity', from: 0, ease: c.ease },
			],
			c.stagger,
			c.order,
		);
	}),
	impl('typewriter', 'char', (ctx) => typewriter(ctx, typewriterSchedule(ctx.units, ctx.durationMs, {})), {
		caret: (p) => p.caret !== false,
	}),
	impl(
		'typewriter',
		'char',
		(ctx, p) => typewriter(ctx, typewriterSchedule(ctx.units, ctx.durationMs, p)),
		{ caret: (p) => p.caret !== false, caretVisible: typewriterCaretVisible },
		2,
	),
	impl('tracking', 'line', (ctx, p) => {
		const c = common(p, 'outExpo');
		return staggered(
			ctx,
			[{ prop: 'letterSpacing', from: num(p.spacing, 0.5), ease: c.ease }, fadeIn(0.5)],
			c.stagger,
			c.order,
		);
	}),
	impl(
		'mask-reveal',
		'line',
		(ctx, p) => {
			const c = common(p, 'outExpo');
			// `reveal` 0 = the unit sits one line height below its place, hidden by its line's mask.
			return staggered(ctx, [{ prop: 'reveal', from: 0, ease: c.ease }], c.stagger, c.order);
		},
		{ lineMasks: true },
	),
	impl('rotate-in', 'char', (ctx, p) => {
		const c = common(p, 'outBack');
		return staggered(
			ctx,
			[{ prop: 'rotate', from: num(p.angle, 90), ease: c.ease }, fadeIn(0.4)],
			c.stagger,
			c.order,
		);
	}),
	impl('drop', 'char', (ctx, p) => {
		const c = common(p, 'outBounce');
		return staggered(
			ctx,
			[{ prop: 'y', from: -num(p.distance, 120), ease: c.ease }, fadeIn(0.25)],
			c.stagger,
			c.order,
		);
	}),
];

/** The shipped implementations keyed `id@version` (one per catalogue entry). */
export const PRESET_IMPLS: Readonly<Record<string, TextAnimationImpl>> = Object.freeze(
	Object.fromEntries(PRESETS.map((p) => [p.key, p])),
);
