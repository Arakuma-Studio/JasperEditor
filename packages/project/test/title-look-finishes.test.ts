// Spec 19 finishes, in the pure model: media reach (TL-021), span records (TL-036), curves, plate padding. GL behaviour:
// packages/compositions/test/title-look-finishes-gl.test.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	appearanceFromRecipe,
	appearanceProblem,
	appearanceWantsTextSpans,
	buildRenderSnapshot,
	buildTextSpans,
	type Clip,
	clearEffectMedia,
	clipParamMediaIds,
	curveLut,
	effectMediaRefs,
	gradientSpanOn,
	layerPropertySpecs,
	lookReach,
	MAX_SPAN_GLYPHS,
	mediaUsage,
	paramValueProblem,
	planGpuEffect,
	planTitleLook,
	resolveAppearance,
	type SpanBox,
	TITLE_FINISHES,
	TITLE_LAYER_TYPES,
	TITLE_MATERIAL_EFFECT,
	titleLayerType,
	titleLookPadding,
	titleLookUniforms,
	validateGpuEffect,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

let n = 0;
const ids = () => `apl_${String(++n).padStart(16, '0')}`;

const texelCount = (u: unknown) => ((u as { texels: Float32Array }).texels.length / 4) | 0;

describe('registry', () => {
	it('types that take a finish have a `paint` param (glass refracts it) and declare handles', () => {
		for (const t of TITLE_LAYER_TYPES.filter((x) => x.finish))
			expect(
				t.params.some((p) => p.name === 'paint' && p.type === 'paint'),
				t.type,
			).toBe(true);
		for (const type of ['inline', 'plate', 'sheen', 'gloss', 'texture'])
			expect(titleLayerType(type)?.handles?.length, type).toBeGreaterThan(0);
		const sheen = titleLayerType('sheen')!;
		expect(sheen.handles).toContainEqual({ kind: 'position', params: ['position'] });
		expect(titleLayerType('rim')!.handles).toContainEqual({ kind: 'angle', params: ['paintAngle'] });
	});

	it('finish params reach Effect Controls, and motif names stay generic', () => {
		const specs = layerPropertySpecs(
			{ id: 'fx_0000000000000001' },
			{
				id: 'apl_0000000000000001',
				type: 'face',
				enabled: true,
				params: { finish: { value: 'bevel', keyframes: [] } } as never,
			},
		);
		expect(specs.some((s) => s.key.endsWith('.bevelSize'))).toBe(true);
		const motif = titleLayerType('texture')!.params.find((p) => p.name === 'motif')!;
		for (const o of motif.type === 'enum' ? (motif.options ?? []) : []) expect(o).toMatch(/^[a-zA-Z]+$/);
	});

	it('Title Material is a valid effect, searchable, sharing the finishes’ params', () => {
		expect(validateGpuEffect(TITLE_MATERIAL_EFFECT)).toEqual([]);
		expect(TITLE_MATERIAL_EFFECT.keywords).toEqual(
			expect.arrayContaining(['chrome', 'bevel', 'glass', 'satin']),
		);
		const names = TITLE_MATERIAL_EFFECT.params.map((p) => p.name);
		expect(new Set(names).size).toBe(names.length);
		for (const id of ['bevel', 'metal', 'glass', 'satin'])
			for (const p of TITLE_FINISHES.find((f) => f.id === id)!.params) expect(names).toContain(p.name);
	});

	it('Title Material binds the Intensity its look’s output pass reads, so it shows in full (TL-089)', () => {
		// Integration: the output pass mixes by `u_lookIntensity`, a param of `jasper.title-look` only; unbound, every
		// Title Material shader failed to compile (undeclared identifier).
		const defaults = Object.fromEntries(TITLE_MATERIAL_EFFECT.params.map((p) => [p.name, p.default]));
		const ctx = {
			width: 320,
			height: 180,
			pxScale: 1,
			fps: 30,
			frame: 0,
			duration: 30,
			seed: 0.5,
			progress: 0,
		};
		for (const material of ['bevel', 'chrome', 'glass', 'satin']) {
			const plan = planGpuEffect(TITLE_MATERIAL_EFFECT, { id: 'f', params: { ...defaults, material } }, ctx, {
				width: 320,
				height: 180,
			});
			expect(
				plan.passes.some((p) => p.source.includes('u_lookIntensity')),
				material,
			).toBe(true);
			expect(plan.uniforms.find((u) => u.name === 'u_lookIntensity')?.value, material).toEqual([100]);
		}
	});
});

describe('params', () => {
	it('a bevel curve is validated on entry', () => {
		const spec = TITLE_FINISHES.find((f) => f.id === 'bevel')!.params.find((p) => p.name === 'bevelCurve')!;
		expect(
			paramValueProblem(spec, {
				curve: [
					[0, 0],
					[1, 1],
				],
			}),
		).toBeNull();
		expect(paramValueProblem(spec, { curve: 'no' })).toBeTruthy();
		expect(paramValueProblem(spec, 3)).toBeTruthy();
		const bad = appearanceFromRecipe(
			{ layers: [{ type: 'face', params: { finish: 'bevel', bevelCurve: { curve: [[0, 0]] } } }] },
			ids,
		);
		expect(appearanceProblem(bad)).toMatch(/curve/);
	});

	it('curveLut is total, bounded and monotone between monotone points', () => {
		const point = fc.tuple(fc.double({ noDefaultInfinity: false }), fc.double());
		fc.assert(
			fc.property(fc.array(point, { maxLength: 40 }), (pts) => {
				const u = curveLut({ curve: pts }) as { texels: Float32Array };
				expect(u.texels.length).toBe(256 * 4);
				for (let i = 0; i < 256; i++) {
					expect(u.texels[i * 4]).toBeGreaterThanOrEqual(0);
					expect(u.texels[i * 4]).toBeLessThanOrEqual(1);
				}
			}),
		);
		const up = curveLut({
			curve: [
				[0, 0],
				[0.3, 0.8],
				[1, 1],
			],
		}) as { texels: Float32Array };
		for (let i = 1; i < 256; i++)
			expect(up.texels[i * 4]! + 1e-6).toBeGreaterThanOrEqual(up.texels[(i - 1) * 4]!);
		expect(curveLut('garbage')).toEqual(
			curveLut({
				curve: [
					[0, 0],
					[1, 1],
				],
			}),
		);
	});
});

describe('plate padding', () => {
	const look = (params: Record<string, unknown>) =>
		resolveAppearance(appearanceFromRecipe({ layers: [{ type: 'plate', params }] }, ids), 0);
	it('a plate reaches its grow; a slant also the lean of the box height', () => {
		expect(lookReach(look({ kind: 'box', grow: 20 })).left).toBe(20);
		expect(lookReach(look({ kind: 'box', grow: 20 })).boxHeight).toBe(0);
		expect(lookReach(look({ kind: 'slant', grow: 5, skew: 45 })).boxHeight).toBeCloseTo(1, 6);
		const a = appearanceFromRecipe(
			{ layers: [{ type: 'plate', params: { kind: 'slant', grow: 0, skew: 45 } }] },
			ids,
		);
		const pad = titleLookPadding({
			width: 400,
			height: 100,
			pxScale: 1,
			fps: 30,
			structures: {
				titleLook: { appearance: resolveAppearance(a, 0), source: a, unitPx: 100, contentSeconds: 0 },
			},
		});
		expect(pad.left).toBe(100);
		expect(pad.right).toBe(100);
		expect(pad.top).toBe(0);
	});
	it('every plate kind plans', () => {
		for (const kind of ['contour', 'hull', 'box', 'slant', 'pill']) {
			const a = appearanceFromRecipe(
				{
					layers: [
						{ type: 'plate', params: { kind } },
						{ type: 'plate', params: { kind } },
					],
				},
				ids,
			);
			const passes = planTitleLook({
				width: 640,
				height: 360,
				pxScale: 1,
				fps: 30,
				structures: {
					titleLook: { appearance: resolveAppearance(a, 0), source: a, unitPx: 64, contentSeconds: 0 },
				},
			});
			// Two plates write one output: the second must be an update (the planner's `write`).
			expect(passes.filter((p) => p.output === 'tlPlate').map((p) => !!p.update)).toEqual([false, true]);
		}
	});
});

describe('media reach (TL-021)', () => {
	const setup = (param: string, recipeParams: Record<string, unknown>, layer = 'face') => {
		const h = new Harness();
		const { mediaId } = h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image' }) }])
			.results[0] as {
			mediaId: string;
		};
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 100, track: 'V2', content: { text: 'Look' }, ref: '$t' },
		]);
		const text = r.refs.$t as string;
		h.ok([
			{
				type: 'look.apply',
				clipIds: [text],
				look: {
					name: 'Mirror',
					recipe: { layers: [{ type: layer, params: { ...recipeParams, [param]: { mediaId } } }] },
				},
			} as never,
		]);
		return { h, mediaId, text };
	};
	const clipOf = (h: Harness, id: string) => h.seq.clips[id] as unknown as Clip;

	for (const [param, params, layer] of [
		['reflectionImage', { finish: 'reflection' }, 'face'],
		['patternImage', { finish: 'pattern', patternKind: 'image' }, 'face'],
		['motifImage', { kind: 'pattern', motif: 'image' }, 'texture'],
	] as const)
		it(`${param} is a media use everywhere, and its render gets a handle`, () => {
			const { h, mediaId, text } = setup(param, params, layer);
			const c = clipOf(h, text);
			expect(clipParamMediaIds(c)).toContain(mediaId);
			expect(effectMediaRefs((c as unknown as { effects: never }).effects)[0]?.param).toMatch(
				new RegExp(`^appearance\\..*\\.${param}$`),
			);
			expect(mediaUsage(h.doc)[mediaId]?.clips).toBe(1);
			const snap = buildRenderSnapshot(h.doc, h.seqId, {
				resolveMedia: () => ({ url: 'media://picture' }),
				resolveFont: () => null,
			} as never);
			expect(snap.media[mediaId]).toBeTruthy();
		});

	it('a deleted picture clears to None, and the look still plans', () => {
		const { h, mediaId, text } = setup('reflectionImage', { finish: 'reflection' });
		const c = structuredClone(clipOf(h, text)) as Clip & { effects: never[] };
		const cleared = clearEffectMedia(c.effects, (id) => id === mediaId);
		expect(cleared.length).toBe(1);
		expect(clipParamMediaIds(c)).not.toContain(mediaId);
	});
});

describe('spans', () => {
	const box: SpanBox = [10, 20, 30, 50];

	it('records every drawn glyph with the inverse of its placement', () => {
		const s = buildTextSpans([
			{ box, line: 3 },
			{ box: [40, 20, 60, 50], line: 3, toDrawn: [1, 0, 5, 0, 1, 7, 0, 0, 1] },
			{ box: [10, 80, 30, 110], line: 8 },
		])!;
		expect(s.glyphs).toBe(3);
		expect(s.lines).toBe(2);
		expect(s.block).toEqual([10, 20, 60, 110]);
		// (H00 H01 H02 H10)(H11 H12 H20 H21): drawn → rest undoes the (5, 7) move.
		expect([...s.texels.subarray(16, 24)]).toEqual([1, 0, -5, 0, 1, -7, 0, 0]);
		// Line indices are compact, then the line boxes.
		expect(s.texels[12]).toBe(0);
		expect(s.texels[44]).toBe(1);
		expect([...s.texels.subarray(48, 52)]).toEqual([10, 20, 60, 50]);
	});

	it('a perspective homography round-trips', () => {
		const m = [1.2, 0.1, 5, -0.05, 0.9, 3, 0.002, 0.001, 1];
		const s = buildTextSpans([{ box, line: 0, toDrawn: m }])!;
		const [a, b, c, d, e, f, g, h] = s.texels;
		const rest = [17, 33];
		const w = m[6]! * rest[0]! + m[7]! * rest[1]! + m[8]!;
		const x = (m[0]! * rest[0]! + m[1]! * rest[1]! + m[2]!) / w;
		const y = (m[3]! * rest[0]! + m[4]! * rest[1]! + m[5]!) / w;
		const W = g! * x + h! * y + 1;
		expect((a! * x + b! * y + c!) / W).toBeCloseTo(rest[0]!, 2);
		expect((d! * x + e! * y + f!) / W).toBeCloseTo(rest[1]!, 2);
	});

	it('glyphs scaled to nothing or with broken boxes own nothing, and the count is capped', () => {
		expect(buildTextSpans([])).toBeNull();
		expect(buildTextSpans([{ box, line: 0, toDrawn: [0, 0, 0, 0, 0, 0, 0, 0, 1] }])).toBeNull();
		expect(buildTextSpans([{ box: [Number.NaN, 0, 1, 1], line: 0 }])).toBeNull();
		const many = Array.from({ length: MAX_SPAN_GLYPHS + 10 }, () => ({ box, line: 0 }));
		expect(buildTextSpans(many)!.glyphs).toBe(MAX_SPAN_GLYPHS);
	});

	it('is total on anything a layout can hand it', () => {
		const num = fc.double();
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						box: fc.tuple(num, num, num, num),
						line: fc.integer({ min: -3, max: 8 }),
						toDrawn: fc.option(fc.array(num, { minLength: 9, maxLength: 9 }), { nil: undefined }),
					}),
					{ maxLength: 30 },
				),
				(gs) => {
					const s = buildTextSpans(gs);
					if (!s) return;
					expect(s.texels.length).toBe((s.glyphs * 4 + s.lines) * 4);
					for (const v of s.block) expect(Number.isFinite(v)).toBe(true);
				},
			),
		);
	});

	it('a look only asks for them when it has a gradient on an enabled layer', () => {
		const gradient = {
			kind: 'gradient',
			gradient: {
				type: 'linear',
				span: 'glyph',
				angle: 0,
				stops: [
					{ at: 0, paint: { color: [0, 0, 0, 1] } },
					{ at: 1, paint: { color: [1, 1, 1, 1] } },
				],
			},
		};
		const of = (paint: unknown, enabled = true) => {
			const a = appearanceFromRecipe({ layers: [{ type: 'face', params: { paint } }] }, ids);
			a.layers[0]!.enabled = enabled;
			return a;
		};
		expect(appearanceWantsTextSpans(of(gradient))).toBe(true);
		expect(appearanceWantsTextSpans(of(gradient, false))).toBe(false);
		expect(appearanceWantsTextSpans(of({ kind: 'role', role: 'face' }))).toBe(false);
		expect(appearanceWantsTextSpans(undefined)).toBe(false);
	});

	it('the owner pass and its uniforms run only when a paint needs them', () => {
		const look = (span: string) => {
			const a = appearanceFromRecipe(
				{
					layers: [
						{
							type: 'face',
							params: {
								paint: {
									kind: 'gradient',
									gradient: {
										type: 'linear',
										span,
										angle: 0,
										stops: [
											{ at: 0, paint: { color: [0, 0, 0, 1] } },
											{ at: 1, paint: { color: [1, 1, 1, 1] } },
										],
									},
								},
							},
						},
					],
				},
				ids,
			);
			return {
				appearance: resolveAppearance(a, 0),
				source: a,
				unitPx: 64,
				contentSeconds: 0,
				textSpans: buildTextSpans([{ box, line: 0 }]),
			};
		};
		const ctx = (titleLook: ReturnType<typeof look>) => ({
			width: 640,
			height: 360,
			pxScale: 1,
			fps: 30,
			frame: 0,
			duration: 10,
			seed: 0,
			progress: 0,
			structures: { titleLook },
		});
		const outputs = (s: string) => planTitleLook(ctx(look(s))).map((p) => p.output);
		expect(outputs('glyph')).toContain('tlSpan');
		expect(outputs('line')).toContain('tlSpan');
		expect(outputs('block')).not.toContain('tlSpan');
		const u = titleLookUniforms(ctx(look('glyph')));
		expect(texelCount(u.u_tlSpans)).toBe(5);
	});

	it('the UI can say a span acts as block', () => {
		expect(gradientSpanOn('glyph', 'text')).toEqual({ span: 'glyph', spanNote: null });
		expect(gradientSpanOn('line', 'still')).toEqual({ span: 'block', spanNote: 'needs-text' });
		expect(gradientSpanOn('block', 'still')).toEqual({ span: 'block', spanNote: null });
	});
});
