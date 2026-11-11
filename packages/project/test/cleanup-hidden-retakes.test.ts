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
import { FAST_SETTINGS, mergeCleanupSettings } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup, type CleanupAnalysis, keptToFrames } from '../src/cleanup/sequence.ts';
import { createCounterIdSource } from '../src/ids.ts';
import { repairDocument, runInvariants } from '../src/invariants.ts';
import type { ProjectDocument } from '../src/schema/document.ts';
import { transcriptAttachPlan } from '../src/speech/index.ts';
import { FLICKS_PER_SECOND, flicksPerFrame } from '../src/time.ts';
import { synthRecording } from './cleanup-synth.ts';
import { Harness, videoAsset } from './helpers.ts';

const REC = synthRecording(
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

function analyse(
	older?: (doc: ProjectDocument) => void,
	rec: ReturnType<typeof synthRecording> = REC,
): {
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
		const firstTake = REC.words.findIndex((w) => w.text === 'para');
		const keptTake = REC.words.findIndex((w, i) => i > firstTake && w.text === 'para');
		const hidden = a.findings.filter((f) => f.kind === 'hidden-retake');
		expect(hidden).toHaveLength(1);
		expect(hidden[0]).toMatchObject({
			words: [firstTake, keptTake - 1],
			suggested: 'remove',
			reason: { params: { text: 'para poder subirlos', kept: 'para poder subirlos' } },
		});
		// the cut lands at the kept take's first word (word edges, within a frame)
		const cut = a.plan.ranges.find((r) => r.reasons.includes('hidden-retake'))!;
		expect(Math.abs(cut.end * F - REC.words[keptTake]!.start)).toBeLessThanOrEqual(2 * F);
		expect(cut.start * F).toBeLessThanOrEqual(REC.words[firstTake]!.end);
		// "boing boing boing" is in the script: nothing of it is cut
		const boing = REC.words.flatMap((w, i) => (w.text === 'boing' ? [i] : []));
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

	it('voice without words inside a removed retake goes with it (third run, fragment E: a take with no words)', () => {
		// the recogniser wrote no word for a stretch of the first take (here a voiced blip between its words)
		const rec = synthRecording(
			[
				{ say: 'Hoy les cuento cómo publicar el juego.', keep: true },
				{ pauseS: 0.8 },
				{ say: 'para poder', keep: false },
				{ coughS: 0.5 },
				{ say: 'subirlos', keep: false },
				{ say: 'para poder subirlos a la Playstore.', keep: true },
				{ pauseS: 0.8 },
			],
			5,
		);
		const { a } = analyse(undefined, rec);
		const [ca, cb] = rec.coughs[0]!;
		const F = flicksPerFrame({ num: 30, den: 1 });
		expect(a.findings.some((f) => f.kind === 'hidden-retake' && f.suggested === 'remove')).toBe(true);
		expect(
			a.plan.kept.some((k) => (k.start * F) / FLICKS_PER_SECOND < cb && (k.end * F) / FLICKS_PER_SECOND > ca),
		).toBe(false);
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

	it('cut edges stay out of the kept word after a cut and the removed word after a piece (fragments A, F)', () => {
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
		// fragment F: "distinto." runs into the removed "Windows"
		speech(354, 454, () => -20);
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
		// on the 30 fps grid the cut ends at the frame at or before "déjenme" (71.933), not the one after (71.967)
		const clip = { start: 0, sourceIn: 0 };
		const toFrames = (p: ReturnType<typeof planMediaCuts>) =>
			keptToFrames(clip, { num: 30, den: 1 }, voice, p.kept, 0.01, [0, 9000], p.tight);
		expect(toFrames(plan)[0]![0]).toBe(2158);
		// and starts at the frame at or before the removed word (its start 4.30), not after it (4.367)
		const f = planMediaCuts({
			words: [w('distinto.', 3.54, 4.3, 0), w('Windows', 4.3, 4.54, 1)],
			removed: [false, true],
			voice,
			settings: FAST_SETTINGS,
		});
		expect(toFrames(f)[0]![1]).toBe(129);
	});

	it('ASR variants between takes do not keep an earlier take (second run: fragments D, C and E)', () => {
		// "las piensas de" / "los pies del", "Inunity" / "Unity", "vivecoder … pueda ser" / "wavecoder … puedo hacer"
		for (const words of [
			real(`En[0.51-0.63] el[0.63-0.75] Jasper[0.75-1.05] Engine[1.05-1.25] agarras[1.25-1.69] las[1.69-1.81]
				manos[1.81-2.09] y[2.09-2.25] las[2.25-2.35] piensas[2.35-2.57] de[2.57-2.59] personaje[2.59-2.97]
				directamente[2.97-3.37] en[3.37-3.69] la[3.69-3.75] escena,[3.75-4.21] les[4.21-4.37] pones[4.37-4.63]
				un[4.63-4.79] par...[4.79-5.05] En[9.01-9.13] el[9.13-9.25] Jasper[9.25-9.59] Engine[9.59-9.73]
				agarras[9.73-10.13] las[10.13-10.27] manos[10.27-10.47] y[10.47-10.61] los[10.61-10.71] pies[10.71-10.85]
				del[10.85-10.99] personaje[10.99-11.35] directamente[11.35-11.73] en[11.73-12.05] la[12.05-12.11]
				escena,[12.11-12.43] los[12.43-12.65] pones[12.65-12.91] en[12.91-13.03] un[13.03-13.13] par[13.13-13.27]
				de[13.27-13.41] poses[13.41-13.91]`),
			real(`meterle[36.80-37.21] todas[37.21-37.45] las[37.45-37.65] cosas[37.65-37.85] que[37.85-38.03]
				siempre[38.03-38.29] quise[38.29-38.55] tener[38.55-38.75] en[38.75-38.93] Inunity,[38.93-39.48]
				no.[41.29-41.45] Meterle[42.06-42.47] todas[42.47-42.67] las[42.67-42.85] cosas[42.85-43.07]
				que[43.07-43.23] siempre[43.23-43.49] quise[43.49-43.73] tener[43.73-43.93] en[43.93-44.11]
				Unity[44.11-44.35] Que[44.35-44.53] nunca[44.53-44.73] tuve[44.73-45.28]`),
			real(`Ok,[19.47-19.81] wow,[19.81-20.07] entonces[20.07-20.27] esto[20.27-20.47] significa[20.47-20.79]
				que[20.79-20.99] soy[20.99-21.29] el[21.29-21.53] puto[21.53-21.79] mejor[21.79-22.01]
				vivecoder[22.01-22.45] del[22.45-22.65] mundo[22.65-22.95] que[22.95-23.17] pueda[23.17-23.33]
				ser[23.33-23.49] lo[23.49-23.61] que...[23.61-23.71] Ok,[24.80-25.09] wow,[25.09-25.33]
				entonces[25.33-25.47] esto[25.47-25.67] significa[25.67-25.97] que[25.97-26.13] soy[26.13-26.35]
				el[26.35-26.55] puto[26.55-26.77] mejor[26.77-26.97] wavecoder[26.97-27.43] del[27.43-27.59]
				mundo[27.59-27.83] que[27.83-28.03] puedo[28.03-28.21] hacer[28.21-28.35] en[28.35-28.49] un[28.49-28.59]
				mes[28.59-28.77] lo[28.77-28.87] mismo[28.87-29.01] que[29.01-29.13] una[29.13-29.23]
				empresa[29.23-29.55] de[29.55-29.79] decenas[29.79-30.07] de[30.07-30.17] miles[30.17-30.37]
				de[30.37-30.47] millones[30.47-30.65] de[30.65-30.81] dólares.[30.81-31.15]`),
		]) {
			expect(removedBy(detectReal(words)).has(0), words[0]!.text).toBe(true);
		}
	});

	it('a clean last take wins over an earlier take with an aside (second run, fragment B)', () => {
		const words = real(`Y[35.50-35.60] el[35.60-35.70] otro[35.70-35.90] 1[35.90-36.08] %[36.08-36.52]
			son[36.52-36.84] personas[36.84-37.16] que[37.16-37.32] hicieron[37.32-37.58] su[37.58-37.74]
			propio[37.74-37.90] motor[37.90-38.18] y[38.18-38.46] nunca[38.46-38.64] terminaron[38.64-39.08]
			un[39.08-39.20] juego[39.20-39.32] en[39.32-39.48] toda[39.48-39.60] su[39.60-39.76] vida.[39.76-40.29]
			¿Y[40.56-40.90] por[40.90-41.04] qué[41.04-41.18] va[41.18-41.28] a[41.28-41.34] decir[41.34-41.50]
			puta?[41.50-41.88] el[53.84-53.96] otro[53.96-54.12] 1[54.12-54.34] %[54.34-54.82] son[54.82-55.14]
			personas[55.14-55.44] que[55.44-55.58] hicieron[55.58-55.76] su[55.76-55.88] propio[55.88-56.06]
			motor[56.06-56.34] Y[56.34-56.56] nunca[56.56-56.76] terminaron[56.76-57.20] un[57.20-57.32]
			juego[57.32-57.50] en[57.50-57.64] toda[57.64-57.78] su[57.78-57.94] vida[57.94-58.25]`);
		const r = detectReal(words);
		expect(r.groups[0]!.chosen).toBe(1);
		const removed = removedBy(r);
		// the whole first take goes; its aside — new words, possibly meant — is its own review finding (round 10); the last
		// take stays whole
		const aside = words.findIndex((w) => w.text === '¿Y');
		const last = words.findIndex((w) => w.start >= 53 * FLICKS_PER_SECOND);
		expect(words.map((_, i) => removed.has(i))).toEqual(words.map((_, i) => i < aside));
		expect(r.findings.filter((f) => f.words?.[0] === aside).map((f) => [f.words, f.suggested])).toEqual([
			[[aside, last - 1], 'review'],
		]);
	});

	it('a take said after the kept one is named a later take', () => {
		const r = detectCleanup({
			mediaId: 'med_real',
			words: real(`diseñé[1.00-1.25] las[1.30-1.55] curvas[1.60-1.85] cerradas[1.90-2.15] para[2.20-2.45]
				el[2.50-2.75] circuito[2.80-3.05] de[3.10-3.35] montaña[3.40-3.65] diseñé[4.50-4.75] las[4.80-5.05]
				curvas[5.10-5.35] cerradas[5.40-5.65] para[5.70-5.95]`),
			language: 'es',
			script: 'Diseñé las curvas cerradas para el circuito de montaña.',
			settings: mergeCleanupSettings(FAST_SETTINGS, { rules: { restart: 'off', falseStart: 'off' } }),
		});
		expect(r.groups[0]!.chosen).toBe(0);
		expect(r.findings.find((f) => f.kind === 'retake')!.reason.params.later).toBe(1);
	});

	it('no finding overlaps the take that stays (second run, fragment A: "… para poder subirlos" said again)', () => {
		const words =
			real(`Al[0.48-0.86] final[0.86-1.12] del[1.12-1.34] mes[1.34-1.56] debo[1.56-1.90] portear[1.90-2.26]
			todos[2.26-2.56] los[2.56-2.70] juegos[2.70-2.90] de[2.90-3.04] la[3.04-3.14] Jasper[3.14-3.40] de[3.40-3.50]
			Barcade[3.50-3.90] y[3.90-4.10] deben[4.10-4.26] funcionar[4.26-4.78] perfectamente[4.78-5.62]
			en[5.62-5.74] mi[5.74-5.82] motor...[5.82-6.22] Al[8.65-8.74] final[8.74-8.96] del[8.96-9.16] mes[9.16-9.40]
			debo[9.40-9.72] portear[9.72-10.08] todos[10.08-10.34] los[10.34-10.52] juegos[10.52-10.70] de[10.70-10.84]
			la[10.84-10.92] Jasper[10.92-11.22] de[11.22-11.30] Barcade...[11.30-11.92] y[11.92-11.98]
			deben[11.98-12.14] funcionar[12.14-12.60] perfectamente[12.60-13.40] en[13.40-13.52] mi[13.52-13.56]
			motor...[13.56-14.04] y[14.04-14.08] correr[14.08-14.34] en[14.34-14.52] todas[14.52-14.70]
			las[14.70-14.86] plataformas[14.86-15.50] para[15.50-15.70] poder[15.70-15.96] subirlos...[15.96-16.55]
			poder[17.38-17.60] subirlos[17.60-18.16] a[18.16-18.28] la[18.28-18.40] Play[18.40-18.58]
			Store[18.58-18.80] y[18.80-18.94] App[18.94-19.12] Store...[19.12-19.40]`);
		const r = detectReal(words);
		const kept = r.groups.map((g) => g.takes[g.chosen]!.range);
		// the first take goes (by a restart or as a take of a group)
		expect(removedBy(r).has(0)).toBe(true);
		for (const f of r.findings)
			if (f.words) for (const k of kept) expect(f.range.end <= k.start || f.range.start >= k.end).toBe(true);
	});

	it('a spoken symbol is a word over its sound ("1 %": "uno por ciento", second run, fragment B)', () => {
		const words = real(`Y[0.62-0.70] el[0.70-0.80] otro[0.80-0.94] 1[0.94-1.14] %[1.14-1.71] No,[8.55-8.65]
			Y[13.66-13.78] el[13.78-13.92] otro[13.92-14.06] 1[14.06-14.30] %[14.30-14.72] son[14.72-15.06]
			personas[15.06-15.46]`);
		const n = 1700;
		const classes = new Uint8Array(n);
		const level = new Uint8Array(n).fill((120 - 64) * 2);
		// voice under every word, under the first "%" only from 1.46 s (after a short pause, as in the recording)
		const voiced = (a: number, b: number) => {
			for (let f = Math.floor(a * 100); f < b * 100; f++) {
				classes[f] = 2;
				level[f] = (120 - 20) * 2;
			}
		};
		for (const w of words) voiced(w.start / FLICKS_PER_SECOND, w.end / FLICKS_PER_SECOND);
		classes.fill(0, 114, 146);
		level.fill((120 - 64) * 2, 114, 146);
		const r = detectCleanup({
			mediaId: 'med_real',
			words,
			language: 'es',
			settings: FAST_SETTINGS,
			voice: {
				classes,
				level,
				frameCount: n,
				levels: { floorDb: -64, speechDb: null, speechThresholdDb: null, breathFloorDb: null },
			},
		});
		// the attempt (a restart, or a retake of the whole clause) takes "%" with it; no voice without words is left
		// between the cuts
		expect(r.findings.filter((f) => f.kind === 'untranscribed')).toEqual([]);
		const restart = r.findings.find(
			(f) => (f.kind === 'restart' || f.kind === 'retake') && f.words?.[0] === 0,
		)!;
		expect(restart.range.end).toBeGreaterThanOrEqual(words[4]!.end);
	});
});
