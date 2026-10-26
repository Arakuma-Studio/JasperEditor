// Reviewing a cleanup analysis (spec 14 TC-041…TC-043, TC-050): which media a finding belongs to and where it plays,
// the rejections Apply remembers and forgets, and the Apply transaction (one undo step) on the golden recording.
import { describe, expect, it } from 'vitest';
import {
	cleanupApplyCommands,
	cleanupFindingFrames,
	cleanupFindingMedia,
	cleanupRejectionChanges,
} from '../src/cleanup/review.ts';
import { analyzeSequenceCleanup, type CleanupAnalysis, isAccepted } from '../src/cleanup/sequence.ts';
import { flicksPerFrame } from '../src/time.ts';
import { GOLDEN_EVENTS, goldenSequence } from './cleanup-golden-fixture.ts';
import { synthRecording } from './cleanup-synth.ts';

const rec = synthRecording(GOLDEN_EVENTS, 7);

function analyse(decisions = {}) {
	const g = goldenSequence(rec);
	const a = analyzeSequenceCleanup({ doc: g.H.doc, seq: g.H.seq, voice: () => rec.voice, decisions });
	if (!a.ok) throw new Error(a.message);
	return { ...g, a: a as CleanupAnalysis };
}

describe('cleanup review helpers', () => {
	it('names the media of every finding and places it on the sequence through its clip', () => {
		const { a, H, mediaId } = analyse();
		const clip = Object.values(H.seq.clips).find((c) => c.kind === 'audio')!;
		const F = flicksPerFrame(H.seq.settings.frameRate);
		expect(a.findings.length).toBeGreaterThan(5);
		for (const f of a.findings) {
			expect(cleanupFindingMedia(a, f)?.mediaId).toBe(mediaId);
			const at = cleanupFindingFrames(H.seq, a, f)!;
			expect(at.clipId).toBe(clip.id);
			expect(at.end).toBeGreaterThan(at.start);
			// the clip starts at frame 0 with sourceIn 0: frames are media time on the frame grid
			expect(at.start).toBe(Math.floor(f.range.start / F));
		}
		expect(cleanupFindingMedia(a, { fingerprint: 'med_other~1~pause~0~1~x' })).toBeNull();
		expect(
			cleanupFindingFrames(H.seq, a, { fingerprint: 'med_other~1~x', range: { start: 0, end: 1 } }),
		).toBeNull();
	});

	it('remembers explicit rejections, never suggestions, and forgets remembered ones accepted again', () => {
		const { a } = analyse();
		const rm = a.findings.find((f) => f.suggested === 'remove')!;
		const review = a.findings.find((f) => f.suggested === 'review')!;
		// no decision: nothing to remember
		expect(cleanupRejectionChanges(a, {}, new Set())).toEqual({ reject: [], unreject: [] });
		// an item rejection and a kind rejection
		const kind = a.findings.find((f) => f.kind !== rm.kind && f.suggested === 'remove')!.kind;
		const ofKind = a.findings.filter((f) => f.kind === kind);
		const r = cleanupRejectionChanges(
			a,
			{ reject: [rm.id], rejectKinds: [kind], accept: [ofKind[0]!.id] },
			new Set(),
		);
		expect(r.reject).toContain(rm.fingerprint);
		for (const f of ofKind.slice(1)) expect(r.reject).toContain(f.fingerprint);
		expect(r.reject).not.toContain(ofKind[0]!.fingerprint);
		expect(r.unreject).toEqual([]);
		// already remembered: not again; accepted now: forgotten
		const again = cleanupRejectionChanges(
			a,
			{ reject: [rm.id], accept: [review.id] },
			new Set([rm.fingerprint, review.fingerprint]),
		);
		expect(again).toEqual({ reject: [], unreject: [review.fingerprint] });
	});

	it('builds one transaction: the remembered rejections and one cleanup.apply over the plan', () => {
		const { a, H } = analyse();
		const rm = a.findings.find((f) => f.suggested === 'remove' && f.words)!;
		const b = analyzeSequenceCleanup({
			doc: H.doc,
			seq: H.seq,
			voice: () => rec.voice,
			decisions: { reject: [rm.id] },
		});
		if (!b.ok) throw new Error(b.message);
		const cmds = cleanupApplyCommands(H.seq.id, b, { reject: [rm.id] }, new Set());
		expect(cmds.map((c) => c.type)).toEqual(['cleanup.configure', 'cleanup.apply']);
		expect(cmds[0]).toMatchObject({ reject: [rm.fingerprint] });
		expect(cmds[1]).toMatchObject({
			sequenceId: H.seq.id,
			clipIds: b.plan.clipIds,
			ranges: b.plan.ranges.map((r) => ({ start: r.start, end: r.end })),
			mode: 'extract',
			fadeMs: 4,
			jlFrames: 0,
		});
		const before = H.seq;
		const r = H.ok(cmds);
		expect(r.ok).toBe(true);
		// one transaction: the rejection is stored and the sequence got shorter by the removed frames
		expect((H.seq.cleanup as { rejected?: string[] }).rejected).toEqual([rm.fingerprint]);
		const len = (s: typeof before) => Math.max(...Object.values(s.clips).map((c) => c.start + c.duration));
		const removed = b.plan.ranges.reduce((n, x) => n + x.end - x.start, 0);
		expect(len(before) - len(H.seq)).toBe(removed);
		// a later analysis keeps the rejected finding without any decision
		const c = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => rec.voice });
		if (!c.ok) throw new Error(c.message);
		const kept = c.findings.find((f) => f.fingerprint === rm.fingerprint)!;
		expect(kept).toBeDefined();
		expect(isAccepted(kept, {}, new Set([rm.fingerprint]))).toBe(false);
		// mute / markers modes and rejections off
		expect(cleanupApplyCommands(H.seq.id, a, {}, new Set(), { mode: 'markers' })[0]).toMatchObject({
			type: 'cleanup.apply',
			mode: 'markers',
			jlFrames: 0,
		});
		expect(
			cleanupApplyCommands(H.seq.id, b, { reject: [rm.id] }, new Set(), { rememberRejections: false }).map(
				(x) => x.type,
			),
		).toEqual(['cleanup.apply']);
	});
});
