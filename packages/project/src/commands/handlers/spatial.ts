// Spatial interpolation commands (S03:KF-021, KF-030, OVL-020; wave1 spatial-motion-path):
// keyframe.setSpatialInterpolation (right-click ▸ Spatial Interpolation) and keyframe.setTangents (motion-path
// handle drags; the monitor sends absolute tangents through a session gesture, so one drag = one undo entry).
// Only vec2 point properties (`spatial` in the property / param spec) accept spatial data.
import { setSpatialMode, setTangents } from '../../keyframes-spatial.ts';
import type { Keyframe } from '../../schema/common.ts';
import type { CommandOf } from '../schemas/index.ts';
import { assertSpatialTarget, finish, locate, MetricMap, targetOf } from './keyframe.ts';
import type { HandlerMap } from './util.ts';

export const spatialHandlers = {
	'keyframe.setSpatialInterpolation': (doc, cmd: CommandOf<'keyframe.setSpatialInterpolation'>, h) => {
		const found = locate(doc, cmd.keyframeIds, h);
		found.sort((a, b) => a.key.time - b.key.time);
		const touched = new Set<(typeof found)[number]['anim']>();
		const metrics = new MetricMap();
		for (const loc of found) {
			const target = metrics.note(targetOf(doc, loc, h));
			assertSpatialTarget(target, h);
			const kfs = loc.anim.keyframes as Keyframe<unknown>[];
			// spatial-points: effect points measure handle lengths in their layer box's pixels.
			setSpatialMode(kfs, kfs.indexOf(loc.key as Keyframe<unknown>), { mode: cmd.mode }, target.metric);
			touched.add(loc.anim);
		}
		finish(touched, metrics.of);
		return { updated: found.length };
	},

	'keyframe.setTangents': (doc, cmd: CommandOf<'keyframe.setTangents'>, h) => {
		if (!cmd.inTangent && !cmd.outTangent) h.fail('E_INVALID_PARAM', 'Give inTangent and/or outTangent');
		for (const t of [cmd.inTangent, cmd.outTangent])
			if (t && !t.every(Number.isFinite)) h.fail('E_INVALID_PARAM', 'Tangents must be finite numbers');
		const [loc] = locate(doc, [cmd.keyframeId], h);
		const target = targetOf(doc, loc!, h);
		assertSpatialTarget(target, h);
		const kfs = loc!.anim.keyframes as Keyframe<unknown>[];
		setTangents(kfs, kfs.indexOf(loc!.key as Keyframe<unknown>), cmd, target.metric);
		finish([loc!.anim], () => target.metric);
		return { keyframeId: loc!.key.id, spatial: JSON.parse(JSON.stringify(loc!.key.spatial)) };
	},
} satisfies HandlerMap;
