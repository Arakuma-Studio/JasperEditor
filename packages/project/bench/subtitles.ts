// Run: pnpm exec tsx packages/project/bench/subtitles.ts > packages/project/bench/subtitles.results.json
// Automatic subtitles (spec 13 AS-001 / AS-010, docs/wp-notes/auto-subtitles.md §10): the whole `captions.generate`
// transaction (layout, cut map, placement of every text clip with the Pixel Pop template, linked style, invariants) on
//   1. a 10-minute 59.94 fps long-form sequence: A-roll with ≈ 1,500 words (≈ 1,200 Pixel Pop subtitles), 300 B-roll
//      cutaways, and
//   2. a 60-second 9:16 short: ≈ 160 words, 40 cuts.
// Also `captions.alignToCuts` on the generated group after the B-roll moved by 7 frames. Fixture construction is not
// timed. Each case: one warm-up, then 7 samples (each a full transaction on the same base document); medians.
import { cpus, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { applyTransaction, createRandomIdSource, FLICKS_PER_SECOND, type ProjectDocument } from '../src/index.ts';
import { Harness, makeCtx } from '../test/helpers.ts';

function fixture(o: { preset: string; seconds: number; words: number; cuts: number }) {
	const h = new Harness({ preset: o.preset });
	const frame = { width: h.seq.settings.width, height: h.seq.settings.height };
	const a = h.registerVideo({ seconds: o.seconds + 10, ...frame });
	const b = h.registerVideo({ seconds: o.seconds + 10, audio: false, ...frame });
	h.ok([{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { video: 'V1', audio: ['A1'] }, mode: 'overwrite' }]);
	const rate = h.seq.settings.frameRate;
	const fps = rate.num / rate.den;
	const every = o.seconds / o.cuts;
	h.ok(
		Array.from({ length: o.cuts }, (_, i) => ({
			type: 'clip.place',
			source: { mediaId: b },
			sourceRange: { in: { seconds: i }, out: { seconds: i + 1.2 } },
			at: Math.round((i * every + every / 2) * fps),
			tracks: { video: 'V2' },
			audio: false,
			mode: 'overwrite',
		})),
	);
	const step = o.seconds / o.words;
	h.ok([
		{
			type: 'transcript.create',
			mediaId: a,
			language: 'es',
			origin: 'manual',
			words: Array.from({ length: o.words }, (_, i) => ({
				text: i % 9 === 8 ? `palabra${i}.` : i % 5 === 0 ? 'de' : `w${i}`,
				start: Math.round(i * step * FLICKS_PER_SECOND),
				end: Math.round((i * step + step * 0.85) * FLICKS_PER_SECOND),
			})),
		},
	]);
	return { doc: structuredClone(h.doc) as ProjectDocument, seqId: h.seqId };
}

function time(fn: () => unknown): { median: number; min: number; max: number } {
	fn();
	const s: number[] = [];
	for (let i = 0; i < 7; i++) {
		const t = performance.now();
		fn();
		s.push(performance.now() - t);
	}
	s.sort((x, y) => x - y);
	return { median: +s[3]!.toFixed(1), min: +s[0]!.toFixed(1), max: +s[6]!.toFixed(1) };
}

function run(doc: ProjectDocument, seqId: string, commands: unknown[]) {
	const r = applyTransaction(doc, { label: 'bench', origin: 'user', sequenceId: seqId, commands }, makeCtx({}, createRandomIdSource()));
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	return r;
}

const cases = [
	{ name: 'long 10 min 59.94 (1080p)', preset: 'hd-1080p-59.94', seconds: 600, words: 1500, cuts: 300 },
	{ name: 'short 60 s 9:16 (60 fps)', preset: 'vertical-1080x1920-60', seconds: 60, words: 160, cuts: 40 },
];
const results = [];
for (const c of cases) {
	const { doc, seqId } = fixture(c);
	const gen = [{ type: 'captions.generate', template: 'builtin:pixel-pop' }];
	const first = run(doc, seqId, gen);
	const out = first.result.ok ? (first.result.results[0] as { count: number; stats: unknown }) : null;
	const brolls = Object.values(first.document.sequences[seqId]!.clips).filter((x) => x.kind === 'video').length;
	if (brolls < 2) throw new Error(`fixture has ${brolls} video clips`);
	const generate = time(() => run(doc, seqId, gen));
	// move every B-roll clip 7 frames later, then align
	const moved = run(first.document, seqId, [
		{
			type: 'clip.move',
			clipIds: Object.values(first.document.sequences[seqId]!.clips)
				.filter((x) => x.kind === 'video' && x.trackId !== first.document.sequences[seqId]!.videoTracks[0]!.id)
				.map((x) => x.id),
			deltaFrames: 7,
		},
	]).document;
	const groupId = Object.keys(
		(moved.sequences[seqId] as { captionGroups?: Record<string, unknown> }).captionGroups ?? {},
	)[0]!;
	const align = time(() => run(moved, seqId, [{ type: 'captions.alignToCuts', groupId }]));
	results.push({ case: c.name, subtitles: out?.count, stats: out?.stats, generateMs: generate, alignAfterMoveMs: align });
}
console.log(
	JSON.stringify(
		{
			date: new Date().toISOString(),
			machine: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30), node: process.version },
			loadavg: loadavg(),
			results,
		},
		null,
		2,
	),
);
