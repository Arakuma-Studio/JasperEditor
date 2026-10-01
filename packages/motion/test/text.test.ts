// Text animator implementations (S11:TXA-002/003/004, ANM-004/009/013): the table matches the catalogue, every
// preset is a pure function of the seek time (in-order = reversed = shuffled = a fresh build per frame, In and
// mirrored Out), starts at its start state and ends exactly at rest, and the window maths of the text layer.
import {
	type ResolvedTextAnimator,
	TEXT_ANIMATION_EASES,
	TEXT_ANIMATION_SPECS,
	textAnimationKey,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EASE_NAMES, frameToMs, hash32, seekCanonical } from '../src/runtime/index.ts';
import {
	activeTextAnimation,
	orderRanks,
	REST_UNIT_VALUES,
	TEXT_ANIMATION_IMPLS,
	type TextAnimationImpl,
	textAnimationImpl,
	textAnimationUnit,
	type UnitValues,
} from '../src/text/index.ts';

const impl = (id: string) => TEXT_ANIMATION_IMPLS[`${id}@1`]!;

function build(
	i: TextAnimationImpl,
	units: number,
	frames: number,
	fps: number,
	params = {},
	side: 'in' | 'out' = 'in',
) {
	const spec = TEXT_ANIMATION_SPECS.find((s) => textAnimationKey(s.id, s.version) === i.key)!;
	return i.build({
		units,
		side,
		durationMs: frameToMs(frames, fps),
		params: { ...spec.defaults, ...params },
		seed: hash32('clp_TEST', 'text-anim', side),
		box: { width: 800, height: 200 },
	});
}

/** Values at a seek time, copied (the targets are reused by the timeline). */
function at(b: ReturnType<typeof build>, ms: number): UnitValues[] {
	seekCanonical(b.timeline, ms);
	// String keys only: anime.js marks registered targets with a symbol property.
	return b.targets.map(
		(t) => Object.fromEntries(Object.keys(t).map((k) => [k, t[k as keyof UnitValues]])) as UnitValues,
	);
}

describe('implementation table (S11:TXA-002)', () => {
	it('has exactly one implementation per catalogue entry, keyed id@version', () => {
		expect(Object.keys(TEXT_ANIMATION_IMPLS).sort()).toEqual(
			TEXT_ANIMATION_SPECS.map((s) => textAnimationKey(s.id, s.version)).sort(),
		);
		for (const [key, i] of Object.entries(TEXT_ANIMATION_IMPLS)) {
			expect(i.key).toBe(key);
			const spec = TEXT_ANIMATION_SPECS.find((s) => textAnimationKey(s.id, s.version) === key)!;
			if ('unit' in spec.defaults) expect(i.unitDefault).toBe(spec.defaults.unit);
		}
		expect(textAnimationImpl({ preset: 'fade', version: 1 })).toBe(impl('fade'));
		expect(textAnimationImpl({ preset: 'fade', version: 2 })).toBeUndefined();
	});
	it('the catalogue ease list is the runtime EASES list', () => {
		expect([...TEXT_ANIMATION_EASES].sort()).toEqual([...EASE_NAMES].sort());
	});
});

// Parameter variants exercising every order, unit count and the preset-specific params.
const VARIANTS: { units: number; frames: number; fps: number; params: Record<string, unknown> }[] = [
	{ units: 1, frames: 15, fps: 30, params: {} },
	{ units: 9, frames: 20, fps: 30, params: { stagger: 0.6, order: 'random' } },
	{ units: 23, frames: 13, fps: 24000 / 1001, params: { stagger: 1, order: 'center' } },
	{ units: 6, frames: 31, fps: 60, params: { stagger: 0.25, order: 'edges', ease: 'steps' } },
	{ units: 4, frames: 1, fps: 25, params: { order: 'backward' } },
];

/** Keeps only the params a preset's schema accepts (VARIANTS are shared by all presets). */
function paramsFor(id: string, p: Record<string, unknown>): Record<string, unknown> {
	const spec = TEXT_ANIMATION_SPECS.find((s) => s.id === id)!;
	return Object.fromEntries(Object.entries(p).filter(([k]) => k in spec.defaults));
}

describe('determinism of every preset (S11:ANM-013)', () => {
	for (const spec of TEXT_ANIMATION_SPECS) {
		it(`${spec.id}: in order = reversed = shuffled = a fresh build per frame, In and mirrored Out`, () => {
			const i = impl(spec.id);
			VARIANTS.forEach((v, vi) => {
				const params = paramsFor(spec.id, v.params);
				const frames = Array.from({ length: v.frames + 1 }, (_, f) => f);
				for (const side of ['in', 'out'] as const) {
					const fresh = frames.map((f) =>
						at(build(i, v.units, v.frames, v.fps, params, side), frameToMs(f, v.fps)),
					);
					const one = build(i, v.units, v.frames, v.fps, params, side);
					for (const f of frames) expect(at(one, frameToMs(f, v.fps))).toEqual(fresh[f]);
					for (const f of [...frames].sort((a, b) => b - a))
						expect(at(one, frameToMs(f, v.fps))).toEqual(fresh[f]);
					fc.assert(
						fc.property(fc.shuffledSubarray(frames, { minLength: frames.length }), (order) => {
							const b = build(i, v.units, v.frames, v.fps, params, side);
							for (const f of order) expect(at(b, frameToMs(f, v.fps))).toEqual(fresh[f]);
						}),
						{ seed: 2026 + vi, numRuns: 8 },
					);
				}
			});
		});
	}
});

describe('start and rest states (S11:ANM-009, TXA-003)', () => {
	it('every preset ends exactly at rest and starts away from it', () => {
		for (const spec of TEXT_ANIMATION_SPECS) {
			const b = build(impl(spec.id), 5, 20, 30);
			expect(at(b, frameToMs(20, 30)), spec.id).toEqual(
				Array.from({ length: 5 }, () => ({ ...REST_UNIT_VALUES })),
			);
			const start = at(b, 0);
			expect(start[0], spec.id).not.toEqual(REST_UNIT_VALUES);
		}
	});
	it('start values per preset follow the params', () => {
		const first = (id: string, params = {}) => at(build(impl(id), 3, 20, 30, params), 0)[0]!;
		expect(first('fade')).toMatchObject({ opacity: 0, x: 0, y: 0 });
		expect(first('slide-up', { distance: 50 })).toMatchObject({ y: 50, opacity: 0 });
		expect(first('slide-down', { distance: 50 })).toMatchObject({ y: -50 });
		expect(first('slide-left', { distance: 50 })).toMatchObject({ x: 50 });
		expect(first('slide-right', { distance: 50 })).toMatchObject({ x: -50 });
		expect(first('pop', { scale: 0.25 })).toMatchObject({ scale: 0.25, opacity: 0 });
		expect(first('blur', { blur: 9 })).toMatchObject({ blur: 9, opacity: 0 });
		expect(first('typewriter')).toMatchObject({ reveal: 0, opacity: 0 });
		expect(first('tracking', { spacing: 2 })).toMatchObject({ letterSpacing: 2, opacity: 0 });
		expect(first('mask-reveal')).toMatchObject({ reveal: 0, opacity: 1 });
		// outBack evaluates to -1e-16 at t = 0
		expect(first('rotate-in', { angle: -45 }).rotate).toBeCloseTo(-45, 9);
		expect(first('rotate-in').opacity).toBe(0);
		expect(first('drop', { distance: 70 })).toMatchObject({ y: -70, opacity: 0 });
	});
	it('pop overshoots (spring ease) while keeping the window length', () => {
		const b = build(impl('pop'), 1, 30, 30, { bounce: 0.6 });
		const scales = Array.from({ length: 31 }, (_, f) => at(b, frameToMs(f, 30))[0]!.scale);
		expect(Math.max(...scales)).toBeGreaterThan(1.02);
		expect(scales[30]).toBe(1);
		expect(b.timeline.duration).toBeCloseTo(1000, 6);
	});
	it('stagger spreads unit starts over the window in the chosen order', () => {
		const b = build(impl('fade'), 5, 30, 30, { stagger: 0.8, ease: 'linear' });
		const mid = at(b, frameToMs(10, 30)).map((u) => u.opacity);
		for (let k = 1; k < 5; k++) expect(mid[k - 1]!).toBeGreaterThanOrEqual(mid[k]!);
		expect(mid[0]).toBeGreaterThan(mid[4]!);
		const back = at(build(impl('fade'), 5, 30, 30, { stagger: 0.8, order: 'backward' }), frameToMs(10, 30));
		expect(back[4]!.opacity).toBeGreaterThan(back[0]!.opacity);
		const together = at(build(impl('fade'), 5, 30, 30, { stagger: 0 }), frameToMs(10, 30)).map(
			(u) => u.opacity,
		);
		expect(new Set(together).size).toBe(1);
	});
	it('typewriter reveals one unit per slot from the start of the window', () => {
		const b = build(impl('typewriter'), 10, 30, 30);
		const shown = (f: number) => at(b, frameToMs(f, 30)).filter((u) => u.reveal === 1).length;
		expect([0, 1, 3, 4, 15, 29, 30].map(shown)).toEqual([0, 1, 1, 2, 5, 10, 10]);
		expect(impl('typewriter').caret?.({ caret: true })).toBe(true);
		expect(impl('typewriter').caret?.({ caret: false })).toBe(false);
		expect(impl('mask-reveal').lineMasks).toBe(true);
	});
});

describe('typewriter@2: blinking caret (a pure function of the frame)', () => {
	const v2 = TEXT_ANIMATION_IMPLS['typewriter@2']!;
	const FPS = 30;
	const FRAMES = 45;
	/**
	 * The caret over a whole clip whose only window is `side` (In: frames [0, 45), Out: the last 45 frames, played
	 * mirrored), as the text layer sees it: `activeTextAnimation` → build seeked → shown units → `caretVisible`.
	 * `1` = lit, `0` = dark, `.` = rest (no window: no caret at all).
	 */
	function caretTrack(units: number, side: 'in' | 'out', params: Record<string, unknown> = {}, extra = 10) {
		const duration = FRAMES + extra;
		const spec = TEXT_ANIMATION_SPECS.find((s) => textAnimationKey(s.id, s.version) === v2.key)!;
		const animator: ResolvedTextAnimator = {
			preset: 'typewriter',
			version: 2,
			params: { ...spec.defaults, ...params },
			frames: FRAMES,
		};
		const b = build(v2, units, FRAMES, FPS, params, side);
		let track = '';
		for (let f = 0; f < duration; f++) {
			const a = activeTextAnimation({ [side]: animator }, f, duration, FPS);
			if (!a) {
				track += '.';
				continue;
			}
			const shown = at(b, a.ms).filter((u) => u.reveal >= 1).length;
			const lit = v2.caretVisible!({
				params: animator.params,
				side: a.side,
				ms: a.ms,
				durationMs: a.durationMs,
				fps: FPS,
				units,
				shown,
			});
			track += lit ? '1' : '0';
		}
		return track;
	}
	it('@1 output is unchanged: same reveal timing, caret always lit (no caretVisible)', () => {
		const v1 = impl('typewriter');
		expect(v1.caretVisible).toBeUndefined();
		const a = build(v1, 10, 30, 30);
		const b = build(v2, 10, 30, 30, { delay: 0, typing: 1 });
		for (let f = -1; f <= 31; f++) expect(at(b, frameToMs(f, 30))).toEqual(at(a, frameToMs(f, 30)));
		expect(a.timeline.duration).toBe(b.timeline.duration);
	});
	it('types within `typing` of the window after `delay`, then idles', () => {
		const b = build(v2, 10, FRAMES, FPS);
		const shown = (f: number) => at(b, frameToMs(f, FPS)).filter((u) => u.reveal === 1).length;
		// slot = 1500 ms · 0.6 / 10 = 90 ms: unit i is typed at 90·i ms, all shown from frame 25 (833 ms)
		expect([0, 1, 3, 24, 25, 44].map(shown)).toEqual([0, 1, 2, 9, 10, 10]);
		const late = build(v2, 10, FRAMES, FPS, { delay: 0.4 });
		const lateShown = (f: number) => at(late, frameToMs(f, FPS)).filter((u) => u.reveal === 1).length;
		expect([0, 18, 19, 43, 44].map(lateShown)).toEqual([0, 0, 1, 10, 10]);
		// typing is capped to the rest of the window
		const capped = build(v2, 4, FRAMES, FPS, { delay: 0.5, typing: 1 });
		expect(at(capped, frameToMs(44, FPS)).every((u) => u.reveal === 1)).toBe(true);
	});
	it('In: solid while typing, blinks after typing finishes, never at rest', () => {
		// typing ends at 810 ms (frame 25); lit for 250 ms after it, dark for 250 ms, lit again
		expect(caretTrack(10, 'in')).toBe('1'.repeat(32) + '0'.repeat(8) + '1'.repeat(5) + '.'.repeat(10));
	});
	it('In with a delay: blinks before the first unit, lit when typing starts', () => {
		const track = caretTrack(10, 'in', { delay: 0.4 });
		expect(track).toBe('1'.repeat(8) + '0'.repeat(7) + '1'.repeat(30) + '.'.repeat(10));
		expect(track[19]).toBe('1'); // first unit typed (600 ms)
	});
	it('blinks between keystrokes further apart than half a period (idle between units)', () => {
		// two words over the whole window: typed at 0 and 750 ms
		const track = caretTrack(2, 'in', { unit: 'word', typing: 1 });
		expect(track.slice(0, FRAMES)).toBe(
			'1'.repeat(8) + '0'.repeat(7) + '1'.repeat(8) + '1'.repeat(7) + '0'.repeat(8) + '1'.repeat(7),
		);
		expect(track[23]).toBe('1'); // the second word appears with the caret lit
	});
	it('Out (mirrored): blinks first, then deletes backwards with a solid caret, rest before the window', () => {
		const track = caretTrack(10, 'out');
		expect(track).toBe('.'.repeat(10) + '1'.repeat(8) + '0'.repeat(7) + '1'.repeat(30));
		// the first deletion (Out frame 20) happens with the caret lit
		const b = build(v2, 10, FRAMES, FPS, {}, 'out');
		const shownAtOut = (j: number) =>
			at(b, frameToMs(FRAMES - 1 - j, FPS)).filter((u) => u.reveal === 1).length;
		expect([19, 20].map(shownAtOut)).toEqual([10, 9]);
		expect(track[10 + 20]).toBe('1');
	});
	it('caretBlink false keeps it solid; blinkRate sets the period; caret false hides it', () => {
		expect(caretTrack(10, 'in', { caretBlink: false }, 0)).toBe('1'.repeat(FRAMES));
		expect(caretTrack(10, 'out', { caretBlink: false }, 0)).toBe('1'.repeat(FRAMES));
		// 1 Hz: lit 500 ms after the last keystroke (810 ms) → dark from frame 40 (1333 ms)
		expect(caretTrack(10, 'in', { blinkRate: 1 }, 0)).toBe('1'.repeat(40) + '0'.repeat(5));
		expect(v2.caret?.({ caret: false })).toBe(false);
		expect(
			v2.caretVisible!({
				params: { caret: false },
				side: 'in',
				ms: 0,
				durationMs: 1500,
				fps: FPS,
				units: 3,
				shown: 0,
			}),
		).toBe(false);
	});
	it('is order-independent (shuffled frame visits give the same caret as in order)', () => {
		const track = caretTrack(10, 'in');
		const b = build(v2, 10, FRAMES, FPS);
		const params = {
			...TEXT_ANIMATION_SPECS.find((s) => s.id === 'typewriter' && s.version === 2)!.defaults,
		};
		const frames = fc.sample(fc.shuffledSubarray([...Array(FRAMES).keys()], { minLength: FRAMES }), {
			seed: 7,
			numRuns: 1,
		})[0]!;
		for (const f of frames) {
			const ms = frameToMs(f, FPS);
			const shown = at(b, ms).filter((u) => u.reveal >= 1).length;
			const lit = v2.caretVisible!({
				params,
				side: 'in',
				ms,
				durationMs: frameToMs(FRAMES, FPS),
				fps: FPS,
				units: 10,
				shown,
			});
			expect(lit ? '1' : '0').toBe(track[f]);
		}
	});
});

describe('order ranks', () => {
	it('forward, backward, center, edges and a seeded random permutation', () => {
		expect(orderRanks(5, 'forward', 1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
		expect(orderRanks(5, 'backward', 1)).toEqual([1, 0.75, 0.5, 0.25, 0]);
		expect(orderRanks(5, 'center', 1)).toEqual([1, 0.5, 0, 0.5, 1]);
		expect(orderRanks(5, 'edges', 1)).toEqual([0, 0.5, 1, 0.5, 0]);
		const r = orderRanks(8, 'random', 99);
		expect([...r].sort()).toEqual(orderRanks(8, 'forward', 0));
		expect(orderRanks(8, 'random', 99)).toEqual(r);
		expect(orderRanks(8, 'random', 100)).not.toEqual(r);
		expect(orderRanks(1, 'random', 1)).toEqual([0]);
		expect(orderRanks(0, 'center', 1)).toEqual([]);
	});
});

describe('windows of the text layer (S11:TXA-004)', () => {
	const a = (frames: number): ResolvedTextAnimator => ({ preset: 'fade', version: 1, params: {}, frames });
	it('In plays forward from the first frame, Out mirrored to the last; rest between', () => {
		const anim = { in: a(10), out: a(5) };
		const w = (f: number) => activeTextAnimation(anim, f, 60, 30);
		expect(w(0)).toMatchObject({ side: 'in', ms: 0, durationMs: frameToMs(10, 30) });
		expect(w(9)).toMatchObject({ side: 'in', ms: frameToMs(9, 30) });
		expect(w(10)).toBeNull();
		expect(w(54)).toBeNull();
		expect(w(55)).toMatchObject({ side: 'out', ms: frameToMs(4, 30), durationMs: frameToMs(5, 30) });
		expect(w(59)).toMatchObject({ side: 'out', ms: 0 });
	});
	it('transition handles clamp to the start/end states; missing sides are rest', () => {
		expect(activeTextAnimation({ in: a(10), out: a(5) }, -3, 60, 30)).toMatchObject({ side: 'in', ms: 0 });
		expect(activeTextAnimation({ in: a(10), out: a(5) }, 64, 60, 30)).toMatchObject({ side: 'out', ms: 0 });
		expect(activeTextAnimation({ out: a(5) }, -3, 60, 30)).toBeNull();
		expect(activeTextAnimation({ in: a(10) }, 64, 60, 30)).toBeNull();
		expect(activeTextAnimation(undefined, 0, 60, 30)).toBeNull();
	});
	it('char units fall back to words for RTL and complex scripts', () => {
		expect(textAnimationUnit(impl('pop'), {}, 'Hello')).toBe('char');
		expect(textAnimationUnit(impl('pop'), { unit: 'line' }, 'Hello')).toBe('line');
		expect(textAnimationUnit(impl('pop'), {}, 'مرحبا بالعالم')).toBe('word');
		expect(textAnimationUnit(impl('fade'), { unit: 'bogus' }, 'x')).toBe('word');
	});
});
