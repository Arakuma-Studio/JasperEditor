// Targeted generators for `mergeDips` (wp-note WP6.5b item 6: "mergeDips (property)" failed once, seed lost): the
// same checks as the WP4.2a / P4-verification properties (sound-dips-property.ts) over inputs built to hit the edge
// cases — keys, dip edges and fades on one coarse grid (keys exactly at window edges, steps at dip edges), identical,
// overlapping, adjacent and touching dips, zero-length dips and fades, −0, subnormal and huge depths, levels at and past
// the clamp, many dips, steep curves. `FC_HUNT_RUNS=<n>` sets the runs of each property (default 60: a quick pass in
// the suite); the hunt in the wp-note ran them with millions (see the WP6.5b verification).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Dip,
	evaluate,
	FLICKS_PER_SECOND,
	type Keyframe,
	mergeDips,
	SEQUENCE_LANE,
} from '../src/index.ts';
import { checkCurvedDips, checkLinearDips, keysOf } from './sound-dips-property.ts';

const MS = FLICKS_PER_SECOND / 1000;
const RUNS = Number(process.env.FC_HUNT_RUNS ?? 60) || 60;
/** 200 ms per run at most (the many-dips property is the slowest), never under the suite's 60 s. */
const TIMEOUT = Math.max(60_000, RUNS * 200);

// volume levels: no key is over the clamp's +15 dB (the Volume range), some are under its −96 dB
const special = [0, -0, 5e-324, -5e-324, 1e-12, -1e-12, -96, -95.999, 15, 14.999, -200, -3, 6];
const level = fc.oneof(
	{ weight: 2, arbitrary: fc.constantFrom(...special) },
	{ weight: 3, arbitrary: fc.double({ min: -40, max: 10, noNaN: true }) },
	{ weight: 1, arbitrary: fc.double({ min: -300, max: 15, noNaN: true }) },
);
// dip depths: the command's range (−60…0 dB), with −0 and the smallest magnitudes
const depth = fc.oneof(
	{
		weight: 2,
		arbitrary: fc.constantFrom(0, -0, -5e-324, -1e-12, -0.0005, -0.5, -6, -24, -59.999, -60),
	},
	{ weight: 3, arbitrary: fc.double({ min: -60, max: 0, noNaN: true }) },
);
const fade = fc.oneof(
	fc.constantFrom(0, 1, 2, 10, 30, 100, 400),
	fc.integer({ min: 0, max: 400 }),
	fc.double({ min: 0, max: 400, noNaN: true }),
);
/** Times on a 10 ms grid (keys at 100 ms steps fall on it too) or anywhere (flicks). */
const time = fc.oneof(
	{ weight: 3, arbitrary: fc.integer({ min: 0, max: 400 }).map((g) => g * 10 * MS) },
	{ weight: 1, arbitrary: fc.integer({ min: 0, max: 4_000 }).map((g) => g * MS) },
	{ weight: 1, arbitrary: fc.integer({ min: 0, max: 4 * FLICKS_PER_SECOND }) },
);

/** One dip, or a group built to touch: duplicates, the same window, adjacent windows, a zero-length one inside. */
const dipGroup: fc.Arbitrary<Dip[]> = fc
	.record({
		start: time,
		len: fc.oneof(
			fc.constant(0),
			fc.integer({ min: 0, max: 60 }).map((l) => l * 10 * MS),
			time,
		),
		depthDb: depth,
		fadeMs: fade,
		shape: fc.constantFrom('one', 'twice', 'adjacent', 'touching', 'nested', 'zero-inside', 'same-start'),
		other: fc.record({ depthDb: depth, fadeMs: fade }),
	})
	.map(({ start, len, depthDb, fadeMs, shape, other }) => {
		const d: Dip = { start, end: start + len, depthDb, fadeMs };
		const f = Math.max(1, fadeMs) * MS;
		const g = Math.max(1, other.fadeMs) * MS;
		switch (shape) {
			case 'twice':
				return [d, { ...d }];
			case 'adjacent': // the second window starts where the first ends
				return [d, { start: d.end + f + g, end: d.end + f + g + 10 * MS, ...other }];
			case 'touching': // the second dip starts where the first ends
				return [d, { start: d.end, end: d.end + len, ...other }];
			case 'nested':
				return [d, { start: d.start + len / 3, end: d.start + (2 * len) / 3, ...other }];
			case 'zero-inside':
				return [d, { start: d.start + len / 2, end: d.start + len / 2, ...other }];
			case 'same-start':
				return [d, { start: d.start, end: d.start + len / 2, ...other }];
			default:
				return [d];
		}
	});
const dips = fc.array(dipGroup, { minLength: 1, maxLength: 6 }).map((gs) => gs.flat());

const linearKeys = fc.array(
	fc.record({
		time: fc.oneof(
			{ weight: 3, arbitrary: fc.integer({ min: 0, max: 40 }).map((t) => t * 100 * MS) },
			{ weight: 2, arbitrary: time },
		),
		v: level,
		interp: fc.constantFrom<Keyframe<number>['interpolation']>('linear', 'hold'),
	}),
	{ maxLength: 12 },
);
const curvedKeys = fc.array(
	fc.record({
		t: fc.integer({ min: 0, max: 40 }),
		v: fc.oneof(fc.double({ min: -40, max: 10, noNaN: true }), fc.constantFrom(-96, 15, -0, 0)),
		interp: fc.constantFrom<Keyframe<number>['interpolation']>(
			'linear',
			'hold',
			'bezier',
			'auto-bezier',
			'continuous-bezier',
		),
		inf: fc.oneof(fc.double({ min: 0.05, max: 0.95, noNaN: true }), fc.constantFrom(0.05, 0.95, 1 / 3)),
		slope: fc.oneof(fc.double({ min: 0, max: 2, noNaN: true }), fc.constantFrom(0, 2)),
	}),
	{ maxLength: 10 },
);

describe('mergeDips targeted hunt (properties)', () => {
	it(
		'linear / hold lanes: grid-aligned keys and dips, touching / identical / zero-length dips, extreme levels',
		() => {
			fc.assert(
				fc.property(linearKeys, level, dips, (keys, value, ds) => {
					// a 5 ms sampling grid: every 10 ms grid point (window edges, keys, dip edges) is sampled
					checkLinearDips(keysOf(keys), value, ds, { samples: 900, step: 5 * MS });
				}),
				{ numRuns: RUNS },
			);
		},
		TIMEOUT,
	);

	for (const maxDips of [3, 12])
		it(
			`linear / hold lanes, the WP4.2a generator${maxDips > 3 ? ' with many dips (up to 12)' : ' as is'}`,
			() => {
				const dip = fc
					.record({
						s: fc.integer({ min: 0, max: 380 }),
						len: fc.integer({ min: 0, max: 60 }),
						depth: fc.double({ min: -60, max: 0, noNaN: true }),
						fade: fc.integer({ min: 0, max: 400 }),
					})
					.map((d) => ({
						start: d.s * 10 * MS,
						end: (d.s + d.len) * 10 * MS,
						depthDb: d.depth,
						fadeMs: d.fade,
					}));
				fc.assert(
					fc.property(
						fc.array(
							fc.record({
								t: fc.integer({ min: 0, max: 40 }),
								v: fc.double({ min: -40, max: 10, noNaN: true }),
								hold: fc.boolean(),
							}),
							{ maxLength: 8 },
						),
						fc.double({ min: -20, max: 6, noNaN: true }),
						fc.array(dip, { minLength: 1, maxLength: maxDips }),
						(keys, value, ds) =>
							checkLinearDips(
								keysOf(
									keys.map((k) => ({ time: k.t * 100 * MS, v: k.v, interp: k.hold ? 'hold' : 'linear' })),
								),
								value,
								ds,
							),
					),
					{ numRuns: RUNS },
				);
			},
			TIMEOUT,
		);

	it(
		'curved lanes (Bézier, auto-Bézier, continuous) on the sequence and a reversed 2× clip: touching / identical dips',
		() => {
			fc.assert(
				fc.property(curvedKeys, dips, fc.constantFrom<0 | 1>(0, 1), (keys, ds, li) => {
					const kfs = keysOf(keys.map((k) => ({ ...k, time: k.t * 100 * MS * (li === 1 ? 2 : 1) })));
					// the curved check's tolerances assume dips that dip (≤ −0.5 dB) and levels inside the clamp
					const deep = ds.map((d) => ({ ...d, depthDb: Math.min(-0.5, Math.max(-60, d.depthDb)) }));
					// dips between whole flicks (the generator's thirds and halves): straight lanes within 1e-4 dB
					const whole = deep.every((d) => Number.isInteger(d.start) && Number.isInteger(d.end));
					checkCurvedDips(kfs, deep, li, -3, whole ? 1e-5 : 1e-4);
				}),
				{ numRuns: RUNS },
			);
		},
		TIMEOUT,
	);
});

describe('mergeDips: counterexamples of the hunt (WP6.5b)', () => {
	const lin = (pts: [number, number][]) =>
		keysOf(pts.map(([ms, v]) => ({ time: ms * MS, v, interp: 'linear' as const })));
	const merge = (kfs: Keyframe<number>[], ds: Dip[]) => {
		let i = 0;
		return mergeDips({ value: 0, keyframes: kfs }, SEQUENCE_LANE, ds, {
			newId: () => `n${i++}`,
			clamp: [-96, 15],
		});
	};

	it('a dip of no depth (0 dB, −0) is no dip: nothing written, the swell inside its window kept', () => {
		// the hunt's counterexample (grid generator): a 15 dB key inside a 0 dB dip's window
		const kfs = lin([
			[0, 0],
			[10, 15],
			[20, 0],
		]);
		const zero = [
			{ start: 0, end: 0, depthDb: 0, fadeMs: 0 },
			{ start: 2 * MS, end: 12 * MS, depthDb: -0, fadeMs: 0 },
		];
		expect(merge(kfs, zero)).toBeNull();
		checkLinearDips(kfs, 0, zero, { samples: 900, step: 5 * MS });
		// in the WP4.2a generator's own domain (keys on 100 ms, depth in [−60, 0], fast-check yields ±0 for ≈ 1 % of
		// those doubles): the property failed with "expected 5.5 to be close to 4.9"
		checkLinearDips(
			lin([
				[0, 0],
				[100, 10],
				[200, 0],
			]),
			0,
			[{ start: 50 * MS, end: 150 * MS, depthDb: 0, fadeMs: 0 }],
		);
	});

	it("a 0 dB dip overlapping a real one does not move the real dip's reference level", () => {
		const kfs = lin([
			[0, 0],
			[1000, -12],
		]);
		const real: Dip = { start: 100 * MS, end: 200 * MS, depthDb: -24, fadeMs: 10 };
		const a = merge(kfs, [real])!;
		const b = merge(kfs, [real, { start: 150 * MS, end: 800 * MS, depthDb: 0, fadeMs: 0 }])!;
		for (let ms = 0; ms <= 1000; ms += 5) {
			const t = ms * MS;
			expect(evaluate({ value: 0, keyframes: b.keyframes }, t)).toBeCloseTo(
				evaluate({ value: 0, keyframes: a.keyframes }, t),
				9,
			);
		}
		expect(b.windows).toEqual(a.windows);
	});

	it('two dips whose windows touch: no spike up to a key at the instant they touch', () => {
		// A's window [99, 201] ms, B's [201, 301] ms; a +6 dB key at 201 ms
		const kfs = lin([
			[0, 0],
			[201, 6],
			[400, 0],
		]);
		const ds: Dip[] = [
			{ start: 100 * MS, end: 200 * MS, depthDb: -24, fadeMs: 1 },
			{ start: 202 * MS, end: 300 * MS, depthDb: -24, fadeMs: 1 },
		];
		const r = merge(kfs, ds)!;
		const anim = { value: 0, keyframes: kfs };
		const ref = Math.max(evaluate(anim, 99 * MS), evaluate(anim, 301 * MS));
		// at the touching instant the dips are back at the local level (both fades end there), never at the +6 dB key
		expect(evaluate({ value: 0, keyframes: r.keyframes }, 201 * MS)).toBeCloseTo(ref, 6);
		checkLinearDips(kfs, 0, ds, { samples: 900, step: 0.5 * MS });
	});
});

describe('mergeDips: a steep Bézier rebuilt next to a dip (WP6.5b hunt)', () => {
	it('the part of the segment outside the dip stays within 0.01 dB of the curve (was 0.087 dB with 1.56 ms samples)', () => {
		// the curved generator's counterexample: auto-Bézier 0 dB at 3.8 s → Bézier −96 dB at 3.9 s (influence 0.94),
		// a dip whose fade ends at 3.801 s (the segment crossing its edge is rebuilt whole)
		const kfs = keysOf([
			{ time: 3800 * MS, v: -0, interp: 'auto-bezier', inf: 0.05, slope: 0 },
			{ time: 3900 * MS, v: -96, interp: 'bezier', inf: 0.9448160422988744, slope: 0 },
		]);
		const ds: Dip[] = [{ start: 2237457600, end: 2611425600, depthDb: -0.5, fadeMs: 100 }];
		let i = 0;
		const anim = { value: -3, keyframes: kfs };
		const r = mergeDips(anim, SEQUENCE_LANE, ds, { newId: () => `n${i++}`, clamp: [-96, 15] })!;
		expect(r.windows).toEqual([[3071 * MS, 3900 * MS]]);
		let worst = 0;
		for (let t = 3801 * MS; t <= 3900 * MS; t += MS / 40)
			worst = Math.max(
				worst,
				Math.abs(evaluate({ value: -3, keyframes: r.keyframes }, t) - evaluate(anim, t)),
			);
		expect(worst).toBeLessThanOrEqual(0.01);
		expect(r.written.length).toBeLessThanOrEqual(512);
		checkCurvedDips(kfs, ds, 0);
	});

	it('a dip between flicks on a reversed 2× clip: straight lanes within half a lane flick of the dip', () => {
		// the curved generator's counterexample (0.000014 dB over the straight lanes' 1e-5): a dip whose edges fall
		// between flicks; keys live on whole lane flicks
		checkCurvedDips(
			[],
			[{ start: 89_204_493.666_666_67, end: 178_408_987.333_333_34, depthDb: -60, fadeMs: 0 }],
			1,
			-3,
			1e-4,
		);
	});
});

describe('mergeDips: a dip window edge between two flicks (WP6.5b hunt)', () => {
	it('the key written at the edge holds the curve, not the dip (the static lane before it stays at its level)', () => {
		// the grid generator's counterexample: a zero-length dip at 7 056 001.5 flicks (10 ms + 1.5 flicks), 1 ms fades:
		// its window starts at 6 350 401.5; the edge key, stored at 6 350 402, took the dip there (−0.0000425 dB) and,
		// as the first key, carried it over the whole lane before the window
		const ds: Dip[] = [{ start: 7_056_001.5, end: 7_056_001.5, depthDb: -59.999, fadeMs: 0 }];
		let i = 0;
		const r = mergeDips({ value: 0, keyframes: [] }, SEQUENCE_LANE, ds, {
			newId: () => `n${i++}`,
			clamp: [-96, 15],
		})!;
		expect(r.keyframes[0]!.value).toBe(0);
		expect(r.keyframes.at(-1)!.value).toBe(0);
		expect(evaluate({ value: 0, keyframes: r.keyframes }, 0)).toBe(0);
		checkLinearDips([], 0, [{ start: 7_056_000, end: 7_056_003, depthDb: 0, fadeMs: 0 }, ...ds], {
			samples: 900,
			step: 5 * MS,
		});
	});
});
