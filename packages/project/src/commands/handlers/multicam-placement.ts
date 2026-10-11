import { firstVideoAngle } from '../../multicam/model.ts';
import type { MulticamSource } from '../../schema/sequence.ts';
import type { DSeq } from '../context.ts';
/**
 * Nest clips just placed from a multi-camera source become enabled multi-camera clips showing camera 1 (audio clips:
 * the same angle; what they play follows the source's audio mode).
 */
export function markMulticamClips(seq: DSeq, clipIds: readonly string[], mc: MulticamSource): void {
	const first = firstVideoAngle(mc) ?? mc.angles[0];
	if (!first) return;
	for (const id of clipIds) {
		const c = seq.clips[id];
		if (c && (c.kind === 'nest-video' || c.kind === 'nest-audio'))
			c.multicam = {
				enabled: true,
				angle: first.id,
			};
	}
}
