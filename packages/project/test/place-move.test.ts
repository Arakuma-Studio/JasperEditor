import { describe, expect, it } from 'vitest';
import { flicksPerFrame, RATES } from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const solid = (at: number, duration: number, track: string) => ({
	type: 'clip.addSolid',
	at,
	duration,
	track,
	color: [1, 0, 0, 1],
});

describe('clip.place (S01 AC-02…04, S02 TL-493)', () => {
	it('AC-02: places linked V1/A1 clips from a 10 s stereo video', () => {
		const h = new Harness();
		const mediaId = h.registerVideo({ seconds: 10 });
		const r = h.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				at: 0,
				mode: 'overwrite',
				tracks: { video: 'V1', audio: 'A1' },
			},
		]);
		const [v] = h.clips('V1');
		const [a] = h.clips('A1');
		expect(v!.kind).toBe('video');
		expect(a!.kind).toBe('audio');
		expect(v!.linkId).not.toBeNull();
		expect(v!.linkId).toBe(a!.linkId);
		expect([v!.sourceIn, v!.duration, a!.duration]).toEqual([0, 300, 300]);
		expect((r.results[0] as { clipIds: string[] }).clipIds).toHaveLength(2);
	});

	it('keeps the last frame of media whose probed duration is rounded to microseconds', () => {
		const h = new Harness();
		// 58 frames at 30 fps: ffprobe reports 1.933333 s (57.99999 frames).
		const asset = videoAsset({ seconds: 1.933333, audio: false });
		const m = (h.ok([{ type: 'media.register', asset }]).results[0] as { mediaId: string }).mediaId;
		const whole = h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		expect(h.seq.clips[whole.created[0]!]!.duration).toBe(58);
		const range = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 100,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 58 } },
			},
		]);
		expect(h.seq.clips[range.created[0]!]!.duration).toBe(58);
		// …and the trim limit lets the out edge reach that frame again.
		const c = range.created[0]!;
		h.ok([{ type: 'clip.trim', clipId: c, edge: 'out', deltaFrames: -10 }]);
		h.ok([{ type: 'clip.trim', clipId: c, edge: 'out', deltaFrames: 10 }]);
		expect(h.seq.clips[c]!.duration).toBe(58);
	});

	it('DT-021: linked A/V halves get the Movie label on video and the Audio label on audio', () => {
		const h = new Harness();
		const av = h.ok([{ type: 'media.register', asset: videoAsset({ seconds: 4 }) }]).results[0] as {
			itemId: string;
		};
		const wav = h.registerVideo({ seconds: 4, kind: 'audio' });
		const vOnly = h.registerVideo({ seconds: 4, audio: false });
		h.ok([
			{ type: 'clip.place', source: { projectItemId: av.itemId }, at: 0 },
			{ type: 'clip.place', source: { mediaId: wav }, at: 0, tracks: { audio: 'A2' } },
			{ type: 'clip.place', source: { mediaId: vOnly }, at: 0, tracks: { video: 'V2' } },
		]);
		expect(h.doc.items[av.itemId]!.label).toBe('violet');
		expect(h.clips('V1').map((c) => c.label)).toEqual(['violet']);
		expect(h.clips('A1').map((c) => c.label)).toEqual(['caribbean']);
		expect(h.clips('A2').map((c) => c.label)).toEqual(['caribbean']);
		expect(h.clips('V2').map((c) => c.label)).toEqual(['iris']);
	});

	it('DT-021: a label the user chose for the item applies to both halves', () => {
		const h = new Harness();
		const av = h.ok([{ type: 'media.register', asset: videoAsset({ seconds: 4 }) }]).results[0] as {
			itemId: string;
		};
		h.ok([{ type: 'item.setLabel', itemIds: [av.itemId], label: 'rose' }]);
		h.ok([{ type: 'clip.place', source: { projectItemId: av.itemId }, at: 0 }]);
		expect(h.clips('V1').map((c) => c.label)).toEqual(['rose']);
		expect(h.clips('A1').map((c) => c.label)).toEqual(['rose']);
	});

	it('AC-03: overwrite into the middle splits the linked clips around it', () => {
		const h = new Harness();
		const a = h.registerVideo({ seconds: 10 });
		const b = h.registerVideo({ seconds: 2 });
		h.ok([{ type: 'clip.place', source: { mediaId: a }, at: 0 }]);
		h.ok([{ type: 'clip.place', source: { mediaId: b }, at: 120, mode: 'overwrite' }]);
		expect(h.spans('V1')).toEqual([
			[0, 120],
			[120, 180],
			[180, 300],
		]);
		expect(h.spans('A1')).toEqual([
			[0, 120],
			[120, 180],
			[180, 300],
		]);
		const [vl, , vr] = h.clips('V1');
		const [al, , ar] = h.clips('A1');
		expect(vl!.linkId).toBe(al!.linkId);
		expect(vr!.linkId).toBe(ar!.linkId);
		expect(vr!.linkId).not.toBe(vl!.linkId);
		expect(vr!.sourceIn).toBe(180 * flicksPerFrame(RATES.r30));
	});

	it('AC-04: insert shifts every sync-locked track and splits straddling clips', () => {
		const h = new Harness();
		const a = h.registerVideo({ seconds: 10 });
		const b = h.registerVideo({ seconds: 2 });
		h.ok([{ type: 'clip.place', source: { mediaId: a }, at: 0 }, solid(30, 90, 'V2'), solid(200, 50, 'V3')]);
		h.ok([{ type: 'clip.place', source: { mediaId: b }, at: 60, mode: 'insert' }]);
		expect(h.spans('V1')).toEqual([
			[0, 60],
			[60, 120],
			[120, 360],
		]);
		expect(h.spans('A1')).toEqual([
			[0, 60],
			[60, 120],
			[120, 360],
		]);
		expect(h.spans('V2')).toEqual([
			[30, 60],
			[120, 180],
		]);
		expect(h.spans('V3')).toEqual([[260, 310]]);
	});

	it('locked tracks are untouched by inserts (ARCHITECTURE §2.3)', () => {
		const h = new Harness();
		const a = h.registerVideo({ seconds: 2 });
		h.ok([solid(0, 100, 'V2'), { type: 'track.update', trackId: 'V2', patch: { locked: true } }]);
		h.ok([{ type: 'clip.place', source: { mediaId: a }, at: 50, mode: 'insert' }]);
		expect(h.spans('V2')).toEqual([[0, 100]]);
	});

	it('video V2 places audio on A2 and creates missing tracks (S02 AC-10c)', () => {
		const h = new Harness();
		const a = h.registerVideo({ seconds: 2 });
		h.ok([{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { video: 'V4' } }]);
		expect(h.seq.videoTracks).toHaveLength(4);
		expect(h.seq.audioTracks).toHaveLength(4);
		expect(h.spans('V4')).toEqual([[0, 60]]);
		expect(h.spans('A4')).toEqual([[0, 60]]);
	});

	it('refuses a locked destination and wrong track kinds', () => {
		const h = new Harness();
		const a = h.registerVideo({ seconds: 2 });
		h.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		const r = h.tx([{ type: 'clip.place', source: { mediaId: a }, at: 0 }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_TRACK_LOCKED');
		const k = h.tx([{ type: 'clip.addText', at: 0, duration: 30, track: 'A1', content: { text: 'x' } }]);
		expect(k.ok).toBe(false);
		if (!k.ok) expect(k.errors[0]!.code).toBe('E_TRACK_KIND');
	});

	it('default scaling fits larger media and keeps smaller media at 100 (S01:FX-004)', () => {
		const h = new Harness();
		const big = h.registerVideo({ width: 3840, height: 2160, audio: false });
		const small = h.registerVideo({ width: 1280, height: 720, audio: false });
		h.ok([
			{ type: 'clip.place', source: { mediaId: big }, at: 0 },
			{ type: 'clip.place', source: { mediaId: small }, at: 0, tracks: { video: 'V2' } },
		]);
		const [b] = h.clips('V1') as Extract<ReturnType<Harness['clips']>[number], { kind: 'video' }>[];
		const [s] = h.clips('V2') as Extract<ReturnType<Harness['clips']>[number], { kind: 'video' }>[];
		expect(b!.transform.scale.value).toBe(50);
		expect(s!.transform.scale.value).toBe(100);
		expect(b!.transform.anchor.value).toEqual([1920, 1080]);
		expect(b!.transform.position.value).toEqual([960, 540]);
	});

	it('dedupes media by fingerprint (S01 media.register)', () => {
		const h = new Harness();
		const asset = {
			type: 'media.register',
			asset: {
				fingerprint: 'q1:same',
				kind: 'image',
				originalName: 'a.png',
				sizeBytes: 1,
				container: 'png',
				probe: {
					durationFlicks: null,
					startTimecode: null,
					streams: [],
					rotationDegrees: 0,
					hasAlpha: false,
					variableFrameRate: false,
				},
				locators: [],
			},
		};
		const r1 = h.ok([asset]);
		const r2 = h.ok([asset]);
		expect((r2.results[0] as { deduped: boolean }).deduped).toBe(true);
		expect((r1.results[0] as { mediaId: string }).mediaId).toBe(
			(r2.results[0] as { mediaId: string }).mediaId,
		);
		expect(Object.keys(h.doc.media)).toHaveLength(1);
		expect(Object.values(h.doc.items).filter((i) => i.kind === 'media')).toHaveLength(2);
		expect(r2.warnings.map((w) => w.code)).toContain('W_DEDUPED');
	});
});

describe('clip.move (S02 AC-10a, AC-10b)', () => {
	it('AC-10a: overwrite move trims the clip underneath and leaves a gap at the origin', () => {
		const h = new Harness();
		h.ok([solid(0, 300, 'V1'), solid(100, 100, 'V2')]);
		const b = h.clips('V2')[0]!;
		h.ok([{ type: 'clip.move', clipIds: [b.id], deltaFrames: 50, deltaTracks: -1 }]);
		expect(h.spans('V1')).toEqual([
			[0, 150],
			[150, 250],
			[250, 300],
		]);
		expect(h.clips('V1')[1]!.id).toBe(b.id);
		expect(h.spans('V2')).toEqual([]);
	});

	it('AC-10b: insert move shifts all sync-locked unlocked tracks and splits straddlers', () => {
		const h = new Harness();
		const audio = h.registerVideo({ seconds: 20, kind: 'audio' });
		h.ok([
			solid(0, 600, 'V1'),
			solid(400, 100, 'V2'),
			solid(0, 60, 'V3'),
			{
				type: 'clip.place',
				source: { mediaId: audio },
				at: 250,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 100 / 30 } },
				tracks: { audio: 'A2' },
			},
		]);
		const m = h.clips('V3')[0]!;
		h.ok([{ type: 'clip.move', clipIds: [m.id], deltaFrames: 300, deltaTracks: -2, mode: 'insert' }]);
		expect(h.spans('V1')).toEqual([
			[0, 300],
			[300, 360],
			[360, 660],
		]);
		expect(h.spans('V2')).toEqual([[460, 560]]);
		expect(h.spans('A2')).toEqual([
			[250, 300],
			[360, 410],
		]);
		expect(h.spans('V3')).toEqual([]);
	});

	it('moves linked clips as a block and refuses missing tracks without createTracks', () => {
		const h = new Harness();
		const a = h.registerVideo({ seconds: 2 });
		h.ok([{ type: 'clip.place', source: { mediaId: a }, at: 0 }]);
		const ids = h.clips().map((c) => c.id);
		h.ok([{ type: 'clip.move', clipIds: ids, deltaFrames: 10 }]);
		expect(h.spans('V1')).toEqual([[10, 70]]);
		expect(h.spans('A1')).toEqual([[10, 70]]);
		const r = h.tx([{ type: 'clip.move', clipIds: ids, deltaFrames: 0, deltaTracks: 5 }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_TRACK_KIND');
		h.ok([
			{ type: 'clip.move', clipIds: ids, deltaFrames: 0, deltaTracks: { video: 3 }, createTracks: true },
		]);
		expect(h.spans('V4')).toEqual([[10, 70]]);
		expect(h.spans('A1')).toEqual([[10, 70]]);
	});
});
