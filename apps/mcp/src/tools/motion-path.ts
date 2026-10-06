// Motion paths for agents (S03:KF-021, KF-030, OVL-020; wave1 spatial-motion-path): read a clip's position path
// (keys with their spatial interpolation and effective tangents, sampled points) and set the spatial
// interpolation of position keys. Tangent edits go through apply_commands keyframe.setTangents.
import {
	type Animatable,
	type Clip,
	contentTimeAt,
	effectiveTangents,
	evaluate,
	fpsOf,
	type Keyframe,
	type ProjectDocument,
	type Sequence,
	SpatialInterpolationSchema,
	sequenceFrameOfContentTime,
	sequenceTimecode,
	spatialModeOf,
	type Vec2,
} from '@jasper/project';
import { z } from 'zod';
import { defineTool, EDIT_IDEMPOTENT, loadDoc, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { applyHelper } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const MOTION_PATH_GUIDE = `Motion paths (curved position animation):
- Position (and Anchor Point, Corner Pin corners) keys have a spatial interpolation besides the temporal one: linear (straight segments), bezier (independent in/out tangents), auto-bezier (smooth tangents from the neighbours, (next − prev) / 6) or continuous-bezier (user tangents kept opposite). New position keys are auto-bezier spatial with linear temporal, so three or more keys make a smooth curve travelled at constant speed; temporal eases change the speed along the curve, not its shape.
- get_motion_path {clipId} shows the keys (frame, value, modes, effective tangents) and sampled points; set_spatial_interpolation {clipId | keyframeIds, mode} changes the mode (linear = straight lines).
- Tangents are offsets from the key in sequence pixels: apply_commands keyframe.setTangents {keyframeId, inTangent?, outTangent?, breakContinuity?} (a non-bezier key becomes continuous-bezier and the other side turns opposite unless breakContinuity). keyframe.add / keyframe.update also take spatial {mode, inTangent?, outTangent?}.`;

function findClip(doc: ProjectDocument, clipId: string): { seq: Sequence; clip: Clip } {
	for (const seq of Object.values(doc.sequences)) {
		const clip = seq.clips[clipId];
		if (clip) return { seq, clip };
	}
	throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipId}`, 'Call get_timeline for clip ids.');
}

function positionOf(clip: Clip): Animatable<Vec2> {
	const p = (clip as { transform?: { position?: Animatable<Vec2> } }).transform?.position;
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

export function registerMotionPathTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_motion_path',
		{
			title: 'Get motion path',
			description:
				"A clip's position animation as a motion path: every position key (id, sequence frame, timecode, value, temporal and spatial interpolation, effective in/out tangents in sequence pixels) and the evaluated position sampled across the clip (at most `samples` points, evenly spaced in time; spacing encodes speed), plus the path length. Values are exactly what the preview and export draw.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Clip id ("clp_…")'),
				samples: z.number().int().min(2).max(1000).optional().describe('Sampled points (default 60)'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, clipId, samples }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq, clip } = findClip(doc, clipId);
			const anim = positionOf(clip);
			const rate = seq.settings.frameRate;
			const kfs = anim.keyframes as readonly Keyframe<unknown>[];
			const keys = anim.keyframes.map((k, i) => {
				const frame = sequenceFrameOfContentTime(clip, k.time, rate);
				const t = effectiveTangents(kfs, i);
				return {
					keyframeId: k.id,
					frame,
					timecode: sequenceTimecode(seq, frame),
					value: r2(k.value),
					temporal: k.interpolation,
					spatial: spatialModeOf(k),
					inTangent: r2(t.inTangent),
					outTangent: r2(t.outTangent),
				};
			});
			const n = Math.min(samples ?? 60, clip.duration);
			const points: { frame: number; position: Vec2 }[] = [];
			let length = 0;
			let prev: Vec2 | null = null;
			for (let j = 0; j < clip.duration; j++) {
				const v = evaluate(anim, contentTimeAt(clip, clip.start + j, rate));
				if (prev) length += Math.hypot(v[0] - prev[0], v[1] - prev[1]);
				prev = v;
				const want = n <= 1 ? 0 : Math.round((points.length * (clip.duration - 1)) / (n - 1));
				if (j === want && points.length < n) points.push({ frame: clip.start + j, position: r2(v) });
			}
			return jsonResult({
				clipId,
				fps: fpsOf(rate),
				animated: anim.keyframes.length > 0,
				keys,
				pathLength: round(length),
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
				"Sets the spatial interpolation of position keys (Effect Controls ▸ right-click ▸ Spatial Interpolation): linear = straight segments, bezier / continuous-bezier = editable tangents (a linear key starts from its auto tangents), auto-bezier = smooth automatic curve. Give keyframeIds (any point property: position, anchor, corner pin corners) or clipId (all of the clip's position keys). One undoable step; check with get_motion_path or render_frame.",
			input: {
				projectId: ProjectIdArg,
				mode: SpatialInterpolationSchema.describe('linear | bezier | auto-bezier | continuous-bezier'),
				clipId: z.string().min(1).optional().describe('Every position key of this clip'),
				keyframeIds: z.array(z.string().min(1)).min(1).optional().describe('These keys'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, mode, clipId, keyframeIds }, extra) => {
			if (!!clipId === !!keyframeIds)
				throw new ToolError('E_INVALID_PARAM', 'Give exactly one of clipId or keyframeIds');
			let ids = keyframeIds ?? [];
			if (clipId) {
				const { doc } = await loadDoc(ctx, projectId);
				ids = positionOf(findClip(doc, clipId).clip).keyframes.map((k) => k.id);
				if (ids.length === 0)
					throw new ToolError(
						'E_INVALID_PARAM',
						`Clip ${clipId} has no position keyframes`,
						'Animate position first: param.setAnimated then param.set with "at", or keyframe.add.',
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
