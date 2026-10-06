import type { Sequence, Transition } from '@jasper/project';
import { setupTimeline, solid } from './timeline-helpers.ts';

/** Many independent fades; fixture construction is deliberately outside benchmark timings. */
export function transitionSequence(count: number) {
	const t = setupTimeline();
	t.apply([solid(0, 60, 'V1')]);
	const base = Object.values(t.seq().clips)[0]!;
	t.apply([
		{ type: 'transition.add', clipId: base.id, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 20 },
	]);
	const fade = Object.values(t.seq().transitions)[0]!;
	const clips: Sequence['clips'] = {};
	const transitions: Record<string, Transition> = {};
	for (let i = 0; i < count; i++) {
		const id = `clip-${i}`;
		clips[id] = { ...base, id, start: i * 100 };
		transitions[`fade-${i}`] = { ...fade, id: `fade-${i}`, incomingClipId: id };
	}
	const seq = { ...t.seq(), clips, transitions };
	return {
		seq,
		media: t.session.getCommitted().media,
		row: t.geometry().layout.video.rows.find((r) => r.trackId === base.trackId)!,
	};
}
