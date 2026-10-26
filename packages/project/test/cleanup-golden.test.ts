// Golden test of the Fast preset (spec 14 TC-070): a synthetic recording (voiced tones with known word timings,
// `cleanup-synth.ts`) with head chatter, an abandoned take, a false start, a filler between pauses, off-script chatter,
// an in-line restart, a standalone marker phrase, breaths, long pauses and a cough without a word, analysed by the real
// voice-analysis code, then detected, planned and placed on a 30 fps sequence. Thresholds: removed-word precision and
// recall ≥ 0.9, removed-time precision ≥ 0.95 and recall ≥ 0.9, no silence longer than 0.25 s left at a join.
import { describe, expect, it } from 'vitest';
import { analyzeSequenceCleanup, type CleanupAnalysis } from '../src/cleanup/sequence.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { type SynthEvent, type SynthRecording, scoreKept, synthRecording } from './cleanup-synth.ts';
import { Harness, videoAsset } from './helpers.ts';

export const GOLDEN_SCRIPT = [
	'Hoy vamos a crear un juego de carreras en tres días.',
	'Primero diseñé la carretera con curvas muy cerradas.',
	'Después programé los coches con físicas sencillas.',
	'Al final añadí música y efectos de sonido.',
].join('\n');

export const GOLDEN_EVENTS: SynthEvent[] = [
	{ say: 'vale ya está grabando esto', keep: false },
	{ pauseS: 2.0 },
	{ say: 'Hoy vamos a crear un juego', keep: false },
	{ pauseS: 0.9 },
	{ breathS: 0.3 },
	{ say: 'Hoy vamos a crear un juego de carreras en tres días.', keep: true },
	{ pauseS: 1.5 },
	{ say: 'Primero,', keep: false },
	{ pauseS: 0.8 },
	{ say: 'primero diseñé la carretera', keep: true },
	{ pauseS: 0.35 },
	{ say: 'eh', keep: false },
	{ pauseS: 0.35 },
	{ say: 'con curvas muy cerradas.', keep: true },
	{ pauseS: 1.5 },
	{ coughS: 0.25 },
	{ pauseS: 1.5 },
	{ say: 'madre mía qué calor hace aquí hoy', keep: false },
	{ pauseS: 1.2 },
	{ breathS: 0.35 },
	{ say: 'Después programé los coches,', keep: false, gapS: 0.05 },
	{ say: 'después programé los coches con físicas sencillas.', keep: true },
	{ pauseS: 1.0 },
	{ say: 'Al final añadí música y efectos de sonido.', keep: true },
	{ pauseS: 0.8 },
	{ say: 'bueno', keep: false },
	{ pauseS: 1.5 },
];

/** A 30 fps sequence with the recording on A1, its transcript and its script attached. */
export function goldenSequence(rec: SynthRecording, opts: { script?: boolean } = {}) {
	const H = new Harness({ preset: 'hd-1080p-30' });
	const r0 = H.ok([{ type: 'media.register', asset: videoAsset({ seconds: rec.durationS, kind: 'audio' }) }]);
	const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
	H.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' }]);
	H.ok([
		{
			type: 'transcript.create',
			mediaId,
			language: 'es',
			origin: 'manual',
			words: rec.words.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence })),
		},
	]);
	if (opts.script !== false)
		H.ok([{ type: 'cleanup.configure', script: { name: 'Guion', text: GOLDEN_SCRIPT } }]);
	return { H, mediaId };
}

function keptSeconds(a: CleanupAnalysis): Array<[number, number]> {
	return a.plan.kept.map((k) => [k.start / 30, k.end / 30]);
}

describe('Fast preset on a synthetic recording (golden)', () => {
	const rec = synthRecording(GOLDEN_EVENTS, 7);

	it('the synthetic voice analysis sees the words as speech', () => {
		let speech = 0;
		let frames = 0;
		for (const w of rec.words) {
			for (let f = Math.ceil(w.s * 100) + 3; f < Math.floor(w.e * 100) - 3; f++) {
				frames++;
				if (rec.voice.classes[f] === 2) speech++;
			}
		}
		expect(speech / frames).toBeGreaterThan(0.95);
		const [a, b] = rec.breaths[0]!;
		let breath = 0;
		for (let f = Math.ceil(a * 100) + 3; f < Math.floor(b * 100) - 3; f++)
			if (rec.voice.classes[f] === 1) breath++;
		expect(breath).toBeGreaterThan(5);
	});

	it('reproduces the editor: removed words and time, no dead air, last take, script lines', () => {
		const { H, mediaId } = goldenSequence(rec);
		const a = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => rec.voice });
		if (!a.ok) throw new Error(a.message);
		const sc = scoreKept(rec, keptSeconds(a));
		expect(sc.wordPrecision).toBeGreaterThanOrEqual(0.9);
		expect(sc.wordRecall).toBeGreaterThanOrEqual(0.9);
		expect(sc.timePrecision).toBeGreaterThanOrEqual(0.95);
		expect(sc.timeRecall).toBeGreaterThanOrEqual(0.9);
		expect(a.plan.stats.largestSilenceLeft).not.toBeNull();
		expect(a.plan.stats.largestSilenceLeft!).toBeLessThanOrEqual(0.25);
		expect(a.plan.stats.joins).toBeGreaterThanOrEqual(4);
		// the abandoned take is grouped with the kept one, the last take chosen, the script line named
		const g = a.groups.find((x) => x.takes.some((t) => t.text.startsWith('Hoy')));
		expect(g).toBeDefined();
		expect(g!.chosen).toBe(g!.takes.length - 1);
		expect(g!.takes[g!.chosen]!.scriptLine).toBe(0);
		expect(a.script?.every((l) => l.said)).toBe(true);
		// the cough is flagged for review and kept (never removed automatically)
		const [ca, cb] = rec.coughs[0]!;
		const cough = a.findings.find(
			(f) =>
				f.kind === 'untranscribed' &&
				f.range.start / FLICKS_PER_SECOND < cb &&
				f.range.end / FLICKS_PER_SECOND > ca,
		);
		expect(cough?.suggested).toBe('review');
		expect(keptSeconds(a).some(([s, e]) => s < cb && e > ca)).toBe(true);
		// accepting it removes it
		const b = analyzeSequenceCleanup({
			doc: H.doc,
			seq: H.seq,
			voice: () => rec.voice,
			decisions: { accept: [cough!.id] },
		});
		if (!b.ok) throw new Error(b.message);
		expect(keptSeconds(b).some(([s, e]) => s < cb && e > ca)).toBe(false);
		// head chatter and off-script talk need the script; kinds found
		const kinds = new Set(a.findings.filter((f) => f.suggested === 'remove').map((f) => f.kind));
		for (const k of ['false-start', 'filler-vocalic', 'off-script', 'restart', 'filler-phrase', 'pause'])
			expect(kinds, k).toContain(k);
		expect(a.media).toEqual([
			expect.objectContaining({ mediaId, voice: true, edgeMode: 'level', language: 'es' }),
		]);
		// edges: every kept piece starts within 40 ms before a kept word's sound and ends within its decay
		const kw = rec.words.filter((w) => w.keep);
		for (const [s, e] of keptSeconds(a)) {
			const first = kw.find((w) => w.e > s && w.s < e);
			if (!first) continue;
			expect(first.s - s).toBeLessThan(0.06);
			expect(first.s - s).toBeGreaterThan(-0.04);
			const last = [...kw].reverse().find((w) => w.s < e && w.e > s)!;
			// out point inside the decay: after the tone's end, before its tail fades into the floor
			expect(e - last.e).toBeGreaterThan(-0.01);
			expect(e - last.e).toBeLessThan(0.2);
		}
	});

	it('without the script the content rules still cut retakes, restarts and fillers', () => {
		const { H } = goldenSequence(rec, { script: false });
		const a = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => rec.voice });
		if (!a.ok) throw new Error(a.message);
		const sc = scoreKept(rec, keptSeconds(a));
		// head chatter and the off-script line stay (no script): recall drops, precision does not
		expect(sc.wordPrecision).toBeGreaterThanOrEqual(0.9);
		expect(sc.wordRecall).toBeGreaterThanOrEqual(0.4);
		expect(a.findings.some((f) => f.kind === 'off-script' || f.kind === 'head-tail')).toBe(false);
	});

	it('Natural keeps air and lists marker phrases and off-script talk for review', () => {
		const { H } = goldenSequence(rec);
		H.ok([{ type: 'cleanup.configure', settings: { presetId: 'builtin.natural' } }]);
		const a = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => rec.voice });
		if (!a.ok) throw new Error(a.message);
		expect(a.findings.some((f) => f.kind === 'filler-phrase' && f.suggested === 'review')).toBe(true);
		expect(a.findings.some((f) => f.kind === 'off-script' && f.suggested === 'review')).toBe(true);
		expect(a.media[0]!.edgeMode).toBe('speech');
		const fast = analyzeSequenceCleanup({
			doc: goldenSequence(rec).H.doc,
			seq: goldenSequence(rec).H.seq,
			voice: () => rec.voice,
		});
		if (!fast.ok) throw new Error(fast.message);
		expect(a.plan.stats.outputDuration).toBeGreaterThan(fast.plan.stats.outputDuration);
		expect(a.plan.fadeMs).toBe(10);
		expect(fast.plan.fadeMs).toBe(4);
	});

	it('is deterministic and maps to frames inside the clip', () => {
		const { H } = goldenSequence(rec);
		const a = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => rec.voice });
		const b = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => rec.voice });
		expect(a).toEqual(b);
		if (!a.ok) throw new Error('refused');
		const end = Math.round((rec.durationS * FLICKS_PER_SECOND) / (FLICKS_PER_SECOND / 30));
		for (const r of a.plan.ranges) {
			expect(r.start).toBeGreaterThanOrEqual(0);
			expect(r.end).toBeLessThanOrEqual(end + 1);
		}
	});
});
