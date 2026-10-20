import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	defineShaderEffect,
	type EffectSpec,
	type FxClipInfo,
	type FxFrameContext,
	type FxTimeStep,
	fxClipContentTime,
	fxParam,
	fxParamsAtFn,
	fxSourceFrame,
	fxSourceSeconds,
	fxStackTime,
	gpuIsTimeDependent,
	isLutMediaParam,
	lutParam,
	type ParamValue,
	planGpuEffect,
	planPasses,
	toUniform,
	validateGpuEffect,
} from '../src/index.ts';

import {
	CLIP_NAME,
	clipNameText,
	timecodeText,
} from '../src/registry/fx/premiere-stylize-distort-generate/video.ts';

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

const F = 705_600_000 / 30; // flicks per frame at 30 fps
const ease = { influence: 1 / 3, slope: 0 };
/** A linear animation through (frame, value) pairs (content time = frame at speed 1, in-point 0). */
function animated<T extends ParamValue>(...kfs: [number, T][]): Animatable<ParamValue> {
	return {
		value: kfs[0]![1],
		keyframes: kfs.map(([f, v], i) => ({
			id: `k${i}`,
			time: Math.round(f * F),
			value: v,
			interpolation: 'linear',
			easeIn: ease,
			easeOut: ease,
		})),
	} as Animatable<ParamValue>;
}
const CLIP = { duration: 60, sourceIn: 0, speed: { rate: 1, reverse: false } };

describe('uniform types', () => {
	it('ivec2/3/4 and vec4 arrays', () => {
		expect(toUniform('u_a', { ivec2: [3.7, -2.2] })).toEqual({ name: 'u_a', type: 'ivec2', value: [3, -2] });
		expect(toUniform('u_b', { ivec4: [1, 2, 3, 4] }).type).toBe('ivec4');
		expect(toUniform('u_c', { vec4s: [1, 2, 3, 4, 5, 6, 7, 8] })).toEqual({
			name: 'u_c',
			type: 'vec4[]',
			value: [1, 2, 3, 4, 5, 6, 7, 8],
		});
		expect(() => toUniform('u_d', { vec4s: [1, 2, 3] })).toThrow(/multiple of 4/);
		const plan = planGpuEffect(
			spec({
				gpu: {
					uniforms: () => ({ u_cell: { ivec2: [4, 2] }, u_pts: { vec4s: new Array(8).fill(0) } }),
					passes: [{ frag: 'void main() { fragColor = vec4(float(u_cell.x)) + u_pts[1]; }' }],
				},
			}),
			{ id: 'fx', params: {} },
			CTX,
			{ width: 10, height: 10 },
		);
		expect(plan.passes[0]!.source).toMatch(/uniform ivec2 u_cell;/);
		expect(plan.passes[0]!.source).toMatch(/uniform vec4 u_pts\[2\];/);
	});
});

describe('pass planning follow-ups', () => {
	it('absolute pass sizes (lookup / statistics passes)', () => {
		const p = planPasses(
			[
				{ output: 'stats', size: { width: 64, height: 1 }, frag: FRAG },
				{ frag: 'void main() { fragColor = texture(u_stats, v_uv); }' },
			],
			{ paramDecls: [], textures: [], canvas: { width: 300, height: 200 } },
		);
		expect(p.map((x) => [x.width, x.height])).toEqual([
			[64, 1],
			[300, 200],
		]);
	});

	it('accepts repeated output updates, rejects duplicate outputs and updates before initialization', () => {
		const iter = (i: number) => ({
			output: 'acc',
			update: true,
			frag: `void main() { fragColor = texture(u_acc, v_uv) + ${i}.0; }`,
		});
		const passes = [
			{ output: 'acc', frag: FRAG },
			iter(1),
			iter(2),
			iter(3),
			{ frag: 'void main() { fragColor = texture(u_acc, v_uv); }' },
		];
		const s = spec({ gpu: { passes } });
		expect(validateGpuEffect(s)).toEqual([]);
		// 100 iterations still count as ONE named output (the 12-texture rule).
		const many = spec({
			gpu: {
				passes: [
					{ output: 'acc', frag: FRAG },
					...Array.from({ length: 100 }, (_, i) => iter(i)),
					{ frag: FRAG },
				],
			},
		});
		expect(validateGpuEffect(many)).toEqual([]);
		expect(
			validateGpuEffect(
				spec({ gpu: { passes: [{ output: 'x', frag: FRAG }, { output: 'x', frag: FRAG }, { frag: FRAG }] } }),
			).join(),
		).toMatch(/used twice/);
		expect(
			validateGpuEffect(
				spec({ gpu: { passes: [{ output: 'x', update: true, frag: FRAG }, { frag: FRAG }] } }),
			).join(),
		).toMatch(/no earlier pass/);
	});

	it('mipmapped outputs and source', () => {
		const s = spec({
			gpu: {
				sourceMipmaps: true,
				passes: [
					{ output: 'small', mipmaps: true, frag: FRAG },
					{ frag: 'void main() { fragColor = textureLod(u_small, v_uv, 3.0); }' },
				],
			},
		});
		const plan = planGpuEffect(s, { id: 'fx', params: {} }, CTX, { width: 64, height: 64 });
		expect(plan.passes[0]!.mipmaps).toBe(true);
		expect(plan.passes[1]!.mipmaps).toBeUndefined();
		expect(plan.sourceMipmaps).toBe(true);
	});

	it('lut media params are 3D textures', () => {
		const l = lutParam('look', 'Look');
		expect(isLutMediaParam(l)).toBe(true);
		expect(isLutMediaParam(fxParam.media('map', 'Map'))).toBe(false);
		const s = spec({
			params: [l],
			gpu: {
				passes: [
					{ frag: 'void main() { fragColor = vec4(texture(u_look, vec3(0.5)).rgb * u_look_size.x, 1.0); }' },
				],
			},
		});
		const plan = planGpuEffect(s, { id: 'fx', params: { look: { mediaId: 'm1' } } }, CTX, {
			width: 4,
			height: 4,
		});
		expect(plan.textures).toEqual([{ param: 'look', uniform: 'u_look', mediaId: 'm1', kind: 'lut' }]);
		expect(plan.passes[0]!.source).toMatch(/uniform highp sampler3D u_look;\nuniform vec2 u_look_size;/);
	});
});

describe('params at other times', () => {
	const inst = {
		params: { x: animated([0, 0], [10, 100]), c: { value: 'a', keyframes: [] } as Animatable<ParamValue> },
	};

	it('evaluates the keyframes at fractional clip-local frames with the shared evaluate()', () => {
		const now = { x: 50, c: 'a' };
		const at = fxParamsAtFn(inst, CLIP, 30, { frame: 5, params: now });
		expect(at(5)).toEqual({ x: 50, c: 'a' });
		expect(at(2.5).x).toBeCloseTo(25, 6);
		expect(at(-3).x).toBe(0);
		expect(at(20).x).toBe(100);
		expect(fxClipContentTime(CLIP, 3, 30)).toBeCloseTo(3 * F, 3);
	});

	it('follows the clip in-point, speed and reverse', () => {
		const rev = fxParamsAtFn(inst, { duration: 11, sourceIn: 0, speed: { rate: 1, reverse: true } }, 30);
		expect(rev(0).x).toBeCloseTo(100, 6); // reverse: frame 0 shows content frame 10
		const fast = fxParamsAtFn(inst, { duration: 30, sourceIn: 2 * F, speed: { rate: 2 } }, 30);
		expect(fast(1).x).toBeCloseTo(40, 6); // content frame 2 + 1 × 2
	});
});

describe('stack time (remaps and samples compose)', () => {
	const freeze = spec({ gpu: { passes: [{ frag: FRAG }], time: { remap: () => 10 } } });
	const echo = spec({ gpu: { passes: [{ frag: FRAG }], time: { samples: () => [-1, -2] } } });
	const echoT = spec({
		gpu: { passes: [{ frag: FRAG }], time: { samples: () => [-1, -2], sampleEdge: 'transparent' } },
	});
	const echoC = spec({
		gpu: { passes: [{ frag: FRAG }], time: { samples: () => [-1, -2], sampleEdge: 'clamp' } },
	});
	const step = (s: EffectSpec): FxTimeStep => ({ spec: s, params: {}, seed: 0 });
	const ctx = { frame: 20, fps: 30, duration: 30, headHandle: 0, tailHandle: 0 };

	it('samples of an effect below a freeze show the frozen picture; above it, the frozen frame ± offsets', () => {
		const below = fxStackTime([step(freeze), step(echo)], ctx);
		expect(below.source).toBe(10);
		expect(below.steps[1]).toMatchObject({ offsets: [-1, -2], frames: [10, 10], valid: 3 });
		const above = fxStackTime([step(echo), step(freeze)], ctx);
		expect(above.source).toBe(10);
		expect(above.steps[0]).toMatchObject({ frame: 10, input: 10, frames: [9, 8], valid: 3 });
		expect(fxSourceFrame([step(echo), step(freeze)], ctx)).toBe(10);
	});

	it('samples outside the drawn span: drop (default), transparent or clamp, flagged in u_sampleValid', () => {
		const at1 = { ...ctx, frame: 1 };
		expect(fxStackTime([step(echo)], at1).steps[0]).toMatchObject({ offsets: [], frames: [], valid: 0 });
		expect(fxStackTime([step(echoT)], at1).steps[0]).toMatchObject({
			offsets: [-1, -2],
			frames: [0, null],
			valid: 1,
		});
		expect(fxStackTime([step(echoC)], at1).steps[0]).toMatchObject({ frames: [0, 0], valid: 1 });
		expect(fxStackTime([step(echo)], ctx).source).toBeNull();
	});
});

describe('time dependence', () => {
	const s = spec({
		params: [fxParam.media('map', 'Map')],
		gpu: { passes: [{ frag: FRAG }], timeInvariant: true },
	});
	it('a media param bound to a video is time dependent', () => {
		expect(gpuIsTimeDependent(s)).toBe(false);
		expect(gpuIsTimeDependent(s, { map: { mediaId: '' } })).toBe(false);
		expect(gpuIsTimeDependent(s, { map: { mediaId: 'v' } }, () => 'video')).toBe(true);
		expect(gpuIsTimeDependent(s, { map: { mediaId: 'i' } }, () => 'image')).toBe(false);
		expect(gpuIsTimeDependent(s, { map: { mediaId: 'x' } })).toBe(true); // unknown kind: conservative
	});
});

const clipInfo: FxClipInfo = {
	clipName: 'Interview A',
	itemName: 'interview_a',
	fileName: 'A001_C003.mov',
	sourceInSeconds: 10,
	sourceStartTimecode: '01:00:00:00',
	speed: 1,
	reverse: false,
	duration: 100,
};

describe('clip context: Clip Name and Timecode', () => {
	it('Clip Name Display', () => {
		const defaults = Object.fromEntries(CLIP_NAME.params.map((p) => [p.name, p.default]));
		expect(clipNameText(defaults, { clip: clipInfo })).toBe('Interview A');
		expect(clipNameText({ ...defaults, display: 'projectItemName' }, { clip: clipInfo })).toBe('interview_a');
		expect(clipNameText({ ...defaults, display: 'fileName' }, { clip: clipInfo })).toBe('A001_C003.mov');
		expect(clipNameText({ ...defaults, display: 'custom', name: 'X' }, { clip: clipInfo })).toBe('X');
		// Instances without Display keep Name; missing clip context also uses Name.
		expect(clipNameText({ name: 'Old' }, { clip: clipInfo })).toBe('Old');
		expect(clipNameText(defaults, {})).toBe('Clip Name');
	});

	it('Timecode Media source = source timecode', () => {
		const p = { timecodeSource: 'media', timeDisplay: '30', format: 'smpte' };
		expect(timecodeText(p, { frame: 0, fps: 30, clip: clipInfo })).toBe('01:00:10:00');
		expect(timecodeText(p, { frame: 45, fps: 30, clip: clipInfo })).toBe('01:00:11:15');
		expect(timecodeText(p, { frame: 0, fps: 30, clip: { ...clipInfo, speed: 2 } })).toBe('01:00:10:00');
		expect(timecodeText(p, { frame: 15, fps: 30, clip: { ...clipInfo, speed: 2 } })).toBe('01:00:11:00');
		expect(timecodeText(p, { frame: 45, fps: 30 })).toBe('00:00:01:15');
		expect(fxSourceSeconds(clipInfo, 30, 30)).toBe(11);
	});
});
