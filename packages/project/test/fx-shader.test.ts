// GPU shader-effect specs (wave-1 fx framework, registry/fx/shader.ts): uniform mapping, pass planning (sizes, named
// intermediates, declarations, includes), padding, seeds, time hooks, built-ins and spec validation.
import { describe, expect, it } from 'vitest';
import {
	addPadding,
	buildPassSource,
	defineShaderEffect,
	type EffectSpec,
	FX_MAX_PADDING,
	FX_MAX_TIME_SAMPLES,
	type FxFrameContext,
	fxBuiltinUniforms,
	fxParam,
	fxRandom,
	fxSeed,
	fxSourceFrame,
	fxTimeSamples,
	GLSL_BLUR,
	GLSL_COLOR,
	GLSL_COMPOSITE,
	GLSL_HASH,
	GLSL_NOISE,
	gpuIsTimeDependent,
	gpuPadding,
	mixWithOriginalParam,
	paramUniforms,
	planGpuEffect,
	resolveIncludes,
	showParam,
	toUniform,
	validateGpuEffect,
} from '../src/index.ts';

const FRAG = 'void main() { fragColor = texture(u_source, v_uv); }';
const CTX: FxFrameContext = {
	width: 100,
	height: 50,
	pxScale: 1,
	fps: 30,
	frame: 0,
	duration: 30,
	seed: 0.5,
	progress: 0,
};

const spec = (over: Partial<Parameters<typeof defineShaderEffect>[0]> = {}): EffectSpec =>
	defineShaderEffect({
		id: 'test.fx',
		label: 'FX',
		category: 'Stylize',
		params: [],
		gpu: { passes: [{ frag: FRAG }] },
		...over,
	});

describe('param uniforms (u_<name>)', () => {
	const s = spec({
		params: [
			fxParam.number('amount', 'Amount', 2, { min: 0, max: 10 }),
			fxParam.toggle('invert', 'Invert', true),
			fxParam.choice('mode', 'Mode', ['a', 'b', 'c'], ['A', 'B', 'C'], 'b'),
			fxParam.point('center', 'Center'),
			fxParam.color('tint', 'Tint', [1, 0.5, 0, 1]),
			fxParam.media('map', 'Map'),
			{ name: 'label', label: 'Label', type: 'string', default: 'x', animatable: false },
		],
	});

	it('maps number, boolean, enum index, vec2 and colour; media/string are not uniforms', () => {
		const u = paramUniforms(s, {
			amount: 3.5,
			invert: false,
			mode: 'c',
			center: [0.25, 0.75],
			tint: [0, 1, 0, 0.5],
		});
		expect(u).toEqual([
			{ name: 'u_amount', type: 'float', value: [3.5] },
			{ name: 'u_invert', type: 'bool', value: [0] },
			{ name: 'u_mode', type: 'int', value: [2] },
			{ name: 'u_center', type: 'vec2', value: [0.25, 0.75] },
			{ name: 'u_tint', type: 'vec4', value: [0, 1, 0, 0.5] },
		]);
	});

	it('falls back to defaults for missing or malformed values (unknown enum → the default index)', () => {
		const u = paramUniforms(s, { amount: Number.NaN, mode: 'zzz', center: 'oops' as never });
		expect(u.find((x) => x.name === 'u_amount')!.value).toEqual([2]);
		expect(u.find((x) => x.name === 'u_invert')!.value).toEqual([1]);
		expect(u.find((x) => x.name === 'u_mode')!.value).toEqual([1]);
		expect(u.find((x) => x.name === 'u_center')!.value).toEqual([0.5, 0.5]);
	});

	it('derives custom uniform types from their values', () => {
		expect(toUniform('u_a', 1.5)).toEqual({ name: 'u_a', type: 'float', value: [1.5] });
		expect(toUniform('u_b', true)).toEqual({ name: 'u_b', type: 'bool', value: [1] });
		expect(toUniform('u_c', [1, 2, 3]).type).toBe('vec3');
		expect(toUniform('u_d', { int: 4.7 })).toEqual({ name: 'u_d', type: 'int', value: [4] });
		expect(toUniform('u_e', { floats: [1, 2] })).toEqual({ name: 'u_e', type: 'float[]', value: [1, 2] });
		expect(toUniform('u_f', { mat3: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).type).toBe('mat3');
		expect(() => toUniform('u_g', [1] as never)).toThrow(/2, 3 or 4/);
	});
});

describe('pass planning', () => {
	const s = spec({
		params: [fxParam.pixels('radius', 'Radius', 4), fxParam.media('map', 'Map')],
		gpu: {
			uniforms: (p) => ({ u_double: (p.radius as number) * 2 }),
			passes: [
				{ output: 'bright', frag: FRAG, include: [GLSL_COMPOSITE] },
				{ frag: FRAG, scale: 0.5, format: 'rgba16f', uniforms: { u_dir: [1, 0] } },
				{ frag: 'void main() { fragColor = texture(u_pass1, v_uv) + texture(u_bright, v_uv); }' },
			],
		},
	});
	const plan = planGpuEffect(s, { id: 'fx1', params: { radius: 6, map: { mediaId: 'm1' } } }, CTX, {
		width: 101,
		height: 51,
	});

	it('sizes passes by scale (the last at full size) and names outputs', () => {
		expect(plan.passes.map((p) => [p.output, p.width, p.height, p.format])).toEqual([
			['bright', 101, 51, 'rgba8'],
			['pass1', 51, 26, 'rgba16f'],
			[null, 101, 51, 'rgba8'],
		]);
	});

	it('declares earlier outputs, params, custom/pass uniforms and media textures; never later outputs', () => {
		const [p0, p1, p2] = plan.passes;
		expect(p0!.source.startsWith('#version 300 es\n')).toBe(true);
		expect(p0!.source).not.toMatch(/uniform sampler2D u_bright;/);
		expect(p1!.source).toMatch(/uniform sampler2D u_bright;/);
		expect(p1!.source).not.toMatch(/uniform sampler2D u_pass1;/);
		expect(p2!.source).toMatch(/uniform sampler2D u_pass1;/);
		for (const p of plan.passes) {
			expect(p.source).toMatch(/uniform float u_radius;/);
			expect(p.source).toMatch(/uniform float u_double;/);
			expect(p.source).toMatch(/uniform sampler2D u_map;\nuniform vec2 u_map_size;/);
		}
		expect(p1!.source).toMatch(/uniform vec2 u_dir;/);
		expect(p0!.source).not.toMatch(/u_dir/);
		expect(plan.uniforms).toContainEqual({ name: 'u_double', type: 'float', value: [12] });
		expect(plan.textures).toEqual([{ param: 'map', uniform: 'u_map', mediaId: 'm1' }]);
	});

	it('includes chunks once, dependencies first', () => {
		expect(resolveIncludes([GLSL_NOISE, GLSL_HASH, GLSL_COMPOSITE, GLSL_COLOR]).map((c) => c.name)).toEqual([
			'fx/hash',
			'fx/noise',
			'fx/color',
			'fx/composite',
		]);
		const src = buildPassSource(
			{ frag: FRAG, include: [GLSL_NOISE, GLSL_NOISE] },
			{ params: [], textures: [], outputs: [], uniforms: [] },
		);
		expect(src.match(/---- fx\/hash/g)).toHaveLength(1);
		expect(src.indexOf('fx/hash')).toBeLessThan(src.indexOf('fx/noise'));
	});

	it('keys programs and sizes, not uniform values', () => {
		const again = planGpuEffect(s, { id: 'fx1', params: { radius: 9 } }, CTX, { width: 101, height: 51 });
		expect(again.key).toBe(plan.key);
		const bigger = planGpuEffect(s, { id: 'fx1', params: { radius: 9 } }, CTX, { width: 200, height: 51 });
		expect(bigger.key).not.toBe(plan.key);
	});

	it('function passes follow the params (variable pyramids)', () => {
		const pyr = spec({
			params: [fxParam.number('levels', 'Levels', 2, { min: 1, max: 6 })],
			gpu: {
				passes: (p) => [
					...Array.from({ length: p.levels as number }, (_, i) => ({
						output: `l${i}`,
						frag: FRAG,
						scale: 1 / 2 ** (i + 1),
					})),
					{ frag: FRAG },
				],
			},
		});
		expect(
			planGpuEffect(pyr, { id: 'x', params: { levels: 4 } }, CTX, { width: 64, height: 64 }).passes,
		).toHaveLength(5);
	});
});

describe('padding (S03:FX-041)', () => {
	it('expands numbers to every side, clamps, and adds along the stack', () => {
		const a = gpuPadding(spec({ gpu: { passes: [{ frag: FRAG }], padding: () => 12 } }), {}, CTX);
		expect(a).toEqual({ left: 12, top: 12, right: 12, bottom: 12 });
		const b = gpuPadding(
			spec({ gpu: { passes: [{ frag: FRAG }], padding: () => ({ right: 5, bottom: -3, left: 1e9 }) } }),
			{},
			CTX,
		);
		expect(b).toEqual({ left: FX_MAX_PADDING, top: 0, right: 5, bottom: 0 });
		expect(addPadding(a, { left: 1, top: 2, right: 3, bottom: 4 })).toEqual({
			left: 13,
			top: 14,
			right: 15,
			bottom: 16,
		});
		expect(gpuPadding(spec(), {}, CTX)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
	});
});

describe('seeds and randomness (S11 §2 determinism)', () => {
	it('u_seed is a stable 0..1 hash of clip, instance and the seed param', () => {
		const s = fxSeed('clip_A', 'fx_1');
		expect(s).toBe(fxSeed('clip_A', 'fx_1'));
		expect(s).toBeGreaterThanOrEqual(0);
		expect(s).toBeLessThan(1);
		expect(fxSeed('clip_B', 'fx_1')).not.toBe(s);
		expect(fxSeed('clip_A', 'fx_2')).not.toBe(s);
		expect(fxSeed('clip_A', 'fx_1', { seed: 3 })).not.toBe(s);
		expect(fxSeed('clip_A', 'fx_1', { seed: 0 })).toBe(s);
	});

	it('fxRandom is deterministic and spread over 0..1', () => {
		const xs = Array.from({ length: 2000 }, (_, i) => fxRandom(0.37, i));
		expect(xs).toEqual(Array.from({ length: 2000 }, (_, i) => fxRandom(0.37, i)));
		expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...xs)).toBeLessThan(1);
		const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
		expect(Math.abs(mean - 0.5)).toBeLessThan(0.03);
	});
});

describe('time hooks', () => {
	const freeze = spec({ gpu: { passes: [{ frag: FRAG }], time: { remap: () => 5.7 } } });
	const back = spec({ gpu: { passes: [{ frag: FRAG }], time: { remap: (_p, c) => c.frame - 10 } } });
	const tctx = { frame: 3, fps: 30, duration: 20, headHandle: 2, tailHandle: 0 };

	it('remaps compose in stack order, floor, and clamp to the drawn span', () => {
		expect(fxSourceFrame([], tctx)).toBeNull();
		expect(fxSourceFrame([{ spec: freeze, params: {}, seed: 0 }], tctx)).toBe(5);
		expect(fxSourceFrame([{ spec: back, params: {}, seed: 0 }], tctx)).toBe(-2); // head handle
		expect(
			fxSourceFrame(
				[
					{ spec: freeze, params: {}, seed: 0 },
					{ spec: back, params: {}, seed: 0 },
				],
				{ ...tctx, frame: 15 },
			),
		).toBe(-2);
		const late = spec({ gpu: { passes: [{ frag: FRAG }], time: { remap: () => 999 } } });
		expect(fxSourceFrame([{ spec: late, params: {}, seed: 0 }], tctx)).toBe(19);
	});

	it('samples are integer offsets, at most FX_MAX_TIME_SAMPLES', () => {
		const t = spec({
			gpu: { passes: [{ frag: FRAG }], time: { samples: () => [-1.4, Number.NaN, ...Array(20).fill(-2)] } },
		});
		const r = fxTimeSamples(t, {}, { ...tctx, seed: 0 });
		expect(r[0]).toBe(-1);
		expect(r).toHaveLength(FX_MAX_TIME_SAMPLES);
	});

	it('time dependence: default true; timeInvariant opts out unless there are time hooks', () => {
		expect(gpuIsTimeDependent(spec())).toBe(true);
		expect(gpuIsTimeDependent(spec({ gpu: { passes: [{ frag: FRAG }], timeInvariant: true } }))).toBe(false);
		expect(
			gpuIsTimeDependent(
				spec({ gpu: { passes: [{ frag: FRAG }], timeInvariant: true, time: { remap: () => 0 } } }),
			),
		).toBe(true);
		expect(gpuIsTimeDependent({})).toBe(false);
	});
});

describe('built-in uniforms', () => {
	it('carries the layer map column-major, progress and side', () => {
		const u = fxBuiltinUniforms({
			canvas: { width: 120, height: 70 },
			box: { x: 10, y: 10, w: 100, h: 50 },
			pxScale: 1,
			frame: 15,
			fps: 30,
			duration: 31,
			layerToComp: [1, 2, 3, 4, 5, 6, 7, 8, 9],
			compSize: { width: 1920, height: 1080 },
		});
		const get = (n: string) => u.find((x) => x.name === n)!.value;
		expect(get('u_layerToComp')).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
		expect(get('u_clipProgress')).toEqual([0.5]);
		expect(get('u_progress')).toEqual([0.5]);
		expect(get('u_side')).toEqual([0]);
		expect(get('u_time')).toEqual([0.5]);
		const t = fxBuiltinUniforms({
			canvas: { width: 1, height: 1 },
			box: { x: 0, y: 0, w: 1, h: 1 },
			pxScale: 1,
			frame: 0,
			fps: 30,
			duration: 10,
			transition: { progress: 0.25, side: 'in' },
			compSize: { width: 1, height: 1 },
		});
		expect(t.find((x) => x.name === 'u_progress')!.value).toEqual([0.25]);
		expect(t.find((x) => x.name === 'u_side')!.value).toEqual([2]);
	});
});

describe('validateGpuEffect', () => {
	it('accepts a well-formed effect with the Sapphire common params', () => {
		expect(
			validateGpuEffect(
				spec({
					params: [fxParam.percent('amount', 'Amount', 50), showParam(), mixWithOriginalParam()],
					gpu: {
						padding: () => 4,
						passes: [
							{ output: 'a', frag: FRAG, include: [GLSL_BLUR], scale: 0.5 },
							{ frag: 'void main() { fragColor = texture(u_a, v_uv); }' },
						],
					},
				}),
			),
		).toEqual([]);
	});

	it('reports reserved names, bad outputs, ES 1.00 code, bad scales, enum defaults and capability mismatches', () => {
		const bad: EffectSpec = {
			...spec({
				params: [
					fxParam.number('source', 'Source', 0, {}),
					fxParam.number('my_param', 'Mine', 0, {}),
					fxParam.choice('mode', 'Mode', ['a'], ['A'], 'z'),
				],
				gpu: {
					passes: [
						{ output: 'x', frag: 'void main() { gl_FragColor = texture2D(u_source, v_uv); }', scale: 2 },
						{ output: 'x', frag: FRAG },
						{ frag: 'void helper() {}' },
					],
					time: { samples: () => Array(9).fill(-1) },
				},
			}),
			capabilities: { preview: 'css', export: ['native'] },
		};
		const problems = validateGpuEffect(bad).join('\n');
		expect(problems).toMatch(/u_source is a built-in uniform/);
		expect(problems).toMatch(/"my_param": names are letters and digits/);
		expect(problems).toMatch(/default is not one of its options/);
		expect(problems).toMatch(/gl_FragColor/);
		expect(problems).toMatch(/texture2D/);
		expect(problems).toMatch(/scale must be in \(0, 1\]/);
		expect(problems).toMatch(/output "x" is used twice/);
		expect(problems).toMatch(/pass 2: no void main/);
		expect(problems).toMatch(/more than 8 time samples/);
		expect(problems).toMatch(/capabilities.preview must be 'webgl'/);
		expect(problems).toMatch(/must include 'remotion'/);
	});
});
