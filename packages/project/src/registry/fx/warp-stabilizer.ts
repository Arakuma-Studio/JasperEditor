// Distort ▸ Warp Stabilizer (docs/wp-notes/gaps.md §FX-6): Premiere's live stabiliser. The clip is
// analysed in the background by the engine (`warp-analysis` job: features tracked frame to frame, robust translation /
// similarity / homography per frame, long trajectories for Subspace Warp); the analysis is stored with the effect
// instance (`EffectInstance.warpAnalysis`). This shader applies the stabilisation planned from it at the current
// settings (`gaps/warp/stabilize.ts`, cached per settings): a homography per frame, or Subspace Warp's mesh, then the
// framing (crop, auto-scale, Additional Scale) and, for "Stabilize, Synthesize Edges", the blank borders filled from
// neighbouring frames (time samples brought into the frame through the analysed motion). Without an analysis it
// passes the picture through (the Program monitor shows Premiere's banner; exports refuse: WARP_NOT_ANALYZED).

import {
	decodeWarpAnalysis,
	mediaTimeAtClipFrame,
	WARP_STABILIZER_EFFECT_ID,
	type WarpAnalysisData,
	warpAnalysisFps,
	warpFrameAt,
	warpPlanFor,
	warpSettingsOf,
} from '../../gaps/warp/analysis.ts';
import { type H3, hInv, hMul } from '../../gaps/warp/math.ts';
import { frameToFrame, type StabPlan } from '../../gaps/warp/stabilize.ts';
import type { EffectParams, EffectSpec } from '../effects.ts';
import { defineShaderEffect } from './define.ts';
import { GLSL_DATA } from './glsl/data.ts';
import { fxParam } from './params.ts';
import type { FxFrameContext, FxPlanContext, FxTimeContext, FxUniformValue } from './shader.ts';

const RESULT = ['smoothMotion', 'noMotion'] as const;
const METHOD = ['position', 'positionScaleRotation', 'perspective', 'subspaceWarp'] as const;
const FRAMING = ['stabilizeOnly', 'stabilizeCrop', 'stabilizeCropAutoScale', 'synthesizeEdges'] as const;
const RIPPLE = ['automatic', 'enhanced'] as const;
const hold = { animatable: false } as const;

/** The analysis of an instance (`ctx.structures.warpAnalysis`), when there is one. */
function analysisOf(ctx: FxPlanContext): WarpAnalysisData | null {
	const a = ctx.structures?.warpAnalysis;
	return a && Array.isArray(a.frames) && a.frames.length >= 14 ? a : null;
}

/** Clip-local frame → analysed frame index. */
function indexAt(a: WarpAnalysisData, frame: number, ctx: FxPlanContext): number {
	return warpFrameAt(a, mediaTimeAtClipFrame(a, frame, ctx.fps, ctx.clip)).index;
}

/** Time-sample offsets (clip frames) Synthesize Edges reads: nearest first, ±, within Synthesis Input Range. */
export function warpSynthesisOffsets(p: EffectParams, fps: number): number[] {
	if (p.framing !== 'synthesizeEdges') return [];
	const secs = typeof p.synthesisInputRange === 'number' ? Math.max(0, p.synthesisInputRange) : 1;
	const range = Math.round(secs * fps);
	if (range < 1) return [];
	const out: number[] = [];
	for (let k = 1; k <= 4; k++) {
		const o = Math.round((k * range) / 4);
		if (o >= 1 && !out.includes(o)) out.push(o, -o);
	}
	return out.slice(0, 8);
}

/** Column-major mat3 of a row-major homography (GLSL `mat3`). */
const colMajor = (h: H3): number[] => [h[0]!, h[3]!, h[6]!, h[1]!, h[4]!, h[7]!, h[2]!, h[5]!, h[8]!];

/** Layer px ↔ analysis px. */
const toLayer = (sx: number, sy: number, h: H3) =>
	hMul(hMul([sx, 0, 0, 0, sy, 0, 0, 0, 1], h), [1 / sx, 0, 0, 0, 1 / sy, 0, 0, 0, 1]);

function uniformsOf(p: EffectParams, ctx: FxFrameContext): Record<string, FxUniformValue> {
	const a = analysisOf(ctx);
	const none: Record<string, FxUniformValue> = {
		u_wsMode: { int: 0 },
		u_wsInv: { mat3: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
		u_wsFramingInv: { mat3: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
		u_wsMesh: { texels: [0, 0, 0, 0], key: 'none' },
		u_wsGrid: { ivec2: [1, 1] },
		u_wsCell: [1, 1],
		u_wsScale: [1, 1],
		u_wsCrop: [-1e9, -1e9, 1e9, 1e9],
		u_wsSynth: false,
		u_wsN: { floats: new Array(72).fill(0) },
		u_wsFeather: 0,
		u_wsEdgeCrop: [0, 0, 0, 0],
	};
	if (!a) return none;
	const s = warpSettingsOf(p, warpAnalysisFps(a));
	let plan: StabPlan;
	try {
		plan = warpPlanFor(a, s);
	} catch {
		return none;
	}
	const k = indexAt(a, ctx.frame, ctx);
	const sx = ctx.width / a.size[0];
	const sy = ctx.height / a.size[1];
	const u: Record<string, FxUniformValue> = { ...none, u_wsScale: [sx, sy] };
	const mesh = plan.meshes[k];
	if (mesh) {
		const fi = hInv(plan.framing) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
		const texels: number[] = [];
		for (let i = 0; i < mesh.verts.length; i += 2) texels.push(mesh.verts[i]!, mesh.verts[i + 1]!, 0, 0);
		u.u_wsMode = { int: 2 };
		u.u_wsFramingInv = { mat3: colMajor(fi) };
		u.u_wsMesh = { texels, key: `${a.key}|${JSON.stringify(s)}|${k}` };
		u.u_wsGrid = { ivec2: [mesh.cols, mesh.rows] };
		u.u_wsCell = [mesh.size[0] / mesh.cols, mesh.size[1] / mesh.rows];
	} else {
		const w = plan.warps[k];
		const inv = w ? hInv(w) : null;
		if (!inv) return none;
		u.u_wsMode = { int: 1 };
		u.u_wsInv = { mat3: colMajor(toLayer(sx, sy, inv)) };
	}
	if (plan.crop) u.u_wsCrop = [plan.crop[0] * sx, plan.crop[1] * sy, plan.crop[2] * sx, plan.crop[3] * sy];
	if (s.framing === 'synthesizeEdges') {
		const offs = warpSynthesisOffsets(p, ctx.fps);
		const n: number[] = [];
		for (const o of offs)
			n.push(
				...colMajor(toLayer(sx, sy, frameToFrame(decodeWarpAnalysis(a), k, indexAt(a, ctx.frame + o, ctx)))),
			);
		while (n.length < 72) n.push(0);
		u.u_wsSynth = offs.length > 0;
		u.u_wsN = { floats: n };
		const feather =
			typeof p.synthesisEdgeFeather === 'number' ? Math.max(0, Math.min(100, p.synthesisEdgeFeather)) : 0;
		u.u_wsFeather = (feather / 100) * 0.1 * Math.min(ctx.width, ctx.height);
	}
	const px = (k2: string) => (typeof p[k2] === 'number' ? Math.max(0, p[k2] as number) : 0);
	u.u_wsEdgeCrop = [px('edgeCropLeft'), px('edgeCropTop'), px('edgeCropRight'), px('edgeCropBottom')];
	return u;
}

const FRAG = /* glsl */ `
vec2 ws_apply(mat3 m, vec2 p) { vec3 q = m * vec3(p, 1.0); return q.xy / (abs(q.z) < 1e-9 ? 1e-9 : q.z); }
vec2 ws_vert(int i, int j) { return fx_texel(u_wsMesh, j * (u_wsGrid.x + 1) + i).xy; }
// Subspace Warp: the source position (analysis px) at a stabilised point (analysis px); outer cells extrapolate.
vec2 ws_mesh(vec2 p) {
  vec2 f = p / u_wsCell;
  ivec2 c = clamp(ivec2(floor(f)), ivec2(0), u_wsGrid - 1);
  vec2 t = f - vec2(c);
  vec2 a = ws_vert(c.x, c.y), b = ws_vert(c.x + 1, c.y), d = ws_vert(c.x, c.y + 1), e = ws_vert(c.x + 1, c.y + 1);
  return (1.0 - t.x) * (1.0 - t.y) * a + t.x * (1.0 - t.y) * b + (1.0 - t.x) * t.y * d + t.x * t.y * e;
}
// Distance (layer px) inside the usable source rectangle (the layer box less Synthesis Edge Cropping); < 0 outside.
float ws_inside(vec2 s) {
  vec2 lo = u_wsEdgeCrop.xy;
  vec2 hi = u_box.zw / u_pxScale - u_wsEdgeCrop.zw;
  return min(min(s.x - lo.x, s.y - lo.y), min(hi.x - s.x, hi.y - s.y));
}
mat3 ws_n(int i) {
  int o = i * 9;
  return mat3(u_wsN[o], u_wsN[o + 1], u_wsN[o + 2], u_wsN[o + 3], u_wsN[o + 4], u_wsN[o + 5], u_wsN[o + 6], u_wsN[o + 7], u_wsN[o + 8]);
}
void main() {
  if (u_wsMode == 0) { fragColor = texture(u_source, v_uv); return; }
  vec2 p = fx_layerPx();
  if (p.x < u_wsCrop.x || p.y < u_wsCrop.y || p.x > u_wsCrop.z || p.y > u_wsCrop.w) { fragColor = vec4(0.0); return; }
  vec2 s;
  if (u_wsMode == 2) s = ws_mesh(ws_apply(u_wsFramingInv, p / u_wsScale)) * u_wsScale;
  else s = ws_apply(u_wsInv, p);
  float d = ws_inside(s);
  vec4 col = d >= 0.0 ? texture(u_source, fx_uvOfLayerPx(s)) : vec4(0.0);
  if (u_wsSynth) {
    float w = u_wsFeather > 0.0 ? clamp(d / u_wsFeather, 0.0, 1.0) : (d >= 0.0 ? 1.0 : 0.0);
    if (w < 1.0) {
      for (int i = 0; i < 8; i++) {
        if (i >= u_sampleCount) break;
        if (((u_sampleValid >> i) & 1) == 0) continue;
        vec2 q = ws_apply(ws_n(i), s);
        if (ws_inside(q) < 0.0) continue;
        col = mix(fx_sample(i, fx_uvOfLayerPx(q)), col, w);
        break;
      }
    }
  }
  fragColor = col;
}`;

export const WARP_STABILIZER: EffectSpec = defineShaderEffect({
	id: WARP_STABILIZER_EFFECT_ID,
	label: 'Warp Stabilizer',
	category: 'Distort',
	description:
		'Removes camera shake: the clip is analysed in the background, then each frame is warped (Position, Scale and Rotation, Perspective or Subspace Warp) towards a smooth or locked camera, with crop, auto-scale or synthesized edges.',
	keywords: ['stabilize', 'stabilise', 'shake', 'jitter', 'warp', 'steady', 'smooth'],
	expensive: true,
	params: [
		fxParam.choice('result', 'Result', RESULT, ['Smooth Motion', 'No Motion'], 'smoothMotion', {
			group: 'Stabilization',
		}),
		{
			...fxParam.number(
				'smoothness',
				'Smoothness',
				50,
				{ min: 0, max: 1000, softMax: 200, step: 1 },
				{ unit: '%' },
			),
			...hold,
			group: 'Stabilization',
		},
		fxParam.choice(
			'method',
			'Method',
			METHOD,
			['Position', 'Position, Scale, Rotation', 'Perspective', 'Subspace Warp'],
			'subspaceWarp',
			{ group: 'Stabilization' },
		),
		fxParam.toggle('preserveScale', 'Preserve Scale', false, { group: 'Stabilization' }),
		fxParam.choice(
			'framing',
			'Framing',
			FRAMING,
			['Stabilize Only', 'Stabilize, Crop', 'Stabilize, Crop, Auto-scale', 'Stabilize, Synthesize Edges'],
			'stabilizeCropAutoScale',
			{ group: 'Borders' },
		),
		{
			...fxParam.number(
				'maxScale',
				'Maximum Scale',
				150,
				{ min: 100, max: 1000, softMax: 300, step: 1 },
				{ unit: '%' },
			),
			...hold,
			group: 'Borders',
		},
		{
			...fxParam.number('actionSafe', 'Action-Safe Margin', 0, { min: 0, max: 45, step: 0.1 }, { unit: '%' }),
			...hold,
			group: 'Borders',
		},
		{
			...fxParam.number(
				'additionalScale',
				'Additional Scale',
				100,
				{ min: 1, max: 1000, softMax: 300, step: 1 },
				{ unit: '%' },
			),
			...hold,
			group: 'Borders',
		},
		fxParam.toggle('detailedAnalysis', 'Detailed Analysis', false, { group: 'Advanced' }),
		fxParam.choice(
			'rollingShutterRipple',
			'Rolling Shutter Ripple',
			RIPPLE,
			['Automatic Reduction', 'Enhanced Reduction'],
			'automatic',
			{ group: 'Advanced' },
		),
		{
			...fxParam.number(
				'cropLessSmoothMore',
				'Crop Less <-> Smooth More',
				50,
				{ min: 0, max: 100, step: 1 },
				{ unit: '%' },
			),
			...hold,
			group: 'Advanced',
		},
		{
			...fxParam.number(
				'synthesisInputRange',
				'Synthesis Input Range (seconds)',
				1,
				{ min: 0, max: 10, step: 0.1 },
				{ unit: 's' },
			),
			...hold,
			group: 'Advanced',
		},
		{
			...fxParam.number('synthesisEdgeFeather', 'Synthesis Edge Feather', 0, { min: 0, max: 100, step: 1 }),
			...hold,
			group: 'Advanced',
		},
		{
			...fxParam.pixels('edgeCropLeft', 'Synthesis Edge Cropping: Left', 0, 200),
			...hold,
			group: 'Advanced',
		},
		{ ...fxParam.pixels('edgeCropTop', 'Synthesis Edge Cropping: Top', 0, 200), ...hold, group: 'Advanced' },
		{
			...fxParam.pixels('edgeCropRight', 'Synthesis Edge Cropping: Right', 0, 200),
			...hold,
			group: 'Advanced',
		},
		{
			...fxParam.pixels('edgeCropBottom', 'Synthesis Edge Cropping: Bottom', 0, 200),
			...hold,
			group: 'Advanced',
		},
		fxParam.toggle('hideWarningBanner', 'Hide Warning Banner', false, { group: 'Advanced' }),
	],
	gpu: {
		uniforms: (p, ctx) => uniformsOf(p, ctx),
		time: {
			samples: (p: EffectParams, ctx: FxTimeContext) => warpSynthesisOffsets(p, ctx.fps),
			sampleEdge: 'transparent',
		},
		passes: [{ include: [GLSL_DATA], frag: FRAG }],
	},
});

export const WARP_STABILIZER_EFFECTS: readonly EffectSpec[] = [WARP_STABILIZER];
