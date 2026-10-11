import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Clip,
	checkInvariants,
	contentTimeAt,
	evaluate,
	flicksPerFrame,
	isThroughEdit,
	type ProjectDocument,
	RATES,
	type Rational,
	sourceOut,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const solid = (at: number, duration: number, track: string) => ({
	type: 'clip.addSolid',
	at,
	duration,
	track,
	color: [0, 1, 0, 1],
});

function patchDoc(h: Harness, fn: (doc: ProjectDocument) => void) {
	const copy = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
	fn(copy);
	h.doc = copy;
}

describe('clip.trim (S02 §11, AC-11a, AC-11c)', () => {
	it('AC-11a: trimming the head of a 50% speed clip by 10 frames advances sourceIn by 5 frames', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20, audio: false });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 10 } },
			},
		]);
		const id = h.clips('V1')[0]!.id;
		patchDoc(h, (d) => {
			d.sequences[h.seqId]!.clips[id]!.speed.rate = 0.5;
		});
		h.ok([{ type: 'clip.trim', clipId: id, edge: 'in', deltaFrames: 10, mode: 'regular' }]);
		const c = h.clips('V1')[0]!;
		expect(c.sourceIn).toBe(5 * flicksPerFrame(RATES.r30));
		expect([c.start, c.duration]).toEqual([10, 290]);
	});

	it('regular trims clamp at neighbours and media bounds with W_DURATION_CLAMPED', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10, audio: false });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { seconds: 1 }, out: { seconds: 5 } },
			},
			solid(150, 30, 'V1'),
		]);
		const id = h.clips('V1')[0]!.id;
		const r = h.ok([{ type: 'clip.trim', clipId: id, edge: 'out', deltaFrames: 100 }]);
		expect(h.spans('V1')).toEqual([
			[0, 150],
			[150, 180],
		]);
		expect(r.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED');
		h.ok([{ type: 'clip.trim', clipId: id, edge: 'in', deltaFrames: -100 }]);
		expect(h.clips('V1')[0]!.start).toBe(0);
		h.ok([{ type: 'clip.move', clipIds: [id], deltaFrames: 100 }]);
		h.ok([{ type: 'clip.trim', clipId: id, edge: 'in', deltaFrames: -100 }]);
		const c = h.clips('V1').find((x) => x.id === id)!;
		expect(c.sourceIn).toBe(0);
		expect(c.start).toBe(70);
	});

	it('trims linked partners with coincident edges', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		h.ok([{ type: 'clip.trim', clipId: h.clips('V1')[0]!.id, edge: 'out', deltaFrames: -100 }]);
		expect(h.spans('V1')).toEqual([[0, 200]]);
		expect(h.spans('A1')).toEqual([[0, 200]]);
		h.ok([{ type: 'clip.trim', clipId: h.clips('V1')[0]!.id, edge: 'out', deltaFrames: -50, linked: false }]);
		expect(h.spans('V1')).toEqual([[0, 150]]);
		expect(h.spans('A1')).toEqual([[0, 200]]);
	});

	it('AC-11c: ripple trim shifts later clips on the track and sync-locked tracks', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1'), solid(100, 100, 'V1'), solid(150, 100, 'V3')]);
		const a = h.clips('V1')[0]!.id;
		h.ok([{ type: 'clip.trim', clipId: a, edge: 'out', deltaFrames: -20, mode: 'ripple' }]);
		expect(h.spans('V1')).toEqual([
			[0, 80],
			[80, 180],
		]);
		expect(h.spans('V3')).toEqual([[130, 230]]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('AC-11c: content on a sync-locked track refuses the command (E_SYNC_CONFLICT) or stops the gesture', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1'), solid(100, 100, 'V1'), solid(70, 25, 'V2')]);
		const a = h.clips('V1')[0]!.id;
		const blocker = h.clips('V2')[0]!.id;
		const r = h.tx([{ type: 'clip.trim', clipId: a, edge: 'out', deltaFrames: -20, mode: 'ripple' }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]!.code).toBe('E_SYNC_CONFLICT');
			expect(r.errors[0]!.blocking).toContain(blocker);
		}
		const g = h.ok([
			{ type: 'clip.trim', clipId: a, edge: 'out', deltaFrames: -20, mode: 'ripple', clampToSyncLock: true },
		]);
		expect(g.results[0]).toEqual({ deltaFrames: -5 });
		expect(h.spans('V1')).toEqual([
			[0, 95],
			[95, 195],
		]);
		expect(h.spans('V2')).toEqual([[70, 95]]);
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { syncLock: false } }]);
		h.ok([{ type: 'clip.trim', clipId: a, edge: 'out', deltaFrames: -15, mode: 'ripple' }]);
		expect(h.spans('V1')).toEqual([
			[0, 80],
			[80, 180],
		]);
		expect(h.spans('V2')).toEqual([[70, 95]]);
	});

	it('ripple lengthening splits straddling clips on sync-locked tracks', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1'), solid(100, 50, 'V1'), solid(50, 100, 'V2')]);
		h.ok([{ type: 'clip.trim', clipId: h.clips('V1')[0]!.id, edge: 'out', deltaFrames: 20, mode: 'ripple' }]);
		expect(h.spans('V1')).toEqual([
			[0, 120],
			[120, 170],
		]);
		expect(h.spans('V2')).toEqual([
			[50, 100],
			[120, 170],
		]);
	});
});

describe('clip.split (S01:CLP-007, S02 AC-12a, AC-1a)', () => {
	it('splits linked partners, relinks right parts and copies keyframes with new ids', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const v = h.clips('V1')[0]!;
		h.ok([
			{ type: 'param.setAnimated', target: ['clip', v.id, 'opacity'], animated: true, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', v.id, 'opacity'], value: 0, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', v.id, 'opacity'], value: 100, at: { frames: 200 } },
		]);
		const r = h.ok([{ type: 'clip.split', at: 100, clipIds: [v.id] }]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 300],
		]);
		expect(h.spans('A1')).toEqual([
			[0, 100],
			[100, 300],
		]);
		const [vl, vr] = h.clips('V1') as Extract<Clip, { kind: 'video' }>[];
		const [, ar] = h.clips('A1');
		expect(vr!.linkId).toBe(ar!.linkId);
		expect(vr!.opacity.keyframes).toHaveLength(2);
		expect(vr!.opacity.keyframes.map((k) => k.id)).not.toEqual(vl!.opacity.keyframes.map((k) => k.id));
		expect((r.results[0] as { right: string[] }).right).toHaveLength(2);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('AC-06: split + head trim keeps on-screen values identical', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10, audio: false });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const id = h.clips('V1')[0]!.id;
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'transform', 'scale'],
				animated: true,
				at: { frames: 20 },
			},
			{ type: 'param.set', target: ['clip', id, 'transform', 'scale'], value: 50, at: { frames: 20 } },
			{ type: 'param.set', target: ['clip', id, 'transform', 'scale'], value: 150, at: { frames: 250 } },
		]);
		const rate = h.seq.settings.frameRate as Rational;
		const valueAt = (frame: number) => {
			const c = h.clips('V1').find((x) => x.start <= frame && frame < x.start + x.duration) as Extract<
				Clip,
				{ kind: 'video' }
			>;
			return evaluate(c.transform.scale, contentTimeAt(c, frame, rate));
		};
		const before = Array.from({ length: 300 }, (_, f) => valueAt(f));
		h.ok([{ type: 'clip.split', at: 120, clipIds: [id] }]);
		const right = h.clips('V1')[1]!;
		h.ok([{ type: 'clip.trim', clipId: right.id, edge: 'in', deltaFrames: 10 }]);
		for (let f = 0; f < 300; f++) {
			if (f >= 120 && f < 130) continue; // trimmed away
			expect(valueAt(f)).toBeCloseTo(before[f]!, 9);
		}
	});

	it('AC-12a: razor all unlocked tracks at 500 skips locked tracks', () => {
		const h = new Harness();
		h.ok([
			solid(0, 1000, 'V1'),
			solid(400, 200, 'V2'),
			solid(450, 100, 'V3'),
			{ type: 'track.update', trackId: 'V3', patch: { locked: true } },
		]);
		const audio = h.registerVideo({ seconds: 60, kind: 'audio' });
		h.ok([{ type: 'clip.place', source: { mediaId: audio }, at: 0, tracks: { audio: 'A2' } }]);
		h.ok([{ type: 'clip.split', at: 500, scope: 'all-unlocked' }], { label: 'Razor All Tracks' });
		expect(h.spans('V1')).toEqual([
			[0, 500],
			[500, 1000],
		]);
		expect(h.spans('V2')).toEqual([
			[400, 500],
			[500, 600],
		]);
		expect(h.spans('V3')).toEqual([[450, 550]]);
		expect(h.spans('A2')).toEqual([
			[0, 500],
			[500, 1800],
		]);
		expect(h.seq.videoTracks.length + h.seq.audioTracks.length).toBe(6);
	});

	it('S02 AC-1a: 500 random splits at 37% speed (29.97) re-join exactly', () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 500, maxLength: 500 }),
				(cuts) => {
					const h = new Harness({ preset: 'hd-1080p-29.97' });
					const m = h.registerVideo({ seconds: 600, audio: false, fps: { num: 30000, den: 1001 } });
					h.ok([
						{
							type: 'clip.place',
							source: { mediaId: m },
							at: 0,
							sourceRange: { in: { seconds: 3.3 }, out: { seconds: 180 } },
						},
					]);
					const id = h.clips('V1')[0]!.id;
					patchDoc(h, (d) => {
						const c = d.sequences[h.seqId]!.clips[id]!;
						c.speed.rate = 0.37;
					});
					const original = { ...h.clips('V1')[0]! };
					const rate = h.seq.settings.frameRate as Rational;
					const origOut = sourceOut(original, rate);
					for (const raw of cuts) {
						const at = 1 + (raw % (original.duration - 1));
						const target = h.clips('V1').find((c) => c.start < at && at < c.start + c.duration);
						if (target) h.ok([{ type: 'clip.split', at, clipIds: [target.id] }]);
					}
					const pieces = h.clips('V1');
					for (let i = 1; i < pieces.length; i++) {
						if (!isThroughEdit(pieces[i - 1]!, pieces[i]!, rate))
							throw new Error(`not a through edit at ${pieces[i]!.start}`);
					}
					const F = flicksPerFrame(rate);
					for (const p of pieces) {
						const ideal = original.sourceIn + (p.start - original.start) * F * 0.37;
						expect(Math.abs(p.sourceIn - ideal)).toBeLessThan(64);
					}
					const joined = { ...pieces[0]!, duration: pieces.reduce((s, p) => s + p.duration, 0) };
					expect(joined.sourceIn).toBe(original.sourceIn);
					expect(joined.duration).toBe(original.duration);
					expect(sourceOut(joined, rate)).toBe(origOut);
				},
			),
			{ numRuns: 2, endOnFailure: true },
		);
	});
});

describe('lift / extract (S02 AC-13b, Appendix A.5)', () => {
	it('lift leaves a gap; extract closes it on sync-locked tracks', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1'), solid(100, 100, 'V1'), solid(200, 100, 'V1'), solid(320, 50, 'V2')]);
		const [, b] = h.clips('V1');
		h.ok([{ type: 'clip.lift', clipIds: [b!.id] }]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[200, 300],
		]);
		h.ok([{ type: 'clip.extract', clipIds: [h.clips('V1')[1]!.id] }]);
		expect(h.spans('V1')).toEqual([[0, 100]]);
		expect(h.spans('V2')).toEqual([[220, 270]]);
	});

	it('AC-13b: ripple delete is refused when a sync-locked track has content in the range', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1'), solid(100, 100, 'V1'), solid(200, 100, 'V1'), solid(150, 100, 'V2')]);
		const b = h.clips('V1')[1]!;
		const r = h.tx([{ type: 'clip.extract', clipIds: [b.id] }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]!.code).toBe('E_SYNC_CONFLICT');
			expect(r.errors[0]!.blocking).toEqual([h.clips('V2')[0]!.id]);
		}
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { syncLock: false } }]);
		h.ok([{ type: 'clip.extract', clipIds: [b.id] }]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 200],
		]);
		expect(h.spans('V2')).toEqual([[150, 250]]);
	});
});

describe('sequence settings (S01 AC-07)', () => {
	it('AC-07: 30 → 25 fps keeps adjacency, keeps keyframes on the picture and collapses 1-frame clips', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20, audio: false });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 3.1 } },
			},
			solid(93, 7, 'V1'),
			solid(100, 1, 'V2'),
			solid(3, 1, 'V3'),
		]);
		const vid = h.clips('V1')[0]!.id;
		h.ok([
			{ type: 'param.setAnimated', target: ['clip', vid, 'opacity'], animated: true, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', vid, 'opacity'], value: 0, at: { frames: 60 } },
		]);
		const kfBefore = (h.clips('V1')[0] as Extract<Clip, { kind: 'video' }>).opacity.keyframes.map(
			(k) => k.time,
		);
		const r = h.ok([{ type: 'sequence.updateSettings', settings: { frameRate: { num: 25, den: 1 } } }]);
		expect(h.seq.settings.frameRate).toEqual({ num: 25, den: 1 });
		const [a, b] = h.clips('V1');
		expect(a!.start + a!.duration).toBe(b!.start);
		expect(
			(h.clips('V1')[0] as Extract<Clip, { kind: 'video' }>).opacity.keyframes.map((k) => k.time),
		).toEqual(kfBefore);
		expect(h.clips('V3')).toHaveLength(0);
		expect(r.warnings.map((w) => w.code)).toContain('W_CLIP_COLLAPSED');
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('frame size change keeps offset from center (S01:SEQ-007)', () => {
		const h = new Harness();
		h.ok([
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V2',
				content: { text: 'Hi' },
				transform: { position: [100, 100] },
			},
		]);
		h.ok([{ type: 'sequence.updateSettings', settings: { width: 1280, height: 720 } }]);
		const t = h.clips('V2')[0] as Extract<Clip, { kind: 'text' }>;
		expect(t.transform.position.value).toEqual([100 - 320, 100 - 180]);
	});
});
