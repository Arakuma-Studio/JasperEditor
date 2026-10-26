// spec 13 AS-072 — the members of kernel streams (taps.ts): what each kind of constant-picture layer decodes once and
// how its frames are drawn, all in sequence pixels.
import type { Rational, RenderVisualClip } from '@jasper/project';
import { isFeatheredCrop } from '../crop.ts';
import { type LoweredPicture, planLoweredFrames, shiftProgram, singleTap, type TapFrame } from './lowered.ts';
import type { StreamLayerPlan } from './plan.ts';
import type { TapMember, TapPicture } from './tap-plan.ts';

/** The decode chain of a layer (`layerSourceChain`), for the level pictures of a constant source. */
export type MemberChain = {
	input: string;
	filters: string[];
	width: number;
	height: number;
	resize: { index: number; options: string } | null;
};

/** The chain's filter text at picture size `w × h` (the sub-pixel kernel's pre-scale to a mip level). */
export function levelFilter(chain: MemberChain, w: number, h: number): string {
	const filters = [...chain.filters];
	if (w !== chain.width || h !== chain.height) {
		if (chain.resize) filters.splice(chain.resize.index, 1, `scale=${w}:${h}${chain.resize.options}`);
		else filters.push(`scale=${w}:${h}:flags=bicubic`, 'format=rgba');
	}
	return `${chain.input}${filters.join(',')}`;
}

/**
 * True when the clip's decoded picture is the same on every frame, so it can be decoded once: a still image or a
 * solid whose only effects are hard crops (the kernel's clip, per frame) and flips. Colour effects and feathered
 * crops (filters that may change per frame) keep the layer its own stream.
 */
export function constantSource(c: RenderVisualClip): boolean {
	if (c.kind !== 'still' && c.kind !== 'solid') return false;
	if (c.frameHold || c.retime || c.timeRemap) return false;
	return c.effects.every(
		(fx) =>
			!fx.enabled ||
			fx.effectId === 'jasper.flip-horizontal' ||
			fx.effectId === 'jasper.flip-vertical' ||
			(fx.effectId === 'jasper.crop' && !isFeatheredCrop(fx)),
	);
}

/** A member from a sub-pixel stream plan of a constant source (`planStreamLayer`; no masks). */
export function chainMember(
	clipId: string,
	f0: number,
	f1: number,
	plan: StreamLayerPlan,
	chain: MemberChain,
): TapMember | null {
	if (plan.frames.some((f) => f.mask)) return null;
	const pictures: TapPicture[] = [];
	const index = new Map<string, number>();
	const frames: TapFrame[] = plan.frames.map((f, k) => {
		const key = `${f.cw}x${f.ch}`;
		let level = index.get(key);
		if (level === undefined) {
			level = pictures.length;
			index.set(key, level);
			pictures.push({ w: f.cw, h: f.ch, inputs: plan.inputs, filter: levelFilter(chain, f.cw, f.ch) });
		}
		if (!f.inv || !f.rect) return { rect: null, opacity: 0, level, prog: [0, 1] };
		const X = plan.offsets.x[k]!;
		const Y = plan.offsets.y[k]!;
		const inv = f.inv as [number, number, number, number, number, number];
		return {
			rect: [f.rect[0] + X, f.rect[1] + Y, f.rect[2] + X, f.rect[3] + Y],
			opacity: f.opacity,
			level,
			// Output px of the plan's frame = sequence px − (X, Y).
			prog: shiftProgram(singleTap(inv, f.clip), -X, -Y),
		};
	});
	return { clipId, f0, f1, pictures, frames };
}

/**
 * A member from a baked still placed in sequence space (static DOM layer, LBK-004/005): drawn at its rect by an
 * integer translation (an exact copy).
 */
export function stillMember(
	clipId: string,
	f0: number,
	f1: number,
	still: { path: string; rect: { x: number; y: number; w: number; h: number } | null },
	seq: { W: number; H: number; swsFlags: string },
): TapMember {
	const r = still.rect ?? { x: 0, y: 0, w: seq.W, h: seq.H };
	const rect: [number, number, number, number] = [
		Math.max(0, r.x),
		Math.max(0, r.y),
		Math.min(seq.W, r.x + r.w),
		Math.min(seq.H, r.y + r.h),
	];
	const visible = rect[2] > rect[0] && rect[3] > rect[1];
	const prog = singleTap([1, 0, -r.x, 0, 1, -r.y], [0, 0, r.w, r.h]);
	const frame: TapFrame = visible
		? { rect, opacity: 1, level: 0, prog }
		: { rect: null, opacity: 0, level: 0, prog: [0, 1] };
	return {
		clipId,
		f0,
		f1,
		pictures: [
			{
				w: r.w,
				h: r.h,
				inputs: [['-i', still.path]],
				filter: `[0:v:0]scale=${r.w}:${r.h}:${seq.swsFlags},setsar=1,format=rgba`,
			},
		],
		frames: Array.from({ length: f1 - f0 }, () => frame),
	};
}

/** A member from a lowered layer's still (`layer-still` bake): Motion, Transform and S_Shake per frame (lowered.ts). */
export function loweredMember(
	c: RenderVisualClip,
	f0: number,
	f1: number,
	still: { path: string; picture: LoweredPicture },
	seq: { W: number; H: number; fps: Rational; swsFlags: string },
): TapMember {
	const { frames, levels } = planLoweredFrames({
		clip: c,
		f0,
		f1,
		fps: seq.fps,
		picture: still.picture,
		W: seq.W,
		H: seq.H,
	});
	return {
		clipId: c.clipId,
		f0,
		f1,
		pictures: levels.map((lv) => ({
			w: lv.w,
			h: lv.h,
			inputs: [['-i', still.path]],
			filter:
				lv.w === still.picture.w && lv.h === still.picture.h
					? '[0:v:0]format=rgba'
					: `[0:v:0]format=rgba,scale=${lv.w}:${lv.h}:${seq.swsFlags},format=rgba`,
		})),
		frames,
	};
}
