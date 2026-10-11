// Time Remapping and Time Interpolation use FCPXML `timeMap`
// (multi-point, smooth pieces, frameSampling), FCP7 Time Remap `graphdict`, OTIO metadata — and the formats that
// cannot carry variable speed (reported, or pre-rendered).
import {
	type Clip,
	checkInvariants,
	clipMediaTimeAt,
	defaultRegistries,
	RATES,
	type TimedClip,
	timeInterpolationOf,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { videoAsset } from '../../project/test/helpers.ts';
import { exportTimeline, type Format, importTimeline, planPrerender } from '../src/index.ts';
import { Harness, withPath } from './support/rich.ts';

function remapped() {
	const h = new Harness({ preset: 'hd-1080p-30' });
	const m = (
		h.ok([
			{
				type: 'media.register',
				asset: withPath(videoAsset({ seconds: 20 }), '/footage/run.mov'),
				name: 'run',
			},
		]).results[0] as { mediaId: string }
	).mediaId;
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 12,
			tracks: { video: 'V1' },
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 150 } },
		},
	]);
	const v = (r.results[0] as { clipIds: string[] }).clipIds.find((id) => h.seq.clips[id]!.kind === 'video')!;
	h.ok([{ type: 'timeRemap.addKeyframe', clipId: v, at: 42 }]);
	h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 50, speedPercent: 50, ripple: true }]);
	const k = h.ok([{ type: 'timeRemap.addKeyframe', clipId: v, at: 80 }]).results[0] as { keyframeId: string };
	h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 100, speedPercent: 200 }]);
	h.ok([{ type: 'timeRemap.setTransition', clipId: v, keyframeId: k.keyframeId, frames: 8 }]);
	h.ok([{ type: 'clip.setTimeInterpolation', clipIds: [v], mode: 'optical-flow' }]);
	return { h, v };
}

function roundTrip(format: Format) {
	const { h, v } = remapped();
	const out = exportTimeline(h.doc, h.seqId, format);
	const imp = importTimeline(out.files[0]!.bytes, {
		format,
		now: '2026-10-07T00:00:00.000Z',
		rate: { num: 30, den: 1 },
	});
	const target = new Harness({ preset: 'hd-1080p-30', seed: 999 });
	const r = target.ok([{ type: 'project.importTimeline', fragment: imp }]);
	expect(checkInvariants(target.doc, { effects: defaultRegistries().effects })).toEqual([]);
	const seqId = (r.results[0] as { topSequenceIds: string[] }).topSequenceIds[0]!;
	const seq = target.doc.sequences[seqId]!;
	const back = Object.values(seq.clips).find((c) => c.kind === 'video') as Clip;
	return { h, v, out, back };
}

/** Media frame (30 fps) shown at each frame of a clip. */
function frames(c: Clip): number[] {
	const out: number[] = [];
	for (let f = c.start; f < c.start + c.duration; f++)
		out.push(Math.round((clipMediaTimeAt(c as TimedClip, f, RATES.r30) / 705_600_000) * 30 * 100) / 100);
	return out;
}

describe('time remapping through interchange', () => {
	for (const format of ['fcpxml', 'fcp7', 'otio'] as const)
		it(`${format}: the same media frame at every frame, Optical Flow kept`, () => {
			const { h, v, back } = roundTrip(format);
			const src = h.seq.clips[v] as Clip;
			expect(back.start).toBe(src.start);
			expect(back.duration).toBe(src.duration);
			const a = frames(src);
			const b = frames(back);
			expect(b.length).toBe(a.length);
			for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!), `frame ${i}`).toBeLessThan(0.02);
			// FCP7 XML only has a frame blending switch.
			expect(timeInterpolationOf(back as TimedClip)).toBe(
				format === 'fcp7' ? 'frame-blending' : 'optical-flow',
			);
		});

	it('FCPXML writes a multi-point timeMap with a smooth piece and frameSampling', () => {
		const { h } = remapped();
		const xml = new TextDecoder().decode(exportTimeline(h.doc, h.seqId, 'fcpxml').files[0]!.bytes);
		const tm = /<timeMap frameSampling="optical-flow">([\s\S]*?)<\/timeMap>/.exec(xml);
		expect(tm).not.toBeNull();
		expect((tm![1]!.match(/<timept/g) ?? []).length).toBeGreaterThan(3);
		expect(tm![1]).toContain('interp="smooth2"');
	});

	it('EDL cannot carry variable speed: reported (or pre-rendered)', () => {
		const { h, v } = remapped();
		const out = exportTimeline(h.doc, h.seqId, 'edl');
		expect(out.report.entries.some((e) => /time remapping/.test(e.message))).toBe(true);
		expect(planPrerender(h.doc, h.seqId, 'edl', 'unsupported').map((p) => p.clipId)).toContain(v);
	});
});
