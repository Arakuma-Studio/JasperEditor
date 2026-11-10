// Hidden retakes (docs/wp-notes/transcript-cleanup.md "Hidden retakes"): a take the recogniser first wrote once and then
// found by decoding the range again (`guard.redecoded` of the transcription → `Transcript.redecoded`) is a hidden
// retake: the cut runs from the first take's first word to the kept take's first word. A repeat the script itself
// makes ("boing boing boing") is never cut. The stored ranges belong to the recognition that decoded them: once a build
// that predates them transcribes the media again (a new `createdAt`), they no longer count.
import { describe, expect, it } from 'vitest';
import { analyzeSequenceCleanup, type CleanupAnalysis } from '../src/cleanup/sequence.ts';
import { createCounterIdSource } from '../src/ids.ts';
import { repairDocument, runInvariants } from '../src/invariants.ts';
import type { ProjectDocument } from '../src/schema/document.ts';
import { transcriptAttachPlan } from '../src/speech/index.ts';
import { flicksPerFrame } from '../src/time.ts';
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
