// Run: pnpm exec tsx apps/web/bench/cleanup-review.ts > apps/web/bench/cleanup-review.results.json
// Clean Up review on one hour of speech (spec 14 TC-060, UI side; docs/wp-notes/transcript-cleanup.md "Clean Up UI and
// MCP" → Responsiveness): what a decision costs.
//   1. the re-plan (`runPlan` = `analyzeSequenceCleanup` with the decisions) — runs in the planner worker, off the main
//      thread;
//   2. the main thread's share after each plan: the transcript marks (`wordMarks`), the findings list grouping and
//      geometry (`groupFindings` + `listLayout`), the inline chips (`inlineFindings`) and the timeline bands
//      (`overlayBands`); the list and the transcript are virtualised, so rendering is bounded by what is in view.
// The fixture is the hour of packages/project/bench/cleanup.ts (same generator, seed and sequence). Fixture construction
// is not timed. Each case: one warm-up, then 7 timed runs; medians.
import { cpus, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { VOICE_CLASS_SPEECH } from '@jasper/audio-dsp';
import {
	type CleanupAnalysis,
	type CleanupVoice,
	FAST_SETTINGS,
	FLICKS_PER_SECOND,
	sequenceWords,
} from '@jasper/project';
import { Harness, videoAsset } from '../../../packages/project/test/helpers.ts';
import {
	decideItem,
	EMPTY_DECISIONS,
	groupFindings,
	inlineFindings,
	listLayout,
	overlayBands,
	toCleanupDecisions,
	wordMarks,
} from '../src/panels/text/cleanup/model.ts';
import { runPlan } from '../src/panels/text/cleanup/planner.ts';

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

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
function time(fn: () => unknown, runs = 7) {
	fn();
	const samples: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		fn();
		samples.push(performance.now() - t0);
	}
	return { medianMs: Math.round(median(samples) * 10) / 10, samplesMs: samples.map((x) => Math.round(x * 10) / 10) };
}

const loadAtStart = loadavg();
const h1 = hour();
const H = new Harness({ preset: 'hd-1080p-30' });
const media = H.registerVideo({ seconds: h1.seconds });
const music = (
	H.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio', seconds: h1.seconds }) }]).results[0] as {
		mediaId: string;
	}
).mediaId;
H.ok([
	{ type: 'clip.place', source: { mediaId: media }, at: 0, tracks: { video: 'V1', audio: ['A1'] } },
	{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: ['A2'] } },
]);
H.ok([{ type: 'transcript.create', mediaId: media, language: 'es', origin: 'manual', words: h1.words }]);
const seq = H.seq;
const speech = Object.values(seq.clips).find((c) => c.kind === 'audio' && c.mediaId === media)!;
const stream = speech.kind === 'audio' ? speech.channels.streamIndex : 0;
const planBase = {
	doc: { transcripts: H.doc.transcripts, media: H.doc.media },
	seq,
	voices: [[`${media}\u0000${stream}`, h1.voice]] as Array<[string, CleanupVoice]>,
};
const voice = () => h1.voice;
const plain = { settings: FAST_SETTINGS, cleanup: undefined, script: null, decisions: {}, scope: {} };
const first = runPlan(planBase, plain) as CleanupAnalysis;
if (!first.ok) throw new Error('refused');
const target = first.findings.find((f) => f.suggested === 'remove')!;
const d = decideItem(EMPTY_DECISIONS, target.id, 'reject');
const req = { ...plain, decisions: toCleanupDecisions(d) };
const analysis = runPlan(planBase, req) as CleanupAnalysis;
const words = sequenceWords(H.doc, seq);
const results = [
	{
		case: 'worker: re-plan after one decision (analyzeSequenceCleanup), 1 h',
		words: words.length,
		findings: analysis.findings.length,
		ranges: analysis.plan.ranges.length,
		...time(() => runPlan(planBase, req)),
	},
	{
		case: 'main thread: transcript marks (wordMarks), 1 h',
		...time(() => wordMarks(words, seq, analysis, d, new Set())),
	},
	{
		case: 'main thread: findings list (groupFindings + listLayout), 1 h',
		...time(() => listLayout(groupFindings(analysis, d, new Set()), new Set(), { header: 24, row: 33 })),
	},
	{
		case: 'main thread: inline chips (inlineFindings), 1 h',
		...time(() => inlineFindings(words, seq, analysis)),
	},
	{
		case: 'main thread: timeline bands (overlayBands), 1 h',
		...time(() => overlayBands(seq, analysis, voice)),
	},
];
const c = cpus();
console.log(
	JSON.stringify(
		{
			machine: { cpu: c[0]?.model, cores: c.length, memoryBytes: totalmem(), node: process.version },
			loadAtStart,
			loadAtEnd: loadavg(),
			results,
		},
		null,
		2,
	),
);
