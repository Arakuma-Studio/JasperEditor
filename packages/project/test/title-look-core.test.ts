// Spec 19 §5 core, in the pure model: per-letter finishes through the runs (TL-093). GL behaviour:
// packages/compositions/test/title-look-core-gl.test.ts.
import { describe, expect, it } from 'vitest';
import {
	appearanceFromRecipe,
	appearanceWantsTextSpans,
	buildTextSpans,
	clipLookTurns,
	type LookRecipe,
	lookOrientation,
	MAX_RUN_FINISHES,
	planTitleLook,
	resolveAppearance,
	type SpanBox,
	type SpanGlyph,
	TITLE_LAYER_TYPES,
	titleLookPadding,
	titleLookStructure,
	titleLookTextures,
	titleLookUniforms,
} from '../src/index.ts';

let n = 0;
const ids = () => `apl_${String(++n).padStart(16, '0')}`;
const box: SpanBox = [0, 0, 10, 20];
/** Glyph i's record slot (texel 3, z). */
const slotOf = (s: { texels: Float32Array }, i: number) => s.texels[i * 16 + 14];

describe('per-letter finishes (TL-093)', () => {
	it('a glyph record carries the slot of its run finish; the ids are in the key', () => {
		const s = buildTextSpans([
			{ box, line: 0 },
			{ box, line: 0, finish: 'metal' },
			{ box, line: 0, finish: 'glass' },
			{ box, line: 0, finish: 'metal' },
		])!;
		expect(s.finishes).toEqual(['metal', 'glass']);
		expect([0, 1, 2, 3].map((i) => slotOf(s, i))).toEqual([0, 1, 2, 1]);
		// Same slots, other finishes: a different picture, so a different key.
		const other = buildTextSpans([
			{ box, line: 0 },
			{ box, line: 0, finish: 'bevel' },
			{ box, line: 0, finish: 'glass' },
			{ box, line: 0, finish: 'bevel' },
		])!;
		expect(other.texels).toEqual(s.texels);
		expect(other.key).not.toBe(s.key);
		expect(buildTextSpans([{ box, line: 0 }])!.finishes).toEqual([]);
	});

	it('slots are bounded: past the cap a letter keeps the look’s finish', () => {
		const many: SpanGlyph[] = Array.from({ length: MAX_RUN_FINISHES + 3 }, (_, i) => ({
			box,
			line: 0,
			finish: `f${i}`,
		}));
		const s = buildTextSpans(many)!;
		expect(s.finishes).toHaveLength(MAX_RUN_FINISHES);
		expect(slotOf(s, MAX_RUN_FINISHES - 1)).toBe(MAX_RUN_FINISHES);
		expect(slotOf(s, MAX_RUN_FINISHES)).toBe(0);
	});

	it('a text whose runs give finishes reports its glyphs under any look', () => {
		const a = appearanceFromRecipe({ layers: [{ type: 'face', params: {} }] }, ids);
		expect(appearanceWantsTextSpans(a)).toBe(false);
		expect(appearanceWantsTextSpans(a, [{ finish: 'metal' }])).toBe(true);
		expect(appearanceWantsTextSpans(a, [{}])).toBe(false);
		expect(appearanceWantsTextSpans(undefined, [{ finish: 'metal' }])).toBe(false);
	});

	it('only layers that take a letter’s finish do, and none blurs (the letter passes run before the blur)', () => {
		const letter = TITLE_LAYER_TYPES.filter((t) => t.letterFinish);
		expect(letter.map((t) => t.type)).toEqual(['face']);
		for (const t of letter) {
			expect(t.finish).toBe(true);
			expect(t.blur).toBeUndefined();
		}
	});

	describe('the plan', () => {
		const ctx = (recipe: LookRecipe, glyphs: SpanGlyph[]) => {
			const a = appearanceFromRecipe(recipe, ids);
			return {
				width: 640,
				height: 360,
				pxScale: 1,
				fps: 30,
				frame: 0,
				duration: 10,
				seed: 0,
				progress: 0,
				structures: {
					titleLook: {
						appearance: resolveAppearance(a, 0),
						source: a,
						unitPx: 64,
						contentSeconds: 0,
						textSpans: buildTextSpans(glyphs),
					},
				},
			};
		};
		const face = (finish: string, extra: Record<string, unknown> = {}): LookRecipe => ({
			layers: [
				{ type: 'rim', params: { width: 4 } },
				{ type: 'face', params: { finish, ...extra } },
			],
		});
		const writes = (c: ReturnType<typeof ctx>, name: string) =>
			planTitleLook(c).filter((p) => p.output === name).length;

		it('draws each other finish of the letters once, after the owner pass', () => {
			const c = ctx(face('flat'), [
				{ box, line: 0, finish: 'metal' },
				{ box, line: 0, finish: 'glass' },
				{ box, line: 0 },
			]);
			const passes = planTitleLook(c);
			const outputs = passes.map((p) => p.output);
			expect(outputs).toContain('tlSpan');
			// A clear and one pass per finish.
			expect(writes(c, 'tlRunFin')).toBe(3);
			expect(outputs.indexOf('tlSpan')).toBeLessThan(outputs.indexOf('tlRunFin'));
			// The face's own pass reads them: the last write to the composite before the output takes them in.
			const own = passes.filter((p) => p.output === 'tlComp').at(-1)!;
			expect(own.frag).toContain('u_tlRunFin');
			expect(own.uniforms?.u_tlRunMask).toEqual({ int: 0b110 });
		});

		it('draws nothing more for the look’s own finish, an unknown id or no runs', () => {
			expect(writes(ctx(face('metal'), [{ box, line: 0, finish: 'metal' }]), 'tlRunFin')).toBe(0);
			expect(writes(ctx(face('flat'), [{ box, line: 0, finish: 'nope' }]), 'tlRunFin')).toBe(0);
			const plain = ctx(face('flat'), [{ box, line: 0 }]);
			expect(writes(plain, 'tlRunFin')).toBe(0);
			expect(planTitleLook(plain).map((p) => p.output)).not.toContain('tlSpan');
		});

		it('declares the picture samplers of a letter’s finish, as its own pass reads them', () => {
			// A layer stores the params of its own finish only: a letter's reflection is the preset, with no image.
			const c = ctx(face('flat'), [{ box, line: 0, finish: 'reflection' }]);
			const letter = titleLookTextures(c).filter((t) => t.uniform.includes('r1_'));
			expect(letter.map((t) => t.uniform)).toEqual(['u_tlm1r1_reflectionImage']);
			const pass = planTitleLook(c).find(
				(p) => p.output === 'tlRunFin' && p.frag.includes('u_tlm1r1_reflectionImage'),
			);
			expect(pass).toBeDefined();
			expect(titleLookTextures(ctx(face('flat'), [{ box, line: 0 }]))).toEqual([]);
		});
	});
});

describe('the look’s stage: lights fixed on screen', () => {
	const close = (a: readonly number[] | null, b: readonly number[]) => {
		for (const [i, v] of a!.entries()) expect(v).toBeCloseTo(b[i]!, 9);
	};
	const turned = (deg: number, sx = 1, sy = 1) => {
		const t = (deg * Math.PI) / 180;
		// Scale first, then the turn: the map of a layer with Motion scale and rotation.
		return { a: Math.cos(t) * sx, b: Math.sin(t) * sx, c: -Math.sin(t) * sy, d: Math.cos(t) * sy };
	};

	it('an upright layer has no orientation, whatever its scale', () => {
		expect(lookOrientation({ a: 1, b: 0, c: 0, d: 1 })).toBeNull();
		expect(lookOrientation({ a: 2.5, b: 0, c: 0, d: 0.5 })).toBeNull();
		expect(lookOrientation(null)).toBeNull();
		expect(lookOrientation({ a: Number.NaN, b: 0, c: 0, d: 1 })).toBeNull();
		expect(lookOrientation({ a: 0, b: 0, c: 0, d: 0 })).toBeNull();
	});

	it('is the layer’s axes on screen: its rotation, not its scale or skew', () => {
		close(lookOrientation(turned(90)), [0, 1, -1, 0]);
		close(lookOrientation(turned(30, 3, 0.5)), [Math.cos(Math.PI / 6), 0.5, -0.5, Math.cos(Math.PI / 6)]);
		// A small skew leaves the rotation where it is.
		const skewed = lookOrientation({ a: 1, b: 0.1, c: -0.1, d: 1 })!;
		expect(Math.atan2(skewed[1], skewed[0])).toBeCloseTo(Math.atan2(0.2, 2), 9);
	});

	it('a mirrored layer: its x or y axis points the other way', () => {
		close(lookOrientation({ a: -1, b: 0, c: 0, d: 1 }), [-1, 0, 0, 1]);
		close(lookOrientation({ a: 1, b: 0, c: 0, d: -1 }), [1, 0, 0, -1]);
		// Both flips are a half turn.
		close(lookOrientation({ a: -1, b: 0, c: 0, d: -1 }), [-1, 0, 0, -1]);
	});

	it('a clip turns when its rotation is not upright, keyed or driven, or it flips', () => {
		const rot = (value: number, extra: object = {}) => ({ transform: { rotation: { value, ...extra } } });
		expect(clipLookTurns({})).toBe(false);
		expect(clipLookTurns(rot(0))).toBe(false);
		expect(clipLookTurns(rot(360))).toBe(false);
		expect(clipLookTurns(rot(15))).toBe(true);
		expect(clipLookTurns(rot(0, { keyframes: [{}] }))).toBe(true);
		expect(clipLookTurns(rot(0, { expression: { enabled: true } }))).toBe(true);
		expect(clipLookTurns({ transform: { rotation: { value: 0 }, flipH: true } })).toBe(true);
	});

	describe('uniforms and padding', () => {
		const recipe: LookRecipe = {
			light: { angle: 0, altitude: 30 },
			layers: [
				{ type: 'shadow', params: { distance: 20, blur: 0, angle: 0 } },
				{ type: 'face', params: {} },
			],
		};
		const ctx = (layerMap?: { a: number; b: number; c: number; d: number }) => {
			const a = appearanceFromRecipe(recipe, ids);
			const clip = { duration: 30, sourceIn: 0, speed: { rate: 1 } };
			return {
				width: 400,
				height: 200,
				pxScale: 1,
				fps: 30,
				frame: 0,
				duration: 30,
				seed: 0,
				progress: 0,
				structures: {
					titleLook: titleLookStructure(resolveAppearance(a, 0), a, clip, 30, 0, null, layerMap),
				},
			};
		};

		it('the light comes into the layer turned back by the layer’s rotation', () => {
			const up = titleLookUniforms(ctx());
			expect(up.u_tlLightDir).toEqual([1, 0]);
			expect(up.u_tlStage).toEqual([1, 0, 0, 1]);
			// Turned a quarter clockwise: a light from screen right comes from the layer's −y.
			const q = titleLookUniforms(ctx({ a: 0, b: 1, c: -1, d: 0 }));
			const dir = q.u_tlLightDir as unknown as number[];
			expect(dir[0]).toBeCloseTo(0, 9);
			expect(dir[1]).toBeCloseTo(-1, 9);
			const light = q.u_tlLight as unknown as number[];
			expect(light[2]).toBeCloseTo(0.5, 9);
			expect(Math.hypot(light[0]!, light[1]!)).toBeCloseTo(Math.cos(Math.PI / 6), 9);
		});

		it('a turned layer pads every side alike: the shadow may fall any way in it', () => {
			const up = titleLookPadding(ctx());
			// The shadow falls right: only that side reaches.
			expect(up.right!).toBeGreaterThan(up.left!);
			const turned = titleLookPadding(ctx({ a: 0, b: 1, c: -1, d: 0 }));
			expect(turned.left).toBe(turned.right);
			expect(turned.top).toBe(turned.right);
			expect(turned.right).toBe(up.right);
		});
	});
});
