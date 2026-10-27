// Golden test of the Fast preset (spec 14 TC-070): a synthetic recording (voiced tones with known word timings,
// `cleanup-synth.ts`) with head chatter, an abandoned take, a false start, a filler between pauses, off-script chatter,
// an in-line restart, a standalone marker phrase, breaths, long pauses and a cough without a word, analysed by the real
// voice-analysis code, then detected, planned and placed on a 30 fps sequence. Thresholds: removed-word precision and
// recall ≥ 0.9, removed-time precision ≥ 0.95 and recall ≥ 0.9, no silence longer than 0.25 s left at a join.
import { describe, expect, it } from 'vitest';
import { analyzeSequenceCleanup, type CleanupAnalysis } from '../src/cleanup/sequence.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { GOLDEN_EVENTS, goldenSequence } from './cleanup-golden-fixture.ts';
import { scoreKept, synthRecording } from './cleanup-synth.ts';

function keptSeconds(a: CleanupAnalysis): Array<[number, number]> {
	return a.plan.kept.map((k) => [k.start / 30, k.end / 30]);
}

describe('Fast preset on a synthetic recording (golden)', () => {
	const rec = synthRecording(GOLDEN_EVENTS, 7);

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
