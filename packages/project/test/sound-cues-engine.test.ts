// Engine cue sources (spec 12 §2.2 "Scene cuts (engine), beats (engine), pixel motion curve (engine, P6)", P6-R2;
// wp-note "Phase 6 → WP6.2"): the pure parts — frame-pair motion, curve events, scene-cut and beat mapping through
// speed / reverse / time remap, the scene anchor's round trip, beat snapping, and how deriveCues merges them.
import { fuzzScale, fuzzSeed, mutateJson, Rng } from '@jasper/testkit/fuzz';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	ABRUPT_STOP,
	applyTransaction,
	beatCues,
	checkInvariants,
	clipMediaTimeFn,
	createCounterIdSource,
	cueAnchorFrame,
	cueInputFromDerived,
	deriveCues,
	type ExtraCue,
	FLICKS_PER_SECOND,
	footageClips,
	MOVE_ON,
	measureFrameMotion,
	musicClips,
	PIXEL_MAX_CONFIDENCE,
	type PixelMotionCurve,
	pixelAnalysisSize,
	pixelMotionCues,
	pixelMotionEvents,
	readSoundDesign,
	resolveCueAnchor,
	type SceneCutData,
	sceneAnchorAt,
	sceneCutCues,
	snapCuesToBeats,
	soundCuesOf,
} from '../src/index.ts';
import { Harness, makeCtx, videoAsset } from './helpers.ts';

// ---------------------------------------------------------------------------------------------------------------
// Frames

const W = 128;
const H = 72;

/** Deterministic texture (value noise, smooth enough to match, rough enough to have gradients). */
function texture(seed: number, w = W, h = H): Uint8Array {
	let s = seed >>> 0 || 1;
	const rnd = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const g = 8;
	const gw = Math.ceil(w / g) + 2;
	const gh = Math.ceil(h / g) + 2;
	const grid = Array.from({ length: gw * gh }, () => rnd() * 255);
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const gx = x / g;
			const gy = y / g;
			const x0 = Math.floor(gx);
			const y0 = Math.floor(gy);
			const fx = gx - x0;
			const fy = gy - y0;
			const v =
				grid[y0 * gw + x0]! * (1 - fx) * (1 - fy) +
				grid[y0 * gw + x0 + 1]! * fx * (1 - fy) +
				grid[(y0 + 1) * gw + x0]! * (1 - fx) * fy +
				grid[(y0 + 1) * gw + x0 + 1]! * fx * fy;
			out[y * w + x] = Math.round(v);
		}
	return out;
}

/** A flat gray frame with a textured box of `size` px at (x, y) (integer). */
function boxFrame(x: number, y: number, size = 24, bg = 60): Uint8Array {
	const tex = texture(7, size, size);
	const out = new Uint8Array(W * H).fill(bg);
	for (let j = 0; j < size; j++)
		for (let i = 0; i < size; i++) {
			const X = x + i;
			const Y = y + j;
			if (X >= 0 && X < W && Y >= 0 && Y < H) out[Y * W + X] = 120 + (tex[j * size + i]! >> 1);
		}
	return out;
}

/** A textured frame shifted by `dx` px (content moves right for dx > 0). */
function shifted(base: Uint8Array, dx: number, dy = 0): Uint8Array {
	const out = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const sx = Math.min(W - 1, Math.max(0, x - dx));
			const sy = Math.min(H - 1, Math.max(0, y - dy));
			out[y * W + x] = base[sy * W + sx]!;
		}
	return out;
}

describe('measureFrameMotion', () => {
	it('a still picture does not move', () => {
		const f = texture(3);
		const m = measureFrameMotion(f, f, W, H);
		expect(m.speedPx).toBe(0);
		expect(m.area).toBe(0);
		expect(m.residual).toBe(0);
		expect(m.diff).toBe(0);
	});

	it('a box moving 3 px right: its speed, direction, area and on-screen x', () => {
		const m = measureFrameMotion(boxFrame(40, 24), boxFrame(43, 24), W, H);
		expect(m.speedPx).toBeGreaterThan(2.4);
		expect(m.speedPx).toBeLessThan(3.6);
		expect(m.vx).toBeGreaterThan(2.7);
		expect(m.vx).toBeLessThan(3.3);
		expect(Math.abs(m.vy)).toBeLessThan(0.3);
		expect(m.area).toBeGreaterThan(0.01);
		expect(m.area).toBeLessThan(0.25);
		// the box centre is at x ≈ 55 of 128
		expect(m.cx).toBeGreaterThan(0.3);
		expect(m.cx).toBeLessThan(0.56);
		expect(m.residual).toBeLessThan(0.02);
	});

	it('a box moving up-left, and fast (9 px: the coarse search)', () => {
		const m = measureFrameMotion(boxFrame(60, 30), boxFrame(58, 28), W, H);
		expect(m.vx).toBeLessThan(-1.4);
		expect(m.vy).toBeLessThan(-1.4);
		const fast = measureFrameMotion(boxFrame(30, 24), boxFrame(39, 24), W, H);
		expect(fast.vx).toBeGreaterThan(8);
		expect(fast.vx).toBeLessThan(10);
	});

	it('a camera pan moves the whole frame', () => {
		const base = texture(11);
		const m = measureFrameMotion(base, shifted(base, -2), W, H);
		expect(m.area).toBeGreaterThan(0.8);
		expect(m.vx).toBeGreaterThan(-2.2);
		expect(m.vx).toBeLessThan(-1.8);
		expect(Math.abs(m.vy)).toBeLessThan(0.2);
		expect(m.residual).toBeLessThan(0.01);
		// under a pixel per frame (Lucas–Kanade): half a pixel right, the average of two neighbours
		const half = new Uint8Array(W * H);
		const one = shifted(base, 1);
		for (let i = 0; i < half.length; i++) half[i] = Math.round((base[i]! + one[i]!) / 2);
		const h = measureFrameMotion(base, half, W, H);
		expect(h.area).toBeGreaterThan(0.5);
		expect(Math.abs(h.vx - 0.5)).toBeLessThan(0.15);
		expect(Math.abs(h.vy)).toBeLessThan(0.15);
	});

	it('a box moving 0.7 px per frame (sub-pixel) is measured', () => {
		// a box drawn at fractional x by blending two whole-pixel positions
		const a = boxFrame(40, 24);
		const b0 = boxFrame(40, 24);
		const b1 = boxFrame(41, 24);
		const b = new Uint8Array(W * H);
		for (let i = 0; i < b.length; i++) b[i] = Math.round(0.3 * b0[i]! + 0.7 * b1[i]!);
		const m = measureFrameMotion(a, b, W, H);
		expect(m.area).toBeGreaterThan(0.01);
		expect(Math.abs(m.vx - 0.7)).toBeLessThan(0.25);
	});

	it('a cut is change that motion does not explain', () => {
		const m = measureFrameMotion(texture(1), texture(99), W, H);
		expect(m.residual).toBeGreaterThan(0.1);
		expect(m.diff).toBeGreaterThan(0.1);
	});

	it('hostile sizes and buffers measure as still; random frames never throw', () => {
		expect(measureFrameMotion(new Uint8Array(4), new Uint8Array(4), 2, 2).speedPx).toBe(0);
		expect(measureFrameMotion(new Uint8Array(10), texture(1), W, H).speedPx).toBe(0);
		expect(measureFrameMotion(texture(1), texture(2), Number.NaN, H).area).toBe(0);
		expect(measureFrameMotion(texture(1), texture(2), 10_000, 10_000).area).toBe(0);
		fc.assert(
			fc.property(fc.uint8Array({ minLength: 32 * 32, maxLength: 32 * 32 }), fc.integer(), (a, seed) => {
				const b = texture(seed, 32, 32);
				const m = measureFrameMotion(a, b, 32, 32);
				return [m.speedPx, m.vx, m.vy, m.area, m.cx, m.residual, m.diff].every(Number.isFinite);
			}),
			{ numRuns: 40 },
		);
	});

	it('analysis sizes keep the aspect with a 128 px long side', () => {
		expect(pixelAnalysisSize(1920, 1080)).toEqual({ width: 128, height: 72 });
		expect(pixelAnalysisSize(1080, 1920)).toEqual({ width: 72, height: 128 });
		expect(pixelAnalysisSize(Number.NaN, 0).width).toBeGreaterThanOrEqual(16);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Curves

/** A curve of `n` frames from per-frame functions. */
function curve(
	n: number,
	f: (
		i: number,
	) => Partial<{ speed: number; vx: number; vy: number; area: number; cx: number; residual: number }>,
	startFrame = 100,
): PixelMotionCurve {
	const s = { speed: [0], vx: [0], vy: [0], area: [0], cx: [0.5], residual: [0] } as Record<string, number[]>;
	for (let i = 1; i < n; i++) {
		const v = f(i);
		s.speed!.push(v.speed ?? 0);
		s.vx!.push(v.vx ?? v.speed ?? 0);
		s.vy!.push(v.vy ?? 0);
		s.area!.push(v.area ?? ((v.speed ?? 0) > 0 ? 0.1 : 0));
		s.cx!.push(v.cx ?? 0.5);
		s.residual!.push(v.residual ?? 0.003);
	}
	return {
		startFrame,
		fps: 30,
		width: W,
		height: H,
		speed: s.speed!,
		vx: s.vx!,
		vy: s.vy!,
		area: s.area!,
		cx: s.cx!,
		residual: s.residual!,
	};
}

describe('pixelMotionEvents (shared thresholds with the keyframe source)', () => {
	it('a constant move with an abrupt stop: move in its middle, window = start … arrival, land on arrival', () => {
		// moving frames 20…39 (indices), at 0.6 screens/s, then still
		const c = curve(80, (i) => (i >= 20 && i <= 39 ? { speed: 0.6, cx: 0.2 + (i - 20) * 0.02 } : {}));
		const ev = pixelMotionEvents(c);
		const move = ev.find((e) => e.kind === 'move');
		const land = ev.find((e) => e.kind === 'land');
		expect(move).toMatchObject({
			kind: 'move',
			start: 120,
			end: 140,
			frame: 129,
			global: false,
			direction: 'right',
		});
		expect(move?.kind === 'move' && move.panSweep).toBeTruthy();
		expect(land).toMatchObject({ kind: 'land', frame: 139, how: 'abrupt stop' });
	});

	it('an ease-out settle gets no land; a slow drift under MOVE_ON is no move', () => {
		const ease = curve(80, (i) =>
			i >= 10 && i < 40 ? { speed: 0.8 * (1 - (i - 10) / 30) ** 2 + 0.001 } : {},
		);
		const ev = pixelMotionEvents(ease);
		expect(ev.filter((e) => e.kind === 'move')).toHaveLength(1);
		expect(ev.some((e) => e.kind === 'land')).toBe(false);
		const drift = curve(80, (i) => (i > 5 ? { speed: MOVE_ON * 0.8 } : {}));
		expect(pixelMotionEvents(drift)).toEqual([]);
	});

	it('an overshoot lands at the turnaround; a bounce is named', () => {
		const c = curve(80, (i) => {
			if (i >= 10 && i < 25) return { speed: 0.9, vx: 0.9 };
			if (i >= 25 && i < 29) return { speed: 0.3, vx: -0.3 };
			return {};
		});
		const land = pixelMotionEvents(c).find((e) => e.kind === 'land');
		expect(land).toMatchObject({ frame: 124, how: 'overshoot' });
		const b = curve(80, (i) => {
			if (i >= 10 && i < 25) return { speed: 0.9, vx: 0.9 };
			if (i >= 25 && i < 28) return { speed: 0.3, vx: -0.3 };
			if (i >= 28 && i < 30) return { speed: 0.2, vx: 0.2 };
			return {};
		});
		expect(pixelMotionEvents(b).find((e) => e.kind === 'land')).toMatchObject({ how: 'bounce' });
	});

	it('a camera pan sweeps the way the picture travels; a cut splits motion and is reported once', () => {
		const pan = curve(60, (i) => (i >= 5 && i < 40 ? { speed: 0.5, vx: -0.5, area: 0.95 } : {}));
		const m = pixelMotionEvents(pan).find((e) => e.kind === 'move');
		expect(m).toMatchObject({ global: true, direction: 'left', panSweep: { from: 40, to: -40 } });
		const cut = curve(90, (i) => {
			if (i === 45) return { speed: 3, residual: 0.35, area: 1 };
			if (i >= 20 && i < 70) return { speed: 0.5, area: 0.3 };
			return {};
		});
		const ev = pixelMotionEvents(cut);
		expect(ev.filter((e) => e.kind === 'cut').map((e) => e.frame)).toEqual([145]);
		expect(ev.filter((e) => e.kind === 'move')).toHaveLength(2);
		// a known edit at that frame is not reported again (the edits source has it), but still splits the motion
		const ev2 = pixelMotionEvents(cut, { edits: [145] });
		expect(ev2.filter((e) => e.kind === 'cut')).toHaveLength(0);
		expect(ev2.filter((e) => e.kind === 'move')).toHaveLength(2);
	});

	it('cues: confidence ≤ 0.5, support, whoosh for long moves, types by impact; unanchored events are left out', () => {
		const c = curve(80, (i) => (i >= 20 && i <= 39 ? { speed: 2, area: 0.6, vx: 2 } : {}));
		const ev = pixelMotionEvents(c);
		const anchor = { type: 'scene' as const, mediaId: 'med_A', mediaSec: 1, clipId: 'clp_A' };
		const { cues, unanchored } = pixelMotionCues(c, ev, (f) =>
			f < 130 ? { anchor, where: "'A' on V1" } : null,
		);
		expect(unanchored).toBe(1);
		expect(cues).toHaveLength(1);
		expect(cues[0]).toMatchObject({
			kind: 'move',
			from: 'pixel',
			weight: 'support',
			types: ['whoosh', 'swish', 'transition'],
		});
		const all = pixelMotionCues(c, ev, () => ({ anchor, where: 'x' })).cues;
		for (const q of all) expect(q.confidence).toBeLessThanOrEqual(PIXEL_MAX_CONFIDENCE);
		expect(all.find((q) => q.kind === 'land')?.types[0]).toBe('hit');
		expect(ABRUPT_STOP).toBeGreaterThan(0);
	});

	it('never throws and is deterministic on hostile curves', () => {
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(1e9), fc.constant(-3)), {
					maxLength: 200,
				}),
				fc.oneof(fc.double(), fc.constant(0)),
				(xs, fps) => {
					const c = {
						startFrame: 3,
						fps,
						width: 1,
						height: 1,
						speed: xs,
						vx: xs,
						vy: xs,
						area: xs,
						cx: xs,
						residual: xs,
					};
					const a = pixelMotionEvents(c);
					const b = pixelMotionEvents(c);
					return JSON.stringify(a) === JSON.stringify(b) && a.every((e) => Number.isInteger(e.frame));
				},
			),
			{ numRuns: 200 },
		);
		expect(pixelMotionEvents(null as never)).toEqual([]);
		expect(pixelMotionCues(undefined as never, [], () => null).cues).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Scene cuts, beats, anchors

/** V1: a 10 s footage clip at frame 0 showing media 0…6 s; A1 its audio; A2 a music clip (Essential music). */
function sequence() {
	const h = new Harness();
	const media = h.registerVideo({ seconds: 10 });
	const v = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: media },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 6 } },
		},
	]).results[0] as { clipIds: string[] };
	const music = h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio', seconds: 20 }) }])
		.results[0] as { mediaId: string };
	const m = h.ok([{ type: 'clip.place', source: { mediaId: music.mediaId }, at: 0, tracks: { audio: 'A2' } }])
		.results[0] as { clipIds: string[] };
	const musicClip = m.clipIds[0]!;
	h.ok([{ type: 'essentialSound.setType', clipIds: [musicClip], audioType: 'music' }]);
	return { h, media, videoClip: v.clipIds[0]!, music: music.mediaId, musicClip };
}

const cutsAt = (...s: number[]): ReadonlyMap<string, SceneCutData> => new Map();

describe('scene cuts mapped through the clip', () => {
	it('lists the footage and the music it analyses', () => {
		const { h, media, music, videoClip, musicClip } = sequence();
		const f = footageClips(h.doc, h.seq);
		expect(f).toEqual([
			expect.objectContaining({ clipId: videoClip, mediaId: media, start: 0, end: 180, mediaStartSec: 0 }),
		]);
		expect(f[0]!.mediaEndSec).toBeCloseTo(179 / 30, 6);
		expect(musicClips(h.doc, h.seq)).toEqual([
			expect.objectContaining({ clipId: musicClip, mediaId: music }),
		]);
		// a range clips it
		expect(footageClips(h.doc, h.seq, { start: 30, end: 60 })[0]).toMatchObject({ start: 30, end: 60 });
		expect(musicClips(h.doc, h.seq, { start: 1000, end: 1001 })).toEqual([]);
		expect(cutsAt().size).toBe(0);
	});

	const scene = (media: string, cuts: number[]) => new Map([[media, { cuts }]]);
	const roundTrip = (h: Harness, cues: ExtraCue[]) => {
		for (const c of cues) expect(resolveCueAnchor(h.doc, h.seq, c.anchor)).toBe(c.frame);
	};

	it('100 %: a change at 2 s is a cut at frame 60, anchored to the media time it shows', () => {
		const { h, media, videoClip } = sequence();
		const cues = sceneCutCues(h.doc, h.seq, scene(media, [2, 4.5, 8]));
		expect(cues.map((c) => [c.frame, c.kind])).toEqual([
			[60, 'cut'],
			[135, 'cut'],
		]);
		expect(cues[0]!.anchor).toEqual({ type: 'scene', mediaId: media, mediaSec: 2, clipId: videoClip });
		expect(cues[0]!.reason).toContain('Shot change');
		roundTrip(h, cues);
		// the clip moves: the anchor follows it
		h.ok([{ type: 'clip.move', clipIds: [videoClip], deltaFrames: 15 }]);
		expect(resolveCueAnchor(h.doc, h.seq, cues[0]!.anchor)).toBe(75);
	});

	it('200 %, reverse and a time remap', () => {
		const { h, media, videoClip } = sequence();
		h.ok([{ type: 'clip.setSpeed', clipIds: [videoClip], rate: 2, ripple: false }]);
		let cues = sceneCutCues(h.doc, h.seq, scene(media, [2, 4.5]));
		expect(cues.map((c) => c.frame)).toEqual([30, 68]);
		roundTrip(h, cues);
		h.ok([{ type: 'clip.setSpeed', clipIds: [videoClip], rate: 1, reverse: true, ripple: false }]);
		const c = h.seq.clips[videoClip]!;
		cues = sceneCutCues(h.doc, h.seq, scene(media, [2]));
		// reversed, the picture crosses 2 s where it first shows the old shot's last frame (59/30 s)
		const at = clipMediaTimeFn(c as never, h.seq.settings.frameRate);
		expect(cues).toHaveLength(1);
		expect(at(cues[0]!.frame) / FLICKS_PER_SECOND).toBeLessThan(2);
		expect(at(cues[0]!.frame - 1) / FLICKS_PER_SECOND).toBeGreaterThanOrEqual(2 - 1e-9);
		roundTrip(h, cues);
		// time remap: 50 % from frame 30 (slow motion: several frames within half a frame of each media time)
		h.ok([{ type: 'clip.setSpeed', clipIds: [videoClip], rate: 1, reverse: false, ripple: false }]);
		h.ok([{ type: 'timeRemap.enable', clipIds: [videoClip], enabled: true }]);
		h.ok([{ type: 'timeRemap.addKeyframe', clipId: videoClip, at: 30 }]);
		h.ok([{ type: 'timeRemap.setSpeed', clipId: videoClip, at: 40, speedPercent: 40 }]);
		const cr = h.seq.clips[videoClip]!;
		const atR = clipMediaTimeFn(cr as never, h.seq.settings.frameRate);
		cues = sceneCutCues(h.doc, h.seq, scene(media, [2]));
		expect(cues).toHaveLength(1);
		const f = cues[0]!.frame;
		expect(atR(f) / FLICKS_PER_SECOND).toBeGreaterThanOrEqual(2 - 0.001);
		expect(atR(f - 1) / FLICKS_PER_SECOND).toBeLessThan(2 - 0.001);
		roundTrip(h, cues);
	});

	it('a soft change (the scores stay high around it) is a move; the first frame of a clip is never a scene cut', () => {
		const { h, media } = sequence();
		const times = Array.from({ length: 180 }, (_, i) => i / 30);
		const scores = times.map((t) => (Math.abs(t - 2) < 0.05 ? 0.5 : 0.01));
		const cues = sceneCutCues(
			h.doc,
			h.seq,
			new Map([[media, { cuts: [0, 2], times, scores, threshold: 0.4 }]]),
		);
		expect(cues.map((c) => [c.frame, c.kind])).toEqual([[60, 'move']]);
	});

	it('the same media twice: each cue resolves to its own clip, and to the first showing when that clip is gone', () => {
		const { h, media } = sequence();
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: media },
				at: 300,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 6 } },
				tracks: { video: 'V1', audio: 'A3' },
			},
		]);
		const cues = sceneCutCues(h.doc, h.seq, scene(media, [2]));
		expect(cues.map((c) => c.frame)).toEqual([60, 360]);
		for (const c of cues) expect(resolveCueAnchor(h.doc, h.seq, c.anchor)).toBe(c.frame);
		const second = cues[1]!.anchor as { clipId: string };
		h.ok([{ type: 'clip.lift', clipIds: [second.clipId] }]);
		expect(resolveCueAnchor(h.doc, h.seq, cues[1]!.anchor)).toBe(60);
	});

	it('the topmost footage clip anchors picture motion', () => {
		const { h, media, videoClip } = sequence();
		const other = h.registerVideo({ seconds: 4 });
		const top = h.ok([{ type: 'clip.place', source: { mediaId: other }, at: 30, tracks: { video: 'V2' } }])
			.results[0] as { clipIds: string[] };
		const at = sceneAnchorAt(h.doc, h.seq);
		expect(at(10)?.anchor).toEqual({ type: 'scene', mediaId: media, mediaSec: 10 / 30, clipId: videoClip });
		const a = at(45)!;
		expect(a.anchor).toMatchObject({ mediaId: other, clipId: top.clipIds[0] });
		expect(a.where).toContain('V2');
		expect(resolveCueAnchor(h.doc, h.seq, a.anchor)).toBe(45);
		expect(at(5000)).toBeNull();
	});
});

describe('beats', () => {
	it('beat cues of Essential music clips: frames, downbeat weights, anchors that resolve back', () => {
		const { h, musicClip } = sequence();
		const beats = Array.from({ length: 16 }, (_, i) => 0.25 + i * 0.5);
		const cues = beatCues(
			h.doc,
			h.seq,
			new Map([[musicClip, { beats, downbeats: beats.filter((_, i) => i % 4 === 0), bpm: 120 }]]),
		);
		expect(cues).toHaveLength(16);
		expect(cues.map((c) => c.frame).slice(0, 4)).toEqual([8, 23, 38, 53]);
		expect(cues[0]).toMatchObject({ kind: 'beat', weight: 'support', from: 'beat' });
		expect(cues[1]!.weight).toBe('ambient');
		expect(cues.every((c) => c.weight !== 'hero')).toBe(true);
		for (const c of cues) expect(resolveCueAnchor(h.doc, h.seq, c.anchor)).toBe(c.frame);
		// a clip at 50 % plays its beats twice as far apart
		h.ok([{ type: 'clip.setSpeed', clipIds: [musicClip], rate: 0.5, ripple: false }]);
		const slow = beatCues(h.doc, h.seq, new Map([[musicClip, { beats }]]));
		expect(slow.map((c) => c.frame).slice(0, 3)).toEqual([15, 45, 75]);
		for (const c of slow) expect(resolveCueAnchor(h.doc, h.seq, c.anchor)).toBe(c.frame);
		// not music → no beats
		h.ok([{ type: 'essentialSound.setType', clipIds: [musicClip], audioType: 'sfx' }]);
		expect(beatCues(h.doc, h.seq, new Map([[musicClip, { beats }]]))).toEqual([]);
	});

	it('snapping: only move / transition / emphasis / reveal, ≤ 2 frames, the offset kept as anchorOffset', () => {
		const { h, videoClip } = sequence();
		const base = {
			weight: 'support' as const,
			types: [],
			align: 'peak' as const,
			anchor: { type: 'clip' as const, clipId: videoClip, edge: 'start' as const },
			confidence: 0.5,
			reason: 'r',
			source: 'derived' as const,
			from: 'keyframes' as const,
			score: 1,
		};
		const cues = [
			{ ...base, key: 'a', frame: 10, kind: 'move' as const },
			{ ...base, key: 'b', frame: 30, kind: 'cut' as const },
			{ ...base, key: 'c', frame: 47, kind: 'transition' as const },
			{ ...base, key: 'd', frame: 70, kind: 'land' as const },
			{ ...base, key: 'e', frame: 100, kind: 'move' as const },
			{ ...base, key: 'f', frame: 120, kind: 'move' as const, source: 'marker' as const },
		];
		const r = snapCuesToBeats(cues, [12, 31, 50, 71, 103, 121]);
		expect(r.cues.map((c) => [c.key, c.frame, c.anchorOffset])).toEqual([
			['a', 12, 2],
			['b', 30, undefined],
			['c', 47, undefined], // 3 frames away
			['d', 70, undefined],
			['e', 100, undefined],
			['f', 120, undefined],
		]);
		expect(r.snapped).toBe(1);
		expect(r.cues[0]!.reason).toContain('on the beat (+2 frames)');
		// the stored cue keeps following its anchor at that offset
		const input = cueInputFromDerived(r.cues[0]!);
		expect(input.anchorOffset).toBe(2);
		expect(cueAnchorFrame(h.doc, h.seq, { anchor: r.cues[0]!.anchor, anchorOffset: 2 })).toBe(2);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// deriveCues with engine cues

describe('deriveCues with engine cues', () => {
	it('scene cuts under dialogue are silenced; pixel motion gives way to the keyframe source; stats per source', () => {
		const { h, media, videoClip } = sequence();
		const scene = sceneCutCues(h.doc, h.seq, new Map([[media, { cuts: [2, 4.5] }]]));
		// dialogue 4–5 s on A1: the clip's own audio as Essential dialogue covers the whole clip, so use a short one
		const speech = h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio', seconds: 2 }) }])
			.results[0] as { mediaId: string };
		const sp = h.ok([
			{ type: 'clip.place', source: { mediaId: speech.mediaId }, at: 120, tracks: { audio: 'A3' } },
		]).results[0] as { clipIds: string[] };
		h.ok([{ type: 'essentialSound.setType', clipIds: sp.clipIds, audioType: 'dialogue' }]);
		const r = deriveCues(h.doc, h.seqId, { extraCues: scene, sources: ['scene'] });
		expect(r.cues.map((c) => c.frame)).toEqual([60]);
		expect(r.stats.bySource.scene).toMatchObject({ found: 1, kept: 1, suppressedByDialogue: 1 });
		const r2 = deriveCues(h.doc, h.seqId, { extraCues: scene, sources: ['scene'], respectDialogue: false });
		expect(r2.cues.map((c) => c.frame)).toEqual([60, 135]);
		// a keyframed move on the footage: the pixel source's measurement of it gives way
		const path = ['clip', videoClip, 'transform', 'position'];
		h.ok([
			{ type: 'param.setAnimated', target: path, animated: true, at: { frames: 0 } },
			{ type: 'keyframe.add', target: path, at: { frames: 140 }, value: [960, 540], interpolation: 'linear' },
			{
				type: 'keyframe.add',
				target: path,
				at: { frames: 160 },
				value: [1400, 540],
				interpolation: 'linear',
			},
		]);
		const kf = deriveCues(h.doc, h.seqId, { sources: ['keyframes'] }).cues.find((c) => c.kind === 'move')!;
		const at = sceneAnchorAt(h.doc, h.seq);
		const pixel: ExtraCue[] = [
			{ ...pixelLike(kf.frame + 2, at), key: 'pixel:near' },
			{ ...pixelLike(30, at), key: 'pixel:far' },
		];
		const r3 = deriveCues(h.doc, h.seqId, { extraCues: pixel, sources: ['keyframes', 'pixel'] });
		expect(r3.stats.bySource.pixel).toMatchObject({ found: 2, kept: 1, merged: 1 });
		expect(r3.cues.find((c) => c.from === 'pixel')?.frame).toBe(30);
		// without the keyframe source, the pixel cue stands
		const r4 = deriveCues(h.doc, h.seqId, { extraCues: pixel, sources: ['pixel'] });
		expect(r4.cues.filter((c) => c.from === 'pixel')).toHaveLength(2);
		// unselected engine sources contribute nothing
		expect(
			deriveCues(h.doc, h.seqId, { extraCues: pixel, sources: ['edits'] }).stats.bySource.pixel.found,
		).toBe(0);
	});

	it('snapToBeats moves derived moves onto beats and counts them; the stored cue resyncs at its offset', () => {
		const { h, videoClip, musicClip } = sequence();
		const path = ['clip', videoClip, 'transform', 'position'];
		h.ok([
			{ type: 'param.setAnimated', target: path, animated: true, at: { frames: 0 } },
			{ type: 'keyframe.add', target: path, at: { frames: 20 }, value: [960, 540], interpolation: 'linear' },
			{ type: 'keyframe.add', target: path, at: { frames: 41 }, value: [1600, 540], interpolation: 'linear' },
		]);
		const plain = deriveCues(h.doc, h.seqId, { sources: ['keyframes'] }).cues.find((c) => c.kind === 'move')!;
		const beatSec = (plain.frame + 2) / 30;
		const beats = beatCues(h.doc, h.seq, new Map([[musicClip, { beats: [beatSec] }]]));
		const r = deriveCues(h.doc, h.seqId, { sources: ['keyframes'], extraCues: beats, snapToBeats: true });
		const move = r.cues.find((c) => c.kind === 'move')!;
		expect(move.frame).toBe(plain.frame + 2);
		expect(move.anchorOffset).toBe(2);
		expect(r.stats.snappedToBeat).toBe(1);
		// stored: resync keeps it on the beat, and follows the clip
		h.ok([{ type: 'soundCue.add', cues: [cueInputFromDerived(move)] }]);
		const cue = soundCuesOf(h.seq)[0]!;
		expect(cue.anchorOffset).toBe(2);
		const before = h.doc;
		const res = h.ok([{ type: 'soundCue.resync' }]).results[0] as { moved: unknown[] };
		expect(res.moved).toEqual([]);
		h.ok([{ type: 'clip.move', clipIds: [videoClip], deltaFrames: 10 }]);
		const moved = h.ok([{ type: 'soundCue.resync' }]).results[0] as { moved: { to: number }[] };
		expect(moved.moved[0]!.to).toBe(plain.frame + 12);
		expect(before).not.toBe(h.doc);
		// explicit beat frames work without beat cues
		const r2 = deriveCues(h.doc, h.seqId, {
			sources: ['keyframes'],
			snapToBeats: true,
			beatFrames: [plain.frame + 9],
		});
		expect(r2.cues.find((c) => c.kind === 'move')!.frame).toBe(plain.frame + 9);
	});

	it('anchorOffset: stored with its anchor, dropped with it, refused without one; undo / redo', () => {
		const { h, videoClip } = sequence();
		const anchor = { type: 'clip', clipId: videoClip, edge: 'start' };
		const before = h.doc;
		const snapshot = structuredClone(before);
		const add = [
			{
				type: 'soundCue.add',
				cues: [{ frame: 2, kind: 'move', weight: 'support', source: 'derived', anchor, anchorOffset: 2 }],
			},
		];
		const run = () =>
			applyTransaction(
				before,
				{ label: 'test', origin: 'user', sequenceId: h.seqId, commands: add as never },
				makeCtx({ revision: h.revision }, createCounterIdSource(77)),
			);
		const first = run();
		expect(first.result.ok).toBe(true);
		// undo = the untouched document before; redo = the same document again
		expect(structuredClone(before)).toEqual(snapshot);
		expect(run().document).toEqual(first.document);
		expect(checkInvariants(first.document)).toEqual([]);
		h.doc = first.document;
		h.revision = first.result.revision;
		const id = soundCuesOf(h.seq)[0]!.id;
		expect(cueAnchorFrame(h.doc, h.seq, soundCuesOf(h.seq)[0]!)).toBe(2);
		expect(soundCuesOf(h.seq)[0]!.anchorOffset).toBe(2);
		h.ok([{ type: 'soundCue.update', cueId: id, anchor: null }]);
		expect(soundCuesOf(h.seq)[0]!.anchorOffset).toBeUndefined();
		const bad = h.tx([
			{
				type: 'soundCue.add',
				cues: [{ frame: 1, kind: 'move', weight: 'support', source: 'user', anchorOffset: 1 }],
			},
		]);
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		const bad2 = h.tx([{ type: 'soundCue.update', cueId: id, anchorOffset: 3 }]);
		expect(!bad2.ok && bad2.errors[0]!.code).toBe('E_INVALID_PARAM');
		const tooFar = h.tx([
			{
				type: 'soundCue.add',
				cues: [{ frame: 1, kind: 'move', weight: 'support', source: 'user', anchor, anchorOffset: 11 }],
			},
		]);
		expect(tooFar.ok).toBe(false);
		// repair keeps a valid offset and drops a broken one
		const raw = { cues: { [id]: { ...soundCuesOf(h.seq)[0], anchor, anchorOffset: 'x' } } };
		expect(readSoundDesign(raw)?.cues[id]?.anchorOffset).toBeUndefined();
		const ok = { cues: { [id]: { ...soundCuesOf(h.seq)[0], anchor, anchorOffset: -2 } } };
		expect(readSoundDesign(ok)?.cues[id]?.anchorOffset).toBe(-2);
	});
});

function pixelLike(frame: number, at: ReturnType<typeof sceneAnchorAt>): ExtraCue {
	return {
		frame,
		kind: 'move',
		weight: 'support',
		types: ['whoosh'],
		align: 'peak',
		anchor: at(frame)!.anchor,
		confidence: 0.45,
		reason: 'Picture motion',
		from: 'pixel',
		size: 0.3,
	};
}

describe('engine-source mappers on hostile input', () => {
	it('fuzzed sequences and measurements (testkit mutateJson): never throw, frames are integers, deterministic', () => {
		const rng = new Rng(fuzzSeed());
		const { h, media, musicClip } = sequence();
		const seed = h.doc.sequences[h.seqId]!;
		const junk = [null, 1.5, -3, Number.NaN, 'x', {}, [], [Number.POSITIVE_INFINITY], [2, 'a', -1]];
		const runs = 200 * fuzzScale();
		for (let i = 0; i < runs; i++) {
			const doc = structuredClone(h.doc);
			doc.sequences[h.seqId] = mutateJson(rng, seed, [seed]) as never;
			const seq = doc.sequences[h.seqId]!;
			const cuts = rng.chance(0.3) ? rng.pick(junk) : [rng.below(10), rng.below(10) / 3];
			const beats = rng.chance(0.3)
				? rng.pick(junk)
				: Array.from({ length: rng.below(30) }, () => rng.below(40) / 2);
			const range = rng.chance(0.3)
				? rng.pick(junk)
				: rng.chance(0.5)
					? { start: rng.below(100), end: rng.below(400) }
					: undefined;
			const run = () => {
				const sc = sceneCutCues(doc, seq, new Map([[media, { cuts } as never]]), { range } as never);
				const bc = beatCues(doc, seq, new Map([[musicClip, { beats, downbeats: rng.pick(junk) } as never]]), {
					range,
				} as never);
				const at = sceneAnchorAt(doc, seq);
				const px = [at(rng.below(400)), at(Number.NaN as never), at(-1)];
				footageClips(doc, seq, range as never);
				musicClips(doc, seq, range as never);
				return { sc, bc, px };
			};
			let a: ReturnType<typeof run>;
			try {
				a = run();
			} catch (e) {
				throw new Error(`engine-source mapper threw on fuzz case ${i} (seed ${fuzzSeed()}): ${e}`);
			}
			for (const c of [...a.sc, ...a.bc]) expect(Number.isInteger(c.frame)).toBe(true);
			const snapped = snapCuesToBeats(
				a.sc.map((c) => ({ ...c, key: c.key ?? 'k', source: 'derived' as const, score: 1 })),
				rng.pick([junk[5], [1, 2, 3], [Number.NaN, 4]]) as never,
			);
			for (const c of snapped.cues) expect(Number.isInteger(c.frame)).toBe(true);
		}
	});
});
