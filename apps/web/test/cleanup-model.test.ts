// Clean Up review model (spec 14 TC-040…TC-043): decisions per item / kind / retake, the word marks (what the plan
// cuts, coloured by why; review; lexical fillers), viewport coverage, timeline bands and request scope.
import { analyzeSequenceCleanup, type CleanupAnalysis, sequenceWords } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	chooseTake,
	decideItem,
	decideKind,
	EMPTY_DECISIONS,
	findingAccepted,
	groupFindings,
	inlineFindings,
	listLayout,
	overlayBands,
	scopeOf,
	toCleanupDecisions,
	visibleEntries,
	wordMarks,
} from '../src/panels/text/cleanup/model.ts';
import { cleanupSession, fakeCleanupEngine, REC, seqOf } from './cleanup-helpers.ts';

function analysed(decisions = EMPTY_DECISIONS) {
	const engine = fakeCleanupEngine();
	const { session, seqId } = cleanupSession(engine.client);
	const seq = seqOf(session, seqId);
	const doc = session.getCommitted();
	const a = analyzeSequenceCleanup({
		doc,
		seq,
		voice: () => REC.voice,
		decisions: toCleanupDecisions(decisions),
	}) as CleanupAnalysis;
	if (!a.ok) throw new Error('analysis refused');
	return { session, seq, doc, a };
}

describe('Clean Up review model', () => {
	it('decisions: item over kind, kind clears its items, retake choices, persisted rejections', () => {
		const { a } = analysed();
		const f = a.findings.find((x) => x.suggested === 'remove')!;
		const none = new Set<string>();
		expect(findingAccepted(f, EMPTY_DECISIONS, none)).toBe(true);
		let d = decideItem(EMPTY_DECISIONS, f.id, 'reject');
		expect(findingAccepted(f, d, none)).toBe(false);
		d = decideKind(d, f.kind, 'accept', a.findings);
		expect(d.reject).not.toContain(f.id);
		expect(findingAccepted(f, d, none)).toBe(true);
		d = decideItem(d, f.id, 'reject');
		expect(findingAccepted(f, d, none)).toBe(false); // the item wins over its kind
		d = decideItem(d, f.id, 'clear');
		expect(findingAccepted(f, d, none)).toBe(true);
		expect(findingAccepted(f, EMPTY_DECISIONS, new Set([f.fingerprint]))).toBe(false);
		expect(chooseTake(EMPTY_DECISIONS, 'g0', 1).retakes).toEqual({ g0: 1 });
		expect(toCleanupDecisions(EMPTY_DECISIONS)).toEqual({});
	});

	it('marks exactly the words the plan removes, coloured by the accepted finding; review and lexical words', () => {
		const { a, seq, doc } = analysed();
		const words = sequenceWords(doc, seq);
		const marks = wordMarks(words, seq, a, EMPTY_DECISIONS, new Set());
		expect(marks).toHaveLength(words.length);
		const F = 705_600_000 / 30;
		words.forEach((w, i) => {
			const mid = Math.floor((w.start + (w.end - w.start) / 2) / F);
			const inRange = a.plan.ranges.some((r) => r.start <= mid && mid < r.end);
			expect(marks[i]!.removed, w.text).toBe(inRange);
		});
		const removed = marks.filter((m) => m.removed);
		expect(removed.length).toBeGreaterThan(5);
		expect(removed.every((m) => m.kind !== null)).toBe(true);
		const kinds = new Set(removed.map((m) => m.kind));
		for (const k of ['restart', 'false-start', 'filler-vocalic', 'off-script']) expect(kinds).toContain(k);
		// the truth of the synthetic recording: words to keep are not struck
		const kept = words.map((w, i) => ({ w, m: marks[i]! })).filter(({ w }) => REC.words[w.index]!.keep);
		expect(kept.filter(({ m }) => m.removed).length).toBeLessThanOrEqual(1);
		// a pause finding lies between words: it is shown inline, before the next word
		const inline = inlineFindings(words, seq, a);
		const n = [...inline.before.values()].flat().length + inline.after.length;
		expect(n).toBe(a.findings.filter((f) => !f.words).length);
	});

	it('visible entries cover the viewport for any scroll position (fast-check)', () => {
		const { a } = analysed();
		const layout = listLayout(groupFindings(a, EMPTY_DECISIONS, new Set()), new Set(), {
			header: 20,
			row: 30,
		});
		fc.assert(
			fc.property(fc.integer({ min: 0, max: layout.total }), fc.integer({ min: 1, max: 400 }), (top, h) => {
				const { start, end } = visibleEntries(layout, top, h, 0);
				for (let i = 0; i < layout.entries.length; i++) {
					const e = layout.entries[i]!;
					const height = e.type === 'header' ? 20 : 30;
					const overlaps = e.top < top + h && e.top + height > top;
					if (overlaps) expect(i >= start && i < end).toBe(true);
				}
			}),
			{ numRuns: 200 },
		);
	});

	it('timeline bands: every cut, and padding / kept pauses only inside kept pieces on the speech track', () => {
		const { a, seq } = analysed();
		const bands = overlayBands(seq, a, () => REC.voice);
		expect(bands.cuts).toHaveLength(a.plan.ranges.length);
		const audioTrack = seq.audioTracks[0]!.id;
		for (const b of [...bands.padding, ...bands.pauses]) {
			expect(b.trackId).toBe(audioTrack);
			expect(a.plan.kept.some((k) => k.start <= b.start + 1e-6 && b.end <= k.end + 1e-6)).toBe(true);
			expect(b.end).toBeGreaterThan(b.start);
		}
		expect(overlayBands(seq, a, () => null).padding).toEqual([]);
	});

	it('resolves sequence, In/Out and selected-clip scopes', () => {
		const { seq } = analysed();
		expect(scopeOf(seq, 'sequence', [])).toEqual({ ok: true, scope: {} });
		expect(scopeOf(seq, 'inout', []).ok).toBe(false);
		expect(scopeOf({ inPoint: 10, outPoint: 50 }, 'inout', [])).toEqual({
			ok: true,
			scope: { range: { from: 10, to: 50 } },
		});
		expect(scopeOf(seq, 'clips', []).ok).toBe(false);
		expect(scopeOf(seq, 'clips', ['clp_x'])).toEqual({ ok: true, scope: { clipIds: ['clp_x'] } });
	});
});
