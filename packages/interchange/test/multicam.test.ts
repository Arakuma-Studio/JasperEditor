// Multi-camera clips through every format: FCP7 multiclips, FCPXML mc-clips, OTIO metadata (with the inactive
// cameras' tracks disabled for other readers), and the angle's clips (Flatten) in EDL, AAF and OMF.
import {
	type Clip,
	checkInvariants,
	defaultRegistries,
	type MediaAsset,
	type MulticamSource,
	type ProjectDocument,
	resolveMulticamClip,
	type Sequence,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { videoAsset } from '../../project/test/helpers.ts';
import { exportTimeline, type Format, importTimeline } from '../src/index.ts';
import { Harness, withPath } from './support/rich.ts';

function multicamProject(audio: 'switch' | 'camera1' | 'all' = 'switch') {
	const h = new Harness({ preset: 'hd-1080p-30' });
	const cams = [
		['A Cam', 10, 2],
		['B Cam', 12, 3],
		['C Cam', 8, 1.5],
	].map(([name, seconds, mark]) => {
		const asset = withPath(videoAsset({ seconds: seconds as number }), `/footage/${name}.mov`) as MediaAsset;
		const r = h.ok([{ type: 'media.register', asset, name }]).results[0] as {
			mediaId: string;
			itemId: string;
		};
		h.ok([{ type: 'item.setMarks', itemId: r.itemId, in: { seconds: mark as number }, out: null }]);
		return r;
	});
	const mc = h.ok([
		{ type: 'multicam.create', itemIds: cams.map((c) => c.itemId), method: 'in', audio, name: 'Concert MC' },
	]).results[0] as { sequenceId: string };
	const r = h.ok([{ type: 'clip.place', source: { sequenceId: mc.sequenceId }, at: 0, sequenceId: h.seqId }]);
	const [video] = (r.results[0] as { clipIds: string[] }).clipIds as [string];
	h.ok([{ type: 'multicam.switchAngle', clipIds: [video], angle: 2 }]);
	h.ok([{ type: 'multicam.switchAngle', range: { from: 30, to: 60 }, angle: 3 }]);
	return { h, sourceId: mc.sequenceId };
}

const pathOf = (doc: ProjectDocument, mediaId: string) =>
	doc.media[mediaId]?.locators.find((l) => l.type === 'path')?.path ?? doc.media[mediaId]?.originalName;

/** What each clip of a track shows: [start, duration, media path, content time at its first frame (frames)]. */
function shown(doc: ProjectDocument, seqId: string, kind: 'video' | 'audio') {
	const s = doc.sequences[seqId]!;
	const rate = s.settings.frameRate;
	const F = 705_600_000 / (rate.num / rate.den);
	const track = (kind === 'video' ? s.videoTracks : s.audioTracks)[0]!;
	return (Object.values(s.clips) as Clip[])
		.filter((c) => c.trackId === track.id)
		.sort((a, b) => a.start - b.start)
		.flatMap((c) => {
			const r = resolveMulticamClip(doc, rate, c);
			if (r)
				return r.pieces
					.filter((p) => kind === 'video' || p.innerTrackId === r.pieces[0]!.innerTrackId)
					.map((p) => [
						p.start,
						p.duration,
						pathOf(doc, (p.inner as { mediaId: string }).mediaId),
						Math.round(p.sourceIn / F),
					]);
			const m = (c as { mediaId?: string }).mediaId;
			return [[c.start, c.duration, m ? pathOf(doc, m) : c.kind, Math.round(c.sourceIn / F)]];
		});
}

function roundTrip(format: Format, h: Harness) {
	const out = exportTimeline(h.doc, h.seqId, format);
	const imp = importTimeline(out.files[0]!.bytes, {
		format,
		now: '2026-10-07T00:00:00.000Z',
		rate: { num: 30, den: 1 },
	});
	const target = new Harness({ preset: 'hd-1080p-30', seed: 777 });
	const res = target.ok([{ type: 'project.importTimeline', fragment: imp }]).results[0] as {
		topSequenceIds: string[];
	};
	expect(checkInvariants(target.doc, { effects: defaultRegistries().effects })).toEqual([]);
	const text = new TextDecoder().decode(out.files[0]!.bytes);
	return { out, imp, target, seqId: res.topSequenceIds[0]!, text };
}

const multicamClips = (doc: ProjectDocument, seqId: string) =>
	(Object.values(doc.sequences[seqId]!.clips) as Clip[]).filter((c) => 'multicam' in c && c.multicam);

const angleNames = (doc: ProjectDocument, clip: Clip) => {
	const src = doc.sequences[(clip as { sequenceId: string }).sequenceId] as Sequence & {
		multicam: MulticamSource;
	};
	return src.multicam.angles.find((a) => a.id === (clip as { multicam: { angle: string } }).multicam.angle)
		?.name;
};

const cuts = (h: Harness) =>
	(Object.values(h.seq.clips) as Clip[])
		.filter((c) => c.kind === 'nest-video')
		.sort((a, b) => a.start - b.start)
		.map((c) => angleNames(h.doc, c));

describe('multi-camera clips', () => {
	it('round trip through FCP7 XML as multiclips (one per edit, the active camera marked)', () => {
		const { h } = multicamProject();
		const { target, seqId, text, out } = roundTrip('fcp7', h);
		expect(text.match(/<multiclip /g)?.length).toBe(6); // 3 video + 3 audio clip items
		expect(text).toContain('<synctype>1</synctype>');
		expect(text.match(/<sequence /g)?.length).toBe(1); // the source is not written as a sequence too
		expect(out.report.mentions('multi-camera')).toBe(false);
		expect(shown(target.doc, seqId, 'video')).toEqual(shown(h.doc, h.seqId, 'video'));
		expect(shown(target.doc, seqId, 'audio')).toEqual(shown(h.doc, h.seqId, 'audio'));
		const mc = multicamClips(target.doc, seqId);
		expect(mc.length).toBe(6);
		expect(
			mc
				.filter((c) => c.kind === 'nest-video')
				.sort((a, b) => a.start - b.start)
				.map((c) => angleNames(target.doc, c)),
		).toEqual(cuts(h));
		expect(new Set(mc.map((c) => (c as { sequenceId: string }).sequenceId)).size).toBe(1);
	});

	it('round trip through FCPXML as mc-clips of one multicam', () => {
		const { h } = multicamProject();
		const { target, seqId, text } = roundTrip('fcpxml', h);
		expect(text.match(/<multicam /g)?.length).toBe(1);
		expect(text.match(/<mc-angle /g)?.length).toBe(3);
		expect(text.match(/<mc-clip /g)?.length).toBe(3);
		expect(text).toContain('srcEnable="all"');
		expect(shown(target.doc, seqId, 'video')).toEqual(shown(h.doc, h.seqId, 'video'));
		expect(shown(target.doc, seqId, 'audio')).toEqual(shown(h.doc, h.seqId, 'audio'));
		expect(
			multicamClips(target.doc, seqId)
				.filter((c) => c.kind === 'nest-video')
				.sort((a, b) => a.start - b.start)
				.map((c) => angleNames(target.doc, c)),
		).toEqual(cuts(h));
	});

	it('round trip through OTIO exactly; other readers see only the active camera', () => {
		const { h, sourceId } = multicamProject();
		const { target, seqId, text } = roundTrip('otio', h);
		expect(shown(target.doc, seqId, 'video')).toEqual(shown(h.doc, h.seqId, 'video'));
		expect(shown(target.doc, seqId, 'audio')).toEqual(shown(h.doc, h.seqId, 'audio'));
		const src =
			target.doc.sequences[(multicamClips(target.doc, seqId)[0] as { sequenceId: string }).sequenceId]!;
		const orig = h.doc.sequences[sourceId]!;
		const norm = (s: Sequence) =>
			s.multicam!.angles.map((a) => [
				a.name,
				a.enabled,
				s.videoTracks.findIndex((t) => t.id === a.videoTrackId),
				a.audioTrackIds.map((id) => s.audioTracks.findIndex((t) => t.id === id)),
			]);
		expect(norm(src)).toEqual(norm(orig));
		expect(src.multicam!.audio).toBe('switch');
		expect(src.videoTracks.map((t) => t.output)).toEqual(orig.videoTracks.map((t) => t.output));
		// In the file: each multi-camera stack enables only its camera's video track.
		const json = JSON.parse(text);
		const v1 = json.tracks.children[0].children.filter(
			(c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA === 'Stack.1',
		);
		expect(v1.length).toBe(3);
		for (const st of v1) {
			const videoTracks = st.children.filter((t: { kind: string }) => t.kind === 'Video');
			expect(videoTracks.filter((t: { enabled: boolean }) => t.enabled).length).toBe(1);
		}
	});

	it('EDL, AAF and OMF write the active camera’s clips', () => {
		const { h } = multicamProject();
		for (const format of ['edl', 'aaf'] as const) {
			const { target, seqId, out } = roundTrip(format, h);
			expect(out.report.mentions('active angle')).toBe(true);
			const got = shown(target.doc, seqId, 'video');
			expect(got.map((x) => x[2])).toEqual([
				'/footage/B Cam.mov',
				'/footage/C Cam.mov',
				'/footage/B Cam.mov',
			]);
			expect(got).toEqual(shown(h.doc, h.seqId, 'video'));
			expect(multicamClips(target.doc, seqId)).toEqual([]);
		}
		const omf = roundTrip('omf', h);
		expect(shown(omf.target.doc, omf.seqId, 'audio').map((x) => x[2])).toEqual([
			'/footage/B Cam.mov',
			'/footage/C Cam.mov',
			'/footage/B Cam.mov',
		]);
	});

	it('FCP7 falls back to a nest showing the camera when an angle is not one clip; disabled clips are nests', () => {
		const { h, sourceId } = multicamProject('all');
		const src = h.doc.sequences[sourceId]!;
		const angleTrack = src.videoTracks[0]!.id;
		const inner = (Object.values(src.clips) as Clip[]).find((c) => c.trackId === angleTrack)!;
		h.ok([
			{
				type: 'clip.split',
				sequenceId: sourceId,
				at: { frames: inner.start + 20 },
				clipIds: [inner.id],
				linked: false,
			},
		]);
		const { target, seqId, text, out } = roundTrip('fcp7', h);
		expect(text).not.toContain('<multiclip');
		expect(out.report.mentions('nested sequence showing its angle')).toBe(true);
		expect(out.report.mentions('mixes every camera')).toBe(true);
		expect(text).toContain('<enabled>FALSE</enabled>');
		expect(shown(target.doc, seqId, 'video').length).toBe(3);
		const { h: h2 } = multicamProject();
		const clips = (Object.values(h2.seq.clips) as Clip[]).map((c) => c.id);
		h2.ok([{ type: 'multicam.setEnabled', clipIds: clips, enabled: false }]);
		const r2 = roundTrip('fcp7', h2);
		expect(r2.text).not.toContain('<multiclip');
		expect(r2.text).not.toMatch(/<track>(?:(?!<\/track>).)*<enabled>FALSE<\/enabled>/s);
	});
});
