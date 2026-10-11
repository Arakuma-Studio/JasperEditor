// keyframe.setRoving (keyframes-blend): right-click ▸ Rove Across Time (After Effects). The evaluator treats each run
// of roving keys between two fixed keys as one segment (`keyframes.ts` roving runs); `finish` re-times the roving keys
// to where the motion passes them. Turning roving off keeps the key's current time and gives it Continuous Bezier
// eases carrying the run's speed through it, so the motion barely changes.
import { isHoldOnlyValue, stopRoving } from '../../keyframes.ts';
import type { Keyframe } from '../../schema/common.ts';
import type { CommandOf } from '../schemas/index.ts';
import { finish, locate, targetOf } from './keyframe.ts';
import type { HandlerMap } from './util.ts';

export const rovingHandlers = {
	'keyframe.setRoving': (doc, cmd: CommandOf<'keyframe.setRoving'>, h) => {
		const found = locate(doc, cmd.keyframeIds, h);
		const touched = new Set<(typeof found)[number]['anim']>();
		let updated = 0;
		for (const loc of found) {
			const target = targetOf(doc, loc, h);
			const kfs = loc.anim.keyframes as Keyframe<unknown>[];
			const i = kfs.indexOf(loc.key as Keyframe<unknown>);
			if (cmd.roving) {
				if (i === 0 || i === kfs.length - 1) {
					h.warn(
						'W_VALUE_CLAMPED',
						`Keyframe ${loc.key.id} is the first or last key of ${target.label}: it cannot rove`,
					);
					continue;
				}
				if (loc.key.interpolation === 'hold' || target.rule.holdOnly || isHoldOnlyValue(loc.key.value)) {
					h.warn('W_VALUE_CLAMPED', `Keyframe ${loc.key.id} holds its value: it cannot rove`);
					continue;
				}
				loc.key.roving = true;
			} else stopRoving(kfs, i);
			updated++;
			touched.add(loc.anim);
		}
		finish(touched);
		return { updated };
	},
} satisfies HandlerMap;
