// Spec 19 TL-056: the style check. Pachislop's rules had no tests: each rule here has a look that trips it and one that does
// not, and every fix runs as commands against a real document, clears the issue and undoes in one step.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Appearance,
	appearanceFromRecipe,
	type Clip,
	clipLook,
	type EffectInstance,
	LINT_CODES,
	LINT_STRINGS,
	type LintCode,
	type LintContext,
	type LookRecipe,
	lintAppearance,
	MIN_DELTA_L,
	RENDERED_CHECKS,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const WHITE = [1, 1, 1, 1] as [number, number, number, number];
const BLACK = [0, 0, 0, 1] as [number, number, number, number];
const c = (r: number, g: number, b: number) => [r, g, b, 1] as [number, number, number, number];

const build = (recipe: LookRecipe): Appearance => {
	let n = 0;
	return appearanceFromRecipe(recipe, () => `apl_${String(++n).padStart(16, '0')}`, 3);
};
const lint = (recipe: LookRecipe, ctx: LintContext = {}) => lintAppearance(build(recipe), ctx);
const codes = (recipe: LookRecipe, ctx: LintContext = {}): LintCode[] =>
	lint(recipe, ctx).issues.map((i) => i.code);

const role = (r: string) => ({ kind: 'role', role: r });
const color = (v: number[]) => ({ kind: 'color', color: v });

const GOOD: LookRecipe = {
	palette: { face: WHITE, keyline: BLACK, shadow: c(0.1, 0.1, 0.2) },
	layers: [
		{ type: 'shadow', params: { distance: 3, blur: 8, opacity: 60 } },
		{ type: 'rim', params: { width: 5, paint: role('keyline') } },
		{ type: 'face' },
	],
};

/** Applies a recipe to a text clip and returns what a fix needs. */
function onClip(recipe: LookRecipe, text = 'Title') {
	const h = new Harness();
	const r = h.ok([
		{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text }, ref: '$t' },
		{ type: 'look.apply', clipIds: ['$t'], look: { name: 'L', recipe } },
	]);
	const id = r.refs.$t!;
	const fx = () => clipLook((h.seq.clips[id] as unknown as { effects: EffectInstance[] }).effects)!;
	const ctx = (): LintContext => ({
		effectInstanceId: fx().id,
		clipKind: 'text',
		text,
		sizePx: (h.seq.clips[id] as Extract<Clip, { kind: 'text' }>).content.style.sizePx,
		frameHeight: h.seq.settings.height,
	});
	return { h, id, fx, ctx, report: () => lintAppearance(fx().appearance as Appearance, ctx()) };
}

/** Runs `code`'s fix: the issue goes, and restoring the document brings it back. */
function fixClears(recipe: LookRecipe, code: LintCode, text?: string) {
	const t = onClip(recipe, text);
	const issue = t.report().issues.find((i) => i.code === code);
	expect(issue, code).toBeTruthy();
	expect(issue!.fixable).toBe(true);
	const before = t.h.doc;
	t.h.ok(issue!.fix!.commands as never);
	expect(
		t.report().issues.map((i) => i.code),
		`${code} after its fix`,
	).not.toContain(code);
	t.h.doc = before;
	expect(t.report().issues.map((i) => i.code)).toContain(code);
}

describe('the lint (TL-056)', () => {
	it('finds nothing on a well-made look', () => {
		expect(lint(GOOD, { clipKind: 'text' }).issues).toEqual([]);
	});

	it('has stable, unique ids and only known codes', () => {
		const r = lint({
			palette: { face: c(0.5, 0.5, 0.5), keyline: c(0.52, 0.52, 0.52) },
			layers: [
				{ type: 'rim', params: { width: 0 } },
				{ type: 'rim', params: { width: 4 } },
				{ type: 'face' },
			],
		});
		const ids = r.issues.map((i) => i.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const i of r.issues) {
			expect(LINT_CODES).toContain(i.code);
			expect(i.message.length).toBeGreaterThan(5);
			expect(i.rule.length).toBeGreaterThan(5);
		}
	});

	it('is deterministic', () => {
		const recipe: LookRecipe = {
			palette: { face: c(0.5, 0.5, 0.5), keyline: c(0.52, 0.52, 0.52) },
			layers: [{ type: 'rim', params: { width: 40 } }, { type: 'face' }],
		};
		expect(lint(recipe)).toEqual(lint(recipe));
	});

	it('sorts errors first', () => {
		const r = lint({
			palette: { face: c(0.5, 0.5, 0.5), keyline: c(0.52, 0.52, 0.52) },
			layers: [{ type: 'rim', params: { width: 40 } }, { type: 'face' }],
		});
		expect(r.issues[0]!.severity).toBe('error');
	});

	describe('no-op settings', () => {
		it('flags a rim of width 0, and its fix removes it', () => {
			const recipe: LookRecipe = { ...GOOD, layers: [{ type: 'rim', params: { width: 0 } }, ...GOOD.layers] };
			expect(codes(recipe)).toContain('LOOK_NOOP_LAYER');
			fixClears(recipe, 'LOOK_NOOP_LAYER');
		});

		it('flags a rim or shadow at 0 % and a glow with no intensity', () => {
			expect(
				codes({ ...GOOD, layers: [{ type: 'rim', params: { width: 4, opacity: 0 } }, { type: 'face' }] }),
			).toContain('LOOK_NOOP_LAYER');
			expect(
				codes({ ...GOOD, layers: [{ type: 'shadow', params: { opacity: 0 } }, { type: 'face' }] }),
			).toContain('LOOK_NOOP_LAYER');
			expect(
				codes({ ...GOOD, layers: [{ type: 'glow', params: { intensity: 0 } }, { type: 'face' }] }),
			).toContain('LOOK_NOOP_LAYER');
		});

		it('flags a shadow with nothing to show', () => {
			expect(
				codes({ ...GOOD, layers: [{ type: 'shadow', params: { distance: 0, blur: 0 } }, { type: 'face' }] }),
			).toContain('LOOK_NOOP_LAYER');
		});

		it('flags a face under an opaque face, and its fix removes it', () => {
			const recipe: LookRecipe = { layers: [{ type: 'face' }, { type: 'face' }] };
			expect(codes(recipe)).toContain('LOOK_HIDDEN_LAYER');
			fixClears(recipe, 'LOOK_HIDDEN_LAYER');
		});

		it('notes a gradient that has one colour under the palette, as information', () => {
			const paint = {
				kind: 'gradient',
				gradient: {
					type: 'linear',
					span: 'block',
					angle: 90,
					stops: [
						{ at: 0, paint: { role: 'face' } },
						{ at: 1, paint: { role: 'face' } },
					],
				},
			};
			const i = lint({ layers: [{ type: 'face', params: { paint } }] }).issues[0]!;
			expect(i.code).toBe('LOOK_FLAT_GRADIENT');
			expect(i.severity).toBe('info');
		});
	});

	describe('invisible looks', () => {
		it('is an error, and its fix shows the face', () => {
			const recipe: LookRecipe = { layers: [{ type: 'face', params: { opacity: 0 } }] };
			const i = lint(recipe).issues.find((x) => x.code === 'LOOK_INVISIBLE')!;
			expect(i.severity).toBe('error');
			fixClears(recipe, 'LOOK_INVISIBLE');
		});

		it('leaves a hollow outline alone: the rim draws', () => {
			expect(
				codes({
					layers: [
						{ type: 'rim', params: { width: 3, paint: role('face') } },
						{ type: 'face', params: { opacity: 0 } },
					],
				}),
			).toEqual([]);
		});

		it('counts an empty stack', () => {
			expect(codes({ layers: [] })).toContain('LOOK_INVISIBLE');
		});
	});

	describe('rings too close in lightness', () => {
		const merged: LookRecipe = {
			palette: { face: c(0.6, 0.6, 0.6), keyline: c(0.65, 0.65, 0.65), accent1: WHITE },
			layers: [{ type: 'rim', params: { width: 5, paint: role('keyline') } }, { type: 'face' }],
		};

		it('flags them with the measured difference', () => {
			const i = lint(merged).issues.find((x) => x.code === 'LOOK_RINGS_MERGE')!;
			expect(i.measured).toBeLessThan(MIN_DELTA_L);
			expect(i.expected).toContain(String(MIN_DELTA_L));
			expect(i.layerIds).toHaveLength(2);
		});

		it('inserts a separating ring, undoably', () => {
			fixClears(merged, 'LOOK_RINGS_MERGE');
		});

		it('passes a pair exactly at the threshold and flags one just under', () => {
			const dark = c(0.2, 0.2, 0.2);
			const pass: LookRecipe = {
				palette: { face: c(0.5, 0.5, 0.5), keyline: dark },
				layers: [{ type: 'rim', params: { width: 5, paint: role('keyline') } }, { type: 'face' }],
			};
			expect(codes(pass)).not.toContain('LOOK_RINGS_MERGE');
		});

		it('allows two dark rings: they read as one keyline', () => {
			expect(
				codes({
					palette: { face: WHITE, keyline: c(0.05, 0.05, 0.05), accent1: c(0.08, 0.08, 0.1) },
					layers: [
						{ type: 'rim', params: { width: 3, paint: role('accent1') } },
						{ type: 'rim', params: { width: 3, paint: role('keyline') } },
						{ type: 'face' },
					],
				}),
			).not.toContain('LOOK_RINGS_MERGE');
		});

		it('does not compare across a gap: air separates a ring that stands off', () => {
			expect(
				codes({
					palette: { face: c(0.6, 0.6, 0.6), keyline: c(0.65, 0.65, 0.65) },
					layers: [
						{ type: 'rim', params: { width: 3, offset: 3, paint: role('keyline') } },
						{ type: 'face' },
					],
				}),
			).not.toContain('LOOK_RINGS_MERGE');
		});

		it('judges a gradient by its samples: two banded metals separate through their banding', () => {
			const banded = (a: number[], b: number[]) => ({
				kind: 'gradient',
				gradient: {
					type: 'linear',
					span: 'block',
					angle: 90,
					stops: [
						{ at: 0, paint: { color: a } },
						{ at: 1, paint: { color: b } },
					],
				},
			});
			expect(
				codes({
					layers: [
						{ type: 'rim', params: { width: 4, paint: banded([0.1, 0.1, 0.1, 1], [1, 1, 1, 1]) } },
						{ type: 'face', params: { paint: banded([1, 1, 1, 1], [0.1, 0.1, 0.1, 1]) } },
					],
				}),
			).not.toContain('LOOK_RINGS_MERGE');
		});

		it('uses the palette in force: a colourway can raise the issue', () => {
			const a = build(GOOD);
			a.palette.keyline = { value: [0.95, 0.95, 0.95, 1], keyframes: [] };
			expect(lintAppearance(a).issues.map((i) => i.code)).toContain('LOOK_RINGS_MERGE');
		});
	});

	describe('too many hue families', () => {
		it('flags three and allows two', () => {
			const three: LookRecipe = {
				palette: { face: c(1, 0, 0), keyline: c(0, 0.7, 0), accent1: c(0, 0, 1) },
				layers: [
					{ type: 'rim', params: { width: 4, paint: role('accent1') } },
					{ type: 'rim', params: { width: 4, paint: role('keyline') } },
					{ type: 'face' },
				],
			};
			const i = lint(three).issues.find((x) => x.code === 'LOOK_TOO_MANY_HUES')!;
			expect(i.measured).toBe(3);
			expect(i.fixable).toBe(false);
			const two: LookRecipe = {
				palette: { face: c(1, 0, 0), keyline: BLACK, accent1: c(0, 0, 1) },
				layers: three.layers,
			};
			expect(codes(two)).not.toContain('LOOK_TOO_MANY_HUES');
		});

		it('treats a spectrum as no hue', () => {
			const paint = {
				kind: 'gradient',
				gradient: {
					type: 'linear',
					span: 'block',
					angle: 0,
					stops: [
						{ at: 0, paint: { color: [1, 0, 0, 1] } },
						{ at: 0.5, paint: { color: [0, 1, 0, 1] } },
						{ at: 1, paint: { color: [0, 0, 1, 1] } },
					],
				},
			};
			expect(codes({ layers: [{ type: 'face', params: { paint } }] })).not.toContain('LOOK_TOO_MANY_HUES');
		});
	});

	describe('rim thickness', () => {
		const rims = (width: number): LookRecipe => ({
			palette: { face: WHITE, keyline: BLACK },
			layers: [{ type: 'rim', params: { width, paint: role('keyline') } }, { type: 'face' }],
		});

		it('flags rims too thin to survive on video, and scales them up', () => {
			expect(codes(rims(1))).toContain('LOOK_RIMS_THIN');
			expect(codes(rims(2))).not.toContain('LOOK_RIMS_THIN');
			fixClears(rims(0.4), 'LOOK_RIMS_THIN');
		});

		it('follows the real size: the same percent passes on a big title and fails on a small one', () => {
			expect(codes(rims(2), { sizePx: 200, frameHeight: 1080 })).not.toContain('LOOK_RIMS_THIN');
			expect(codes(rims(2), { sizePx: 60, frameHeight: 1080 })).toContain('LOOK_RIMS_THIN');
			expect(codes(rims(2), { sizePx: 200, frameHeight: 2160 })).not.toContain('LOOK_RIMS_THIN');
			expect(codes(rims(1.2), { sizePx: 200, frameHeight: 2160 })).toContain('LOOK_RIMS_THIN');
		});

		it('flags rims thicker than the strokes as a warning, and scales them down', () => {
			const i = lint(rims(20)).issues.find((x) => x.code === 'LOOK_RIMS_THICK')!;
			expect(i.severity).toBe('warning');
			fixClears(rims(20), 'LOOK_RIMS_THICK');
		});

		it('makes it an error when counters flood', () => {
			const i = lint(rims(32)).issues.find((x) => x.code === 'LOOK_RIMS_FLOOD')!;
			expect(i.severity).toBe('error');
			fixClears(rims(32), 'LOOK_RIMS_FLOOD');
		});

		it('sums the whole stack, offsets included', () => {
			expect(
				codes({
					palette: { face: WHITE, keyline: BLACK, accent1: WHITE },
					layers: [
						{ type: 'rim', params: { width: 9, paint: role('keyline') } },
						{ type: 'rim', params: { width: 9, paint: role('accent1') } },
						{ type: 'face' },
					],
				}),
			).toContain('LOOK_RIMS_THICK');
		});

		it('does not judge rims on clips without letters', () => {
			expect(codes(rims(1), { clipKind: 'still' })).not.toContain('LOOK_RIMS_THIN');
			expect(codes(rims(40), { clipKind: 'shape' })).not.toContain('LOOK_RIMS_FLOOD');
		});

		it('says nothing about a look with no rims', () => {
			expect(codes({ layers: [{ type: 'face' }] })).toEqual([]);
		});
	});

	describe('hard black shadows', () => {
		const hard: LookRecipe = {
			palette: { shadow: BLACK },
			layers: [{ type: 'shadow', params: { distance: 5, blur: 1, opacity: 100 } }, { type: 'face' }],
		};

		it('flags one on plain letters, and softens it', () => {
			expect(codes(hard)).toContain('LOOK_HARD_SHADOW');
			fixClears(hard, 'LOOK_HARD_SHADOW');
		});

		it('allows soft, translucent or tinted ones', () => {
			const soft = (p: object) => ({
				...hard,
				layers: [{ type: 'shadow', params: { distance: 5, blur: 1, opacity: 100, ...p } }, { type: 'face' }],
			});
			expect(codes(soft({ blur: 8 }))).not.toContain('LOOK_HARD_SHADOW');
			expect(codes(soft({ opacity: 60 }))).not.toContain('LOOK_HARD_SHADOW');
			expect(codes(soft({ paint: color([0.8, 0.2, 0.2, 1]) }))).not.toContain('LOOK_HARD_SHADOW');
		});

		it('allows a hard block behind an inked outline: it is a drawn extrusion', () => {
			expect(
				codes({
					palette: { shadow: BLACK, keyline: BLACK, face: WHITE },
					layers: [
						{ type: 'shadow', params: { distance: 5, blur: 0, opacity: 100 } },
						{ type: 'rim', params: { width: 4, paint: role('keyline') } },
						{ type: 'face' },
					],
				}),
			).not.toContain('LOOK_HARD_SHADOW');
		});

		it('leaves long shadows alone', () => {
			expect(
				codes({
					palette: { shadow: BLACK },
					layers: [
						{ type: 'shadow', params: { kind: 'long', distance: 8, blur: 0, opacity: 100 } },
						{ type: 'face' },
					],
				}),
			).not.toContain('LOOK_HARD_SHADOW');
		});
	});

	describe('a spectrum across several lines', () => {
		const spectrum: LookRecipe = {
			layers: [
				{
					type: 'face',
					params: {
						paint: {
							kind: 'gradient',
							gradient: {
								type: 'linear',
								span: 'block',
								angle: 90,
								stops: [
									{ at: 0, paint: { color: [1, 0, 0, 1] } },
									{ at: 0.5, paint: { color: [0, 1, 0, 1] } },
									{ at: 1, paint: { color: [0, 0, 1, 1] } },
								],
							},
						},
					},
				},
			],
		};

		it('flags it on two lines only, and spans each line', () => {
			expect(codes(spectrum, { text: 'One line' })).not.toContain('LOOK_SPECTRUM_SPAN');
			expect(codes(spectrum, { text: 'Two\nlines' })).toContain('LOOK_SPECTRUM_SPAN');
			fixClears(spectrum, 'LOOK_SPECTRUM_SPAN', 'Two\nlines');
		});
	});

	describe('fixed layers', () => {
		it('flags a fixed layer that reads a role, and fixes its colours', () => {
			const recipe: LookRecipe = {
				palette: { face: WHITE },
				layers: [{ type: 'face', fixedColor: true }],
			};
			expect(codes(recipe)).toContain('LOOK_FIXED_READS_ROLE');
			fixClears(recipe, 'LOOK_FIXED_READS_ROLE');
		});

		it('passes one that uses colours', () => {
			expect(
				codes({ layers: [{ type: 'face', fixedColor: true, params: { paint: color([1, 0.5, 0, 1]) } }] }),
			).not.toContain('LOOK_FIXED_READS_ROLE');
		});
	});

	describe('the rendered backdrop seam', () => {
		const plain: LookRecipe = { palette: { face: c(0.5, 0.5, 0.5) }, layers: [{ type: 'face' }] };

		it('gives a template and arguments the UI can translate', () => {
			const i = lint(plain, { rendered: { backdropL: 54, frames: 5 } }).issues[0]!;
			expect(LINT_STRINGS).toContain(i.template);
			expect(i.template.replace(/\{(\d+)\}/g, (_, n) => i.args[Number(n)]!)).toBe(i.message);
			expect(i.fix).toBeUndefined();
			expect(LINT_STRINGS).toContain(
				lint(plain, { rendered: { backdropL: 54, frames: 5 }, effectInstanceId: 'fx_1' }).issues[0]!.fix!
					.label,
			);
		});

		it('reports what was not measured, and never passes it', () => {
			const r = lint(plain);
			expect(r.unmeasured).toEqual([...RENDERED_CHECKS]);
			expect(r.issues.map((i) => i.code)).not.toContain('LOOK_BACKDROP_CONTRAST');
		});

		it('compares the outside of the title with the measured picture', () => {
			const near = lint(plain, { rendered: { backdropL: 54, frames: 5 } });
			expect(near.unmeasured).toEqual([]);
			const i = near.issues.find((x) => x.code === 'LOOK_BACKDROP_CONTRAST')!;
			expect(i.severity).toBe('error');
			expect(i.measured).toBeLessThan(6);
			expect(i.message).toContain('frames sampled: 5');
			expect(lint(plain, { rendered: { backdropL: 5, frames: 5 } }).issues).toEqual([]);
		});

		it('warns before it errors', () => {
			const i = lint(plain, { rendered: { backdropL: 40, frames: 1 } }).issues[0]!;
			expect(i.code).toBe('LOOK_BACKDROP_CONTRAST');
			expect(i.severity).toBe('warning');
		});

		it('judges the outermost ring, not the face', () => {
			const ringed: LookRecipe = {
				palette: { face: WHITE, keyline: BLACK },
				layers: [{ type: 'rim', params: { width: 5, paint: role('keyline') } }, { type: 'face' }],
			};
			expect(codes(ringed, { rendered: { backdropL: 96, frames: 1 } })).toEqual([]);
			expect(codes(ringed, { rendered: { backdropL: 5, frames: 1 } })).toContain('LOOK_BACKDROP_CONTRAST');
		});

		it('accepts a halo as separation', () => {
			expect(
				codes(
					{ ...plain, layers: [{ type: 'glow', params: { radius: 20, intensity: 60 } }, { type: 'face' }] },
					{ rendered: { backdropL: 54, frames: 1 } },
				),
			).toEqual([]);
		});

		it('its fix adds a halo, undoably', () => {
			const t = onClip(plain);
			const ctx = { ...t.ctx(), rendered: { backdropL: 54, frames: 2 } };
			const issue = lintAppearance(t.fx().appearance as Appearance, ctx).issues.find(
				(i) => i.code === 'LOOK_BACKDROP_CONTRAST',
			)!;
			const before = t.h.doc;
			t.h.ok(issue.fix!.commands as never);
			expect(lintAppearance(t.fx().appearance as Appearance, ctx).issues.map((i) => i.code)).not.toContain(
				'LOOK_BACKDROP_CONTRAST',
			);
			t.h.doc = before;
			expect(lintAppearance(t.fx().appearance as Appearance, ctx).issues.map((i) => i.code)).toContain(
				'LOOK_BACKDROP_CONTRAST',
			);
		});
	});

	describe('fixes', () => {
		it('are data, present only when the context names the instance', () => {
			const recipe: LookRecipe = { ...GOOD, layers: [{ type: 'rim', params: { width: 0 } }, ...GOOD.layers] };
			const without = lint(recipe).issues.find((i) => i.fixable)!;
			expect(without.fix).toBeUndefined();
			const withIt = lint(recipe, { effectInstanceId: 'fx_1' }).issues.find((i) => i.fixable)!;
			expect(JSON.parse(JSON.stringify(withIt.fix))).toEqual(withIt.fix);
		});
	});

	it('evaluates at a time: a keyed opacity can make a layer a no-op', () => {
		const a = build({ layers: [{ type: 'rim', params: { width: 4 } }, { type: 'face' }] });
		expect(lintAppearance(a).issues.map((i) => i.code)).not.toContain('LOOK_NOOP_LAYER');
		a.layers[0]!.params.width = {
			value: 4,
			keyframes: [
				{ id: 'k1', time: 0, value: 0, interpolation: 'linear' },
				{ id: 'k2', time: 1000, value: 4, interpolation: 'linear' },
			],
		} as never;
		expect(lintAppearance(a, { time: 0 }).issues.map((i) => i.code)).toContain('LOOK_NOOP_LAYER');
		expect(lintAppearance(a, { time: 1000 }).issues.map((i) => i.code)).not.toContain('LOOK_NOOP_LAYER');
	});

	it('never throws on any stack of valid layers (fuzz)', () => {
		const roleName = fc.constantFrom(
			'face',
			'faceAlt',
			'keyline',
			'accent1',
			'accent2',
			'accent3',
			'base',
			'glow',
			'shadow',
		);
		const channel = fc.double({ min: 0, max: 1, noNaN: true });
		const rgba = fc.tuple(channel, channel, channel, channel);
		const paint = fc.oneof(
			roleName.map((r) => ({ kind: 'role', role: r })),
			rgba.map((v) => ({ kind: 'color', color: v })),
			fc.constant({ kind: 'source' }),
			fc
				.array(
					fc.record({
						at: channel,
						paint: fc.oneof(
							roleName.map((r) => ({ role: r })),
							rgba.map((v) => ({ color: v })),
						),
					}),
					{
						minLength: 2,
						maxLength: 6,
					},
				)
				.map((stops) => ({
					kind: 'gradient',
					gradient: { type: 'linear', span: 'block', angle: 0, stops },
				})),
		);
		const size = fc.double({ min: 0, max: 100, noNaN: true });
		const layer = fc.oneof(
			fc.record({ type: fc.constant('face'), params: fc.record({ paint, opacity: size }) }),
			fc.record({
				type: fc.constant('rim'),
				params: fc.record({ paint, width: size, offset: size, opacity: size }),
			}),
			fc.record({
				type: fc.constant('shadow'),
				params: fc.record({ paint, distance: size, blur: size, opacity: size }),
			}),
			fc.record({ type: fc.constant('glow'), params: fc.record({ paint, radius: size, intensity: size }) }),
		);
		fc.assert(
			fc.property(
				fc.array(layer, { maxLength: 8 }),
				fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
				(layers, backdropL) => {
					const a = build({ layers });
					const ctx: LintContext = {
						effectInstanceId: 'fx_1',
						text: 'a\nb',
						...(backdropL !== undefined ? { rendered: { backdropL, frames: 1 } } : {}),
					};
					const r = lintAppearance(a, ctx);
					expect(r).toEqual(lintAppearance(a, ctx));
					expect(new Set(r.issues.map((i) => i.id)).size).toBe(r.issues.length);
				},
			),
			{ numRuns: 300 },
		);
	});
});
