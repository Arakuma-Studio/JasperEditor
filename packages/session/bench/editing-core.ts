// ARCHITECTURE §13 editing-core benchmark (workstream perf-core): one command and one 50-clip gesture update on
// large documents, best of N, for profiling with `--cpu-prof`.
// Run: pnpm exec tsx packages/session/bench/editing-core.ts [clips=1000] [sequences=1] [runs=30]
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	invariantStats,
	type ProjectDocument,
} from '@jasper/project';
import { MemoryProjectStore } from '../src/persistence/memory.ts';
import { EditorSession } from '../src/session.ts';

const clips = Number(process.argv[2] ?? 1000);
const sequences = Number(process.argv[3] ?? 1);
const runs = Number(process.argv[4] ?? 30);

const ids = createCounterIdSource(1);
const now = () => '2026-10-08T10:00:00.000Z';
const store = new MemoryProjectStore({ ids, now });
const doc = createEmptyProject({ ids, name: 'Perf', preset: 'hd-1080p-30' });
store.put(doc);
const ctx = { ids, now, registries: defaultRegistries() };
const s = await EditorSession.open({ store, projectId: doc.projectId, ctx, sessionId: 'perf' });
const t0 = performance.now();
const perSeq = Math.ceil(clips / sequences);
for (let q = 0; q < sequences; q++) {
	if (q > 0) {
		const r = s.apply({
			label: 'seq',
			origin: 'user',
			commands: [{ type: 'sequence.create', name: `S${q}` } as never],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		s.openSequence(r.created.find((id) => id.startsWith('seq_'))!);
	}
	const seqId = q === 0 ? Object.keys(s.getCommitted().sequences)[0]! : s.getState().activeSequenceId!;
	const commands = Array.from({ length: perSeq }, (_, i) => ({
		type: 'clip.addSolid' as const,
		at: Math.floor(i / 4) * 40,
		duration: 30,
		track: `V${(i % 4) + 1}`,
		color: [1, 0, 0, 1] as [number, number, number, number],
	}));
	const r = s.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'track.add', kind: 'video', count: 1 }, ...commands],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
}
console.log(`setup ${clips} clips / ${sequences} sequences: ${(performance.now() - t0).toFixed(0)} ms`);

const firstSeq = (d: ProjectDocument) => Object.values(d.sequences)[0]!;
const clipIds = Object.keys(firstSeq(s.getCommitted()).clips);
// PROFILE=<dir>: CPU profiles of the timed sections only (command.cpuprofile, gesture.cpuprofile).
const profileDir = process.env.PROFILE;
const inspector = profileDir ? new Session() : null;
if (inspector) {
	inspector.connect();
	await inspector.post('Profiler.enable');
}
const profiled = async (name: string, fn: () => void) => {
	if (inspector) await inspector.post('Profiler.start');
	fn();
	if (inspector) {
		const { profile } = await inspector.post('Profiler.stop');
		writeFileSync(`${profileDir}/${name}.cpuprofile`, JSON.stringify(profile));
	}
};
const best = (n: number, fn: () => void) => {
	const all: number[] = [];
	for (let i = 0; i < n; i++) {
		const a = performance.now();
		fn();
		all.push(performance.now() - a);
	}
	all.sort((x, y) => x - y);
	return { best: all[0]!, median: all[all.length >> 1]! };
};
let k = 0;
const seqId = firstSeq(s.getCommitted()).id;
let cmd = { best: 0, median: 0 };
await profiled('command', () => {
	cmd = best(runs, () => {
		const id = clipIds[k++ % clipIds.length]!;
		const r = s.apply({
			label: 'Opacity',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'param.set', target: ['clip', id, 'opacity'], value: 50 + (k % 40) }],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
	});
});
console.log(`command: best ${cmd.best.toFixed(2)} ms, median ${cmd.median.toFixed(2)} ms`);
const g = s.beginGesture('Move');
let d = 0;
const fifty = clipIds.slice(0, 50);
let ges = { best: 0, median: 0 };
await profiled('gesture', () => {
	ges = best(runs, () => {
		const r = g.update([{ type: 'clip.move', clipIds: fifty, deltaFrames: 1000 + ++d }]);
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
	});
});
g.cancel();
console.log(`gesture update (50 clips): best ${ges.best.toFixed(2)} ms, median ${ges.median.toFixed(2)} ms`);
// Gesture commit (the 50-clip move as one undoable transaction, invariants included) and its undo, best of N.
const commits: number[] = [];
const undos: number[] = [];
for (let i = 0; i < Math.min(runs, 20); i++) {
	const g2 = s.beginGesture('Move');
	const r = g2.update([{ type: 'clip.move', clipIds: fifty, deltaFrames: 1000 + ++d }]);
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const c0 = performance.now();
	g2.commit();
	commits.push(performance.now() - c0);
	const u0 = performance.now();
	s.undo();
	undos.push(performance.now() - u0);
}
console.log(
	`gesture commit: best ${Math.min(...commits).toFixed(2)} ms; undo best ${Math.min(...undos).toFixed(2)} ms`,
);
console.log('invariants:', JSON.stringify(invariantStats()));
