// Premiere's Pitch Shifter → JasperEditor's Pitch Shifter (premiere-pitch-shifter.ts): the normalised Transpose Ratio
// (ratio = 0.5 + 1.5·n) as semitones + cents, keyframes, bypass, instance names, Adobe's splicing settings reported;
// through FCP7 XML (a generated Premiere-style document) and back.
import {
	type Animatable,
	checkInvariants,
	defaultRegistries,
	evaluateKeyframes,
	type Keyframe,
	type Sequence,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportFcp7, importFcp7 } from '../src/fcp7.ts';
import { importTimeline } from '../src/index.ts';
import {
	isPremierePitchShifter,
	jasperPitchToPremiere,
	PREMIERE_PITCH_SHIFTER_MATCH_NAME,
	type PremierePitchParam,
	premierePitchShifterToJasper,
} from '../src/premiere-pitch-shifter.ts';
import { Report } from '../src/report.ts';
import { framesToFlicks } from '../src/time.ts';
import { Harness } from './support/rich.ts';

const S = 705_600_000; // flicks per second
const total = (m: { params: { semitones: Animatable<number>; cents: Animatable<number> } }, t = 0) =>
	evaluateKeyframes(m.params.semitones, t) * 100 + evaluateKeyframes(m.params.cents, t);
const fromRatio = (n: number, extra: PremierePitchParam[] = []) =>
	premierePitchShifterToJasper({ params: [{ name: 'Transpose Ratio', value: n }, ...extra] }, new Report());

/** Premiere's ExtendScript-measured Transpose Ratio of whole semitone shifts (−12…12; public script, see wp-note). */
const SEMITONE_TABLE: [number, number][] = [
	[12, 1],
	[11, 0.9251657128334],
	[7, 0.66553807258606],
	[5, 0.55655986070633],
	[2, 0.41497468948364],
	[1, 0.37297543883324],
	[0, 0.33333334326744],
	[-1, 0.29591619968414],
	[-3, 0.22726428508759],
	[-7, 0.11161327362061],
	[-11, 0.0198210477829],
	[-12, 0],
];

/** A `.prproj` instance as decoded (Spanish names, Precision without a value, plug-in state Version 2). */
const pluginState = (values: number[], version = 2) =>
	`<?xml version='1.0'?>\n<prop.map version='4'>\n<prop.list>\n<prop.pair>\n<key>ParamList</key>\n<array>\n<array.type><float/></array.type>\n${values
		.map((v) => `<float>${v}</float>\n`)
		.join(
			'',
		)}</array>\n</prop.pair>\n<prop.pair>\n<key>Type</key>\n<int type='signed' size='32'>0</int>\n</prop.pair>\n<prop.pair>\n<key>Version</key>\n<float>${version}</float>\n</prop.pair>\n</prop.list>\n</prop.map>\n`;
const spanish = (
	ratio: number,
	extra: Partial<Record<string, PremierePitchParam>> = {},
): PremierePitchParam[] => {
	const base: Record<string, PremierePitchParam> = {
		Derivar: { name: 'Derivar', value: null },
		'Transponer proporción': { name: 'Transponer proporción', value: ratio },
		Precisión: { name: 'Precisión', value: null },
		Lineatura: { name: 'Lineatura', value: 0.088465765119 },
		Superposición: { name: 'Superposición', value: 0.583365321159 },
		'Usar ajuste predeterminado': { name: 'Usar ajuste predeterminado', value: 0.75 },
		'Utilizar centenas positivas': { name: 'Utilizar centenas positivas', value: 0.75 },
	};
	return Object.values({ ...base, ...extra }) as PremierePitchParam[];
};

describe('Premiere Pitch Shifter: Transpose Ratio', () => {
	it("reads the whole semitones of Premiere's measured table exactly", () => {
		for (const [st, n] of SEMITONE_TABLE) {
			const m = fromRatio(n);
			expect(m.params.semitones.value, String(st)).toBe(st);
			expect(m.params.cents.value, String(st)).toBe(0);
		}
	});

	it("the user's values: 0.2995 is −90.04 cents (−1 st +9.96 c with Use Positive Cents, else 0 st −90.04 c)", () => {
		const m = fromRatio(0.29954681, [{ name: 'Use Positive Cents', value: 0.75 }]);
		expect(m.decoded.totalCents).toBe(-90.04);
		expect(m.decoded.ratio).toBeCloseTo(0.94932, 5);
		expect([m.params.semitones.value, m.params.cents.value]).toEqual([-1, 9.96]);
		const n = fromRatio(0.29954681, [{ name: 'Use Positive Cents', value: 0.25 }]);
		expect([n.params.semitones.value, n.params.cents.value]).toEqual([0, -90.04]);
		const cases: [number, number][] = [
			[0.303227752447, -80],
			[0.310624212027, -60],
			[0.318106651306, -40],
			[0.325675994158, -20],
			[0.414974689484, 200],
		];
		for (const [v, c] of cases) expect(fromRatio(v).decoded.totalCents, String(v)).toBe(c);
	});

	it('exports every shift within an octave using the documented ratio formula', () => {
		fc.assert(
			fc.property(fc.integer({ min: -12, max: 12 }), fc.integer({ min: -99, max: 99 }), (st, c) => {
				fc.pre(Math.abs(st * 100 + c) <= 1200);
				const p = jasperPitchToPremiere(
					{ semitones: { value: st, keyframes: [] }, cents: { value: c, keyframes: [] } },
					new Report(),
				);
				// wp-note §2: frequency ratio = 2^(cents/1200), normalized ratio = (ratio−0.5)/1.5.
				expect(p.ratio.value).toBeCloseTo((2 ** ((st * 100 + c) / 1200) - 0.5) / 1.5, 12);
				expect(p.positiveCents).toBe(c >= 0);
			}),
		);
	});

	it('clamps shifts beyond an octave on export, and a Transpose Ratio outside 0…1 on import (reported)', () => {
		const r = new Report();
		const p = jasperPitchToPremiere(
			{ semitones: { value: 12, keyframes: [] }, cents: { value: 100, keyframes: [] } },
			r,
		);
		expect(p.ratio.value).toBe(1);
		expect(r.warnings.some((w) => w.message.includes('clamped'))).toBe(true);
		const ri = new Report();
		const m = premierePitchShifterToJasper(
			{ params: [{ name: 'Transpose Ratio', value: -0.5 }], ratioScale: 'normalized' },
			ri,
		);
		expect(m.decoded.totalCents).toBe(-1200);
		expect(ri.warnings.some((w) => w.message.includes('clamped'))).toBe(true);
	});

	it('reads a displayed ratio (0.5…2) when asked, or when a value is above 1', () => {
		expect(
			premierePitchShifterToJasper(
				{ params: [{ name: 'Transpose Ratio', value: 0.75 }], ratioScale: 'ratio' },
				new Report(),
			).decoded.totalCents,
		).toBe(-498.045);
		expect(fromRatio(1.5).decoded.ratio).toBe(1.5);
	});
});

describe('Premiere Pitch Shifter: the decoded instance', () => {
	it('a .prproj instance: Spanish names, the instance name, Precision from the plug-in state, nothing reported', () => {
		const report = new Report();
		const m = premierePitchShifterToJasper(
			{
				params: spanish(0.299546808004),
				bypass: false,
				instanceName: 'Voice FX',
				pluginState: pluginState([0.29954681, 1, 0.088465765, 0.58336532, 0.75, 0.75]),
			},
			report,
		);
		expect(m).toMatchObject({ effectId: 'jasper.audio.pitch-shifter', enabled: true, name: 'Voice FX' });
		expect(m.decoded).toMatchObject({
			precision: 'high',
			useDefaults: true,
			positiveCents: true,
			totalCents: -90.04,
		});
		expect(m.decoded.splicing).toBeCloseTo(0.088465765119, 12);
		expect([m.params.semitones.value, m.params.cents.value]).toEqual([-1, 9.96]);
		expect(report.entries).toEqual([]);
		// The effect's display name is not an instance name.
		expect(
			premierePitchShifterToJasper({ params: spanish(0.3), instanceName: 'Desfasador de tono' }, new Report())
				.name,
		).toBeUndefined();
	});

	it('bypass (the component flag or the Bypass parameter) disables the effect', () => {
		expect(premierePitchShifterToJasper({ params: spanish(0.3), bypass: true }, new Report()).enabled).toBe(
			false,
		);
		expect(
			premierePitchShifterToJasper(
				{ params: spanish(0.3, { Derivar: { name: 'Derivar', value: true } }) },
				new Report(),
			).enabled,
		).toBe(false);
	});

	it('the keyframed Use Positive Cents (0.75 → 0.25) changes nothing audible and is reported as ignored', () => {
		const report = new Report();
		const m = premierePitchShifterToJasper(
			{
				params: spanish(0.299546808004, {
					'Utilizar centenas positivas': {
						name: 'Utilizar centenas positivas',
						value: 0.75,
						keyframes: [{ time: 4403109110400 / 360, value: 0.25, interpolation: 'linear' }],
					},
				}),
			},
			report,
		);
		expect(m.decoded.totalCents).toBe(-90.04);
		expect(m.params.semitones.keyframes).toEqual([]);
		expect(report.warnings).toEqual([]);
		expect(report.mentions('Use Positive Cents')).toBe(true);
	});

	it('reports custom splicing settings and a non-default Precision (Audition-style names)', () => {
		const report = new Report();
		premierePitchShifterToJasper(
			{
				params: [
					{ name: 'Transpose Ratio', value: 0.2959333 },
					{ name: 'Precision', value: 0 },
					{ name: 'Frequency', value: 0.040404 },
					{ name: 'Overlapping', value: 0.8 },
					{ name: 'Use Default Setting', value: 0.25 },
				],
			},
			report,
		);
		expect(report.warnings.map((w) => w.message).join('\n')).toMatch(/Splicing Frequency \/ Overlapping/);
		expect(report.warnings.map((w) => w.message).join('\n')).toMatch(/Precision "low"/);
	});

	it('reads parameters by ExtendScript match name or index when names are localised otherwise', () => {
		const a = premierePitchShifterToJasper(
			{ params: [{ name: 'Transponieren', id: 'ADBE Pitch Shifter-0001', value: 0.22726428508759 }] },
			new Report(),
		);
		expect(a.decoded.totalCents).toBe(-300);
		const b = premierePitchShifterToJasper({ params: [{ name: '?', index: 1, value: 1 }] }, new Report());
		expect(b.decoded.totalCents).toBe(1200);
	});

	it('state-only Version 1 and Version 2 instances retain pitch and missing state defaults safely', () => {
		for (const version of [1, 2]) {
			const report = new Report();
			const m = premierePitchShifterToJasper(
				{
					params: [],
					pluginState: pluginState(
						[0.41497469, 1, 0.085, 0.56, 0.75, ...(version === 2 ? [0.75] : [])],
						version,
					),
				},
				report,
			);
			expect([m.params.semitones.value, m.params.cents.value]).toEqual([2, 0]);
			expect(report.warnings).toEqual([]);
		}
		const m = premierePitchShifterToJasper({ params: [], pluginState: '<prop.map>' }, new Report());
		expect([m.params.semitones.value, m.params.cents.value]).toEqual([0, 0]);
	});

	it('identifies the effect by match name, the Spanish name or a Premiere-only parameter, not by JasperEditor id', () => {
		expect(isPremierePitchShifter(PREMIERE_PITCH_SHIFTER_MATCH_NAME, 'Voice FX')).toBe(true);
		expect(isPremierePitchShifter('ADBE Pitch Shifter', null)).toBe(true);
		expect(isPremierePitchShifter('x', 'Desfasador de tono')).toBe(true);
		expect(isPremierePitchShifter('Pitch Shifter', 'Pitch Shifter', ['Transpose Ratio'])).toBe(true);
		expect(isPremierePitchShifter('jasper.audio.pitch-shifter', 'Pitch Shifter', ['Transpose Ratio'])).toBe(
			false,
		);
		expect(isPremierePitchShifter('Pitch Shifter', 'Pitch Shifter', ['semitones', 'cents'])).toBe(false);
	});

	it('never throws on garbage and only produces valid Pitch Shifter values (fuzz)', () => {
		const scalar = fc.oneof(fc.double(), fc.boolean(), fc.string({ maxLength: 8 }), fc.constant(null));
		const name = fc.constantFrom(
			'Transpose Ratio',
			'Transponer proporción',
			'Precision',
			'Use Positive Cents',
			'Use Default Setting',
			'Bypass',
			'Overlapping',
			'???',
		);
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						name,
						value: scalar,
						keyframes: fc.option(
							fc.array(
								fc.record({
									time: fc.double(),
									value: scalar,
									interpolation: fc.constantFrom('linear', 'hold', 'bezier', 'nope'),
								}),
								{ maxLength: 4 },
							),
							{ nil: undefined },
						),
					}),
					{ maxLength: 10 },
				),
				fc.anything(),
				fc.anything(),
				(params, state, inst) => {
					const m = premierePitchShifterToJasper(
						{
							params: params as PremierePitchParam[],
							pluginState: state as string,
							instanceName: inst as string,
						},
						new Report(),
					);
					for (const a of [m.params.semitones, m.params.cents]) {
						expect(Number.isFinite(a.value)).toBe(true);
						for (const k of a.keyframes) {
							expect(Number.isFinite(k.value) && Number.isInteger(k.time) && k.time >= 0).toBe(true);
						}
					}
					expect(Math.abs(m.params.semitones.value)).toBeLessThanOrEqual(12);
					expect(Math.abs(m.params.cents.value)).toBeLessThanOrEqual(100);
				},
			),
		);
		expect(() => premierePitchShifterToJasper(null as never, new Report())).not.toThrow();
		expect(() => jasperPitchToPremiere(null as never, new Report())).not.toThrow();
		expect(() =>
			jasperPitchToPremiere(
				{ semitones: { value: Number.NaN, keyframes: [null] }, cents: 'x' },
				new Report(),
			),
		).not.toThrow();
	});
});

describe('Premiere Pitch Shifter: keyframes', () => {
	/** Independent piecewise-linear normalized-ratio curve, wp-note §2 (no production mapping/evaluator). */
	const premiereCents = (keys: [number, number][], t: number) => {
		const end = keys.findIndex(([time]) => time > t);
		const [ta, a] = keys[end < 0 ? keys.length - 1 : Math.max(0, end - 1)]!;
		const [tb, b] = keys[end < 0 ? keys.length - 1 : end]!;
		const n = tb === ta ? a : a + ((t - ta) / (tb - ta)) * (b - a);
		return 1200 * Math.log2(0.5 + 1.5 * n);
	};

	it('keeps every keyframe time and follows the linear-ratio curve within the tolerance (property)', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 20 * S }), { minLength: 2, maxLength: 5 }),
				fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 5, maxLength: 5 }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				(times, values, u) => {
					const keys = [...times].sort((a, b) => a - b).map((t, i) => [t, values[i]!] as [number, number]);
					const report = new Report();
					const m = premierePitchShifterToJasper(
						{
							params: [
								{
									name: 'Transpose Ratio',
									value: keys[0]![1],
									keyframes: keys.map(([time, value]) => ({ time, value, interpolation: 'linear' as const })),
								},
							],
						},
						report,
					);
					const kt = m.params.semitones.keyframes.map((k) => k.time);
					for (const [t] of keys) expect(kt).toContain(t);
					expect(m.params.cents.keyframes.map((k) => k.time)).toEqual(kt);
					const t = Math.round(keys[0]![0] + u * (keys[keys.length - 1]![0] - keys[0]![0]));
					expect(Math.abs(total(m, t) - premiereCents(keys, t))).toBeLessThanOrEqual(0.11);
				},
			),
			{ numRuns: 60, examples: [[[0, 2 * S], [0, 1, 0, 0, 0], 0.5]] },
		);
	});

	it('a hold key stays a hold; equal keys add nothing', () => {
		const report = new Report();
		const m = premierePitchShifterToJasper(
			{
				params: [
					{
						name: 'Transpose Ratio',
						value: 0,
						keyframes: [
							{ time: 0, value: 0, interpolation: 'hold' },
							{ time: S, value: 1, interpolation: 'linear' },
						],
					},
				],
			},
			report,
		);
		expect(m.params.semitones.keyframes.map((k) => [k.time, k.value, k.interpolation])).toEqual([
			[0, -12, 'hold'],
			[S, 12, 'linear'],
		]);
		expect(total(m, S / 2)).toBe(-1200);
		const flat = fromRatio(0.4, []);
		expect(flat.params.semitones.keyframes).toEqual([]);
	});

	it('exports JasperEditor keyframes so Premiere follows the semitone curve within the tolerance', () => {
		const lin = (time: number, value: number): Keyframe<number> => ({
			id: `k${time}`,
			time,
			value,
			interpolation: 'linear',
			easeIn: { influence: 1 / 3, slope: 1 },
			easeOut: { influence: 1 / 3, slope: 1 },
		});
		const st: Animatable<number> = { value: -12, keyframes: [lin(0, -12), lin(2 * S, 12)] };
		const ce: Animatable<number> = { value: 0, keyframes: [] };
		const p = jasperPitchToPremiere({ semitones: st, cents: ce }, new Report());
		expect(p.ratio.keyframes[0]!.time).toBe(0);
		expect(p.ratio.keyframes.at(-1)!.time).toBe(2 * S);
		for (let i = 0; i <= 50; i++) {
			const t = Math.round((i / 50) * 2 * S);
			const premiere = 1200 * Math.log2(0.5 + 1.5 * evaluateKeyframes(p.ratio, t));
			expect(Math.abs(premiere - (-1200 + 2400 * (t / (2 * S)))), String(t)).toBeLessThanOrEqual(0.11);
		}
	});
});

/** A generated Premiere-style FCP7 document: one 30 fps audio clip with a Pitch Shifter filter. */
function xml(filter: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4"><sequence id="sequence-1"><name>S</name><duration>300</duration><rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
<media><audio><track>
<clipitem id="clipitem-1"><name>voice</name><rate><timebase>30</timebase></rate><start>0</start><end>300</end><in>0</in><out>300</out>
<file id="file-1"><name>voice.wav</name><pathurl>file:///m/voice.wav</pathurl><duration>600</duration><rate><timebase>30</timebase></rate>
<media><audio><samplecharacteristics><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>
<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
${filter}
</clipitem>
</track></audio></media></sequence></xmeml>`;
}
const p = (name: string, value: string | number, extra = '') =>
	`<parameter authoringApp="PremierePro"><parameterid>${name}</parameterid><name>${name}</name><valuemin>0</valuemin><valuemax>1</valuemax><value>${value}</value>${extra}</parameter>`;
const pitchFilter = (inner: string, opts: { name?: string; enabled?: boolean } = {}) =>
	`<filter>${opts.enabled === false ? '<enabled>FALSE</enabled>' : ''}<effect><name>${opts.name ?? 'Pitch Shifter'}</name><effectid>${PREMIERE_PITCH_SHIFTER_MATCH_NAME}</effectid><effectcategory>Time and Pitch</effectcategory><effecttype>filter</effecttype><mediatype>audio</mediatype>${inner}</effect></filter>`;
const audioClip = (text: string, report = new Report()) => {
	const proj = importFcp7(text, { baseDir: '/m' }, report);
	return { proj, clip: Object.values(proj.sequences)[0]!.audio[0]!.clips[0]!, report };
};

describe('FCP7 XML (Premiere dialect): Pitch Shifter', () => {
	it('imports the normalised Transpose Ratio with keyframes, the switches and the instance name', () => {
		const rate = { num: 30, den: 1 };
		const { clip, report } = audioClip(
			xml(
				pitchFilter(
					p(
						'Transpose Ratio',
						0.29954681,
						'<keyframe><when>0</when><value>0.29954681</value></keyframe><keyframe><when>150</when><value>0.414974689</value></keyframe>',
					) +
						p('Precision', 1) +
						p('Use Appropriate Default Settings', 0.75) +
						p('Use Positive Cents', 0.75),
					{ name: 'Voice FX' },
				),
			),
		);
		const fx = clip.effects.find((e) => e.effectId === 'jasper.audio.pitch-shifter')!;
		expect(fx).toMatchObject({ enabled: true, name: 'Voice FX' });
		const st = fx.params.semitones as Animatable<number>;
		const ce = fx.params.cents as Animatable<number>;
		const at = (t: number) => evaluateKeyframes(st, t) * 100 + evaluateKeyframes(ce, t);
		expect(at(0)).toBeCloseTo(-90.04, 9);
		expect(at(framesToFlicks(150, rate))).toBe(200);
		// intermediate keys on frames, Premiere's curve within the tolerance
		for (const k of st.keyframes) expect(k.time % framesToFlicks(1, rate)).toBe(0);
		const mid = framesToFlicks(75, rate);
		const premiereMid = 1200 * Math.log2(0.5 + 1.5 * ((0.29954681 + 0.414974689) / 2));
		expect(Math.abs(at(mid) - premiereMid)).toBeLessThanOrEqual(0.11);
		expect(report.warnings).toEqual([]);
	});

	it('a disabled filter is a bypassed (disabled) effect; Spanish names; a ratio-scaled parameter', () => {
		const { clip } = audioClip(
			xml(
				pitchFilter(
					`<parameter><parameterid>Transponer proporción</parameterid><name>Transponer proporción</name><valuemin>0.5</valuemin><valuemax>2</valuemax><value>1.122462048</value></parameter>`,
					{ name: 'Desfasador de tono', enabled: false },
				),
			),
		);
		const fx = clip.effects[0]!;
		expect(fx.effectId).toBe('jasper.audio.pitch-shifter');
		expect(fx.enabled).toBe(false);
		expect(fx.name).toBeUndefined();
		expect([fx.params.semitones!.value, fx.params.cents!.value]).toEqual([2, 0]);
	});

	it("JasperEditor's own Pitch Shifter filters (semitones / cents by id) still read back", () => {
		const { clip } = audioClip(
			xml(
				`<filter><effect><name>Pitch Shifter</name><effectid>jasper.audio.pitch-shifter</effectid><effecttype>filter</effecttype><mediatype>audio</mediatype>${p('semitones', 3).replace('<valuemax>1</valuemax>', '<valuemax>12</valuemax>')}${p('cents', 25).replace('<valuemax>1</valuemax>', '<valuemax>100</valuemax>')}</effect></filter>`,
			),
		);
		expect([clip.effects[0]!.params.semitones!.value, clip.effects[0]!.params.cents!.value]).toEqual([3, 25]);
	});

	it("exports in Premiere's representation and reads back the same shift, keyframes and bypass", () => {
		const first = audioClip(
			xml(
				pitchFilter(
					p(
						'Transpose Ratio',
						0.22726428508759,
						'<keyframe><when>30</when><value>0.22726428508759</value></keyframe><keyframe><when>90</when><value>0.55655986070633</value><interpolation><name>hold</name></interpolation></keyframe><keyframe><when>120</when><value>0.33333334</value></keyframe>',
					),
					{ enabled: false },
				),
			),
		);
		const report = new Report();
		const text = exportFcp7(first.proj, first.proj.top[0]!, {}, report);
		expect(text).toContain(`<effectid>${PREMIERE_PITCH_SHIFTER_MATCH_NAME}</effectid>`);
		expect(text).toContain('<name>Transpose Ratio</name>');
		expect(text).not.toContain('<parameterid>semitones</parameterid>');
		expect(report.warnings).toEqual([]);
		const again = audioClip(text);
		const b = again.clip.effects[0]!;
		expect(b.enabled).toBe(false);
		const cents = (fx: typeof b, t: number) =>
			evaluateKeyframes(fx.params.semitones as Animatable<number>, t) * 100 +
			evaluateKeyframes(fx.params.cents as Animatable<number>, t);
		for (let f = 0; f <= 150; f += 5) {
			const t = framesToFlicks(f, { num: 30, den: 1 });
			// Original XML: linear normalized ratio from frames30→90, then a hold to120.
			const expected =
				f < 30
					? -300
					: f < 90
						? 1200 *
							Math.log2(
								0.5 + 1.5 * (0.22726428508759 + ((f - 30) / 60) * (0.55655986070633 - 0.22726428508759)),
							)
						: f < 120
							? 500
							: 0;
			expect(Math.abs(cents(b, t) - expected), String(f)).toBeLessThanOrEqual(0.21);
		}
		expect(cents(b, framesToFlicks(100, { num: 30, den: 1 }))).toBe(500);
	});

	it('into a document: a valid Pitch Shifter effect (invariants)', () => {
		const text = xml(
			pitchFilter(p('Transpose Ratio', 0.303227752447) + p('Use Positive Cents', 0.25), { name: 'Voice FX' }),
		);
		const imp = importTimeline(new TextEncoder().encode(text), {
			format: 'fcp7',
			now: '2026-10-25T00:00:00.000Z',
		});
		const target = new Harness({ preset: 'hd-1080p-30', seed: 91 });
		const r = target.ok([{ type: 'project.importTimeline', fragment: imp }]);
		const seqId = (r.results[0] as { topSequenceIds: string[] }).topSequenceIds[0]!;
		expect(checkInvariants(target.doc, { effects: defaultRegistries().effects })).toEqual([]);
		const seq = target.doc.sequences[seqId] as Sequence;
		const fx = Object.values(seq.clips)
			.flatMap(
				(c) =>
					(
						c as {
							effects?: { effectId: string; name?: string; params: Record<string, { value: unknown }> }[];
						}
					).effects ?? [],
			)
			.find((e) => e.effectId === 'jasper.audio.pitch-shifter')!;
		expect(fx.name).toBe('Voice FX');
		expect([fx.params.semitones!.value, fx.params.cents!.value]).toEqual([0, -80]);
	});
});
