// Run: pnpm exec tsx packages/project/bench/cut-map.ts > packages/project/bench/cut-map.results.json
// Cut map (spec 13 SH-001, docs/wp-notes/auto-subtitles.md "Cut map"): `pictureCuts` on
//   1. one long 59.94 fps sequence of 5,000 clips — A-roll jump cuts on V1 (2,600, every 13th with an animated
//      punch-in), full-frame B-roll on V2 (700, cross dissolves on 300 edits), picture-in-picture on V3 (300),
//      titles on V4 (1,000) and shapes on V5 (400) — about 55 minutes;
//   2. the shared scale project (bench/scale-project.ts: 200 sequences, ~5,000 clips), every sequence once.
// Fixture construction is not timed. Each case: warm-up, then 7 samples of ≥ 200 ms of repeated calls; medians.
import { createHash } from 'node:crypto';
import { cpus, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { type Clip, type ProjectDocument, pictureCuts } from '../src/index.ts';
import { Harness } from '../test/helpers.ts';
import { buildScaleProject, countClips } from './scale-project.ts';

function longSequence(): { doc: ProjectDocument; seqId: string; clips: number } {
	const h = new Harness({ preset: 'hd-1080p-59.94' });
	const media = Array.from({ length: 12 }, () => h.registerVideo({ seconds: 3600, audio: false }));
	h.ok([{ type: 'track.add', kind: 'video', count: 2 }]);
	const F = (705_600_000 * 1001) / 60000;
	const placed = h.ok([
		{ type: 'clip.place', source: { mediaId: media[0] }, at: 0, tracks: { video: 'V1' }, ref: '$v' },
		{ type: 'clip.place', source: { mediaId: media[1] }, at: 600, tracks: { video: 'V1' } },
		{ type: 'transition.add', clipId: '$v', edge: 'out', effectId: 'jasper.cross-dissolve', duration: 20 },
		{ type: 'clip.addText', at: 0, duration: 60, track: 'V4', content: { text: 'Title' } },
		{
			type: 'clip.addShape',
			at: 0,
			duration: 60,
			track: 'V5',
			shape: { type: 'rect', size: [300, 200], fill: [1, 0.8, 0.2, 1] },
		},
	]);
	const vid = placed.refs.$v!;
	h.ok([
		{
			type: 'param.setAnimated',
			target: ['clip', vid, 'transform', 'scale'],
			animated: true,
			at: { frames: 0 },
		},
		{ type: 'param.set', target: ['clip', vid, 'transform', 'scale'], value: 100, at: { frames: 0 } },
		{ type: 'param.set', target: ['clip', vid, 'transform', 'scale'], value: 120, at: { frames: 20 } },
	]);
	const doc = structuredClone(h.doc);
	const seq = doc.sequences[h.seqId]!;
	const all = Object.values(seq.clips);
	const video = all.find((c) => c.kind === 'video' && c.id !== vid)!;
	const zoom = seq.clips[vid]!;
	const text = all.find((c) => c.kind === 'text')!;
	const shape = all.find((c) => c.kind === 'shape')!;
	const transition = Object.values(seq.transitions)[0]!;
	const tracks = seq.videoTracks.map((t) => t.id);
	const clips: Record<string, Clip> = {};
	const transitions: typeof seq.transitions = {};
	let n = 0;
	const add = (
		tpl: Clip,
		track: number,
		start: number,
		duration: number,
		patch: Record<string, unknown> = {},
	) => {
		const c = {
			...structuredClone(tpl),
			...patch,
			id: `c${n++}`,
			trackId: tracks[track]!,
			start,
			duration,
		} as Clip;
		c.linkId = null;
		clips[c.id] = c;
		return c;
	};
	// V1: 2,600 A-roll pieces of 75 frames from a few takes (same take = jump cut), every 13th punched in.
	let t = 0;
	for (let i = 0; i < 2600; i++) {
		add(i % 13 === 0 ? zoom : video, 0, t, 75, {
			mediaId: media[Math.floor(i / 4) % 3],
			sourceIn: ((i * 97) % 3000) * F,
		});
		t += 75;
	}
	const total = t;
	// V2: 700 full-frame B-roll clips of 60 frames in pairs (cross dissolves on 300 inner edits).
	for (let i = 0; i < 350; i++) {
		const at = Math.floor((i * total) / 350);
		const a = add(video, 1, at, 60, { mediaId: media[3 + (i % 5)], sourceIn: 500 * F });
		const b = add(video, 1, at + 60, 60, { mediaId: media[3 + ((i + 1) % 5)], sourceIn: 500 * F });
		if (i < 300) {
			const id = `t${i}`;
			transitions[id] = {
				...structuredClone(transition),
				id,
				trackId: tracks[1]!,
				outgoingClipId: a.id,
				incomingClipId: b.id,
			};
		}
	}
	// V3: 300 picture-in-picture clips at 75 % (56 % of the frame).
	for (let i = 0; i < 300; i++) {
		const c = add(video, 2, Math.floor((i * total) / 300) + 200, 90, { mediaId: media[8 + (i % 4)] });
		(c as { transform: { scale: { value: number } } }).transform.scale.value = 75;
	}
	// V4 titles, V5 shapes (ignored by the cut map, but present like in a real edit).
	for (let i = 0; i < 1000; i++) add(text, 3, Math.floor((i * total) / 1000), 60);
	for (let i = 0; i < 400; i++) add(shape, 4, Math.floor((i * total) / 400) + 30, 40);
	seq.clips = clips;
	seq.transitions = transitions;
	seq.links = {};
	return { doc, seqId: h.seqId, clips: Object.keys(clips).length };
}

function measure(run: () => number): { medianMs: number; samplesMs: number[]; checksum: number } {
	let checksum = run();
	run();
	const samples: number[] = [];
	for (let s = 0; s < 7; s++) {
		const start = performance.now();
		let it = 0;
		do {
			checksum += run();
			it++;
		} while (performance.now() - start < 200);
		samples.push((performance.now() - start) / it);
	}
	return { medianMs: [...samples].sort((a, b) => a - b)[3]!, samplesMs: samples, checksum };
}

const loadAtStart = loadavg();
const results: Record<string, unknown>[] = [];

const long = longSequence();
const longCuts = pictureCuts(long.doc, long.seqId);
const kinds: Record<string, number> = {};
for (const c of longCuts) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
results.push({
	case: 'one sequence, 5,000 clips, 59.94 fps',
	clips: long.clips,
	frames: Math.max(...Object.values(long.doc.sequences[long.seqId]!.clips).map((c) => c.start + c.duration)),
	cuts: longCuts.length,
	kinds,
	sha256: createHash('sha256').update(JSON.stringify(longCuts)).digest('hex'),
	...measure(() => pictureCuts(long.doc, long.seqId).length),
});

const scale = buildScaleProject();
const seqIds = Object.keys(scale.sequences);
results.push({
	case: 'scale project, every sequence',
	sequences: seqIds.length,
	clips: countClips(scale),
	cuts: seqIds.reduce((s, id) => s + pictureCuts(scale, id).length, 0),
	...measure(() => seqIds.reduce((s, id) => s + pictureCuts(scale, id).length, 0)),
});

console.log(
	JSON.stringify(
		{
			machine: {
				cpu: cpus()[0]?.model,
				cores: cpus().length,
				memoryBytes: totalmem(),
				node: process.version,
			},
			loadAtStart,
			loadAtEnd: loadavg(),
			results,
		},
		null,
		2,
	),
);
