import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	browserPictureNeed,
	buildRenderSnapshot,
	checkInvariants,
	FLICKS_PER_SECOND,
	fileFieldOrder,
	filePieces,
	fileTimeOf,
	interpretedFrameRate,
	type MediaAsset,
	type MediaHandle,
	mediaDisplaySize,
	mediaDurationFlicks,
	mediaFieldOrder,
	mediaLoaderPath,
	mediaPixelVariant,
	mediaTimeMap,
	mediaTimeScale,
	type PixelInterpretation,
	parsePixelVariant,
	pixelInterpretationFilters,
	pixelVariantKey,
	rationalFromFps,
	repairDocument,
	type VideoClip,
} from '../src/index.ts';
import { Harness, makeCtx, videoAsset } from './helpers.ts';

const S = FLICKS_PER_SECOND;

function asset(over: Partial<MediaAsset> = {}, opts: Parameters<typeof videoAsset>[0] = {}): MediaAsset {
	return { id: 'med_x', ...videoAsset(opts), ...over } as MediaAsset;
}

describe('interpretation model', () => {
	it('parses typed frame rates, NTSC as 1001 fractions', () => {
		expect(rationalFromFps(23.976)).toEqual({ num: 24000, den: 1001 });
		expect(rationalFromFps(29.97)).toEqual({ num: 30000, den: 1001 });
		expect(rationalFromFps(59.94)).toEqual({ num: 60000, den: 1001 });
		expect(rationalFromFps(25)).toEqual({ num: 25, den: 1 });
		expect(rationalFromFps(12.5)).toEqual({ num: 12500, den: 1000 });
		expect(rationalFromFps(0)).toBeNull();
		expect(rationalFromFps(Number.NaN)).toBeNull();
		expect(rationalFromFps(1001)).toBeNull();
	});

	it('an assumed frame rate scales the duration; a loop multiplies it', () => {
		const a = asset(
			{ interpretation: { frameRate: { num: 24, den: 1 } } },
			{ seconds: 10, fps: { num: 30, den: 1 } },
		);
		expect(interpretedFrameRate(a)).toEqual({ num: 24, den: 1 });
		expect(mediaTimeScale(a)).toBeCloseTo(0.8, 12);
		expect(mediaDurationFlicks(a)).toBe(Math.round((10 * S) / 0.8));
		const looped = asset({ interpretation: { frameRate: { num: 24, den: 1 }, loop: 3 } }, { seconds: 10 });
		expect(mediaDurationFlicks(looped)).toBe(3 * Math.round((10 * S) / 0.8));
		const still = asset({ interpretation: { loop: 3 } }, { kind: 'image' });
		expect(mediaDurationFlicks(still)).toBeNull();
		expect(mediaTimeMap(asset({}, { seconds: 4 }))).toBeNull();
	});

	it('display size follows the pixel aspect ratio and the rotation', () => {
		const dv = asset({}, { width: 720, height: 480 });
		(dv.probe.streams[0] as { pixelAspect: unknown }).pixelAspect = { num: 10, den: 11 };
		expect(mediaDisplaySize(dv)).toEqual({ width: 655, height: 480 });
		expect(mediaDisplaySize({ ...dv, interpretation: { pixelAspect: { num: 1, den: 1 } } })).toEqual({
			width: 720,
			height: 480,
		});
		const ana = asset({ interpretation: { pixelAspect: { num: 4, den: 3 } } }, { width: 1440, height: 1080 });
		expect(mediaDisplaySize(ana)).toEqual({ width: 1920, height: 1080 });
		const rotated = asset(
			{ interpretation: { pixelAspect: { num: 2, den: 1 } } },
			{ width: 100, height: 50, rotation: 90 },
		);
		expect(mediaDisplaySize(rotated)).toEqual({ width: 50, height: 200 });
	});

	it('maps ffprobe field orders and lets the interpretation override them', () => {
		const a = asset();
		for (const [fo, want] of [
			['tt', 'upper'],
			['tb', 'upper'],
			['bb', 'lower'],
			['bt', 'lower'],
			['progressive', 'progressive'],
		] as const) {
			(a.probe.streams[0] as { fieldOrder?: string }).fieldOrder = fo;
			expect(fileFieldOrder(a)).toBe(want);
		}
		(a.probe.streams[0] as { fieldOrder?: string }).fieldOrder = 'tt';
		expect(mediaFieldOrder({ ...a, interpretation: { fieldOrder: 'progressive' } })).toBe('progressive');
		expect(mediaPixelVariant(a)).toBe('fo=upper');
	});

	it('pixel variant keys preserve interpretation and safely parse arbitrary text (properties)', () => {
		const unit = fc.integer({ min: 0, max: 255 }).map((v) => v / 255);
		const interp: fc.Arbitrary<PixelInterpretation> = fc.record(
			{
				deinterlace: fc.constantFrom('upper' as const, 'lower' as const),
				alpha: fc.record({
					mode: fc.constantFrom('straight' as const, 'premultiplied' as const, 'ignore' as const),
					matte: fc.tuple(unit, unit, unit),
					invert: fc.boolean(),
				}),
			},
			{ requiredKeys: [] },
		);
		fc.assert(
			fc.property(interp, (p) => {
				const back = parsePixelVariant(pixelVariantKey(p));
				expect(back?.deinterlace ?? null).toBe(p.deinterlace ?? null);
				expect(back?.alpha?.mode ?? 'straight').toBe(p.alpha?.mode ?? 'straight');
				expect(back?.alpha?.invert ?? false).toBe(p.alpha?.invert ?? false);
				if (p.alpha?.mode === 'premultiplied') expect(back?.alpha?.matte).toEqual(p.alpha.matte);
			}),
		);
		fc.assert(
			fc.property(fc.string({ maxLength: 256 }), (text) => {
				const parsed = parsePixelVariant(text);
				if (parsed === null) return;
				expect(parsed).toBeTypeOf('object');
				expect(Array.isArray(parsed)).toBe(false);
				expect([undefined, 'upper', 'lower']).toContain(parsed.deinterlace);
				if (parsed.alpha !== undefined) {
					expect(['straight', 'premultiplied', 'ignore']).toContain(parsed.alpha.mode);
					expect(parsed.alpha.invert).toBeTypeOf('boolean');
					expect(parsed.alpha.matte).toHaveLength(3);
					for (const channel of parsed.alpha.matte)
						expect(Number.isFinite(channel) && channel >= 0 && channel <= 1).toBe(true);
				}
			}),
			{ examples: [['fo=upper'], ['a=premultiplied;m=ff0080;inv=1']] },
		);
		expect(parsePixelVariant('fo=upper;fo=lower')).toBeNull();
		expect(parsePixelVariant('a=premultiplied;m=zzzzzz')).toBeNull();
	});

	it('builds LGPL-only ffmpeg filters for each pixel interpretation', () => {
		const GPL =
			/\b(eq|hqdn3d|perspective|boxblur|smartblur|delogo|frei0r|spp|pp7|uspp|fspp|mpdecimate|pullup|vidstab\w*)\b/;
		const cases: PixelInterpretation[] = [
			{ deinterlace: 'upper' },
			{ deinterlace: 'lower', alpha: { mode: 'ignore', matte: [0, 0, 0], invert: false } },
			{ alpha: { mode: 'premultiplied', matte: [0, 0, 0], invert: true } },
			{ alpha: { mode: 'premultiplied', matte: [1, 1, 1], invert: false } },
		];
		const all = cases.map(pixelInterpretationFilters);
		expect(all[0]).toEqual(['bwdif=mode=send_frame:parity=tff:deint=all']);
		expect(all[1]).toEqual(['bwdif=mode=send_frame:parity=bff:deint=all', 'format=rgba', 'lutrgb=a=maxval']);
		expect(all[2]).toEqual(['format=rgba', 'unpremultiply=inplace=1', 'lutrgb=a=negval']);
		expect(all[3]![1]).toMatch(/^geq=/);
		for (const f of all.flat()) expect(f.split('=')[0]).not.toMatch(GPL);
		expect(pixelInterpretationFilters(null)).toEqual([]);
	});

	it('file time pieces cover a range exactly and agree with fileTimeOf (property)', () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0.1, max: 10, noNaN: true }),
				fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: undefined }),
				fc.integer({ min: 0, max: 100_000 }),
				fc.integer({ min: 1, max: 50_000 }),
				(scale, period, t0, len) => {
					const map = { scale, ...(period ? { period } : {}) };
					const pieces = filePieces(map, t0, t0 + len);
					expect(pieces[0]!.from).toBe(t0);
					// At most 4096 pieces (longer ranges are cut).
					if (pieces.length < 4096) expect(pieces.at(-1)!.to).toBe(t0 + len);
					for (let i = 0; i < pieces.length; i++) {
						const p = pieces[i]!;
						if (i) expect(p.from).toBe(pieces[i - 1]!.to);
						expect(p.fileTo - p.fileFrom).toBeCloseTo((p.to - p.from) * scale, 6);
						expect(p.fileFrom).toBeCloseTo(fileTimeOf(map, p.from), 6);
						if (period) expect(p.fileTo).toBeLessThanOrEqual(period * scale + 1e-6);
					}
				},
			),
		);
		expect(fileTimeOf(null, 123)).toBe(123);
		expect(fileTimeOf({ scale: 2, period: 10 }, 25)).toBe(10);
		expect(fileTimeOf({ scale: 1, period: 10 }, -3)).toBe(7);
	});

	it('says what a browser needs to show the asset', () => {
		const exr = asset({}, { kind: 'image' });
		(exr.probe.streams[0] as { browserDecodable: boolean }).browserDecodable = false;
		expect(browserPictureNeed(exr)).toEqual({ loader: null, picture: 'display', variant: '' });
		const premul = asset({ interpretation: { alpha: { mode: 'premultiplied' } } }, { kind: 'image' });
		expect(browserPictureNeed(premul).picture).toBe('display');
		const inter = asset({ interpretation: { fieldOrder: 'upper' } });
		expect(browserPictureNeed(inter)).toEqual({ loader: null, picture: 'proxy', variant: 'fo=upper' });
		const lottie = asset(
			{ lottie: { fps: 30, inFrame: 0, outFrame: 60, width: 100, height: 100 } },
			{ kind: 'animated-image' },
		);
		expect(browserPictureNeed(lottie).loader).toBe('lottie');
		expect(mediaLoaderPath(lottie)).toBe(
			`/media/${lottie.locators[0]!.type === 'engine-store' ? lottie.locators[0]!.key : ''}/lottie.json`,
		);
		const svg = asset({ vector: { format: 'svg', width: 10, height: 10 } }, { kind: 'image' });
		expect(mediaLoaderPath(svg)).toMatch(/\/vector$/);
		expect(mediaLoaderPath(asset())).toBeNull();
	});
});

describe('media.interpret', () => {
	function placed(seconds = 10, outSec = 10) {
		const h = new Harness();
		const m = h.registerVideo({ seconds, audio: false });
		const r = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				tracks: { video: 'V1' },
				sourceRange: { in: { seconds: 0 }, out: { seconds: outSec } },
			},
		]);
		const v = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
		return { h, m, v };
	}

	it('sets, resets and normalises sections; the previous document is untouched (undo)', () => {
		const { h, m } = placed();
		const before = h.doc;
		h.ok([
			{
				type: 'media.interpret',
				mediaIds: [m],
				interpretation: { frameRate: { num: 60, den: 1 }, pixelAspect: { num: 2, den: 1 }, loop: 1 },
			},
		]);
		expect(h.doc.media[m]!.interpretation).toEqual({
			frameRate: { num: 60, den: 1 },
			pixelAspect: { num: 2, den: 1 },
		});
		expect(before.media[m]!.interpretation).toBeUndefined();
		h.ok([
			{
				type: 'media.interpret',
				mediaIds: [m],
				interpretation: { pixelAspect: null, alpha: { mode: 'straight' } },
			},
		]);
		expect(h.doc.media[m]!.interpretation).toEqual({ frameRate: { num: 60, den: 1 } });
		h.ok([{ type: 'media.interpret', mediaIds: [m], interpretation: { frameRate: null } }]);
		expect(h.doc.media[m]!.interpretation).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
		h.doc = before;
		h.ok([{ type: 'media.interpret', mediaIds: [m], interpretation: { loop: 2 } }]);
		expect(mediaDurationFlicks(h.doc.media[m]!)).toBe(20 * S);
	});

	it('a faster assumed rate shortens the media and trims the clip with a warning', () => {
		const { h, m, v } = placed(10, 10);
		expect(h.seq.clips[v]!.duration).toBe(300);
		const r = h.ok([
			{ type: 'media.interpret', mediaIds: [m], interpretation: { frameRate: { num: 60, den: 1 } } },
		]);
		expect(r.warnings.map((w) => w.code)).toContain('W_CLIPS_TRIMMED');
		expect(h.seq.clips[v]!.duration).toBe(150);
		expect((r.results[0] as { trimmedClipIds: string[] }).trimmedClipIds).toEqual([v]);
		expect(checkInvariants(h.doc)).toEqual([]);
		h.ok([{ type: 'media.interpret', mediaIds: [m], interpretation: { frameRate: { num: 15, den: 1 } } }]);
		expect(h.seq.clips[v]!.duration).toBe(150);
		expect(h.tx([{ type: 'clip.trim', clipId: v, edge: 'out', deltaFrames: 450 }]).ok).toBe(true);
		expect(h.seq.clips[v]!.duration).toBe(600);
	});

	it('refuses what the media cannot carry and clips past the new end', () => {
		const h = new Harness();
		const still = h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image' }) }]).results[0] as {
			mediaId: string;
		};
		const bad = (interpretation: Record<string, unknown>, id = still.mediaId) =>
			h.tx([{ type: 'media.interpret', mediaIds: [id], interpretation }]);
		expect(bad({ frameRate: { num: 24, den: 1 } }).ok).toBe(false);
		expect(bad({ loop: 2 }).ok).toBe(false);
		expect(bad({ pixelAspect: { num: 1, den: 100 } }).ok).toBe(false);
		expect(bad({ loop: 2 }, 'med_missing').ok).toBe(false);
		expect(bad({ bogus: 1 }).ok).toBe(false);
		expect(bad({ alpha: { mode: 'ignore' } }).ok).toBe(true);
		const p = placed(10, 10);
		p.h.ok([{ type: 'clip.trim', clipId: p.v, edge: 'in', deltaFrames: 200 }]);
		const r = p.h.tx([
			{ type: 'media.interpret', mediaIds: [p.m], interpretation: { frameRate: { num: 120, den: 1 } } },
		]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
	});

	it('repair drops interpretation sections the media cannot carry', () => {
		const h = new Harness();
		const id = (
			h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image' }) }]).results[0] as {
				mediaId: string;
			}
		).mediaId;
		const doc = structuredClone(h.doc);
		(doc.media[id] as MediaAsset).interpretation = {
			frameRate: { num: 24, den: 1 },
			pixelAspect: { num: 2, den: 1 },
		};
		expect(checkInvariants(doc).some((i) => (i as { invariant?: string }).invariant === 'INV-012')).toBe(
			true,
		);
		const fixed = repairDocument(doc, makeCtx().ids);
		expect(checkInvariants(fixed.document)).toEqual([]);
		expect(fixed.document.media[id]!.interpretation).toEqual({ pixelAspect: { num: 2, den: 1 } });
	});

	it('the render snapshot carries the time map, the retime and the interpreted handle', () => {
		const { h, m, v } = placed(10, 10);
		const resolve = (a: MediaAsset): MediaHandle => ({
			url: `/media/${a.id}`,
			proxyUrl: null,
			kind: a.kind,
			width: 1920,
			height: 1080,
			durationFlicks: a.probe.durationFlicks,
			hasAudio: false,
			rotation: 0,
		});
		const plain = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: resolve, resolveFont: () => null });
		const c0 = plain.videoTracks[0]!.clips[0] as { mediaTime?: unknown; retime?: unknown };
		expect(c0.mediaTime).toBeUndefined();
		expect(c0.retime).toBeUndefined();
		h.ok([
			{
				type: 'media.interpret',
				mediaIds: [m],
				interpretation: {
					frameRate: { num: 15, den: 1 },
					fieldOrder: 'upper',
					pixelAspect: { num: 2, den: 1 },
				},
			},
		]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: resolve, resolveFont: () => null });
		const c1 = snap.videoTracks[0]!.clips[0] as {
			mediaTime?: { scale: number };
			retime?: { mediaRate: unknown };
		};
		expect(c1.mediaTime).toEqual({ scale: 0.5 });
		expect(c1.retime?.mediaRate).toEqual({ num: 30, den: 1 });
		const handle = snap.media[m]!;
		expect(handle.width).toBe(3840);
		expect(handle.pixelVariant).toBe('fo=upper');
		expect(handle.browserDecodable).toBe(false);
		expect((h.seq.clips[v] as VideoClip).kind).toBe('video');
	});
});
