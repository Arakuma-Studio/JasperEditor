// spec 18 AF-OPS-001: media.derive for the derivation ops (conform-cfr, reverse, denoise-audio, extract-audio,
// time-stretch, range) and the shared recipe checks.
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	DERIVE_OPS,
	type DeriveRecipe,
	derivedKind,
	deriveProblems,
	FLICKS_PER_SECOND,
	type NativeRecipe,
	NativeRecipeSchema,
	rangeFrames,
	type VideoClip,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

let n = 0;
/** What the engine sends for a derived file: RegisteredMedia fields + recipe version/hash. */
function derivedAsset(opts: Parameters<typeof videoAsset>[0] & { hash?: string }) {
	const { kind: _k, derivation: _d, importedAt: _i, id: _id, ...rest } = videoAsset(opts);
	return { ...rest, recipeVersion: 1, recipeHash: opts.hash ?? `d${(++n).toString(16).padStart(15, '0')}` };
}

const flicks = (sec: number) => Math.round(sec * FLICKS_PER_SECOND);

function setup(kind: 'video' | 'audio' = 'video') {
	const h = new Harness();
	const r = h.ok([
		{
			type: 'media.register',
			asset: videoAsset({ seconds: 10, kind }),
			name: 'crudo',
			ref: '$m',
			itemRef: '$i',
		},
	]);
	h.ok([{ type: 'clip.place', source: { mediaId: r.refs.$m }, at: 0 }]);
	return { h, mediaId: r.refs.$m!, itemId: r.refs.$i! };
}

describe('derivation recipes (shared checks)', () => {
	it('every derive op is a NativeRecipe op', () => {
		const samples: Record<(typeof DERIVE_OPS)[number], NativeRecipe> = {
			'conform-cfr': { op: 'conform-cfr', frameRate: { num: 25, den: 1 } },
			reverse: { op: 'reverse' },
			'denoise-audio': { op: 'denoise-audio', strength: 0.5 },
			'extract-audio': { op: 'extract-audio', streamIndex: 1, format: 'wav' },
			'time-stretch': { op: 'time-stretch', rate: 2, preservePitch: true },
			range: { op: 'range', inFlicks: 0, outFlicks: flicks(1) },
		};
		for (const op of DERIVE_OPS) expect(NativeRecipeSchema.safeParse(samples[op]).success).toBe(true);
	});

	it('rangeFrames keeps the frames starting in [in, out), exactly at NTSC rates', () => {
		expect(rangeFrames({ inFlicks: flicks(1), outFlicks: flicks(2) }, { num: 30, den: 1 })).toEqual({
			startFrame: 30,
			endFrame: 60,
		});
		// a hair after a frame start: that frame starts before In and is not kept
		expect(rangeFrames({ inFlicks: flicks(1) + 1, outFlicks: flicks(2) + 1 }, { num: 30, den: 1 })).toEqual({
			startFrame: 31,
			endFrame: 61,
		});
		// 29.97: frame 1001 starts at exactly 1001·1001/30000 s = 33.4334 s
		const f1001 = (1001 * 1001 * FLICKS_PER_SECOND) / 30000;
		expect(Number.isInteger(f1001)).toBe(true);
		expect(rangeFrames({ inFlicks: f1001, outFlicks: f1001 + 1 }, { num: 30000, den: 1001 })).toEqual({
			startFrame: 1001,
			endFrame: 1002,
		});
		// ten hours at 29.97 stays exact (BigInt)
		const tenHours = flicks(36_000);
		expect(rangeFrames({ inFlicks: 0, outFlicks: tenHours }, { num: 30000, den: 1001 }).endFrame).toBe(
			Math.ceil((36_000 * 30000) / 1001),
		);
	});

	it('deriveProblems refuses with the engine codes', () => {
		const video = videoAsset({ seconds: 10 }) as never;
		const silent = videoAsset({ seconds: 10, audio: false }) as never;
		const audio = videoAsset({ seconds: 10, kind: 'audio' }) as never;
		const codes = (src: never, r: DeriveRecipe) => deriveProblems(src, r).map((p) => p.code);
		expect(codes(video, { op: 'conform-cfr', frameRate: { num: 30000, den: 1001 } })).toEqual([]);
		expect(codes(video, { op: 'conform-cfr', frameRate: { num: 500, den: 1 } })).toEqual([
			'UNSUPPORTED_RATE',
		]);
		expect(codes(audio, { op: 'conform-cfr', frameRate: { num: 25, den: 1 } })).toEqual([
			'UNSUPPORTED_MEDIA',
		]);
		expect(codes(silent, { op: 'denoise-audio', strength: 0.5 })).toEqual(['NO_AUDIO']);
		expect(codes(video, { op: 'denoise-audio', strength: 2 })).toEqual(['INVALID_PARAM']);
		expect(codes(video, { op: 'extract-audio', streamIndex: 0, format: 'flac' })).toEqual(['NO_AUDIO']);
		expect(codes(video, { op: 'extract-audio', streamIndex: 1, format: 'flac' })).toEqual([]);
		expect(codes(video, { op: 'time-stretch', rate: 8, preservePitch: true })).toEqual(['UNSUPPORTED_RATE']);
		expect(codes(video, { op: 'time-stretch', rate: 0.25, preservePitch: false })).toEqual([]);
		expect(codes(video, { op: 'range', inFlicks: flicks(2), outFlicks: flicks(11) })).toEqual([
			'OUT_OF_RANGE',
		]);
		expect(codes(video, { op: 'range', inFlicks: flicks(3), outFlicks: flicks(2) })).toEqual(['EMPTY_RANGE']);
		// shorter than one frame and holding no frame start
		expect(codes(video, { op: 'range', inFlicks: flicks(1) + 1, outFlicks: flicks(1) + 1000 })).toEqual([
			'EMPTY_RANGE',
		]);
		expect(codes(audio, { op: 'range', inFlicks: flicks(1) + 1, outFlicks: flicks(1) + 1000 })).toEqual([]);
	});
});

describe('media.derive with derivation ops (AF-OPS-001)', () => {
	it.each([
		['conform-cfr', { op: 'conform-cfr', frameRate: { num: 25, den: 1 } }, 'video'],
		['reverse', { op: 'reverse' }, 'video'],
		['time-stretch', { op: 'time-stretch', rate: 2, preservePitch: true }, 'video'],
		['denoise-audio', { op: 'denoise-audio', strength: 0.4 }, 'audio'],
		['extract-audio', { op: 'extract-audio', streamIndex: 1, format: 'flac' }, 'audio'],
	] as const)('%s registers a %s asset with its derivation in the Processed bin', (_op, recipe, kind) => {
		const { h, mediaId } = setup();
		const before = h.doc;
		const asset = derivedAsset({ seconds: 5, kind });
		const r = h.ok([{ type: 'media.derive', fromMediaId: mediaId, recipe, asset }]);
		const res = r.results[0] as { mediaId: string; itemId: string };
		const m = h.doc.media[res.mediaId]!;
		expect(m.kind).toBe(kind);
		expect(m.kind).toBe(derivedKind(recipe.op, 'video'));
		expect(m.derivation).toEqual({
			fromMediaId: mediaId,
			recipe,
			recipeVersion: 1,
			recipeHash: asset.recipeHash,
		});
		expect(m.sourceRange).toBeUndefined();
		expect(h.doc.items[res.itemId]!.name).toMatch(/^crudo \[/);
		expect(checkInvariants(h.doc)).toEqual([]);
		// the previous document is untouched (undo restores it)
		expect(before.media[res.mediaId]).toBeUndefined();
		// idempotent: the same recipe of the same source is registered once
		const again = h.ok([{ type: 'media.derive', fromMediaId: mediaId, recipe, asset }]);
		expect((again.results[0] as { deduped: boolean }).deduped).toBe(true);
	});

	it('timing ops keep an audio source audio; conform-cfr refuses audio', () => {
		const { h, mediaId } = setup('audio');
		const r = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'reverse' },
				asset: derivedAsset({ seconds: 10, kind: 'audio' }),
			},
		]);
		expect(h.doc.media[(r.results[0] as { mediaId: string }).mediaId]!.kind).toBe('audio');
		const bad = h.tx([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'conform-cfr', frameRate: { num: 25, den: 1 } },
				asset: derivedAsset({ seconds: 10 }),
			},
		]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.message).toContain('conform-cfr needs video media');
	});

	it('refuses recipes the engine would refuse (out-of-range range, bad stream, unsupported rate)', () => {
		const { h, mediaId } = setup();
		const run = (recipe: unknown) =>
			h.tx([{ type: 'media.derive', fromMediaId: mediaId, recipe, asset: derivedAsset({ seconds: 2 }) }]);
		const code = (r: ReturnType<typeof run>) => (r.ok ? 'ok' : r.errors[0]!.code);
		expect(code(run({ op: 'range', inFlicks: flicks(9), outFlicks: flicks(12) }))).toBe('E_OUT_OF_MEDIA');
		expect(code(run({ op: 'range', inFlicks: flicks(3), outFlicks: flicks(3) }))).toBe('E_INVALID_PARAM');
		expect(code(run({ op: 'extract-audio', streamIndex: 0, format: 'wav' }))).toBe('E_INVALID_PARAM');
		expect(code(run({ op: 'time-stretch', rate: 10, preservePitch: true }))).toBe('E_INVALID_PARAM');
	});

	it('a range of a video records its source frames: clips switch to it keeping their source frames', () => {
		const { h, mediaId } = setup();
		const videoId = h.clips('V1')[0]!.id;
		// Trim the clip to source frames 60..120 (2 s … 4 s at 30 fps).
		h.ok([{ type: 'clip.trim', clipId: videoId, edge: 'in', deltaFrames: 60 }]);
		h.ok([{ type: 'clip.trim', clipId: videoId, edge: 'out', deltaFrames: -180 }]);
		const clip0 = h.seq.clips[videoId] as VideoClip;
		const recipe = { op: 'range', inFlicks: flicks(1), outFlicks: flicks(5) } as const;
		const r = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe,
				asset: derivedAsset({ seconds: 4 }),
				replaceInClips: [videoId],
			},
		]);
		const res = r.results[0] as { mediaId: string; itemId: string; clipIds: string[] };
		const m = h.doc.media[res.mediaId]!;
		expect(m.sourceRange).toMatchObject({ mediaId, firstFrame: 30, frames: 120, origin: 'process' });
		expect(h.doc.items[res.itemId]!.name).toBe('crudo [Range · frames 30–149]');
		expect(res.clipIds).toEqual([videoId]);
		const clip = h.seq.clips[videoId] as VideoClip;
		expect(clip.mediaId).toBe(res.mediaId);
		// the clip shows the same source frames: its in-point moved back by the 30 frames the file skips
		expect(clip.sourceIn).toBe(clip0.sourceIn - 30 * (FLICKS_PER_SECOND / 30));
		expect(clip.start).toBe(clip0.start);
		expect(clip.duration).toBe(clip0.duration);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('a range whose file frames disagree with the recipe is refused', () => {
		const { h, mediaId } = setup();
		const r = h.tx([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'range', inFlicks: flicks(1), outFlicks: flicks(5) },
				asset: derivedAsset({ seconds: 2 }),
			},
		]);
		expect(r.ok).toBe(false);
	});

	it('denoised audio can replace the source in audio clips; extracted audio and reversed media cannot', () => {
		const { h, mediaId } = setup();
		const audioId = h.clips('A1')[0]!.id;
		const videoId = h.clips('V1')[0]!.id;
		const r = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'denoise-audio', strength: 0.5 },
				asset: derivedAsset({ seconds: 10, kind: 'audio' }),
				replaceInClips: [audioId],
			},
		]);
		const res = r.results[0] as { mediaId: string; clipIds: string[] };
		expect(res.clipIds).toEqual([audioId]);
		expect((h.seq.clips[audioId] as { mediaId: string }).mediaId).toBe(res.mediaId);
		const ex = h.tx([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'extract-audio', streamIndex: 1, format: 'wav' },
				asset: derivedAsset({ seconds: 10, kind: 'audio' }),
				replaceInClips: [audioId],
			},
		]);
		expect(ex.ok).toBe(false);
		const rev = h.tx([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'reverse' },
				asset: derivedAsset({ seconds: 10 }),
				replaceInClips: [videoId],
			},
		]);
		expect(rev.ok).toBe(false);
		if (!rev.ok) expect(rev.errors[0]!.message).toContain('not a processed version');
	});
});

describe('audio versions replace only clips that play the processed stream', () => {
	/** A camera file with two audio streams (1: camera mic, 2: lav); A1's clip plays stream `clipStream`. */
	function twoStreams(clipStream: number) {
		const h = new Harness();
		const asset = videoAsset({ seconds: 10 });
		asset.probe.streams.push({
			index: 2,
			type: 'audio',
			codec: 'aac',
			sampleRate: 48000,
			channels: 1,
			channelLayout: 'mono',
		});
		const r = h.ok([{ type: 'media.register', asset, ref: '$m' }]);
		h.ok([{ type: 'clip.place', source: { mediaId: r.refs.$m }, at: 0 }]);
		const audioId = h.clips('A1')[0]!.id;
		const copy = JSON.parse(JSON.stringify(h.doc)) as typeof h.doc;
		const clip = copy.sequences[h.seqId]!.clips[audioId] as {
			channels: { streamIndex: number; map: number[] };
		};
		clip.channels = { streamIndex: clipStream, map: [0] };
		h.doc = copy;
		return { h, mediaId: r.refs.$m!, audioId };
	}

	it.each([
		['denoise-audio', { op: 'denoise-audio', strength: 0.5 }],
		['loudness-normalize', { op: 'loudness-normalize', targetLufs: -16, truePeakDb: -1 }],
	] as const)('%s refuses a clip that plays another audio stream, naming it', (_op, recipe) => {
		const { h, mediaId, audioId } = twoStreams(2);
		const r = h.tx([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe,
				asset: derivedAsset({ seconds: 10, kind: 'audio' }),
				replaceInClips: [audioId],
			},
		]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
			expect(r.errors[0]!.message).toContain(audioId);
			expect(r.errors[0]!.message).toContain('stream 2');
		}
		expect((h.seq.clips[audioId] as { mediaId: string }).mediaId).toBe(mediaId);
	});

	it('a clip playing the processed (first) audio stream switches', () => {
		const { h, mediaId, audioId } = twoStreams(1);
		const r = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'denoise-audio', strength: 0.5 },
				asset: derivedAsset({ seconds: 10, kind: 'audio' }),
				replaceInClips: [audioId],
			},
		]);
		expect((r.results[0] as { clipIds: string[] }).clipIds).toEqual([audioId]);
	});
});
