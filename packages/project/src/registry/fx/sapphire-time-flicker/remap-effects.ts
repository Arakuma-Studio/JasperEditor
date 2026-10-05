// Source-remapping Sapphire time effects: S_FreezeFrame, S_GetFrame, S_JitterFrames, S_RandomEdits, S_Retime,
// S_ReverseClip, S_ReverseEdits. Each is a pure `gpu.time.remap` (the layer's source is drawn at another frame; Motion
// and params stay at the real time); fractional frames (Get Frame interpolation, Retime) add the next frame as a time
// sample and blend (Retime: motion-compensated, see flow.ts).
import type { EffectParams } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { fxParam } from '../params.ts';
import type { FxTimeContext } from '../shader.ts';
import {
	intParam,
	PASSTHROUGH_PASS,
	SWAP_FIELDS_PASS,
	sapphireSeedParam,
	swapFieldsParam,
} from './common.ts';
import { FLOW_INTERP_GLSL, flowPasses, GLSL_FLOW_FINAL } from './flow.ts';
import {
	bool,
	clampToSpan,
	freezeFrameSource,
	inSpan,
	int,
	jitterFramesSource,
	num,
	RETIME_MODE_LABELS,
	RETIME_MODES,
	randomEditsSource,
	retimeSource,
	reverseClipSource,
	reverseEditsSource,
	splitFrame,
	str,
} from './time-math.ts';

const time = { category: 'Time' as const, bin: SAPPHIRE_BINS.time };

export const S_FREEZE_FRAME = defineShaderEffect({
	...time,
	id: 'jasper.s.freeze-frame',
	label: 'S_FreezeFrame',
	description: 'Holds every n-th frame for n frames (stepped, stop-motion look).',
	keywords: ['freeze', 'hold', 'stutter', 'stop motion', 'posterize time'],
	params: [
		intParam('freezeFrames', 'Freeze Frames', 5, { min: 1, softMax: 60 }),
		intParam('frameStart', 'Frame Start', 0, { min: 0, softMax: 60 }),
	],
	gpu: {
		time: {
			remap: (p, ctx) => freezeFrameSource(ctx.frame, int(p.freezeFrames, 5, 1), int(p.frameStart, 0, 0)),
		},
		passes: [PASSTHROUGH_PASS],
	},
});

/** S_GetFrame's source frame (fractional when Get Frame is between frames). */
export function getFrameSource(p: EffectParams): number {
	return Math.max(0, num(p.getFrame, 0));
}

function getFrameSamples(p: EffectParams, ctx: FxTimeContext): number[] {
	if (!bool(p.interpFrames)) return [];
	const { frame, t } = splitFrame(getFrameSource(p));
	return t > 1e-6 ? inSpan([1], clampToSpan(frame, ctx), ctx) : [];
}

export const S_GET_FRAME = defineShaderEffect({
	...time,
	id: 'jasper.s.get-frame',
	label: 'S_GetFrame',
	description:
		'Shows the source frame given by Get Frame: animate it to speed up, slow down or reverse the clip freely.',
	keywords: ['time remap', 'speed', 'ramp', 'frame', 'retime'],
	params: [
		fxParam.number('getFrame', 'Get Frame', 0, { min: 0, softMax: 300, step: 0.01 }, { unit: 'frames' }),
		fxParam.toggle('interpFrames', 'Interp Frames', false),
	],
	gpu: {
		time: { remap: (p) => getFrameSource(p), samples: getFrameSamples },
		uniforms: (p) => ({ u_t: bool(p.interpFrames) ? splitFrame(getFrameSource(p)).t : 0 }),
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec4 a = texture(u_source, v_uv);
  fragColor = (u_sampleCount > 0 && u_t > 0.0) ? mix(a, fx_sample(0, v_uv), u_t) : a;
}`,
			},
		],
	},
});

export const S_JITTER_FRAMES = defineShaderEffect({
	...time,
	id: 'jasper.s.jitter-frames',
	label: 'S_JitterFrames',
	description: 'Each frame (or group of frames) shows a random nearby frame: repeatable time jitter.',
	keywords: ['jitter', 'random', 'stutter', 'glitch', 'shuffle'],
	params: [
		intParam('editFrameLength', 'Edit Frame Length', 1, { min: 1, softMax: 30 }),
		fxParam.number(
			'jitterFrameDist',
			'Jitter Frame Dist',
			10,
			{ min: 0, softMax: 60, step: 0.1 },
			{ unit: 'frames' },
		),
		sapphireSeedParam(),
	],
	gpu: {
		time: {
			remap: (p, ctx) =>
				jitterFramesSource(
					ctx.frame,
					int(p.editFrameLength, 1, 1),
					num(p.jitterFrameDist, 10),
					ctx.seed,
					ctx.duration,
				),
		},
		passes: [PASSTHROUGH_PASS],
	},
});

export const S_RANDOM_EDITS = defineShaderEffect({
	...time,
	id: 'jasper.s.random-edits',
	label: 'S_RandomEdits',
	description: 'Re-edits the whole clip: segments of Edit Frame Length play in a random, repeatable order.',
	keywords: ['random', 'shuffle', 'edit', 'montage', 'glitch'],
	params: [
		fxParam.number(
			'editFrameLength',
			'Edit Frame Length',
			2,
			{ min: 1, softMax: 60, step: 1 },
			{ unit: 'frames' },
		),
		sapphireSeedParam(),
	],
	gpu: {
		time: {
			remap: (p, ctx) => randomEditsSource(ctx.frame, int(p.editFrameLength, 2, 1), ctx.seed, ctx.duration),
		},
		passes: [PASSTHROUGH_PASS],
	},
});

// ---------------------------------------------------------------- S_Retime

const RETIME_EPS = 1e-4;

function retimeSamples(p: EffectParams, ctx: FxTimeContext): number[] {
	const { frame, t } = splitFrame(retimeSource(p, ctx.frame, ctx.duration));
	if (t <= RETIME_EPS && str(p.result, 'result') !== 'flowVectors') return [];
	return inSpan([1], clampToSpan(frame, ctx), ctx);
}

export const S_RETIME = defineShaderEffect({
	...time,
	id: 'jasper.s.retime',
	label: 'S_Retime',
	description:
		'Changes the speed of a clip (speed, longer, scale, fps, length or keyframed input frame) with motion-compensated in-between frames.',
	keywords: ['retime', 'slow motion', 'speed', 'optical flow', 'frame interpolation', 'time remap'],
	expensive: true,
	params: [
		fxParam.choice('mode', 'Mode', RETIME_MODES, RETIME_MODE_LABELS, 'speed'),
		fxParam.number('speed', 'Speed', 0.5, { min: 0.01, max: 10, step: 0.01 }),
		fxParam.number(
			'percentLonger',
			'Percent Longer',
			100,
			{ min: 0, max: 10000, softMax: 400, step: 0.1 },
			{ unit: '%' },
		),
		fxParam.number('percent', 'Percent', 200, { min: 1, max: 10000, softMax: 400, step: 0.1 }, { unit: '%' }),
		fxParam.number('inputFps', 'Input Fps', 30, { min: 1, max: 1000, step: 0.001 }),
		fxParam.number('outputFps', 'Output Fps', 60, { min: 1, max: 1000, step: 0.001 }),
		intParam('outputLength', 'Output Length', 30, { min: 2, max: 10000 }),
		fxParam.number('inputFrame', 'Input Frame', 1, { min: 0, max: 10000, step: 0.01 }, { unit: 'frames' }),
		fxParam.choice('result', 'Result', ['result', 'flowVectors'], ['Result', 'Flow Vectors'], 'result'),
		intParam('startFrame', 'Start Frame', 0, { min: 0 }),
		fxParam.number('motionBlur', 'Motion Blur', 0, { min: 0, max: 2, step: 0.01 }),
		fxParam.number('flowFieldSmoothness', 'Flow Field Smoothness', 0.8, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('flowViewScale', 'Flow View Scale', 0.9, { min: 0, softMax: 4, step: 0.01 }),
	],
	gpu: {
		time: {
			remap: (p, ctx) => retimeSource(p, ctx.frame, ctx.duration),
			samples: retimeSamples,
		},
		uniforms: (p, ctx) => ({ u_t: splitFrame(retimeSource(p, ctx.frame, ctx.duration)).t }),
		passes: (p) => {
			const smooth = Math.max(0, num(p.flowFieldSmoothness, 0.8));
			const defs = /* glsl */ `
vec4 flowA(vec2 uv) { return texture(u_source, uv); }
vec4 flowB(vec2 uv) { return fx_sample(0, uv); }
bool flowActive() { return u_sampleCount > 0; }`;
			return [
				...flowPasses(defs, [], 2e-4 * (0.25 + smooth), Math.min(1, smooth / 2)),
				{
					include: [GLSL_FLOW_FINAL],
					frag: /* glsl */ `${defs}
${FLOW_INTERP_GLSL}
void main() {
  vec4 a = texture(u_source, v_uv);
  if (u_result == 1) { fragColor = flowActive() ? fl_vectors(v_uv, u_flowViewScale) : vec4(1.0); return; }
  if (!flowActive() || u_t <= ${RETIME_EPS}) { fragColor = a; return; }
  fragColor = fl_interp(v_uv, u_t, u_motionBlur);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- reversing

export const S_REVERSE_CLIP = defineShaderEffect({
	...time,
	id: 'jasper.s.reverse-clip',
	label: 'S_ReverseClip',
	description: 'Plays the clip backwards, optionally swapping the fields of each frame.',
	keywords: ['reverse', 'backwards', 'rewind', 'fields'],
	params: [swapFieldsParam('yesUp1')],
	gpu: {
		time: { remap: (_p, ctx) => reverseClipSource(ctx.frame, ctx.duration) },
		passes: [SWAP_FIELDS_PASS],
	},
});

export const S_REVERSE_EDITS = defineShaderEffect({
	...time,
	id: 'jasper.s.reverse-edits',
	label: 'S_ReverseEdits',
	description: 'Reverses each segment of Edit Frame Length independently (5 4 3 2 1 10 9 8 7 6 …).',
	keywords: ['reverse', 'segments', 'stutter', 'backwards', 'glitch'],
	params: [
		intParam('editFrameLength', 'Edit Frame Length', 5, { min: 1, softMax: 60 }),
		intParam('editsStart', 'Edits Start', 0, { min: 0, softMax: 60 }),
		fxParam.toggle('reverseAll', 'Reverse All', false),
		swapFieldsParam('no'),
	],
	gpu: {
		time: {
			remap: (p, ctx) =>
				reverseEditsSource(
					ctx.frame,
					int(p.editFrameLength, 5, 1),
					int(p.editsStart, 0, 0),
					bool(p.reverseAll),
					ctx.duration,
				),
		},
		passes: [SWAP_FIELDS_PASS],
	},
});
