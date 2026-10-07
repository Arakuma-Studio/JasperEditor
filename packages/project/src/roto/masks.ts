// Convert to Masks (parity workstream `roto`): the outlines of a roto object's computed matte (auto-traced by the
// engine with the masks workstream's `tracePaths`) become Opacity masks of its clip — one mask per outline at a frame
// (holes subtract), or one animated mask following the object's main outline over its frames.
import type { BezierPath } from '../path/model.ts';
import type { Rational } from '../time.ts';
import { mediaFrameFlicks } from './index.ts';

export type TracedMatteFrame = {
	frame: number;
	paths: { path: BezierPath; depth: number; area: number }[];
};

/**
 * `mask.add` / `mask.setPathKeys` commands for traced matte frames. `still`: one mask per outline of the first frame
 * (depth odd = a hole → Subtract); `animated`: one mask on the largest outline of each frame, keyed at every frame
 * (content time of the media frame).
 */
export function rotoMaskCommands(opts: {
	clipId: string;
	rate: Rational;
	frames: readonly TracedMatteFrame[];
	mode: 'still' | 'animated';
	name: string;
	feather?: number;
}): unknown[] {
	const { clipId, frames } = opts;
	const first = frames[0];
	if (!first) return [];
	const base = {
		type: 'mask.add',
		clipId,
		shape: 'bezier',
		...(opts.feather !== undefined ? { feather: opts.feather } : {}),
	};
	if (opts.mode === 'still')
		return first.paths.map((p, i) => ({
			...base,
			path: p.path,
			name: first.paths.length > 1 ? `${opts.name} ${i + 1}` : opts.name,
			mode: p.depth % 2 === 1 ? 'subtract' : 'add',
		}));
	const largest = (f: TracedMatteFrame) =>
		f.paths.filter((p) => p.depth % 2 === 0).sort((a, b) => Math.abs(b.area) - Math.abs(a.area))[0];
	const keys = frames
		.map((f) => ({ f, p: largest(f) }))
		.filter((x): x is { f: TracedMatteFrame; p: NonNullable<ReturnType<typeof largest>> } => !!x.p)
		.map(({ f, p }) => ({ at: { flicks: mediaFrameFlicks(f.frame, opts.rate) }, path: p.path }));
	if (keys.length === 0) return [];
	const ref = '$rotoMask';
	return [
		{ ...base, path: keys[0]!.path, name: opts.name, mode: 'add', ref },
		...(keys.length > 1 ? [{ type: 'mask.setPathKeys', maskId: ref, keys }] : []),
	];
}
