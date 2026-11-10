// Hidden retakes (docs/wp-notes/transcript-cleanup.md "Hidden retakes"): a take the recogniser first wrote once and then
// found by decoding the range again (`guard.redecoded` of the transcription → `Transcript.redecoded`) is a hidden
// retake: the cut runs from the first take's first word to the kept take's first word. A repeat the script itself
// makes ("boing boing boing") is never cut. The stored ranges belong to the recognition that decoded them: once a build
// that predates them transcribes the media again (a new `createdAt`), they no longer count.
import { describe, expect, it } from 'vitest';
import {
	type CleanupVoice,
	type CleanupWordIn,
	detectCleanup,
	effectiveLists,
} from '../src/cleanup/detector.ts';
import { cleanupNorm } from '../src/cleanup/lists.ts';
import { planMediaCuts } from '../src/cleanup/plan.ts';
import { FAST_SETTINGS } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup, type CleanupAnalysis } from '../src/cleanup/sequence.ts';
import { createCounterIdSource } from '../src/ids.ts';
import { repairDocument, runInvariants } from '../src/invariants.ts';
import type { ProjectDocument } from '../src/schema/document.ts';
import { transcriptAttachPlan } from '../src/speech/index.ts';
import { FLICKS_PER_SECOND, flicksPerFrame } from '../src/time.ts';
import { synthRecording } from './cleanup-synth.ts';
import { Harness, videoAsset } from './helpers.ts';

const rec = synthRecording(
	[
		{ say: 'Hoy les cuento cómo publicar el juego.', keep: true },
		{ pauseS: 0.8 },
		{ say: 'para poder subirlos', keep: false },
		{ say: 'para poder subirlos a la Playstore.', keep: true },
		{ pauseS: 0.8 },
		{ say: 'El sonido hace boing boing boing al saltar.', keep: true },
		{ pauseS: 0.8 },
	],
	3,
);
const SCRIPT = [
	'Hoy les cuento cómo publicar el juego.',
	'Para poder subirlos a la Playstore necesitamos una cuenta.',
	'El sonido hace boing boing boing al saltar.',
].join('\n');

function analyse(older?: (doc: ProjectDocument) => void): {
	a: CleanupAnalysis;
	F: number;
	doc: ProjectDocument;
} {
	const H = new Harness({ preset: 'hd-1080p-30' });
	const r0 = H.ok([{ type: 'media.register', asset: videoAsset({ seconds: rec.durationS, kind: 'audio' }) }]);
	const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
	H.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' }]);
	// the transcription decoded the whole recording again and replaced its words (both takes written)
	const plan = transcriptAttachPlan(
		H.doc,
		{
			target: { type: 'media' },
			model: 'whisper-large-v3-turbo',
			language: 'es',
			task: 'transcribe',
			words: rec.words.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence })),
			speakers: {},
			guard: { redecoded: { ranges: [{ start: 0, end: rec.durationS, replaced: true }] } },
		},
		{ mediaId, replace: true },
	);
	if ('error' in plan) throw new Error(plan.error);
	H.ok(plan.commands);
	H.ok([{ type: 'cleanup.configure', script: { name: 'Guion', text: SCRIPT } }]);
	const doc = structuredClone(H.doc);
	older?.(doc);
	const a = analyzeSequenceCleanup({ doc, seq: doc.sequences[H.seq.id]!, voice: () => rec.voice });
	if (!a.ok) throw new Error(a.message);
	return { a, F: flicksPerFrame(H.seq.settings.frameRate), doc };
}

describe('hidden retakes', () => {
	it('cuts the first take of a re-decoded restart up to the kept take, and keeps a repeat the script makes', () => {
		const { a, F } = analyse();
		const firstTake = rec.words.findIndex((w) => w.text === 'para');
		const keptTake = rec.words.findIndex((w, i) => i > firstTake && w.text === 'para');
		const hidden = a.findings.filter((f) => f.kind === 'hidden-retake');
		expect(hidden).toHaveLength(1);
		expect(hidden[0]).toMatchObject({
			words: [firstTake, keptTake - 1],
			suggested: 'remove',
			reason: { params: { text: 'para poder subirlos', kept: 'para poder subirlos' } },
		});
		// the cut lands at the kept take's first word (word edges, within a frame)
		const cut = a.plan.ranges.find((r) => r.reasons.includes('hidden-retake'))!;
		expect(Math.abs(cut.end * F - rec.words[keptTake]!.start)).toBeLessThanOrEqual(2 * F);
		expect(cut.start * F).toBeLessThanOrEqual(rec.words[firstTake]!.end);
		// "boing boing boing" is in the script: nothing of it is cut
		const boing = rec.words.flatMap((w, i) => (w.text === 'boing' ? [i] : []));
		for (const f of a.findings)
			if (f.words && f.suggested === 'remove')
				expect(boing.some((i) => i >= f.words![0] && i <= f.words![1])).toBe(false);
	});

	it('ranges of an earlier recognition are ignored and repaired away (an older build transcribed again)', () => {
		const { a, doc } = analyse((d) => {
			// what an older build's transcript.attach leaves: new words' time stamp, the unknown field kept
			for (const t of Object.values(d.transcripts)) t.createdAt = '2026-12-01T00:00:00.000Z';
		});
		expect(a.findings.some((f) => f.kind === 'hidden-retake')).toBe(false);
		expect(
			a.findings.some((f) => f.kind === 'restart' && f.reason.params.text === 'para poder subirlos'),
		).toBe(true);
		expect(runInvariants(doc).issues.some((i) => i.path?.includes('redecoded'))).toBe(true);
		const r = repairDocument(doc, createCounterIdSource(900));
		expect(r.report.map((x) => x.action)).toContain('normalize-redecoded');
		expect(Object.values(r.document.transcripts).some((t) => 'redecoded' in t)).toBe(false);
	});
});

// Words of a real recording (large-v3-turbo on the reporter's 57-minute Spanish file, `chunking: "vad"` or the
// re-decode pass; seconds within ~80 s fragments): "text[start-end]" each.
const real = (s: string): CleanupWordIn[] =>
	s
		.trim()
		.split(/\s+/)
		.map((x) => {
			const m = /^(.*)\[([\d.]+)-([\d.]+)\]$/.exec(x)!;
			const at = (t: string) => Math.round(Number(t) * FLICKS_PER_SECOND);
			return { text: m[1]!, start: at(m[2]!), end: at(m[3]!), confidence: 0.9 };
		});
const detectReal = (words: CleanupWordIn[]) =>
	detectCleanup({
		mediaId: 'med_real',
		words,
		language: 'es',
		settings: FAST_SETTINGS,
		redecoded: [[0, 90 * FLICKS_PER_SECOND]],
	});
const removedBy = (r: ReturnType<typeof detectCleanup>) => {
	const out = new Set<number>();
	for (const f of r.findings)
		if (f.words && f.suggested === 'remove') for (let i = f.words[0]; i <= f.words[1]; i++) out.add(i);
	return out;
};

describe('hidden retakes of a real recording', () => {
	it('keeps the take that says the most: a cut never removes content words no kept word says (fragment E)', () => {
		// three takes; the first re-says itself inside ("¿Qué puedo hacer…" ×3), the last one is the whole question
		const words =
			real(`¿Qué[31.87-31.95] puedo[31.95-32.09] hacer[32.09-32.25] en[32.25-32.39] un[32.39-32.47]
			mes[32.47-32.63] lo[32.63-32.75] mismo[32.75-32.93] de[32.93-33.05] una[33.05-33.13] empresa?[33.13-33.50]
			¿Qué[33.72-33.79] puedo[33.79-33.97] hacer[33.97-34.15] en[34.15-34.27] un[34.27-34.39] mes[34.39-34.57]
			lo[34.57-34.71] mismo?[34.71-34.91] ¿Qué[35.18-35.25] puedo[35.25-35.41] hacer[35.41-35.53] en[35.53-35.69]
			un[35.69-35.77] mes[35.77-35.95] lo[35.95-36.09] mismo[36.09-36.29] que[36.29-36.39] una[36.39-36.49]
			empresa[36.49-36.77] de[36.77-37.01] hacer[37.01-37.19] Que[38.14-38.20] puedo[38.20-38.36] hacer[38.36-38.50]
			en[38.50-38.62] un[38.62-38.74] mes[38.74-38.90] lo[38.90-39.00] mismo[39.00-39.34] puedo[39.84-39.98]
			hacer[39.98-40.12] en[40.12-40.26] un[40.26-40.36] mes[40.36-40.54] lo[40.54-40.64] mismo[40.64-40.80]
			que[40.80-40.92] una[40.92-41.04] empresa[41.04-41.32] de[41.32-41.54] decenas[41.54-41.78] de[41.78-41.88]
			miles[41.88-42.15] ¿Que[42.91-42.99] puedo[42.99-43.13] hacer[43.13-43.29] en[43.29-43.43] un[43.43-43.53]
			mes[43.53-43.71] lo[43.71-43.83] mismo[43.83-44.01] que[44.01-44.15] una[44.15-44.27] empresa[44.27-44.55]
			de[44.55-44.67] decenas[44.67-44.93] de[44.93-45.03] miles[45.03-45.31] de[45.31-45.41] millones[45.41-45.77]
			de[45.77-45.87] dólares?[45.87-46.08] Y[48.33-48.45] eso[48.45-48.70] es[48.70-48.85] posible.[48.85-49.30]`);
		const r = detectReal(words);
		expect(r.groups[0]!.chosen).toBe(r.groups[0]!.takes.length - 1);
		const removed = removedBy(r);
		const stop = new Set(effectiveLists('es').stopWords);
		const tok = (i: number) => cleanupNorm(words[i]!.text);
		const kept = new Set(words.flatMap((_, i) => (removed.has(i) ? [] : [tok(i)])));
		const lost = [...removed].map(tok).filter((t) => t.length >= 3 && !stop.has(t) && !kept.has(t));
		expect(lost).toEqual([]);
	});

	it('a cut-off attempt between two takes goes too (fragment D: "Y funcionan con cual…")', () => {
		const words = real(`Y[41.86-41.92] funcionan[41.92-42.40] con[42.40-42.60] casi[42.60-42.90]
			cualquier[42.90-43.40] personaje[43.40-43.90] humanoide.[43.90-44.34] Y[44.50-44.60] funcionan[44.60-44.95]
			con[44.95-45.10] cual[45.10-45.40] Y[45.67-45.75] funcionan[45.75-46.20] con[46.20-46.40] casi[46.40-46.70]
			cualquier[46.70-47.20] personaje[47.20-47.70] humanoide[47.70-48.20] de[48.20-48.30] tu[48.30-48.45]
			juego.[48.45-48.90]`);
		const removed = removedBy(detectReal(words));
		expect([...removed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("a finding names its own group's kept take and ends before it (fragments A and D)", () => {
		// "poder subirlos" closes the kept take of a group; it is said again right after, outside the group
		const a =
			real(`Al[0.48-0.60] final[0.60-0.90] del[0.90-1.02] mes[1.02-1.30] debo[1.30-1.60] portear[1.60-2.00]
			todos[2.00-2.25] los[2.25-2.35] juegos[2.35-2.70] de[2.70-2.80] la[2.80-2.90] Jasper[2.90-3.30] de[3.30-3.40]
			Barcade[3.40-3.90] y[3.90-4.10] deben[4.10-4.40] funcionar[4.40-4.90] perfectamente[4.90-5.60] en[5.60-5.70]
			mi[5.70-5.80] motor[5.80-6.10] Al[8.65-8.80] final[8.80-9.10] del[9.10-9.22] mes[9.22-9.50] debo[9.50-9.80]
			portear[9.80-10.20] todos[10.20-10.45] los[10.45-10.55] juegos[10.55-10.90] de[10.90-11.00] la[11.00-11.10]
			Jasper[11.10-11.30] de[11.30-11.40] Barcade[11.40-11.74] y[11.92-11.98] deben[11.98-12.14]
			funcionar[12.14-12.60] perfectamente[12.60-13.40] en[13.40-13.52] mi[13.52-13.56] motor[13.56-13.86]
			y[14.04-14.08] correr[14.08-14.34] en[14.34-14.52] todas[14.52-14.70] las[14.70-14.86]
			plataformas[14.86-15.50] para[15.50-15.70] poder[15.70-15.96] subirlos[15.96-16.54] poder[17.38-17.60]
			subirlos[17.60-18.16] a[18.16-18.28] la[18.28-18.40] Play[18.40-18.58] Store.[18.58-18.80]`);
		const poder = a.findIndex((w) => w.text === 'poder');
		const fa = detectReal(a).findings.find((f) => f.words?.[0] === poder)!;
		expect(fa.reason.params.kept).toBe('poder subirlos');
		// the kept take starts with "En", which the first take did not say: the cut ends before it
		const d = real(`el[0.62-0.75] Jasper[0.75-1.05] Engine[1.05-1.30] agarras[1.30-1.70] las[1.70-1.80]
			manos[1.80-2.05] y[2.05-2.15] los[2.15-2.25] pies[2.25-2.40] del[2.40-2.55] personaje[2.55-2.95]
			directamente[2.95-3.36] en[3.36-3.68] la[3.68-3.76] escena,[3.76-4.24] les[4.24-4.36] pones[4.36-4.62]
			en[4.62-4.78] un[4.78-4.84] par[4.84-4.96] En[9.01-9.10] el[9.10-9.24] Jasper[9.24-9.52] Engine[9.52-9.74]
			agarras[9.74-10.12] las[10.12-10.26] manos[10.26-10.46] y[10.46-10.60] los[10.60-10.72] pies[10.72-10.84]
			del[10.84-10.98] personaje[10.98-11.36] directamente[11.36-11.72] en[11.72-12.04] la[12.04-12.10]
			escena,[12.10-12.52] los[12.52-12.64] pones[12.64-12.90] en[12.90-13.04] un[13.04-13.12] par[13.12-13.28]
			de[13.28-13.40] poses[13.40-13.72]`);
		expect(removedBy(detectReal(d)).has(d.findIndex((w) => w.text === 'En'))).toBe(false);
	});

	it('the cut ends at the kept take\'s first word, not inside its soft onset (fragment A: "déjenme")', () => {
		// level-mode in point: floor −64 dBFS + 25 dB; "déjenme" starts at −48 dBFS and reaches −39 dBFS 70 ms in
		const n = 7400;
		const classes = new Uint8Array(n);
		const level = new Uint8Array(n).fill((120 - 64) * 2);
		const speech = (a: number, b: number, db: (f: number) => number) => {
			for (let f = a; f < b; f++) {
				classes[f] = 2;
				level[f] = Math.round((120 + db(f)) * 2);
			}
		};
		speech(7121, 7163, () => -25);
		speech(7196, 7281, (f) => (f < 7203 ? -48 + (f - 7196) * 1.2 : -25.8));
		const voice: CleanupVoice = {
			classes,
			level,
			frameCount: n,
			levels: { floorDb: -64, speechDb: null, speechThresholdDb: null, breathFloorDb: null },
		};
		const w = (text: string, s: number, e: number, i: number) => ({
			i,
			n: cleanupNorm(text),
			s,
			e,
			text,
			conf: null,
		});
		const words = [
			w('toda', 71.21, 71.49, 0),
			w('la', 71.49, 71.63, 1),
			w('déjenme', 71.96, 72.35, 2),
			w('decirles', 72.35, 72.81, 3),
		];
		const plan = planMediaCuts({
			words,
			removed: [true, true, false, false],
			voice,
			settings: FAST_SETTINGS,
		});
		expect(plan.kept[0]![0]).toBeLessThanOrEqual(71.96 + 1e-9);
	});
});
