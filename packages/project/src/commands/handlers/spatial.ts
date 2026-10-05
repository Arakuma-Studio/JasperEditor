// Spatial interpolation commands (S03:KF-021, KF-030, OVL-020; wave1 spatial-motion-path):
// keyframe.setSpatialInterpolation (right-click ▸ Spatial Interpolation) and keyframe.setTangents (motion-path
// handle drags; the monitor sends absolute tangents through a session gesture, so one drag = one undo entry).
// Only vec2 point properties (`spatial` in the property / param spec) accept spatial data.
import { setSpatialMode, setTangents } from '../../keyframes-spatial.ts';
import type { Keyframe } from '../../schema/common.ts';
import type { CommandOf } from '../schemas/index.ts';
import { assertSpatialTarget, finish, locate, targetOf } from './keyframe.ts';
import type { HandlerMap } from './util.ts';

export const spatialHandlers: HandlerMap = {
	'keyframe.setSpatialInterpolation': (doc, cmd: CommandOf<'keyframe.setSpatialInterpolation'>, h) => {
		const found = locate(doc, cmd.keyframeIds, h);
		found.sort((a, b) => a.key.time - b.key.time);
		const touched = new Set<(typeof found)[number]['anim']>();
		for (const loc of found) {
			assertSpatialTarget(targetOf(doc, loc, h), h);
			const kfs = loc.anim.keyframes as Keyframe<unknown>[];
			setSpatialMode(kfs, kfs.indexOf(loc.key as Keyframe<unknown>), { mode: cmd.mode });
			touched.add(loc.anim);
		}
		finish(touched);
		return { updated: found.length };
	},

	'keyframe.setTangents': (doc, cmd: CommandOf<'keyframe.setTangents'>, h) => {
		if (!cmd.inTangent && !cmd.outTangent) h.fail('E_INVALID_PARAM', 'Give inTangent and/or outTangent');
		for (const t of [cmd.inTangent, cmd.outTangent])
			if (t && !t.every(Number.isFinite)) h.fail('E_INVALID_PARAM', 'Tangents must be finite numbers');
		const [loc] = locate(doc, [cmd.keyframeId], h);
		assertSpatialTarget(targetOf(doc, loc!, h), h);
		const kfs = loc!.anim.keyframes as Keyframe<unknown>[];
		setTangents(kfs, kfs.indexOf(loc!.key as Keyframe<unknown>), cmd);
		finish([loc!.anim]);
		return { keyframeId: loc!.key.id, spatial: JSON.parse(JSON.stringify(loc!.key.spatial)) };
	},
};
