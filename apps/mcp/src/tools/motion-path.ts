import {
	type Animatable,
	type Clip,
	contentTimeAt,
	defaultEffectRegistry,
	type EffectInstance,
	effectiveTangents,
	evaluate,
	fpsOf,
	intrinsicBoxOf,
	type Keyframe,
	type ProjectDocument,
	paramSpatialMetric,
	type Sequence,
	SpatialInterpolationSchema,
	type SpatialMetric,
	sequenceFrameOfContentTime,
	sequenceTimecode,
	spatialModeOf,
	type Vec2,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import { defineTool, EDIT_IDEMPOTENT, findClip, loadDoc, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { applyHelper } from './editing.ts';

export const MOTION_PATH_GUIDE = `Motion paths (curved position animation):
- Position (and Anchor Point, Corner Pin corners) keys have a spatial interpolation besides the temporal one: linear (straight segments), bezier (independent in/out tangents), auto-bezier (smooth tangents from the neighbours: along next − prev, each handle ⅓ of its neighbouring segment, as in After Effects; keys made before keyframes-blend keep (next − prev) / 6 until Auto Bezier is re-applied) or continuous-bezier (user tangents kept opposite). New position keys are auto-bezier spatial with linear temporal, so three or more keys make a smooth curve travelled at constant speed; temporal eases change the speed along the curve, not its shape.
- get_motion_path {clipId} shows the keys (frame, value, modes, effective tangents) and sampled points; set_spatial_interpolation {clipId | keyframeIds, mode} changes the mode (linear = straight lines).
- Tangents are offsets from the key in sequence pixels: apply_commands keyframe.setTangents {keyframeId, inTangent?, outTangent?, breakContinuity?} (a non-bezier key becomes continuous-bezier and the other side turns opposite unless breakContinuity). keyframe.add / keyframe.update also take spatial {mode, inTangent?, outTangent?}.
- Effect point params are motion paths too (Transform's Position / Anchor Point, Offset's Shift Center To, Mirror's Reflection Center, lens / zoom / light centres, Corner Pin corners, every point the Program monitor shows a crosshair for): new keys are auto-bezier spatial like Motion's Position. Their values AND tangents are normalised to the layer box ([0,0] top-left, [1,1] bottom-right), but lengths are measured in the box's pixels (a circle path on a 16:9 layer stays round and is travelled at constant speed; Auto Bezier handles follow the pixel distances). get_motion_path / set_spatial_interpolation take effect {effectInstanceId, param} with clipId; pathLength is then in layer pixels. Transition params are never spatial.`;

function positionOf(clip: Clip, property: 'position' | 'anchor' = 'position'): Animatable<Vec2> {
	const t = (clip as { transform?: { position?: Animatable<Vec2>; anchor?: Animatable<Vec2> } }).transform;
	const p = property === 'anchor' ? t?.anchor : t?.position;
	if (!p)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Clip ${clip.id} has no Motion`,
			'Pick a visual clip (video, still…).',
		);
	return p;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (v: readonly number[]): Vec2 => [round(v[0]!), round(v[1]!)];
const round6 = (n: number) => Math.round(n * 1e6) / 1e6 || 0;
const r6 = (v: readonly number[]): Vec2 => [round6(v[0]!), round6(v[1]!)];

const EffectPointArg = z
	.strictObject({
		effectInstanceId: z.string().min(1).describe('Effect instance id on the clip ("fx_…")'),
		param: z.string().min(1).describe('Point param name (e.g. "position", "anchorPoint", "center")'),
	})
	.describe('An effect point param of the clip instead of Motion (values normalised to the layer box)');

/**
 * spatial-points: an effect point param of a clip, its spatial metric (the layer box in px) and label; refused for
 * unknown instances and params that are not points.
 */
function effectPointOf(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	ref: { effectInstanceId: string; param: string },
): { anim: Animatable<Vec2>; metric: SpatialMetric | undefined; box: { width: number; height: number } } {
	const fx = ((clip as { effects?: EffectInstance[] }).effects ?? []).find((e) => e.id === ref.effectInstanceId);
	if (!fx)
		throw new ToolError(
			'E_NOT_FOUND',
			`Clip ${clip.id} has no effect ${ref.effectInstanceId}`,
			'get_clip_properties lists the clip effects and their ids.',
		);
	const p = defaultEffectRegistry.get(fx.effectId, fx.effectVersion)?.params.find((x) => x.name === ref.param);
	if (!p?.spatial)
		throw new ToolError(
			'E_INVALID_PARAM',
			`${fx.effectId}.${ref.param} is not a point param; it has no motion path`,
			'Pick a point param (a vec2 position such as position, anchorPoint or center).',
		);
	const box = intrinsicBoxOf({ doc, seq, clip });
	const anim = (fx.params[ref.param] as Animatable<Vec2> | undefined) ?? {
		value: p.default as Vec2,
		keyframes: [],
	};
	return { anim, metric: paramSpatialMetric(p, box), box };
}

export function registerMotionPathTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_motion_path',
		{
			title: 'Get motion path',
			description:
				"A clip's position (or, with property: 'anchor', Anchor Point) animation as a motion path: every position key (id, sequence frame, timecode, value, temporal and spatial interpolation, effective in/out tangents in sequence pixels) and the evaluated position sampled across the clip (at most `samples` points, evenly spaced in time; spacing encodes speed), plus the path length. Values are exactly what the preview and export draw.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Clip id ("clp_…")'),
				samples: z.number().int().min(2).max(1000).optional().describe('Sampled points (default 60)'),
				property: z
					.enum(['position', 'anchor'])
					.optional()
					.describe(
						'position (default; sequence px) or anchor (the Anchor Point path; values and tangents in layer px)',
					),
				effect: EffectPointArg.optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, clipId, samples, property, effect }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq, clip } = findClip(doc, clipId);
			if (effect && property)
				throw new ToolError('E_INVALID_PARAM', 'Give property (Motion) or effect, not both');
			const point = effect ? effectPointOf(doc, seq, clip, effect) : null;
			const anim = point ? point.anim : positionOf(clip, property ?? 'position');
			const metric = point?.metric;
			const opts = metric ? { metric } : undefined;
			// Effect points are normalised: more decimals.
			const rv = point ? r6 : r2;
			const rate = seq.settings.frameRate;
			const kfs = anim.keyframes as readonly Keyframe<unknown>[];
			const keys = anim.keyframes.map((k, i) => {
				const frame = sequenceFrameOfContentTime(clip, k.time, rate);
				const t = effectiveTangents(kfs, i, metric);
				return {
					keyframeId: k.id,
					frame,
					timecode: sequenceTimecode(seq, frame),
					value: rv(k.value),
					temporal: k.interpolation,
					// keyframe-sides: the incoming temporal side when the key has one of its own.
					...(k.inInterpolation !== undefined ? { temporalIn: k.inInterpolation } : {}),
					spatial: spatialModeOf(k),
					inTangent: rv(t.inTangent),
					outTangent: rv(t.outTangent),
				};
			});
			const n = Math.min(samples ?? 60, clip.duration);
			const points: { frame: number; position: Vec2 }[] = [];
			let length = 0;
			let prev: Vec2 | null = null;
			const [sx, sy] = metric ?? [1, 1];
			for (let j = 0; j < clip.duration; j++) {
				const v = evaluate(anim, contentTimeAt(clip, clip.start + j, rate), opts);
				if (prev) length += Math.hypot((v[0] - prev[0]) * sx, (v[1] - prev[1]) * sy);
				prev = v;
				const want = n <= 1 ? 0 : Math.round((points.length * (clip.duration - 1)) / (n - 1));
				if (j === want && points.length < n) points.push({ frame: clip.start + j, position: rv(v) });
			}
			return jsonResult({
				clipId,
				...(effect ? { effect, units: 'layer-box', box: point!.box } : {}),
				fps: fpsOf(rate),
				animated: anim.keyframes.length > 0,
				keys,
				pathLength: round(length),
				...(effect ? { pathLengthUnits: 'layer px' } : {}),
				points,
			});
		},
	);

	defineTool(
		ctx,
		'set_spatial_interpolation',
		{
			title: 'Set spatial interpolation',
			description:
				"Sets the spatial interpolation of point keys (Effect Controls ▸ right-click ▸ Spatial Interpolation): linear = straight segments, bezier / continuous-bezier = editable tangents (a linear key starts from its auto tangents), auto-bezier = smooth automatic curve. Give keyframeIds (any point property: position, anchor, effect points such as the Transform effect's Position, corner pin corners) or clipId (all of the clip's position keys, or with effect all keys of that effect point param). One undoable step; check with get_motion_path or render_frame.",
			input: {
				projectId: ProjectIdArg,
				mode: SpatialInterpolationSchema.describe('linear | bezier | auto-bezier | continuous-bezier'),
				clipId: z.string().min(1).optional().describe('Every position key of this clip'),
				effect: EffectPointArg.optional(),
				keyframeIds: z.array(z.string().min(1)).min(1).optional().describe('These keys'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, mode, clipId, effect, keyframeIds }, extra) => {
			if (!!clipId === !!keyframeIds)
				throw new ToolError('E_INVALID_PARAM', 'Give exactly one of clipId or keyframeIds');
			if (effect && !clipId) throw new ToolError('E_INVALID_PARAM', 'effect needs clipId');
			let ids = keyframeIds ?? [];
			if (clipId) {
				const { doc } = await loadDoc(ctx, projectId);
				const { seq, clip } = findClip(doc, clipId);
				ids = (effect ? effectPointOf(doc, seq, clip, effect).anim : positionOf(clip)).keyframes.map(
					(k) => k.id,
				);
				if (ids.length === 0)
					throw new ToolError(
						'E_INVALID_PARAM',
						effect
							? `${effect.effectInstanceId}.${effect.param} has no keyframes`
							: `Clip ${clipId} has no position keyframes`,
						'Animate it first: param.setAnimated then param.set with "at", or keyframe.add.',
					);
			}
			return applyHelper(
				ctx,
				projectId,
				'Spatial Interpolation',
				[{ type: 'keyframe.setSpatialInterpolation', keyframeIds: ids, mode }],
				extra,
			);
		},
	);
}
