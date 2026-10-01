// Effect Controls mini-timeline In/Out bars (S11:TXA-022): drawn over the head and tail of the clip bar of the
// ruler with the windows as rendered (compressed when In + Out exceed the clip); dragging a bar's inner edge
// changes that side's duration — one gesture, one undo step (Escape cancels).
import {
	type Clip,
	compressAnimationWindows,
	resolveTextAnimationWindows,
	type TextAnimationSide,
} from '@jasper/project';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { pctOf, type Range } from '../panels/effectControls/lib.ts';
import type { InspectorOps } from '../panels/properties/lib/ops.ts';

/**
 * The stored `durationFrames` of `side` that renders a window of `shown` frames (the smallest such value, so an
 * uncompressed window stores exactly what it shows) against the other side's stored length (0 = none): the
 * inverse of the proportional compression, so a dragged edge tracks the pointer even while the windows are
 * compressed. Clamped to the longest window the clip can show.
 */
function storedFramesForWindow(
	duration: number,
	side: TextAnimationSide,
	shown: number,
	otherStored: number,
): number {
	const other = otherStored > 0 ? Math.max(1, Math.round(otherStored)) : 0;
	const windowOf = (stored: number) => {
		const w =
			side === 'in'
				? compressAnimationWindows(duration, stored, other)
				: compressAnimationWindows(duration, other, stored);
		return w[side];
	};
	let lo = 1;
	let hi = Math.max(1, Math.floor(duration)) * Math.max(1, other) + 1;
	// The longest window is reached by then (both sides keep ≥ 1 frame); windowOf is non-decreasing.
	const target = Math.min(windowOf(hi), Math.max(1, Math.round(shown)));
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (windowOf(mid) >= target) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

export function TextAnimationBars({ clip, range, ops }: { clip: Clip; range: Range; ops: InspectorOps }) {
	if (clip.kind !== 'text' || !clip.textAnimation) return null;
	const w = resolveTextAnimationWindows(clip);
	const startDrag = (
		e: ReactPointerEvent<HTMLElement>,
		side: TextAnimationSide,
		frames: number,
		shown: number,
	) => {
		if (e.button !== 0) return;
		// The ruler under the bars seeks on press.
		e.stopPropagation();
		e.preventDefault();
		const ruler = (e.currentTarget as HTMLElement).closest('[data-testid="ec-ruler"]');
		const width = ruler?.getBoundingClientRect().width || 1;
		const framesPerPx = (range.end - range.start) / width;
		const x0 = e.clientX;
		const label = `${side === 'in' ? 'In' : 'Out'} Animation Duration`;
		if (!ops.scrub.start(label)) return;
		let last = frames;
		const otherStored = clip.textAnimation?.[side === 'in' ? 'out' : 'in']?.durationFrames ?? 0;
		const move = (ev: PointerEvent) => {
			const delta = Math.round((ev.clientX - x0) * framesPerPx) * (side === 'in' ? 1 : -1);
			// The bar is drawn at the rendered (maybe compressed) window: move that edge with the pointer.
			const next = storedFramesForWindow(clip.duration, side, shown + delta, otherStored);
			if (next === last) return;
			last = next;
			ops.scrub.update([
				{
					type: 'clip.update',
					clipId: clip.id,
					patch: { textAnimation: { [side]: { durationFrames: next } } },
				},
			]);
		};
		const end = (cancelled: boolean) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('keydown', key, true);
			ops.scrub.end(cancelled || last === frames);
		};
		const up = () => end(false);
		const key = (ev: KeyboardEvent) => {
			if (ev.key === 'Escape') end(true);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('keydown', key, true);
	};
	const bar = (side: TextAnimationSide) => {
		const a = w[side];
		const stored = clip.textAnimation?.[side];
		if (!a || !stored) return null;
		const from = side === 'in' ? clip.start : clip.start + clip.duration - a.frames;
		const left = pctOf(range, from);
		const right = pctOf(range, from + a.frames);
		return (
			<span
				key={side}
				data-testid={`ec-text-anim-bar-${side}`}
				title={`${side === 'in' ? 'In' : 'Out'}: ${a.preset} · ${a.frames} f${w.compressed ? ' (shortened to fit)' : ''}`}
				className="absolute top-[16px] h-[14px] bg-pr-accent-fill opacity-70"
				style={{ left: `${left}%`, width: `${right - left}%` }}
			>
				<span
					data-testid={`ec-text-anim-edge-${side}`}
					aria-label={`Drag to change the ${side === 'in' ? 'In' : 'Out'} duration`}
					role="slider"
					aria-valuenow={stored.durationFrames}
					tabIndex={-1}
					className="absolute inset-y-0 w-[6px] cursor-col-resize bg-pr-accent"
					style={side === 'in' ? { right: -3 } : { left: -3 }}
					onPointerDown={(e) => startDrag(e, side, stored.durationFrames, a.frames)}
				/>
			</span>
		);
	};
	return (
		<>
			{bar('in')}
			{bar('out')}
		</>
	);
}
