// Shared by the frame-rate conform tests (docs/wp-notes/time.md §15): the cases, the time model's expected source
// frames, and readers for the 12-bit frame code and the colour patches of scripts/fixtures/fpsmap.mjs.
import { spawnSync } from 'node:child_process';
import type { RegisteredMedia } from '@jasper/api';
import { FLICKS_PER_SECOND, frameIndexAt } from '@jasper/project';
import type { Rgba8 } from '@jasper/testkit/image';
import {
	FPSMAP_BITS,
	FPSMAP_PATCHES,
	fpsmapBitCentre,
	fpsmapPatchRect,
} from '../../../scripts/fixtures/fpsmap.mjs';
import type { DocBuilder } from './helpers.ts';

export type R = { num: number; den: number };
export type ConformCase = {
	name: string;
	file: string;
	media: R;
	seq: R;
	/** First source frame of the clip, the sequence frame it starts at, and its length in sequence frames. */
	inFrame: number;
	at: number;
	frames: number;
	/** Constant speed (Frame Sampling), default 1. */
	speed?: number;
	/** Frame Hold at this sequence frame (Hold On: sequence time). */
	holdAt?: number;
};
const r = (num: number, den = 1): R => ({ num, den });
export const R2997 = r(30000, 1001);

/** The conversions of the brief, a slipped clip that starts later, and same-rate controls. */
export const CONFORM_CASES: ConformCase[] = [
	{ name: '29.97 → 30', file: 'rate-code-2997.mp4', media: R2997, seq: r(30), inFrame: 0, at: 0, frames: 1040 },
	{
		name: '29.97 → 30 (in-point 37, at frame 5)',
		file: 'rate-code-2997.mp4',
		media: R2997,
		seq: r(30),
		inFrame: 37,
		at: 5,
		frames: 90,
	},
	{
		name: '23.976 → 24',
		file: 'rate-code-23976.mp4',
		media: r(24000, 1001),
		seq: r(24),
		inFrame: 0,
		at: 0,
		frames: 850,
	},
	{ name: '25 → 30', file: 'rate-code-25.mp4', media: r(25), seq: r(30), inFrame: 0, at: 0, frames: 120 },
	{ name: '60 → 30', file: 'rate-code-60.mp4', media: r(60), seq: r(30), inFrame: 0, at: 0, frames: 120 },
	{ name: '30 → 29.97', file: 'rate-code-30.mp4', media: r(30), seq: R2997, inFrame: 0, at: 0, frames: 1040 },
	{ name: '30 → 30', file: 'rate-code-30.mp4', media: r(30), seq: r(30), inFrame: 11, at: 3, frames: 60 },
];
/** Further Frame Sampling cases of the same timing rule (native path). */
export const TIMING_EXTRA_CASES: ConformCase[] = [
	{ name: '30 → 30 at 70 %', file: 'rate-code-30.mp4', media: r(30), seq: r(30), inFrame: 0, at: 0, frames: 90, speed: 0.7 },
	{
		name: '29.97 → 30 held at frame 7',
		file: 'rate-code-2997.mp4',
		media: R2997,
		seq: r(30),
		inFrame: 0,
		at: 0,
		frames: 30,
		holdAt: 7,
	},
];

/** BT.709 tagged, BT.601 untagged SD, BT.601 tagged SD, BT.709 untagged HD (placed at 50 %). */
export const COLOUR_FILES = [
	'rate-code-2997.mp4',
	'rate-code-2997-sd601.mp4',
	'rate-code-2997-sd601-tagged.mp4',
	'rate-code-2997-hd-untagged.mp4',
];

/** The case's sequence (640 × 360 at its rate) with its clip on V1; `hybrid` adds a browser-only no-op effect. */
export function buildConform(
	d: DocBuilder,
	media: RegisteredMedia,
	c: ConformCase,
	hybrid = false,
): { clipId: string } {
	d.tx([{ type: 'sequence.updateSettings', settings: { width: 640, height: 360, frameRate: c.seq } }]);
	const m = d.addMedia(media);
	const speed = c.speed ?? 1;
	const span = Math.ceil((c.frames * speed * c.media.num * c.seq.den) / (c.media.den * c.seq.num)) + 2;
	const placed = d.tx([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: c.at,
			sourceRange: { in: { sourceFrames: c.inFrame }, out: { sourceFrames: c.inFrame + span } },
			matchSequence: 'keep',
			audio: false,
		},
	]);
	const clipId = (placed.results[0] as { clipIds: string[] }).clipIds[0]!;
	if (speed !== 1) d.tx([{ type: 'clip.setSpeed', clipIds: [clipId], rate: speed, ripple: false }]);
	if (c.file.includes('-hd-'))
		d.tx([{ type: 'param.set', target: ['clip', clipId, 'transform', 'scale'], value: 50 }]);
	const clip = d.doc.sequences[d.seqId]!.clips[clipId]!;
	if (clip.duration !== c.frames)
		d.tx([{ type: 'clip.trim', clipId, edge: 'out', deltaFrames: c.frames - clip.duration }]);
	if (c.holdAt !== undefined)
		d.tx([
			{
				type: 'clip.frameHoldOptions',
				clipIds: [clipId],
				enabled: true,
				holdOn: 'sequence-time',
				at: c.holdAt,
			},
		]);
	// hybrid: a browser-only effect that leaves the picture as it is (the mirror line is the right edge) bakes the
	// whole layer through the compositions (layer bake).
	if (hybrid)
		d.tx([
			{
				type: 'effect.add',
				target: { clipId },
				effectId: 'jasper.mirror',
				params: { reflectionCenter: [1, 0.5], reflectionAngle: 0 },
			},
		]);
	return { clipId };
}

/**
 * The source frame the time model shows at every sequence frame of the case's clip (S01:CLP-004 / the frame hold, then
 * `frameIndexAt`); −1 before the clip.
 */
export function modelFrames(d: DocBuilder, clipId: string, c: ConformCase): number[] {
	const clip = d.doc.sequences[d.seqId]!.clips[clipId]! as {
		start: number;
		duration: number;
		sourceIn: number;
		speed: { rate: number };
		frameHold?: { flicks: number } | null;
	};
	const F = (FLICKS_PER_SECOND * c.seq.den) / c.seq.num;
	return Array.from({ length: clip.start + clip.duration }, (_, f) => {
		if (f < clip.start) return -1;
		const content = clip.frameHold
			? clip.frameHold.flicks
			: clip.sourceIn + (f - clip.start) * F * clip.speed.rate;
		return frameIndexAt({ kind: 'cfr', rate: c.media, count: 1 << 20 }, content / FLICKS_PER_SECOND);
	});
}

/** The code of every frame of `file`, read at the bit centres; frames before `at` are −1 (not compared). */
export function readCodes(file: string, at = 0, length = Number.POSITIVE_INFINITY): number[] {
	const x0 = fpsmapBitCentre(0).x;
	const w = fpsmapBitCentre(FPSMAP_BITS - 1).x - x0 + 1;
	const run = spawnSync(
		'ffmpeg',
		[
			...['-v', 'error', '-i', file],
			...['-vf', `format=rgb24,crop=${w}:1:${x0}:${fpsmapBitCentre(0).y}`],
			...['-fps_mode', 'passthrough', '-f', 'rawvideo', '-'],
		],
		{ maxBuffer: 1 << 28 },
	);
	if (run.status !== 0) throw new Error(run.stderr.toString());
	const out: number[] = [];
	for (let i = 0; i + w * 3 <= run.stdout.length && out.length < length; i += w * 3) {
		let code = 0;
		for (let b = 0; b < FPSMAP_BITS; b++) if (run.stdout[i + 50 * b * 3 + 1]! > 127) code |= 1 << b;
		out.push(out.length < at ? -1 : code);
	}
	return out;
}

/** The code shown in an RGBA picture. */
export function codeOf(img: Rgba8): number {
	let code = 0;
	for (let b = 0; b < FPSMAP_BITS; b++) {
		const p = fpsmapBitCentre(b);
		if (img.data[(p.y * img.width + p.x) * 4 + 1]! > 127) code |= 1 << b;
	}
	return code;
}

/** Frame `n` of an export as RGBA (BT.709 limited decode: every export is tagged so). */
export function decodeFrame(file: string, n: number, width = 640, height = 360): Rgba8 {
	const run = spawnSync(
		'ffmpeg',
		[
			...['-v', 'error', '-i', file],
			...[
				'-vf',
				`select=eq(n\\,${n}),scale=in_color_matrix=bt709:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=rgba`,
			],
			...['-frames:v', '1', '-f', 'rawvideo', '-'],
		],
		{ maxBuffer: 1 << 26 },
	);
	if (run.status !== 0) throw new Error(run.stderr.toString());
	return { width, height, data: new Uint8Array(run.stdout) } as Rgba8;
}

/** Mean R, G, B of each patch (inset from its edges). */
export function patchMeans(img: Rgba8): number[][] {
	return FPSMAP_PATCHES.map((_, i) => {
		const p = fpsmapPatchRect(i);
		const s = [0, 0, 0];
		for (let y = p.y; y < p.y + p.h; y++)
			for (let x = p.x; x < p.x + p.w; x++)
				for (let k = 0; k < 3; k++) s[k]! += img.data[(y * img.width + x) * 4 + k]!;
		return s.map((v) => v / (p.w * p.h));
	});
}
export const SOURCE_PATCHES = FPSMAP_PATCHES.map((p) => [...p]);

/** Largest per-channel difference of two patch tables (`channels`: which of R, G, B count). */
export function maxPatchError(a: number[][], b: number[][], channels: readonly number[] = [0, 1, 2]): number {
	return Math.max(...a.flatMap((p, i) => channels.map((k) => Math.abs(p[k]! - b[i]![k]!))));
}

/** Frames where `got` differs from `want` (−1 entries are skipped). */
export function mismatches(want: readonly number[], got: readonly number[]): number[] {
	return want.map((w, f) => (w >= 0 && got[f] !== w ? f : -1)).filter((f) => f >= 0);
}
