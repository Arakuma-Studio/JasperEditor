// Run: pnpm exec tsx packages/project/bench/cleanup.ts > packages/project/bench/cleanup.results.json
// Transcript cleanup performance (spec 14 TC-060, the pure parts; docs/wp-notes/transcript-cleanup.md "Performance"):
//   1. `detectCleanup` over one hour of speech (≈ 9,000 Spanish words in sentences with retakes, restarts, fillers and
//      pauses; a synthetic 360,000-frame voice analysis) — target ≤ 200 ms;
//   2. `analyzeSequenceCleanup` of a 30 fps sequence playing that hour (detector + planner + frame mapping + stats);
//   3. `cleanup.apply` of 1,500 ranges on the hour (linked V1 + A1, music on a sync-locked A2, 4 ms edge fades) as one
//      transaction with the production invariant check — target ≤ 2 s, one undo step (one revision).
// Fixture construction is not timed. Each case: one warm-up, then 7 timed runs; medians.
import { cpus, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { VOICE_CLASS_SPEECH } from '@jasper/audio-dsp';
import { type CleanupVoice, detectCleanup } from '../src/cleanup/detector.ts';
import { FAST_SETTINGS } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup } from '../src/cleanup/sequence.ts';
import { applyTransaction, createCounterIdSource, defaultRegistries } from '../src/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness, videoAsset } from '../test/helpers.ts';

const VOCAB =
	'hoy vamos a crear un juego de carreras en tres días primero diseñé la carretera con curvas muy cerradas después programé los coches físicas sencillas al final añadí música efectos sonido jugador puede saltar sobre obstáculos rojos nivel enemigo cámara textura luz'.split(
		' ',
	);

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One hour: sentences, a fifth said twice (the first time cut short), fillers, pauses. */
function hour(seconds = 3600) {
	const r = rng(7);
	const words: Array<{ text: string; start: number; end: number; confidence: number }> = [];
	const spans: Array<[number, number]> = [];
	let t = 1;
	const say = (ws: string[]) => {
		for (const w of ws) {
			const d = 0.12 + r() * 0.3;
			spans.push([t, t + d]);
			words.push({
				text: w,
				start: Math.round((t + 0.02) * FLICKS_PER_SECOND),
				end: Math.round((t + d + 0.03) * FLICKS_PER_SECOND),
				confidence: 0.6 + r() * 0.4,
			});
			t += d + 0.03 + r() * 0.04;
		}
	};
	while (t < seconds - 10) {
		const n = 6 + Math.floor(r() * 7);
		const s = Array.from({ length: n }, () => VOCAB[Math.floor(r() * VOCAB.length)]!);
		if (r() < 0.2) {
			say(s.slice(0, Math.max(2, Math.floor(n * 0.7))));
			t += 0.7 + r();
		}
		if (r() < 0.15) s.splice(1 + Math.floor(r() * (n - 2)), 0, 'eh');
		say(s);
		t += 0.3 + r() * 2.7;
	}
	const frameCount = seconds * 100;
	const classes = new Uint8Array(frameCount);
	const level = new Uint8Array(frameCount).fill((120 - 65) * 2);
	for (const [a, b] of spans)
		for (let f = Math.floor(a * 100); f < Math.min(frameCount, Math.ceil(b * 100)); f++) {
			classes[f] = VOICE_CLASS_SPEECH;
			level[f] = (120 - 25) * 2;
		}
	const voice: CleanupVoice = {
		classes,
		level,
		frameCount,
		levels: { floorDb: -65, speechDb: -25, speechThresholdDb: -53, breathFloorDb: -60 },
	};
	return { words, voice, seconds };
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
}

function time(fn: () => unknown, runs = 7): { medianMs: number; samplesMs: number[] } {
	fn();
	const samples: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		fn();
		samples.push(performance.now() - t0);
	}
	return { medianMs: median(samples), samplesMs: samples.map((x) => Math.round(x * 10) / 10) };
}

const loadAtStart = loadavg();
const h1 = hour();
const results: unknown[] = [];

results.push({
	case: 'detectCleanup, 1 h of speech (Fast)',
	words: h1.words.length,
	frames: h1.voice.frameCount,
	findings: detectCleanup({
		mediaId: 'med_bench',
		words: h1.words,
		voice: h1.voice,
		language: 'es',
		settings: FAST_SETTINGS,
	}).findings.length,
	targetMs: 200,
	...time(() =>
		detectCleanup({
			mediaId: 'med_bench',
			words: h1.words,
			voice: h1.voice,
			language: 'es',
			settings: FAST_SETTINGS,
		}),
	),
});

// a 30 fps sequence playing the hour: linked V1 + A1, music on a sync-locked A2
const H = new Harness({ preset: 'hd-1080p-30' });
const media = H.registerVideo({ seconds: h1.seconds });
const music = (
	H.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio', seconds: h1.seconds }) }])
		.results[0] as {
		mediaId: string;
	}
).mediaId;
H.ok([
	{ type: 'clip.place', source: { mediaId: media }, at: 0, tracks: { video: 'V1', audio: ['A1'] } },
	{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: ['A2'] } },
]);
H.ok([{ type: 'transcript.create', mediaId: media, language: 'es', origin: 'manual', words: h1.words }]);
const plan = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => h1.voice });
if (!plan.ok) throw new Error(plan.message);
results.push({
	case: 'analyzeSequenceCleanup, 1 h sequence (detect + plan + frames + stats)',
	ranges: plan.plan.ranges.length,
	outputSeconds: plan.plan.stats.outputDuration,
	cutsPerMinute: plan.plan.stats.cutsPerMinute,
	...time(() => analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => h1.voice })),
});

const a1 = H.clips('A1')[0]!.id;
const step = Math.floor((h1.seconds * 30) / 1500);
const ranges = Array.from({ length: 1500 }, (_, i) => ({
	start: i * step + 10,
	end: i * step + 10 + Math.floor(step / 3),
}));
const base = H.doc;
let revisionDelta = 0;
let clipsAfter = 0;
const apply = () => {
	const { document, result } = applyTransaction(
		base,
		{
			label: 'Clean Up Voice: 1500 cuts',
			origin: 'user',
			sequenceId: H.seqId,
			commands: [{ type: 'cleanup.apply', clipIds: [a1], ranges, fadeMs: 4 }],
		},
		{
			ids: createCounterIdSource(1000),
			now: () => '2026-10-26T00:00:00.000Z',
			revision: H.revision,
			registries: defaultRegistries(),
		},
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	revisionDelta = result.revision - H.revision;
	clipsAfter = Object.keys(document.sequences[H.seqId]!.clips).length;
};
const applied = time(apply);
results.push({
	case: 'cleanup.apply, 1 500 ranges on 1 h (V1 + A1 linked, sync-locked music on A2, 4 ms fades), one transaction',
	ranges: ranges.length,
	clipsAfter,
	revisions: revisionDelta,
	targetMs: 2000,
	...applied,
});

const c = cpus();
console.log(
	JSON.stringify(
		{
			machine: { cpu: c[0]?.model, cores: c.length, memoryBytes: totalmem(), node: process.version },
			invariants: process.env.JASPER_INVARIANTS ?? 'incremental (production default)',
			loadAtStart,
			loadAtEnd: loadavg(),
			results,
		},
		null,
		2,
	),
);
