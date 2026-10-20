// sound-design (spec 12 §2.7 "Insert"): the ghost of a library sound dragged over the timeline — the clip it would
// make on the track it would go on (a dashed row below the last audio track for a new "SFX n" track), with a tick at
// its peak, the primary snap edge. Drawn with the ghost tokens; the label names the sound and its destination.
import { rowOf, type TrackAreaLayout } from '../model/layout.ts';
import { frameToX, type Viewport } from '../model/viewport.ts';
import type { SoundGhost } from '../state/ui-store.ts';

export function SoundGhostView(props: { ghost: SoundGhost; layout: TrackAreaLayout; v: Viewport }) {
	const { ghost, layout, v } = props;
	const row = ghost.trackId ? rowOf(layout, ghost.trackId) : null;
	const last = layout.audio.rows.at(-1);
	const y = row ? row.y : last ? last.y + last.height + 2 : layout.audio.top;
	const height = row ? row.height : (last?.height ?? 40);
	if (y > layout.height) return null;
	const x0 = frameToX(v, ghost.start);
	const x1 = frameToX(v, ghost.start + ghost.frames);
	const px = frameToX(v, ghost.start + ghost.peakOffset);
	return (
		<div
			className="pointer-events-none absolute"
			style={{ left: 0, right: 0, top: 0, bottom: 0, zIndex: 4 }}
			data-sound-ghost={ghost.trackId ?? 'new'}
			data-sound-ghost-start={ghost.start}
			data-sound-ghost-align={ghost.align}
		>
			<div
				className="absolute overflow-hidden rounded-[2px] border border-dashed"
				style={{
					left: x0,
					width: Math.max(2, x1 - x0),
					top: y + 1,
					height: Math.max(8, Math.min(height, layout.height - y) - 2),
					background: 'var(--pr-ghost-fill)',
					borderColor: 'var(--pr-ghost-stroke)',
				}}
			>
				<span className="absolute top-0 left-1 truncate text-pr-small whitespace-nowrap text-pr-text">
					{ghost.label}
				</span>
			</div>
			<div
				className="absolute w-[2px]"
				style={{
					left: px - 1,
					top: y,
					height: Math.max(8, Math.min(height, layout.height - y)),
					background: 'var(--pr-accent)',
				}}
				data-sound-ghost-peak
			/>
		</div>
	);
}
