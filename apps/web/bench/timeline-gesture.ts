// The timeline's gesture path on a 1 000-clip sequence (workstream perf-core, ARCHITECTURE §13 "50-clip gesture
// update < 8 ms"): one pointer move of a 50-clip drag through the real TimelineController (snapping, the
// session's gesture update) plus what the timeline derives from the drawn sequence to render that frame (per-track
// index and visible clips, through edits, out-of-sync offsets, transitions, duration).
// Run: pnpm exec tsx apps/web/bench/timeline-gesture.ts [clips=1000] [moves=60]
import { performance } from 'node:perf_hooks';
import { clipsInRange, outOfSyncOffsets, type Sequence, sequenceDuration, throughEdits } from '@jasper/project';
import { transitionIndex } from '../src/panels/timeline/model/transitions.ts';
import { setupTimeline, solid } from '../test/timeline-helpers.ts';

const clips = Number(process.argv[2] ?? 1000);
const moves = Number(process.argv[3] ?? 60);
const t = setupTimeline({ pxPerFrame: 2 });
t.session.setToggles({ snapping: true });
t.apply([
	{ type: 'track.add', kind: 'video', count: 1 },
	...Array.from({ length: clips }, (_, i) => solid(Math.floor(i / 4) * 40, 30, `V${(i % 4) + 1}`)),
]);
const seq = () => t.session.getDrawn().sequences[t.seqId] as Sequence;
const ids = Object.keys(seq().clips).slice(0, 50);
t.session.select('timeline', ids, 'replace', { linked: false, groups: false });
const first = seq().clips[ids[0]!]!;

/** What the panel derives for one frame of the drawn sequence (the visible window of 1 000 px). */
function render(s: Sequence): number {
	let n = 0;
	for (const tr of s.videoTracks) n += clipsInRange(s, tr.id, 0, 600).length;
	n += throughEdits(s).length;
	n += Object.keys(outOfSyncOffsets(s)).length;
	n += transitionIndex(s, t.session.getDrawn().media as never).size;
	return n + sequenceDuration(s);
}

const timed = (fn: () => void) => {
	const a = performance.now();
	fn();
	return performance.now() - a;
};
const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return `best ${s[0]!.toFixed(2)} ms, median ${s[s.length >> 1]!.toFixed(2)} ms`;
};
const ctl: number[] = [];
const der: number[] = [];
for (let round = 0; round < 3; round++) {
	t.controller.pointerDown(t.pt(t.x(first.start + 5), t.rowY('V1')));
	for (let i = 1; i <= moves; i++) {
		const x = t.x(first.start + 5) + i * 7;
		ctl.push(timed(() => t.controller.pointerMove(t.pt(x, t.rowY('V1')))));
		der.push(timed(() => render(seq())));
	}
	if (round === 0) {
		const committed = t.session.getCommitted().sequences[t.seqId]!.clips;
		const moved = ids.filter((id) => seq().clips[id]?.start !== committed[id]!.start).length;
		console.log(`moving clips in the drawn sequence: ${moved}`);
	}
	t.controller.cancel();
	t.controller.pointerUp(t.pt(0, 0));
}
console.log(`${clips} clips, 50 moving, ${moves} moves × 3`);
console.log(`controller pointerMove (gesture update): ${stats(ctl)}`);
console.log(`timeline derivations of the drawn sequence: ${stats(der)}`);
console.log(`frame total: ${stats(ctl.map((c, i) => c + der[i]!))}`);
