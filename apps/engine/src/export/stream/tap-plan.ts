// spec 13 AS-072 — the plan of a kernel stream (what `streamTaps` in taps.ts writes): its members and the union
// rectangle they are drawn in. Pure (no process plumbing), so the native graph builder imports it without the runner.
import type { Rational } from '@jasper/project';
import type { OverrideReady } from '../native-ext.ts';
import { shiftProgram, type TapFrame } from './lowered.ts';

/** A picture of a member: `inputs` + `filter` (ending in a `w × h` RGBA stream) decoded for one frame. */
export type TapPicture = { w: number; h: number; inputs: string[][]; filter: string };

export type TapMember = {
	clipId: string;
	/** Sequence frames `[f0, f1)` the member draws. */
	f0: number;
	f1: number;
	pictures: TapPicture[];
	/** One per frame of `[f0, f1)`, in sequence px (`planTapStream` moves them into the stream's frame). */
	frames: TapFrame[];
	/**
	 * spec 13 AS-076: the member's still is being baked (pipelined): the stream waits for it before decoding; a
	 * trimmed layer still re-plans the member (`refresh`, sequence px) inside the stream's frame.
	 */
	ready?: Promise<OverrideReady>;
	refresh?(picture: { x: number; y: number; w: number; h: number }): { pictures: TapPicture[]; frames: TapFrame[] };
};

export type TapStreamPlan = {
	kind: 'taps';
	members: TapMember[];
	/** Where the stream's frame sits in the sequence frame (overlay offset). */
	x: number;
	y: number;
	outW: number;
	outH: number;
	/** Sequence frames `[g0, g1)` the stream covers (its frame 0 = `g0`). */
	g0: number;
	g1: number;
	fps: Rational;
};

/**
 * The stream of `members` (non-overlapping, any order) in a `W × H` sequence: the union of their drawn rectangles,
 * frame programs moved into it. Throws when two members overlap in time (callers group by track).
 */
export function planTapStream(
	members: readonly TapMember[],
	W: number,
	H: number,
	fps: Rational,
): TapStreamPlan {
	const sorted = [...members].sort((a, b) => a.f0 - b.f0);
	for (let i = 1; i < sorted.length; i++)
		if (sorted[i]!.f0 < sorted[i - 1]!.f1)
			throw new Error(`stream members ${sorted[i - 1]!.clipId} and ${sorted[i]!.clipId} overlap in time`);
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const m of sorted)
		for (const f of m.frames) {
			if (!f.rect) continue;
			x0 = Math.min(x0, f.rect[0]);
			y0 = Math.min(y0, f.rect[1]);
			x1 = Math.max(x1, f.rect[2]);
			y1 = Math.max(y1, f.rect[3]);
		}
	if (!Number.isFinite(x0)) [x0, y0, x1, y1] = [0, 0, 1, 1];
	x0 = Math.max(0, Math.min(W - 1, x0));
	y0 = Math.max(0, Math.min(H - 1, y0));
	x1 = Math.max(x0 + 1, Math.min(W, x1));
	y1 = Math.max(y0 + 1, Math.min(H, y1));
	const out: TapMember[] = sorted.map((m) => ({ ...m, frames: toStreamFrames(m.frames, x0, y0) }));
	return {
		kind: 'taps',
		members: out,
		x: x0,
		y: y0,
		outW: x1 - x0,
		outH: y1 - y0,
		g0: sorted[0]?.f0 ?? 0,
		g1: sorted[sorted.length - 1]?.f1 ?? 0,
		fps,
	};
}

/** Frames in sequence px → frames of a stream whose frame sits at `(x0, y0)`. */
export function toStreamFrames(frames: readonly TapFrame[], x0: number, y0: number): TapFrame[] {
	return frames.map((f) =>
		f.rect
			? {
					...f,
					rect: [f.rect[0] - x0, f.rect[1] - y0, f.rect[2] - x0, f.rect[3] - y0],
					prog: shiftProgram(f.prog, x0, y0),
				}
			: f,
	);
}
