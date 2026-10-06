// wp-multicam: Synchronize, Merge Clips, Create Multi-Camera Source Sequence, multi-camera clips (switching,
// recording, enable, flatten, Edit Cameras), their render expansion and invariants.
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	checkInvariants,
	type Clip,
	contentTimeAt,
	createCounterIdSource,
	evaluate,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type MediaAsset,
	type MulticamSource,
	type ProjectDocument,
	type RenderSnapshot,
	repairDocument,
	resolveSceneAt,
	type Sequence,
} from '../src/index.ts';
import { commonPlacements, mediaTimecode, type SyncSource, syncOffsets } from '../src/multicam/sync.ts';
import { Harness, videoAsset } from './helpers.ts';

const F30 = flicksPerFrame({ num: 30, den: 1 });
const SEC = FLICKS_PER_SECOND;

function register(h: Harness, opts: Parameters<typeof videoAsset>[0] & { tc?: string; name?: string } = {}) {
	const asset = videoAsset(opts) as MediaAsset;
	if (opts.tc) asset.probe.startTimecode = opts.tc;
	const r = h.ok([{ type: 'media.register', asset, ...(opts.name ? { name: opts.name } : {}) }]);
	return r.results[0] as { mediaId: string; itemId: string };
}

const snap = (doc: ProjectDocument, seqId: string): RenderSnapshot =>
	buildRenderSnapshot(doc, seqId, { resolveMedia: () => null, resolveFont: () => null });

/** Three cameras (10 s, 1080p30) and an audio recorder; the In marks say where the clap is. */
function setup(opts: { audioOnly?: boolean } = {}) {
	const h = new Harness();
	const cams = [
		register(h, { seconds: 10, name: 'B Cam' }),
		register(h, { seconds: 12, name: 'A Cam' }),
		register(h, { seconds: 8, name: 'C Cam' }),
	];
	const rec = opts.audioOnly ? register(h, { seconds: 15, kind: 'audio', name: 'Recorder' }) : null;
	// clap at 2 s / 3 s / 1.5 s (+ 4.25 s on the recorder)
	const marks = [2, 3, 1.5, 4.25];
	const items = [...cams, ...(rec ? [rec] : [])];
	items.forEach((it, i) =>
		h.ok([{ type: 'item.setMarks', itemId: it.itemId, in: { seconds: marks[i]! }, out: null }]),
	);
	return { h, cams, rec, items };
}

function createMc(h: Harness, itemIds: string[], extra: Record<string, unknown> = {}) {
	const r = h.ok([{ type: 'multicam.create', itemIds, method: 'in', ...extra }]);
	return r.results[0] as { sequenceId: string; itemId: string; angles: { angle: string; name: string }[] };
}

function placeMc(h: Harness, sequenceId: string, at = 0) {
	const r = h.ok([{ type: 'clip.place', source: { sequenceId }, at, sequenceId: h.seqId }]);
	const [video, audio] = (r.results[0] as { clipIds: string[] }).clipIds;
	return { video: video!, audio: audio! };
}

const mcOf = (doc: ProjectDocument, id: string) => doc.sequences[id]!.multicam as MulticamSource;

describe('sync points', () => {
	const src = (key: string, p: Partial<SyncSource>): SyncSource => ({
		key,
		name: key,
		inPoint: 0,
		outPoint: 10 * SEC,
		timecode: null,
		markers: [],
		...p,
	});
	it('In, Out, clip marker (named) and timecode give offsets relative to the reference', () => {
		const a = src('a', { inPoint: 2 * SEC, outPoint: 9 * SEC, markers: [{ flicks: 5 * SEC, name: 'clap' }] });
		const b = src('b', {
			inPoint: 3 * SEC,
			outPoint: 8 * SEC,
			markers: [
				{ flicks: 1 * SEC, name: 'x' },
				{ flicks: 7 * SEC, name: 'Clap' },
			],
		});
		expect(syncOffsets([a, b], 0, { method: 'in' })).toEqual([0, SEC]);
		expect(syncOffsets([a, b], 0, { method: 'out' })).toEqual([0, -SEC]);
		expect(syncOffsets([a, b], 0, { method: 'marker' })).toEqual([0, -4 * SEC]);
		expect(syncOffsets([a, b], 0, { method: 'marker', marker: 'clap' })).toEqual([0, 2 * SEC]);
		expect(() => syncOffsets([a, src('c', {})], 0, { method: 'marker' })).toThrow(/no clip marker/);
		const t = (s: number) => ({ flicks: s * SEC, hourFlicks: 3600 * SEC });
		const ta = src('a', { timecode: t(3600 + 10) });
		const tb = src('b', { timecode: t(2 * 3600 + 7) });
		// a at content 0 shows TC 01:00:10; b shows 02:00:07 → b at content t shows a's t + 3600 − 3 s
		expect(syncOffsets([ta, tb], 0, { method: 'timecode' })).toEqual([0, -(3600 - 3) * SEC]);
		expect(syncOffsets([ta, tb], 0, { method: 'timecode', ignoreHours: true })).toEqual([0, 3 * SEC]);
		expect(() => syncOffsets([ta, src('n', {})], 0, { method: 'timecode' })).toThrow(/no timecode/);
		expect(syncOffsets([a, b], 1, { method: 'audio', audioOffsets: { a: 123 } })).toEqual([123, 0]);
		expect(() => syncOffsets([a, b], 0, { method: 'audio' })).toThrow(/No audio offset/);
	});

	it('timecode labels: NDF and drop-frame hours', () => {
		const asset = videoAsset({ fps: { num: 30000, den: 1001 } }) as MediaAsset;
		asset.probe.startTimecode = '01:00:00;00';
		const tc = mediaTimecode(asset, { num: 30, den: 1 })!;
		// one drop-frame hour of labels is 107 892 frames = 3599.9964 s ≈ real time
		expect(tc.flicks).toBe(Math.round(107_892 * flicksPerFrame({ num: 30000, den: 1001 })));
		expect(tc.hourFlicks).toBe(tc.flicks);
		asset.probe.startTimecode = '00:00:10:15';
		expect(mediaTimecode(asset, { num: 30, den: 1 })!.flicks).toBe(
			Math.round(315 * flicksPerFrame({ num: 30000, den: 1001 })),
		);
	});

	it('common placements start at 0 and keep sub-frame sync in the source In', () => {
		const p = commonPlacements(
			[
				{ start: 0, end: 10 * SEC },
				{ start: 0, end: 10 * SEC },
			],
			[0, Math.round(0.51 * SEC)],
			{ num: 30, den: 1 },
		);
		// b's content 0 sits at common −0.51 s → b is the earliest; a starts at 0.51 s = 15.3 frames → frame 16
		expect(p[1]).toEqual({ start: 0, sourceIn: 0, frames: 300 });
		expect(p[0]!.start).toBe(16);
		const exact = 0.51 * SEC;
		expect(p[0]!.sourceIn).toBe(Math.round(16 * F30 - exact));
		// the frame a shows at timeline frame 16 is the one that coincides with b's
		const aTime = p[0]!.sourceIn;
		const bTime = 16 * F30;
		expect(Math.abs(bTime - (aTime + Math.round(0.51 * SEC)))).toBeLessThanOrEqual(1);
	});
});

describe('Create Multi-Camera Source Sequence', () => {
	it('builds one video track per camera, audio per source, angles, names and sync by In', () => {
		const { h, items } = setup({ audioOnly: true });
		const r = createMc(
			h,
			items.map((i) => i.itemId),
			{ audio: 'switch', cameraNames: 'clip', order: 'name' },
		);
		const src = h.doc.sequences[r.sequenceId]!;
		const mc = src.multicam!;
		expect(mc.audio).toBe('switch');
		expect(mc.sync).toBe('in');
		expect(mc.angles.map((a) => a.name)).toEqual(['A Cam', 'B Cam', 'C Cam', 'Recorder']);
		expect(mc.angles.map((a) => a.videoTrackId !== null)).toEqual([true, true, true, false]);
		expect(src.videoTracks).toHaveLength(3);
		expect(src.audioTracks).toHaveLength(4);
		expect(src.videoTracks.map((t) => t.name)).toEqual(['A Cam', 'B Cam', 'C Cam']);
		// automatic preset = the reference camera's format
		expect([src.settings.width, src.settings.height, src.settings.frameRate]).toEqual([1920, 1080, { num: 30, den: 1 }]);
		// In points (3, 2, 1.5, 4.25 s for A, B, C, Recorder) line up: the recorder (latest In) starts at 0
		const at = (trackId: string) => Object.values(src.clips).find((c) => c.trackId === trackId)!;
		const inOf = { A: 3, B: 2, C: 1.5, R: 4.25 };
		const clapFrame = (trackId: string, clapSec: number) => {
			const c = at(trackId);
			return c.start + (clapSec * SEC - c.sourceIn) / F30;
		};
		const claps = [
			clapFrame(mc.angles[0]!.videoTrackId!, inOf.A),
			clapFrame(mc.angles[1]!.videoTrackId!, inOf.B),
			clapFrame(mc.angles[2]!.videoTrackId!, inOf.C),
			clapFrame(mc.angles[3]!.audioTrackIds[0]!, inOf.R),
		];
		for (const c of claps) expect(c).toBeCloseTo(claps[3]!, 6);
		expect(Math.min(...Object.values(src.clips).map((c) => c.start))).toBe(0);
		expect(h.doc.items[r.itemId]).toMatchObject({ kind: 'sequence', name: 'A Cam Multicam' });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('enumerates camera names, honours an explicit order, a preset and the Processed Clips bin', () => {
		const { h, cams } = setup();
		const r = createMc(h, [cams[0]!.itemId, cams[1]!.itemId, cams[2]!.itemId], {
			order: [cams[2]!.itemId, cams[0]!.itemId, cams[1]!.itemId],
			preset: 'hd-720p-30',
			moveToProcessedBin: true,
			name: 'Show',
		});
		const mc = mcOf(h.doc, r.sequenceId);
		expect(mc.angles.map((a) => a.name)).toEqual(['Camera 1', 'Camera 2', 'Camera 3']);
		expect(mc.angles.map((a) => a.itemId)).toEqual([cams[2]!.itemId, cams[0]!.itemId, cams[1]!.itemId]);
		expect(h.doc.sequences[r.sequenceId]!.settings.width).toBe(1280);
		const bin = Object.values(h.doc.items).find((i) => i.kind === 'bin' && i.name === 'Processed Clips')!;
		expect(bin.kind === 'bin' && [...bin.children].sort()).toEqual(cams.map((c) => c.itemId).sort());
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('needs a camera; audio sync needs offsets', () => {
		const h = new Harness();
		const a = register(h, { kind: 'audio' });
		expect(h.tx([{ type: 'multicam.create', itemIds: [a.itemId], method: 'in' }]).ok).toBe(false);
		const v = register(h);
		const r = h.tx([{ type: 'multicam.create', itemIds: [v.itemId, a.itemId], method: 'audio' }]);
		expect(r.ok).toBe(false);
		const ok = h.ok([
			{ type: 'multicam.create', itemIds: [v.itemId, a.itemId], method: 'audio', audioOffsets: { [a.itemId]: SEC } },
		]);
		const src = h.doc.sequences[(ok.results[0] as { sequenceId: string }).sequenceId]!;
		// a's content t = v's content t + 1 s → a starts 1 s (30 frames) before v
		const vClip = Object.values(src.clips).find((c) => c.kind === 'video')!;
		const aClip = Object.values(src.clips).find((c) => c.kind === 'audio' && c.trackId === src.audioTracks[1]!.id)!;
		expect(vClip.start - aClip.start).toBe(30);
	});
});

describe('multi-camera clips: placing and rendering', () => {
	it('places linked multi-camera video and audio clips showing camera 1', () => {
		const { h, cams } = setup();
		const { sequenceId } = createMc(h, cams.map((c) => c.itemId));
		const { video, audio } = placeMc(h, sequenceId, 10);
		const v = h.seq.clips[video]!;
		const a = h.seq.clips[audio]!;
		const mc = mcOf(h.doc, sequenceId);
		expect(v).toMatchObject({ kind: 'nest-video', sequenceId, start: 10, multicam: { enabled: true, angle: mc.angles[0]!.id } });
		expect(a).toMatchObject({ kind: 'nest-audio', sequenceId, multicam: { enabled: true } });
		expect(v.linkId).toBe(a.linkId);
		const src = h.doc.sequences[sequenceId]!;
		const len = Math.max(...Object.values(src.clips).map((c) => c.start + c.duration));
		expect(v.duration).toBe(len);
		// bounded by the source sequence: extending past it fails
		h.tx([{ type: 'clip.trim', clipId: video, edge: 'out', deltaFrames: 5, linked: false }]);
		expect(h.seq.clips[video]!.duration).toBe(len);
		expect(checkInvariants(h.doc)).toEqual([]);
		// a sequence cannot be placed into itself
		const self = h.tx([{ type: 'clip.place', source: { sequenceId }, at: 0, sequenceId }]);
		expect(self.ok).toBe(false);
	});

	it('renders the active angle’s media at the synced media time, with outer effects and Motion', () => {
		const { h, cams } = setup();
		const { sequenceId } = createMc(h, cams.map((c) => c.itemId));
		const { video } = placeMc(h, sequenceId, 0);
		const src = h.doc.sequences[sequenceId]!;
		const mc = mcOf(h.doc, sequenceId);
		h.ok([
			{ type: 'effect.add', target: { clipId: video }, effectId: 'jasper.gaussian-blur' },
			{ type: 'param.set', target: ['clip', video, 'opacity'], value: 50 },
			{ type: 'param.set', target: ['clip', video, 'transform', 'position'], value: [1000, 500] },
		]);
		for (const [k, angle] of mc.angles.entries()) {
			h.ok([{ type: 'multicam.switchAngle', clipIds: [video], angle: angle.id }]);
			const s = snap(h.doc, h.seqId);
			const layers = s.videoTracks.flatMap((t) => t.clips);
			const inner = Object.values(src.clips).find((c) => c.trackId === angle.videoTrackId)!;
			expect(layers.map((l) => l.clipId)).toEqual([video]);
			const l = layers[0]!;
			expect(l.kind).toBe('video');
			expect((l.source as { mediaId: string }).mediaId).toBe((inner as { mediaId: string }).mediaId);
			expect(l.multicamOf).toEqual({ clipId: video, sequenceId, angle: angle.id });
			expect(l.start).toBe(inner.start);
			expect(l.sourceIn).toBe(inner.sourceIn);
			expect(l.effects.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur']);
			expect(l.opacity.value).toBe(50);
			expect(l.transform!.position.value).toEqual([1000, 500]);
			// every outer frame shows the inner clip's media at the right time
			for (const f of [l.start, l.start + 7, l.start + l.duration - 1]) {
				const scene = resolveSceneAt(s, f);
				expect(scene).toHaveLength(1);
				expect(contentTimeAt(l, f, { num: 30, den: 1 })).toBe(contentTimeAt(inner, f, src.settings.frameRate));
			}
			void k;
		}
	});

	it('Motion composes with a scaled angle (a 4K camera fitted into a 1080 source) and keyframes re-time', () => {
		const h = new Harness();
		const a = register(h, { seconds: 10, width: 3840, height: 2160 });
		const b = register(h, { seconds: 10 });
		h.ok([{ type: 'project.updateSettings', settings: { defaultScaling: 'fit' } }]);
		const { sequenceId } = createMc(h, [b.itemId, a.itemId], { preset: 'hd-1080p-30' });
		const src = h.doc.sequences[sequenceId]!;
		const mc = mcOf(h.doc, sequenceId);
		const inner4k = Object.values(src.clips).find((c) => c.trackId === mc.angles[1]!.videoTrackId)!;
		expect((inner4k as { transform: { scale: { value: number } } }).transform.scale.value).toBe(50);
		const { video } = placeMc(h, sequenceId, 30);
		h.ok([
			{ type: 'multicam.switchAngle', clipIds: [video], angle: 2 },
			{ type: 'param.setAnimated', target: ['clip', video, 'transform', 'scale'], animated: true, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', video, 'transform', 'scale'], value: 100, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', video, 'transform', 'scale'], value: 200, at: { frames: 60 } },
			{ type: 'param.set', target: ['clip', video, 'transform', 'rotation'], value: 30 },
		]);
		const s = snap(h.doc, h.seqId);
		const l = s.videoTracks.flatMap((t) => t.clips)[0]!;
		const outer = h.seq.clips[video] as Extract<Clip, { kind: 'nest-video' }>;
		for (const f of [30, 60, 90, 120]) {
			const scene = resolveSceneAt(s, f)[0]!;
			// expected: outer matrix × inner matrix applied to the media's corners
			const to = contentTimeAt(outer, f, { num: 30, den: 1 });
			const oScale = evaluate(outer.transform.scale, to) / 100;
			const th = (30 * Math.PI) / 180;
			// media centre → sequence: outer anchor (960,540 of the 1080 source) is the media centre's image
			const centre = scene.props.matrix;
			const mx = centre.a * 1920 + centre.c * 1080 + centre.e;
			const my = centre.b * 1920 + centre.d * 1080 + centre.f;
			expect(mx).toBeCloseTo(960, 6);
			expect(my).toBeCloseTo(540, 6);
			// the matrix's linear part = rotation(30°) · (outer scale × inner 0.5)
			expect(centre.a).toBeCloseTo(Math.cos(th) * oScale * 0.5, 6);
			expect(centre.b).toBeCloseTo(Math.sin(th) * oScale * 0.5, 6);
		}
		expect(l.intrinsicBox).toEqual({ width: 3840, height: 2160 });
	});

	it('audio follows the source’s audio mode: camera 1, all cameras, switch', () => {
		const { h, cams } = setup();
		const { sequenceId } = createMc(h, cams.map((c) => c.itemId));
		const { video, audio } = placeMc(h, sequenceId, 0);
		const mc = mcOf(h.doc, sequenceId);
		const src = h.doc.sequences[sequenceId]!;
		const mediaOfTrack = (t: string) =>
			(Object.values(src.clips).find((c) => c.trackId === t) as { mediaId: string }).mediaId;
		const played = () => snap(h.doc, h.seqId).audioClips.map((c) => c.mediaId).sort();
		h.ok([{ type: 'multicam.switchAngle', clipIds: [video], angle: 3 }]);
		expect(played()).toEqual([mediaOfTrack(mc.angles[0]!.audioTrackIds[0]!)]);
		h.ok([{ type: 'multicam.editAngles', sequenceId, audio: 'all' }]);
		expect(played()).toEqual(mc.angles.map((a) => mediaOfTrack(a.audioTrackIds[0]!)).sort());
		h.ok([{ type: 'multicam.editAngles', sequenceId, audio: 'switch' }]);
		expect(played()).toEqual([mediaOfTrack(mc.angles[2]!.audioTrackIds[0]!)]);
		// audio stays fixed when switching video only
		h.ok([{ type: 'multicam.switchAngle', clipIds: [video], angle: 2, audio: false }]);
		expect(played()).toEqual([mediaOfTrack(mc.angles[2]!.audioTrackIds[0]!)]);
		expect((h.seq.clips[audio] as { multicam: { angle: string } }).multicam.angle).toBe(mc.angles[2]!.id);
		// …and follows with the default
		h.ok([{ type: 'multicam.switchAngle', clipIds: [video], angle: 1 }]);
		expect(played()).toEqual([mediaOfTrack(mc.angles[0]!.audioTrackIds[0]!)]);
		// gain/volume of the outer and inner clips add up
		h.ok([{ type: 'clip.update', clipId: audio, patch: { gainDb: -6 } }]);
		const a0 = snap(h.doc, h.seqId).audioClips[0]!;
		expect(a0.gainDb).toBe(-6);
		expect(a0.clipId).toBe(audio);
	});

	it('changes in the source sequence (adjusting sync) are reflected; disabled clips render as nests', () => {
		const { h, cams } = setup();
		const { sequenceId } = createMc(h, cams.map((c) => c.itemId));
		const { video } = placeMc(h, sequenceId, 0);
		const mc = mcOf(h.doc, sequenceId);
		const src = h.doc.sequences[sequenceId]!;
		const inner = Object.values(src.clips).find((c) => c.trackId === mc.angles[0]!.videoTrackId)!;
		const before = snap(h.doc, h.seqId).videoTracks.flatMap((t) => t.clips)[0]!;
		h.ok([{ type: 'clip.move', clipIds: [inner.id], deltaFrames: 3 }]);
		const after = snap(h.doc, h.seqId).videoTracks.flatMap((t) => t.clips)[0]!;
		expect(after.start).toBe(before.start + 3);
		h.ok([{ type: 'multicam.setEnabled', clipIds: [video], enabled: false }]);
		const off = snap(h.doc, h.seqId).videoTracks.flatMap((t) => t.clips);
		expect(off[0]!.kind).toBe('nest-video');
		expect((h.seq.clips[video] as { multicam: { enabled: boolean } }).multicam.enabled).toBe(false);
		h.ok([{ type: 'multicam.setEnabled', clipIds: [video], enabled: true }]);
		expect(snap(h.doc, h.seqId).videoTracks.flatMap((t) => t.clips)[0]!.kind).toBe('video');
	});
});

describe('switching angles', () => {
	function placed() {
		const { h, cams } = setup();
		const { sequenceId } = createMc(h, cams.map((c) => c.itemId), { audio: 'switch' });
		const ids = placeMc(h, sequenceId, 0);
		return { h, sequenceId, ...ids, mc: mcOf(h.doc, sequenceId) };
	}
	const anglesOn = (h: Harness, track: string) =>
		h.clips(track).map((c) => [c.start, c.start + c.duration, (c as { multicam: { angle: string } }).multicam.angle]);

	it('at the playhead switches the whole clip (and its audio); a range adds edits; same angle heals', () => {
		const { h, mc, video } = placed();
		const len = h.seq.clips[video]!.duration;
		h.ok([{ type: 'multicam.switchAngle', at: 50, angle: 2 }]);
		expect(anglesOn(h, 'V1')).toEqual([[0, len, mc.angles[1]!.id]]);
		expect(anglesOn(h, 'A1')).toEqual([[0, len, mc.angles[1]!.id]]);
		h.ok([{ type: 'multicam.switchAngle', range: { from: 30, to: 60 }, angle: 'Camera 3' }]);
		expect(anglesOn(h, 'V1')).toEqual([
			[0, 30, mc.angles[1]!.id],
			[30, 60, mc.angles[2]!.id],
			[60, len, mc.angles[1]!.id],
		]);
		expect(anglesOn(h, 'A1')).toEqual(anglesOn(h, 'V1'));
		// switching the middle back heals both edits
		h.ok([{ type: 'multicam.switchAngle', range: { from: 30, to: 60 }, angle: 2 }]);
		expect(anglesOn(h, 'V1')).toEqual([[0, len, mc.angles[1]!.id]]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('a recording pass applies all cuts as one transaction; pressing the shown angle adds no edit', () => {
		const { h, mc, video } = placed();
		const len = h.seq.clips[video]!.duration;
		const before = h.revision;
		const r = h.ok([
			{
				type: 'multicam.record',
				cuts: [
					{ at: 10, angle: 2 },
					{ at: 40, angle: 3 },
					{ at: 70, angle: 3 },
					{ at: 90, angle: 1 },
					{ at: 90, angle: 2 },
				],
				to: 120,
			},
		]);
		expect(h.revision).toBe(before + 1);
		expect(anglesOn(h, 'V1')).toEqual([
			[0, 10, mc.angles[0]!.id],
			[10, 40, mc.angles[1]!.id],
			[40, 90, mc.angles[2]!.id],
			[90, 120, mc.angles[1]!.id],
			[120, len, mc.angles[0]!.id],
		]);
		expect((r.results[0] as { editPoints: number }).editPoints).toBe(4);
		// linked audio follows
		expect(anglesOn(h, 'A1')).toEqual(anglesOn(h, 'V1'));
		// video only
		h.ok([{ type: 'multicam.record', cuts: [{ at: 0, angle: 3 }], to: 10, audio: false }]);
		expect(anglesOn(h, 'V1')[0]).toEqual([0, 10, mc.angles[2]!.id]);
		expect(anglesOn(h, 'A1')[0]).toEqual([0, 10, mc.angles[0]!.id]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('every outer frame renders the angle the cuts selected (property check)', () => {
		const { h, mc } = placed();
		const src = h.doc.sequences[mc.angles.length ? Object.values(h.doc.sequences).find((s) => s.multicam)!.id : '']!;
		let seed = 7;
		const rnd = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let round = 0; round < 6; round++) {
			const cuts = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({
				at: Math.floor(rnd() * 200),
				angle: 1 + Math.floor(rnd() * 3),
			}));
			const to = 200 + Math.floor(rnd() * 40);
			h.ok([{ type: 'multicam.record', cuts, to }]);
			expect(checkInvariants(h.doc)).toEqual([]);
			const s = snap(h.doc, h.seqId);
			const layers = s.videoTracks.flatMap((t) => t.clips);
			for (let f = 0; f < 240; f += 3) {
				const outer = h.clips('V1').find((c) => c.start <= f && f < c.start + c.duration) as
					| (Clip & { multicam: { angle: string } })
					| undefined;
				const live = layers.filter((l) => l.start <= f && f < l.start + l.duration);
				if (!outer) continue;
				const angle = mc.angles.find((a) => a.id === outer.multicam.angle)!;
				const inner = Object.values(src.clips).find(
					(c) => c.trackId === angle.videoTrackId && c.start <= f && f < c.start + c.duration,
				);
				if (!inner) {
					expect(live).toHaveLength(0);
					continue;
				}
				expect(live).toHaveLength(1);
				expect((live[0]!.source as { mediaId: string }).mediaId).toBe((inner as { mediaId: string }).mediaId);
				expect(contentTimeAt(live[0]!, f, { num: 30, den: 1 })).toBe(contentTimeAt(inner, f, src.settings.frameRate));
			}
		}
	});

	it('camera numbers follow Edit Cameras: hidden angles are skipped, order and names change', () => {
		const { h, sequenceId, mc, video } = placed();
		h.ok([
			{
				type: 'multicam.editAngles',
				sequenceId,
				angles: [{ angle: 2, enabled: false }, { angle: mc.angles[0]!.id, name: 'Wide' }],
				order: [mc.angles[2]!.id, mc.angles[0]!.id, mc.angles[1]!.id],
			},
		]);
		const next = mcOf(h.doc, sequenceId);
		expect(next.angles.map((a) => a.name)).toEqual(['Camera 3', 'Wide', 'Camera 2']);
		// camera 2 is now "Wide" (camera 3 is hidden, so only two are shown)
		h.ok([{ type: 'multicam.switchAngle', clipIds: [video], angle: 2 }]);
		expect((h.seq.clips[video] as { multicam: { angle: string } }).multicam.angle).toBe(mc.angles[0]!.id);
		expect(h.tx([{ type: 'multicam.switchAngle', clipIds: [video], angle: 3 }]).ok).toBe(false);
		expect(h.tx([{ type: 'multicam.editAngles', sequenceId, order: [mc.angles[0]!.id] }]).ok).toBe(false);
	});
});

describe('Flatten', () => {
	it('replaces multi-camera clips by the angle’s clips and renders identically', () => {
		const { h, cams } = setup();
		const { sequenceId } = createMc(h, cams.map((c) => c.itemId), { audio: 'switch' });
		const { video } = placeMc(h, sequenceId, 5);
		h.ok([
			{ type: 'multicam.record', cuts: [{ at: 40, angle: 2 }, { at: 100, angle: 3 }], to: 160 },
			{ type: 'effect.add', target: { clipId: video }, effectId: 'jasper.gaussian-blur' },
		]);
		const before = snap(h.doc, h.seqId);
		const ids = h.clips('V1').map((c) => c.id);
		const r = h.ok([{ type: 'multicam.flatten', clipIds: ids }]);
		const after = snap(h.doc, h.seqId);
		expect(h.clips('V1').every((c) => c.kind === 'video')).toBe(true);
		expect(h.clips('A1').every((c) => c.kind === 'audio')).toBe(true);
		expect((r.results[0] as { clipIds: string[] }).clipIds.length).toBeGreaterThan(3);
		const strip = (s: RenderSnapshot) => ({
			video: s.videoTracks
				.flatMap((t) => t.clips)
				.map((l) => [l.start, l.duration, l.sourceIn, (l.source as { mediaId: string }).mediaId, l.effects.map((e) => e.effectId)]),
			audio: s.audioClips.map((a) => [a.start, a.duration, a.sourceIn, a.mediaId, a.gainDb]),
		});
		expect(strip(after)).toEqual(strip(before));
		// flattened video and audio of one camera stay linked
		for (const v of h.clips('V1')) {
			const partner = h.clips('A1').find((a) => a.start === v.start);
			expect(v.linkId).not.toBeNull();
			expect(partner?.linkId).toBe(v.linkId);
		}
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('Synchronize (timeline clips)', () => {
	it('aligns clips by In, timecode, clip marker or audio offsets; linked clips move together', () => {
		const h = new Harness();
		const a = register(h, { seconds: 20, tc: '01:00:00:00' });
		const b = register(h, { seconds: 20, tc: '01:00:02:10' });
		h.ok([
			{ type: 'clip.place', source: { mediaId: a.mediaId }, at: 0, tracks: { video: 'V1', audio: 'A1' } },
			{ type: 'clip.place', source: { mediaId: b.mediaId }, at: 400, tracks: { video: 'V2', audio: 'A2' } },
		]);
		const [va] = h.clips('V1');
		const [vb] = h.clips('V2');
		// timecode: b's content 0 shows TC 01:00:02:10 = a's content 2 s 10 f → b starts at frame 70
		const r = h.ok([{ type: 'clip.synchronize', clipIds: [va!.id, vb!.id], method: 'timecode' }]);
		expect(h.clips('V2')[0]!.start).toBe(70);
		expect(h.clips('A2')[0]!.start).toBe(70);
		expect((r.results[0] as { referenceClipId: string }).referenceClipId).toBe(va!.id);
		// clip markers
		h.ok([
			{ type: 'marker.add', clipId: va!.id, flicks: { seconds: 5 }, name: 'clap' },
			{ type: 'marker.add', clipId: vb!.id, flicks: { seconds: 1 }, name: 'clap' },
		]);
		h.ok([{ type: 'clip.synchronize', clipIds: [va!.id, vb!.id], method: 'marker', marker: 'clap' }]);
		expect(h.clips('V2')[0]!.start).toBe(120);
		// audio offsets with a sub-frame part: b's content t = a's t − 1.51 s → b starts at 1.51 s (45.3 frames)
		const off = -Math.round(1.51 * SEC);
		const ab = h.clips('A2')[0]!;
		const aa = h.clips('A1')[0]!;
		h.ok([
			{
				type: 'clip.synchronize',
				clipIds: [va!.id, vb!.id],
				method: 'audio',
				audioOffsets: { [ab.id]: off },
			},
		]);
		const nb = h.clips('A2')[0]!;
		expect(nb.start).toBe(46);
		// at frame 46, b plays content that coincides with a's: a(46) + off
		const at = 46 * F30;
		expect(Math.abs(nb.sourceIn - (aa.sourceIn + at + off))).toBeLessThanOrEqual(1);
		expect(h.clips('V2')[0]!.sourceIn).toBe(nb.sourceIn);
		// a reference on V2 moves V1 instead (and nothing may go before frame 0: everything shifts right)
		h.ok([{ type: 'clip.synchronize', clipIds: [va!.id, vb!.id], method: 'in', referenceTrack: 'V2' }]);
		expect(h.clips('V2')[0]!.start).toBe(46);
		expect(h.clips('V1')[0]!.start).toBe(46);
		expect(checkInvariants(h.doc)).toEqual([]);
		// a single source cannot be synchronized
		expect(h.tx([{ type: 'clip.synchronize', clipIds: [va!.id], method: 'in' }]).ok).toBe(false);
	});
});

describe('Merge Clips', () => {
	it('merges a video and external audio, removes the camera audio on request and places synced clips', () => {
		const h = new Harness();
		const v = register(h, { seconds: 10, name: 'Interview' });
		const rec = register(h, { seconds: 14, kind: 'audio', name: 'Lav' });
		h.ok([
			{ type: 'marker.add', itemId: v.itemId, flicks: { seconds: 2 }, name: 'slate' },
			{ type: 'marker.add', itemId: rec.itemId, flicks: { seconds: 5.5 }, name: 'slate' },
		]);
		const r = h.ok([
			{ type: 'item.mergeClips', itemIds: [rec.itemId, v.itemId], method: 'marker', removeVideoAudio: true },
		]);
		const res = r.results[0] as { itemId: string; sequenceId: string };
		expect(h.doc.items[res.itemId]).toMatchObject({ name: 'Interview - Merged', kind: 'sequence' });
		const merged = h.doc.sequences[res.sequenceId]!;
		expect(merged.merged).toEqual({ videoItemId: v.itemId, audioItemIds: [rec.itemId], sync: 'marker', removeVideoAudio: true });
		const clips = Object.values(merged.clips);
		expect(clips.map((c) => c.kind).sort()).toEqual(['audio', 'video']);
		const mv = clips.find((c) => c.kind === 'video')!;
		const ma = clips.find((c) => c.kind === 'audio')!;
		expect((ma as { mediaId: string }).mediaId).toBe(rec.mediaId);
		expect(mv.linkId).toBe(ma.linkId);
		// slate at video 2 s and audio 5.5 s coincide: audio starts 3.5 s = 105 frames before the video
		expect(mv.start - ma.start).toBe(105);
		// placed into the edit: linked video + audio at the same relative sync
		const p = h.ok([{ type: 'clip.place', source: { projectItemId: res.itemId }, at: 300 }]);
		const ids = (p.results[0] as { clipIds: string[] }).clipIds;
		const placed = ids.map((id) => h.seq.clips[id]!);
		const pv = placed.find((c) => c.kind === 'video')!;
		const pa = placed.find((c) => c.kind === 'audio')!;
		expect(pv.start - pa.start).toBe(105);
		expect(pa.start).toBe(300);
		expect(pv.linkId).not.toBeNull();
		expect(pv.linkId).toBe(pa.linkId);
		expect(checkInvariants(h.doc)).toEqual([]);
		// limits
		expect(h.tx([{ type: 'item.mergeClips', itemIds: [v.itemId, register(h).itemId], method: 'in' }]).ok).toBe(false);
	});

	it('keeps the camera audio by default and takes up to 16 audio clips', () => {
		const h = new Harness();
		const v = register(h, { seconds: 10 });
		const auds = Array.from({ length: 17 }, () => register(h, { seconds: 10, kind: 'audio' }));
		expect(
			h.tx([{ type: 'item.mergeClips', itemIds: [v.itemId, ...auds.map((a) => a.itemId)], method: 'in' }]).ok,
		).toBe(false);
		const r = h.ok([{ type: 'item.mergeClips', itemIds: [v.itemId, auds[0]!.itemId, auds[1]!.itemId], method: 'in' }]);
		const merged = h.doc.sequences[(r.results[0] as { sequenceId: string }).sequenceId]!;
		expect(Object.values(merged.clips).filter((c) => c.kind === 'audio')).toHaveLength(3);
	});
});

describe('invariants and repair', () => {
	it('removing an angle’s tracks prunes the angle and re-points clips; repair fixes hand-broken data', () => {
		const { h, cams } = setup();
		const { sequenceId } = createMc(h, cams.map((c) => c.itemId));
		const { video } = placeMc(h, sequenceId, 0);
		const mc = mcOf(h.doc, sequenceId);
		h.ok([{ type: 'multicam.switchAngle', clipIds: [video], angle: 3 }]);
		h.ok([
			{
				type: 'track.remove',
				sequenceId,
				trackIds: [mc.angles[2]!.videoTrackId!, mc.angles[2]!.audioTrackIds[0]!],
				force: true,
			},
		]);
		expect(mcOf(h.doc, sequenceId).angles).toHaveLength(2);
		expect((h.seq.clips[video] as { multicam: { angle: string } }).multicam.angle).toBe(mc.angles[0]!.id);
		expect(checkInvariants(h.doc)).toEqual([]);
		const broken = structuredClone(h.doc) as ProjectDocument;
		(broken.sequences[sequenceId] as Sequence).multicam!.angles[0]!.videoTrackId = 'trk_00000000000000ZZ';
		(broken.sequences[h.seqId]!.clips[video] as { multicam: { angle: string } }).multicam.angle = 'nope';
		const issues = checkInvariants(broken);
		expect(issues.some((i) => /missing video track/.test(i.message))).toBe(true);
		expect(issues.some((i) => /missing angle/.test(i.message))).toBe(true);
		const { document } = repairDocument(broken, createCounterIdSource(900));
		expect(checkInvariants(document).filter((i) => i.invariant === 'INV-006' || /angle|multi/i.test(i.message))).toEqual([]);
	});

	it('source clip markers live on media items', () => {
		const h = new Harness();
		const v = register(h);
		const r = h.ok([{ type: 'marker.add', itemId: v.itemId, flicks: { seconds: 1 }, name: 'a' }]);
		const id = (r.results[0] as { markerId: string }).markerId;
		h.ok([{ type: 'marker.update', markerId: id, name: 'b', flicks: { seconds: 2 } }]);
		expect((h.doc.items[v.itemId] as { markers: { name: string; flicks: number }[] }).markers).toMatchObject([
			{ name: 'b', flicks: 2 * SEC },
		]);
		expect(checkInvariants(h.doc)).toEqual([]);
		h.ok([{ type: 'marker.remove', markerIds: [id] }]);
		expect((h.doc.items[v.itemId] as { markers: unknown[] }).markers).toEqual([]);
	});
});
