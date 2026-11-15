import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type ClipTracker,
	checkInvariants,
	clipHandles,
	coveredClipFrames,
	defaultEffectRegistry,
	flicksPerFrame,
	loadProject,
	type MediaAsset,
	mediaVersionsOf,
	migrate,
	originalMediaId,
	type ProjectDocument,
	parseSourceSidecar,
	type Rational,
	rootFrameSpan,
	type SourceRange,
	shiftClipContentTime,
	sourceRangeFromSidecar,
	sourceTimingShift,
	type VideoClip,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const DENOISE = { op: 'denoise' as const, method: 'atadenoise' as const, strength: 0.25 };
const R30: Rational = { num: 30, den: 1 };
const F30 = flicksPerFrame(R30);

let hashN = 0;

/** What the engine sends for a processed file of `frames` frames at `fps` (RegisteredMedia fields + recipe). */
function processedAsset(frames: number, fps: Rational, size = { width: 848, height: 480 }) {
	const {
		kind: _k,
		derivation: _d,
		importedAt: _i,
		id: _id,
		...rest
	} = videoAsset({
		...size,
		fps,
		seconds: (frames * fps.den) / fps.num,
	});
	rest.probe.durationFlicks = frames * flicksPerFrame(fps);
	return { ...rest, recipeVersion: 1, recipeHash: `sha256:${(++hashN).toString(16).padStart(64, '0')}` };
}

function patchDoc(h: Harness, fn: (doc: ProjectDocument) => void) {
	const copy = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
	fn(copy);
	h.doc = copy;
}

/** crudo (848×480, `frames` frames at `fps`, with audio) placed at 0 on V1/A1 (linked). */
function setup(opts: { frames?: number; fps?: Rational } = {}) {
	const fps = opts.fps ?? R30;
	const frames = opts.frames ?? 1800;
	const h = new Harness();
	const asset = videoAsset({ width: 848, height: 480, fps, seconds: 1 });
	asset.originalName = 'crudo.mp4';
	asset.probe.durationFlicks = frames * flicksPerFrame(fps);
	const r = h.ok([{ type: 'media.register', asset, name: 'crudo', ref: '$m' }]);
	h.ok([{ type: 'clip.place', source: { mediaId: r.refs.$m }, at: 0 }]);
	return {
		h,
		fps,
		frames,
		mediaId: r.refs.$m!,
		videoId: h.clips('V1')[0]!.id,
		audioId: h.clips('A1')[0]!.id,
	};
}

/** media.derive of `[start, end)` of `fromMediaId` (a processed range); returns the version's media id. */
function deriveRange(
	h: Harness,
	fromMediaId: string,
	range: { startFrame: number; endFrame: number } | null,
	fps: Rational,
	extra: Record<string, unknown> = {},
) {
	const frames = range
		? range.endFrame - range.startFrame
		: Math.round(h.doc.media[fromMediaId]!.probe.durationFlicks! / flicksPerFrame(fps));
	const r = h.ok([
		{
			type: 'media.derive',
			fromMediaId,
			recipe: { op: 'process', steps: [DENOISE] },
			asset: processedAsset(frames, fps),
			...(range ? { range } : {}),
			ref: '$v',
			...extra,
		},
	]);
	return { id: r.refs.$v!, result: r.results[0] as Record<string, unknown>, warnings: r.warnings };
}

const vclip = (h: Harness, id: string) => h.seq.clips[id] as VideoClip;

/** Sets a clip's timing directly (content time in frames of the media at `fps`). */
function setTiming(
	h: Harness,
	id: string,
	t: { start?: number; duration: number; inFrame: number; fps: Rational; rate?: number; reverse?: boolean },
) {
	patchDoc(h, (d) => {
		const c = d.sequences[h.seqId]!.clips[id]!;
		c.start = t.start ?? 0;
		c.duration = t.duration;
		c.sourceIn = t.inFrame * flicksPerFrame(t.fps);
		c.speed = { rate: t.rate ?? 1, reverse: !!t.reverse, maintainPitch: true };
	});
}

/** The root-original frame every timeline frame of a clip shows (CLP-004), e.g. [1100, 1101, …]. */
function shownRootFrames(h: Harness, clipId: string): number[] {
	const c = h.seq.clips[clipId] as VideoClip;
	const m = h.doc.media[c.mediaId] as MediaAsset;
	const vs = m.probe.streams.find((s) => s.type === 'video')!;
	const F = flicksPerFrame(vs.type === 'video' ? vs.frameRate : R30);
	const step = flicksPerFrame(h.seq.settings.frameRate) * c.speed.rate;
	const off = rootFrameSpan(h.doc, m.id)!.start;
	const out: number[] = [];
	for (let i = 0; i < c.duration; i++) {
		const content = c.speed.reverse ? c.sourceIn + (c.duration - 1 - i) * step : c.sourceIn + i * step;
		out.push(off + Math.floor(content / F + 1e-9));
	}
	return out;
}

const kf = (h: Harness, time: number, value: number) => ({
	id: h.ids.next('kf'),
	time,
	value,
	interpolation: 'linear' as const,
	easeIn: { influence: 1 / 3, slope: 0 },
	easeOut: { influence: 1 / 3, slope: 0 },
});

const marker = (h: Harness, flicks: number) => ({
	id: h.ids.next('mrk'),
	flicks,
	duration: 0,
	name: 'm',
	comment: '',
	color: 'rose' as const,
	type: 'comment' as const,
	author: 'user' as const,
});

describe('ranged processed versions (S07:PRC-015)', () => {
	it("records the processed range as the version's sourceRange and names the item after it", () => {
		const { h, mediaId } = setup();
		const v = deriveRange(h, mediaId, { startFrame: 1090, endFrame: 1220 }, R30);
		const m = h.doc.media[v.id]!;
		expect(m.sourceRange).toEqual({
			mediaId,
			sourceName: 'crudo.mp4',
			firstFrame: 1090,
			frames: 130,
			frameRate: R30,
			origin: 'process',
		});
		const item = Object.values(h.doc.items).find((it) => it.kind === 'media' && it.mediaId === v.id)!;
		expect(item.name).toContain('1090–1219');
		expect(rootFrameSpan(h.doc, v.id)).toEqual({ rootId: mediaId, start: 1090, end: 1220, rate: R30 });
		expect(originalMediaId(h.doc, v.id)).toBe(mediaId);
		expect(mediaVersionsOf(h.doc, mediaId)).toEqual([mediaId, v.id]);
	});

	it('records the whole source for unranged versions, and refuses ranges that do not match the file', () => {
		const { h, mediaId } = setup();
		const v = deriveRange(h, mediaId, null, R30);
		expect(h.doc.media[v.id]!.sourceRange).toMatchObject({ firstFrame: 0, frames: 1800 });
		const bad = h.tx([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'process', steps: [DENOISE] },
				asset: processedAsset(50, R30),
				range: { startFrame: 0, endFrame: 130 },
			},
		]);
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		const outside = h.tx([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'process', steps: [DENOISE] },
				asset: processedAsset(130, R30),
				range: { startFrame: 1750, endFrame: 1880 },
			},
		]);
		expect(!outside.ok && outside.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
	});

	it('swaps a clip onto a range with handles: same source frames, same timeline place, handles from the range', () => {
		const { h, mediaId, videoId, audioId } = setup();
		setTiming(h, videoId, { start: 0, duration: 120, inFrame: 1100, fps: R30 });
		setTiming(h, audioId, { start: 0, duration: 120, inFrame: 1100, fps: R30 });
		const before = shownRootFrames(h, videoId);
		expect(before.slice(0, 2)).toEqual([1100, 1101]);
		const v = deriveRange(h, mediaId, { startFrame: 1088, endFrame: 1232 }, R30, {
			replaceInClips: [videoId],
		});
		expect(v.result.clipIds).toEqual([videoId]);
		const c = vclip(h, videoId);
		expect(c.mediaId).toBe(v.id);
		expect(c.sourceIn).toBe(12 * F30);
		expect(c.start).toBe(0);
		expect(c.duration).toBe(120);
		expect(shownRootFrames(h, videoId)).toEqual(before);
		// 12 frames of pre-handle, 1232 − 1220 = 12 frames of post-handle in the processed file.
		expect(clipHandles(h.doc, h.seq, c)).toEqual({ head: 12, tail: 12 });
		expect(h.seq.clips[audioId]!.sourceIn).toBe(1100 * F30);
		expect(checkInvariants(h.doc)).toEqual([]);
		h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId }]);
		expect(vclip(h, videoId).sourceIn).toBe(1100 * F30);
		expect(clipHandles(h.doc, h.seq, vclip(h, videoId))).toEqual({ head: 1100, tail: 1800 - 1220 });
	});

	it('switches directly between two ranged versions of one original (and versions of versions)', () => {
		const { h, mediaId, videoId } = setup();
		setTiming(h, videoId, { duration: 60, inFrame: 500, fps: R30 });
		const a = deriveRange(h, mediaId, { startFrame: 480, endFrame: 600 }, R30).id;
		const b = deriveRange(h, mediaId, { startFrame: 400, endFrame: 700 }, R30).id;
		// A version of version `b` (its frames 90..200 = original 490..600).
		const c = deriveRange(h, b, { startFrame: 90, endFrame: 200 }, R30).id;
		expect(rootFrameSpan(h.doc, c)).toMatchObject({ rootId: mediaId, start: 490, end: 600 });
		const want = shownRootFrames(h, videoId);
		for (const [id, inFrame] of [
			[a, 20],
			[b, 100],
			[c, 10],
			[a, 20],
			[mediaId, 500],
		] as const) {
			const r = h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId: id }]);
			expect(r.results[0]).toMatchObject({ changed: true });
			expect(vclip(h, videoId).sourceIn).toBe(inFrame * F30);
			expect(shownRootFrames(h, videoId)).toEqual(want);
		}
	});
});

describe('remap property (S07:PRC-016): random ranges, rates, speeds and directions', () => {
	const rates: Rational[] = [
		{ num: 24, den: 1 },
		{ num: 25, den: 1 },
		R30,
		{ num: 30000, den: 1001 },
		{ num: 60, den: 1 },
	];
	it('the clip shows the same source frames at the same timeline frames, and swapping back restores it exactly', () => {
		fc.assert(
			fc.property(
				fc.record({
					fps: fc.constantFrom(...rates),
					total: fc.integer({ min: 400, max: 3000 }),
					duration: fc.integer({ min: 1, max: 150 }),
					rate: fc.constantFrom(0.5, 1, 1.5, 2, 0.25),
					reverse: fc.boolean(),
					inPick: fc.double({ min: 0, max: 1, noNaN: true }),
					pre: fc.integer({ min: 0, max: 40 }),
					post: fc.integer({ min: 0, max: 40 }),
					start: fc.integer({ min: 0, max: 300 }),
					kfFrames: fc.uniqueArray(fc.integer({ min: -30, max: 200 }), { maxLength: 4 }),
					markerFrames: fc.array(fc.integer({ min: 0, max: 200 }), { maxLength: 3 }),
				}),
				(p) => {
					const { h, mediaId, videoId } = setup({ frames: p.total, fps: p.fps });
					const F = flicksPerFrame(p.fps);
					const step = F30 * p.rate;
					const spanFrames = Math.ceil((p.duration * step) / F - 1e-9);
					if (spanFrames >= p.total) return;
					const inFrame = Math.floor(p.inPick * (p.total - spanFrames));
					setTiming(h, videoId, {
						start: p.start,
						duration: p.duration,
						inFrame,
						fps: p.fps,
						rate: p.rate,
						reverse: p.reverse,
					});
					patchDoc(h, (d) => {
						const c = d.sequences[h.seqId]!.clips[videoId] as VideoClip;
						const base = c.sourceIn;
						c.opacity = {
							value: 100,
							keyframes: [...p.kfFrames].sort((x, y) => x - y).map((f, i) => kf(h, base + f * F, i * 10)),
						};
						c.markers = p.markerFrames.map((f) => marker(h, base + f * F));
					});
					const original = JSON.parse(JSON.stringify(vclip(h, videoId)));
					const want = shownRootFrames(h, videoId);
					const startFrame = Math.max(0, inFrame - p.pre);
					const endFrame = Math.min(p.total, inFrame + spanFrames + p.post);
					const v = deriveRange(h, mediaId, { startFrame, endFrame }, p.fps).id;
					h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId: v }]);
					const c = vclip(h, videoId);
					expect(c.start).toBe(p.start);
					expect(c.duration).toBe(p.duration);
					expect(c.sourceIn).toBe(original.sourceIn - startFrame * F);
					expect(shownRootFrames(h, videoId)).toEqual(want);
					// Keyframes and markers moved with the content (same source moment).
					expect(c.opacity.keyframes.map((k) => k.time + startFrame * F)).toEqual(
						original.opacity.keyframes.map((k: { time: number }) => k.time),
					);
					h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId }]);
					const back = vclip(h, videoId);
					// Generated markers lie at or after sourceIn, so none are dropped by this range.
					expect(back).toEqual(original);
					expect(shownRootFrames(h, videoId)).toEqual(want);
				},
			),
			{ numRuns: 150 },
		);
	});
});

describe('coveredClipFrames (S07:PRC-017)', () => {
	it('keeps exactly the timeline frames whose content lies in the file', () => {
		fc.assert(
			fc.property(
				fc.record({
					sourceIn: fc.integer({ min: -60, max: 200 }),
					duration: fc.integer({ min: 1, max: 100 }),
					rate: fc.constantFrom(0.5, 1, 2),
					reverse: fc.boolean(),
					fileFrames: fc.integer({ min: 1, max: 200 }),
				}),
				(p) => {
					const timing = {
						sourceIn: p.sourceIn * F30,
						duration: p.duration,
						speed: { rate: p.rate, reverse: p.reverse },
					};
					const dur = p.fileFrames * F30;
					const cov = coveredClipFrames(timing, R30, dur, 0);
					const step = F30 * p.rate;
					const inside = (i: number) => {
						const j = p.reverse ? p.duration - 1 - i : i;
						const c0 = timing.sourceIn + j * step;
						return c0 >= 0 && c0 + step <= dur;
					};
					const expected = Array.from({ length: p.duration }, (_, i) => i).filter(inside);
					if (!cov) expect(expected).toEqual([]);
					else {
						expect(expected[0]).toBe(cov.from);
						expect(expected.at(-1)).toBe(cov.to - 1);
						expect(expected.length).toBe(cov.to - cov.from);
					}
				},
			),
			{ numRuns: 400 },
		);
	});
});

describe('shiftClipContentTime', () => {
	it('shifts nested keyframes and tracker times, dropping samples and markers before the file', () => {
		const tracker: ClipTracker = {
			id: 'tkr_1',
			name: 'T',
			kind: 'point',
			reference: { time: 10 * F30, point: [1, 2] },
			samples: {
				start: 5 * F30,
				step: F30,
				stride: 2,
				data: [1, 1, 2, 2, 3, 3, 4, 4],
				confidence: [1, 1, 1, 1],
			},
			method: 'klt',
		};
		const clip = {
			sourceIn: 10 * F30,
			markers: [{ flicks: 12 * F30 }],
			trackers: [tracker],
			transform: { scale: { value: 1, keyframes: [{ time: 11 * F30 }] } },
			effects: [{ params: { amount: { value: 0, keyframes: [{ time: 0 }, { time: 3 * F30 }] } } }],
		};
		expect(shiftClipContentTime(clip, -4 * F30)).toEqual({
			droppedMarkers: 0,
			droppedTrackerSamples: 0,
		});
		expect(clip.markers[0]!.flicks).toBe(8 * F30);
		expect(clip.transform.scale.keyframes[0]!.time).toBe(7 * F30);
		expect(clip.effects[0]!.params.amount.keyframes.map((k) => k.time)).toEqual([-4 * F30, -1 * F30]);
		expect(tracker.reference.time).toBe(6 * F30);
		expect(tracker.samples!.start).toBe(F30);
		shiftClipContentTime(clip, 4 * F30);
		// Samples and markers before the new file's start are dropped (content time is never negative there).
		const rep = shiftClipContentTime(clip, -7 * F30);
		expect(rep).toEqual({ droppedMarkers: 0, droppedTrackerSamples: 2 });
		expect(tracker.samples).toMatchObject({ start: 0, data: [3, 3, 4, 4], confidence: [1, 1] });
		expect(shiftClipContentTime(clip, -20 * F30).droppedMarkers).toBe(1);
		expect(tracker.samples).toBeNull();
	});
});

describe('clips a version does not cover (S07:PRC-017)', () => {
	function uncovered() {
		const s = setup();
		setTiming(s.h, s.videoId, { start: 30, duration: 60, inFrame: 1090, fps: R30 });
		setTiming(s.h, s.audioId, { start: 30, duration: 60, inFrame: 1090, fps: R30 });
		// Covers 1100..1139: the clip shows 1090..1149 → 10 frames missing at each end.
		const v = deriveRange(s.h, s.mediaId, { startFrame: 1100, endFrame: 1140 }, R30).id;
		return { ...s, v };
	}

	it('refuses with source ranges in the diagnostic and leaves the document unchanged', () => {
		const { h, videoId, v } = uncovered();
		const doc = h.doc;
		const r = h.tx([{ type: 'clip.replaceSource', clipId: videoId, mediaId: v }]);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
		const message = !r.ok && r.errors[0]!.message;
		expect(message).toContain('1100–1139');
		expect(message).toContain('1090–1149');
		expect(message).toContain('crudo.mp4');
		expect(h.doc).toBe(doc);
	});

	it('fit: "trim" trims the clip and its linked audio to the covered frames, still on the same source frames', () => {
		const { h, videoId, audioId, v } = uncovered();
		const before = shownRootFrames(h, videoId);
		const r = h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId: v, fit: 'trim' }]);
		expect(r.results[0]).toMatchObject({ changed: true, trimmed: { head: 10, tail: 10 } });
		const c = vclip(h, videoId);
		expect([c.start, c.duration, c.sourceIn]).toEqual([40, 40, 0]);
		expect(shownRootFrames(h, videoId)).toEqual(before.slice(10, 50));
		const a = h.seq.clips[audioId]!;
		expect([a.start, a.duration, a.sourceIn]).toEqual([40, 40, 1100 * F30]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('fit: "trim" on a reverse clip trims the right ends', () => {
		const { h, mediaId, videoId } = setup();
		setTiming(h, videoId, { start: 30, duration: 60, inFrame: 1090, fps: R30, reverse: true });
		// Source 1090..1149 played backwards; omit 10 low frames and 20 high frames.
		const v = deriveRange(h, mediaId, { startFrame: 1100, endFrame: 1130 }, R30).id;
		h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId: v, fit: 'trim' }]);
		const c = vclip(h, videoId);
		expect([c.start, c.duration, c.sourceIn]).toEqual([50, 30, 0]);
	});

	it('fit: "skip" leaves the clip with a warning; media.derive replaceInClips uses it per clip', () => {
		const { h, mediaId, videoId } = uncovered();
		const r = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'process', steps: [{ ...DENOISE, strength: 0.5 }] },
				asset: processedAsset(40, R30),
				range: { startFrame: 1100, endFrame: 1140 },
				replaceInClips: [videoId],
				fit: 'skip',
			},
		]);
		expect(r.results[0]).toMatchObject({ clipIds: [], skippedClipIds: [videoId] });
		expect(r.warnings.map((w) => w.code)).toContain('W_CLIP_SKIPPED');
		expect(vclip(h, videoId).mediaId).toBe(mediaId);
	});

	it('warns when a source swap shortens transition handles', () => {
		const { h, mediaId } = setup();
		// Two clips of crudo back to back with a 20-frame centred cross dissolve.
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				at: 0,
				sourceRange: { in: { flicks: 100 * F30 }, out: { flicks: 160 * F30 } },
			},
		]);
		const clips = h.clips('V1');
		const [a, b] = clips.sort((x, y) => x.start - y.start);
		setTiming(h, a!.id, { start: 0, duration: 60, inFrame: 1000, fps: R30 });
		setTiming(h, b!.id, { start: 60, duration: 60, inFrame: 100, fps: R30 });
		h.ok([
			{
				type: 'transition.add',
				effectId: 'jasper.cross-dissolve',
				at: 60,
				trackId: 'V1',
				duration: 20,
				alignment: 'center',
				handles: 'freeze',
			},
		]);
		const v = deriveRange(h, mediaId, { startFrame: 997, endFrame: 1063 }, R30).id;
		const r = h.ok([{ type: 'clip.replaceSource', clipId: a!.id, mediaId: v }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_TRANSITION_SHORTENED');
	});
});

const T02_SIDECAR = {
	id: 'T02',
	frames: 130,
	first_src_frame: 174,
	handles: [0, 8],
	probe: { r_frame_rate: '30/1', nb_read_frames: '130' },
	spec: { src: 'raw/crudo.mp4', handles: { pre: 0, post: 8 } },
};

describe('source-range sidecars (S07:PRC-019)', () => {
	it('reads the trailer grade sidecar, jasper-proc sidecars and the generic shape', () => {
		expect(parseSourceSidecar(T02_SIDECAR, '/x/T02.json')).toEqual({
			sidecar: 'T02.json',
			sourceName: 'crudo.mp4',
			firstFrame: 174,
			frames: 130,
			frameRate: R30,
			handles: [0, 8],
		});
		expect(
			parseSourceSidecar(
				{
					name: 'jasper-proc',
					input: { path: '/m/clip.mp4', fps: '30000/1001', range: [12, 48] },
					output: { frames: 36 },
				},
				'out.mov.json',
			),
		).toMatchObject({
			sourceName: 'clip.mp4',
			firstFrame: 12,
			frames: 36,
			frameRate: { num: 30000, den: 1001 },
		});
		expect(
			parseSourceSidecar({ firstFrame: 5, source: 'a.mov', fps: 25, handles: { pre: 2, post: 3 } }),
		).toMatchObject({
			firstFrame: 5,
			frameRate: { num: 25, den: 1 },
			handles: [2, 3],
		});
		expect(parseSourceSidecar({ name: 'jasper-proc', input: { path: 'a' } })).toBeNull();
		expect(parseSourceSidecar({ frames: 3 })).toBeNull();
		expect(parseSourceSidecar([1, 2])).toBeNull();
	});

	it('binds an imported render sidecar to the source media by filename', () => {
		const { h, mediaId } = setup();
		const t02 = videoAsset({ width: 1920, height: 1080, fps: R30, seconds: 1 });
		t02.originalName = 'T02.mov';
		t02.probe.durationFlicks = 130 * F30;
		const range = sourceRangeFromSidecar(h.doc, parseSourceSidecar(T02_SIDECAR, 'T02.json')!, t02)!;
		expect(range).toEqual({
			mediaId,
			sourceName: 'crudo.mp4',
			firstFrame: 174,
			frames: 130,
			frameRate: R30,
			origin: 'sidecar',
		});
		const r = h.ok([{ type: 'media.register', asset: { ...t02, sourceRange: range }, ref: '$t' }]);
		const t = r.refs.$t!;
		expect(mediaVersionsOf(h.doc, mediaId)).toEqual([mediaId, t]);
	});

	it('media.setSourceRange links, re-links and clears; refuses cycles and rate mismatches', () => {
		const { h, mediaId } = setup();
		const other = videoAsset({ fps: R30, seconds: 4 });
		const r = h.ok([{ type: 'media.register', asset: other, ref: '$o' }]);
		const o = r.refs.$o!;
		const range = (mid: string | null, first = 10): SourceRange => ({
			mediaId: mid,
			sourceName: null,
			firstFrame: first,
			frames: 120,
			frameRate: R30,
			origin: 'manual',
		});
		h.ok([{ type: 'media.setSourceRange', mediaId: o, sourceRange: range(mediaId) }]);
		expect(originalMediaId(h.doc, o)).toBe(mediaId);
		const cyc = h.tx([{ type: 'media.setSourceRange', mediaId, sourceRange: range(o) }]);
		expect(!cyc.ok && cyc.errors[0]!.code).toBe('E_INVALID_PARAM');
		const self = h.tx([{ type: 'media.setSourceRange', mediaId: o, sourceRange: range(o) }]);
		expect(!self.ok && self.errors[0]!.code).toBe('E_INVALID_PARAM');
		const bad = h.tx([
			{
				type: 'media.setSourceRange',
				mediaId: o,
				sourceRange: { ...range(mediaId), frameRate: { num: 25, den: 1 } },
			},
		]);
		expect(!bad.ok && bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		h.ok([{ type: 'media.setSourceRange', mediaId: o, sourceRange: null }]);
		expect(h.doc.media[o]!.sourceRange).toBeUndefined();
		expect(originalMediaId(h.doc, o)).toBe(o);
	});
});

function replacement(frames: number, opts: { name?: string; tc?: string | null } = {}) {
	const a = videoAsset({ width: 1920, height: 1080, fps: R30, seconds: 1 });
	a.originalName = opts.name ?? 'T02.mov';
	a.probe.durationFlicks = frames * F30;
	a.probe.startTimecode = opts.tc ?? null;
	return a;
}

describe('Replace Footage with "keep source timing" (S07:PRC-018)', () => {
	it('resolves two source ranges and refuses incompatible sources or frame rates', () => {
		const raw = replacement(1800, { name: 'crudo.mp4' });
		const r = (first: number, name: string | null = 'crudo.mp4'): SourceRange => ({
			mediaId: null,
			sourceName: name,
			firstFrame: first,
			frames: 130,
			frameRate: R30,
			origin: 'sidecar',
		});
		expect(
			sourceTimingShift(
				{ ...replacement(130), sourceRange: r(174) },
				{ ...replacement(140), sourceRange: r(170) },
			),
		).toMatchObject({ shiftFrames: 4, basis: 'source-range' });
		expect(sourceTimingShift(raw, { ...replacement(130), sourceRange: r(174, 'other.mp4') })).toMatchObject({
			ok: true,
			warning: expect.any(String),
		});
		expect(
			sourceTimingShift(
				{ ...replacement(130), sourceRange: r(1) },
				{ ...replacement(130), sourceRange: r(2, 'x.mp4') },
			),
		).toMatchObject({ ok: false });
		const at25 = replacement(130);
		(at25.probe.streams[0] as { frameRate: Rational }).frameRate = { num: 25, den: 1 };
		expect(sourceTimingShift(raw, { ...at25, sourceRange: r(1) })).toMatchObject({
			ok: false,
		});
	});

	function replaceSetup() {
		const s = setup();
		setTiming(s.h, s.videoId, { start: 0, duration: 100, inFrame: 180, fps: R30 });
		setTiming(s.h, s.audioId, { start: 0, duration: 100, inFrame: 180, fps: R30 });
		patchDoc(s.h, (d) => {
			const item = Object.values(d.items).find((it) => it.kind === 'media' && it.mediaId === s.mediaId)!;
			if (item.kind === 'media') item.marks = { in: { flicks: 200 * F30 }, out: { flicks: 250 * F30 } };
			(d.sequences[s.h.seqId]!.clips[s.videoId] as VideoClip).markers = [marker(s.h, 190 * F30)];
		});
		return s;
	}

	function relinkCmd(mediaId: string, a: ReturnType<typeof replacement>, extra: Record<string, unknown>) {
		return {
			type: 'media.relink',
			mediaId,
			replace: true,
			locator: a.locators[0],
			locators: a.locators,
			fingerprint: a.fingerprint,
			probe: a.probe,
			sizeBytes: a.sizeBytes,
			originalName: a.originalName,
			container: a.container,
			...extra,
		};
	}

	it('moves every clip, mark and marker of the media so the same source frames stay at the same place', () => {
		const { h, mediaId, videoId, audioId } = replaceSetup();
		const want = shownRootFrames(h, videoId);
		const t02 = replacement(130);
		const sr: SourceRange = {
			mediaId: null,
			sourceName: 'crudo.mp4',
			firstFrame: 174,
			frames: 130,
			frameRate: R30,
			origin: 'sidecar',
		};
		const r = h.ok([relinkCmd(mediaId, t02, { sourceRange: sr, keepSourceTiming: true })], {
			label: 'Replace Footage',
		});
		expect(r.results[0]).toMatchObject({ mediaId, shiftFrames: -174, basis: 'range-of-current' });
		const m = h.doc.media[mediaId]!;
		expect(m.fingerprint).toBe(t02.fingerprint);
		expect(m.locators).toEqual(t02.locators);
		expect(m.sourceRange).toEqual(sr);
		expect(vclip(h, videoId).sourceIn).toBe(6 * F30);
		expect(h.seq.clips[audioId]!.sourceIn).toBe(6 * F30);
		// The file's own frames 6…105 are source frames 180…279 (offsets from the declared first frame).
		expect(shownRootFrames(h, videoId).map((f) => f + 174)).toEqual(want);
		expect(vclip(h, videoId).markers[0]!.flicks).toBe(16 * F30);
		const item = Object.values(h.doc.items).find((it) => it.kind === 'media' && it.mediaId === mediaId)!;
		expect(item.kind === 'media' && item.marks).toEqual({
			in: { flicks: 26 * F30 },
			out: { flicks: 76 * F30 },
		});
		expect(checkInvariants(h.doc)).toEqual([]);
		const raw = replacement(1800, { name: 'crudo.mp4' });
		const back = h.ok([relinkCmd(mediaId, raw, { sourceRange: null, keepSourceTiming: true })]);
		expect(back.results[0]).toMatchObject({ shiftFrames: 174, basis: 'current-is-range' });
		expect(vclip(h, videoId).sourceIn).toBe(180 * F30);
	});

	it('refuses (or trims) clips the new file does not hold, and without keep-timing keeps content time', () => {
		const { h, mediaId, videoId } = replaceSetup();
		const short = replacement(60);
		const sr: SourceRange = {
			mediaId: null,
			sourceName: 'crudo.mp4',
			firstFrame: 174,
			frames: 60,
			frameRate: R30,
			origin: 'sidecar',
		};
		const refused = h.tx([relinkCmd(mediaId, short, { sourceRange: sr, keepSourceTiming: true })]);
		expect(!refused.ok && refused.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
		const trimmed = h.ok([
			relinkCmd(mediaId, short, { sourceRange: sr, keepSourceTiming: true, fit: 'trim' }),
		]);
		expect(trimmed.results[0]).toMatchObject({ trimmedClipIds: expect.arrayContaining([videoId]) });
		expect([vclip(h, videoId).start, vclip(h, videoId).duration]).toEqual([0, 54]);
		expect(checkInvariants(h.doc)).toEqual([]);
		// Plain replace (no keep timing): content time unchanged; still checked against the new file.
		const { h: h2, mediaId: m2, videoId: v2, audioId: a2 } = replaceSetup();
		const plain = h2.ok([relinkCmd(m2, replacement(1800, { name: 'crudo-v2.mp4' }), {})]);
		// every clip now on the new file is listed, though none moved
		expect(plain.results[0]).toMatchObject({ shiftFrames: 0 });
		const listed = (plain.results[0] as { clipIds: string[] }).clipIds;
		expect(listed).toHaveLength(2);
		expect(listed).toEqual(expect.arrayContaining([v2, a2]));
		expect(vclip(h2, v2).sourceIn).toBe(180 * F30);
		const tooShort = h2.tx([relinkCmd(m2, replacement(100, { name: 'x.mov' }), {})]);
		expect(!tooShort.ok && tooShort.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
	});

	it('refuses keep-source-timing without a source relation or timecodes', () => {
		const { h, mediaId } = replaceSetup();
		const before = h.doc;
		const none = h.tx([relinkCmd(mediaId, replacement(1800), { keepSourceTiming: true })]);
		expect(!none.ok && none.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(h.doc).toBe(before);
	});

	it('re-anchors versions of the media on the new file (or detaches those it no longer holds)', () => {
		const { h, mediaId, videoId } = replaceSetup();
		const kept = deriveRange(h, mediaId, { startFrame: 100, endFrame: 300 }, R30).id;
		const lost = deriveRange(h, mediaId, { startFrame: 10, endFrame: 40 }, R30).id;
		h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId: kept }]);
		const want = shownRootFrames(h, videoId).map((f) => f);
		const sr: SourceRange = {
			mediaId: null,
			sourceName: 'crudo.mp4',
			firstFrame: 50,
			frames: 1000,
			frameRate: R30,
			origin: 'sidecar',
		};
		const r = h.ok([
			relinkCmd(mediaId, replacement(1000, { name: 'crudo-from50.mov' }), {
				sourceRange: sr,
				keepSourceTiming: true,
			}),
		]);
		expect(h.doc.media[kept]!.sourceRange).toMatchObject({ mediaId, firstFrame: 50, frames: 200 });
		expect(h.doc.media[lost]!.sourceRange).toMatchObject({
			mediaId: null,
			sourceName: 'crudo.mp4',
			firstFrame: 10,
		});
		expect(r.warnings.map((w) => w.code)).toContain('W_VERSION_DETACHED');
		// The clip on the kept version still shows the same frames (now counted from the new file's start).
		expect(shownRootFrames(h, videoId).map((f) => f + 50)).toEqual(want);
		expect(mediaVersionsOf(h.doc, mediaId)).toEqual([mediaId, kept]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('keeps source timing by timecode', () => {
		const { h, mediaId, videoId } = replaceSetup();
		patchDoc(h, (d) => {
			d.media[mediaId]!.probe.startTimecode = '01:00:00:00';
		});
		h.ok([relinkCmd(mediaId, replacement(300, { tc: '01:00:05:00' }), { keepSourceTiming: true })]);
		expect(vclip(h, videoId).sourceIn).toBe(30 * F30);
	});

	it('keeps every clip framed as before when the new file has another pixel size (stills and video)', () => {
		const h = new Harness();
		const still = h.registerVideo({ kind: 'image', width: 3000, height: 3000 });
		const video = h.registerVideo({ width: 960, height: 540, audio: false });
		h.ok([
			{ type: 'clip.place', source: { mediaId: still }, at: 0, scaling: 'fit' },
			{ type: 'clip.place', source: { mediaId: video }, at: 0, tracks: { video: 'V2' }, scaling: 'fit' },
		]);
		const ids = [h.clips('V1')[0]!.id, h.clips('V2')[0]!.id];
		const framing = (doc: ProjectDocument) =>
			ids.map((id) => {
				const t = (doc.sequences[h.seqId]!.clips[id] as VideoClip).transform;
				return { scale: t.scale.value, anchor: t.anchor.value, position: t.position.value };
			});
		const placed = [
			{ scale: 36, anchor: [1500, 1500], position: [960, 540] },
			{ scale: 200, anchor: [480, 270], position: [960, 540] },
		];
		const before = h.doc;
		expect(framing(before)).toEqual(placed);
		h.ok([
			relinkCmd(still, videoAsset({ kind: 'image', width: 1500, height: 1500 }), {}),
			relinkCmd(video, videoAsset({ width: 1920, height: 1080, audio: false }), {}),
		]);
		expect(framing(h.doc)).toEqual([
			{ scale: 72, anchor: [750, 750], position: [960, 540] },
			{ scale: 100, anchor: [960, 540], position: [960, 540] },
		]);
		expect(checkInvariants(h.doc)).toEqual([]);
		// undo restores the previous document, untouched
		expect(framing(before)).toEqual(placed);
	});
});

describe('schema v5 migration (S07:PRC-015)', () => {
	it('the v5 fixture (a ranged processed version in use, a sidecar-linked render) loads without repairs', () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const env = JSON.parse(readFileSync(join(here, 'fixtures/v5/basic.jasper'), 'utf8'));
		const r = loadProject(env, { effects: defaultEffectRegistry });
		expect(r.readOnly).toBe(false);
		expect(r.migration.steps).toEqual([
			'v5→v6',
			'v6→v7',
			'v7→v8',
			'v8→v9',
			'v9→v10',
			'v10→v11',
			'v11→v12',
			'v12→v13',
			'v13→v14',
			'v14→v15',
		]);
		expect(r.repairs).toEqual([]);
		expect(r.issues).toEqual([]);
		const d = r.document;
		const crudo = Object.values(d.media).find((m) => m.originalName === 'crudo.mp4')!;
		const versions = mediaVersionsOf(d, crudo.id);
		expect(versions.map((id) => d.media[id]!.sourceRange?.firstFrame ?? 0)).toEqual([0, 1088, 174]);
		const clip = Object.values(Object.values(d.sequences)[0]!.clips).find(
			(c) => c.kind === 'video',
		) as VideoClip;
		expect(clip.mediaId).toBe(versions[1]);
		expect(clip.sourceIn).toBe(12 * F30);
	});

	it('records the whole-source range on M2 processed versions', () => {
		const { h, mediaId } = setup();
		const v = deriveRange(h, mediaId, null, R30).id;
		const doc = JSON.parse(JSON.stringify(h.doc));
		delete doc.media[v].sourceRange;
		doc.schemaVersion = 4;
		const m = migrate({ format: 'jasper-project', document: doc });
		expect(m.report.steps).toEqual([
			'v4→v5',
			'v5→v6',
			'v6→v7',
			'v7→v8',
			'v8→v9',
			'v9→v10',
			'v10→v11',
			'v11→v12',
			'v12→v13',
			'v13→v14',
			'v14→v15',
		]);
		expect(m.document.media[v]!.sourceRange).toEqual({
			mediaId,
			sourceName: 'crudo.mp4',
			firstFrame: 0,
			frames: 1800,
			frameRate: R30,
			origin: 'process',
		});
		expect(m.document.media[mediaId]!.sourceRange).toBeUndefined();
	});
});
