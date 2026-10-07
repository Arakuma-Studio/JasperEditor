// The clip area of both regions (S02:TL-150 layers): track backgrounds, virtualized clip bodies,
// gesture overlays. Pointer input is forwarded to the TimelineController by the panel.
import type { EngineClient } from '@jasper/engine-client';
import {
	clipsInRange,
	findTrack,
	type MediaAsset,
	outOfSyncOffsets,
	type Sequence,
	throughEdits,
} from '@jasper/project';
import type { GapRef, MediaRuntime } from '@jasper/session';
import { useMemo } from 'react';
import { type RegionLayout, rowOf, type TrackAreaLayout, visibleRows } from '../model/layout.ts';
import { type TransitionIndex, transitionsInRange } from '../model/transitions.ts';
import { frameToX, type Viewport } from '../model/viewport.ts';
import type { EditPointSel, TimelineUiState } from '../state/ui-store.ts';
import { type ClipDisplay, ClipView } from './ClipView.tsx';
import { TransitionGhostView, TransitionView, transitionViewProps } from './TransitionView.tsx';

type TrackAreaProps = {
	seq: Sequence;
	layout: TrackAreaLayout;
	viewport: Viewport;
	selected: ReadonlySet<string>;
	gaps: readonly GapRef[];
	targeting: { video: string[]; audio: string[] };
	media: Record<string, MediaAsset>;
	runtime: Record<string, MediaRuntime>;
	engine: EngineClient | null;
	display: ClipDisplay;
	mediaVersion: number;
	overlays: Pick<
		TimelineUiState,
		| 'marquee'
		| 'snapFrame'
		| 'razor'
		| 'insertAt'
		| 'limit'
		| 'editPoints'
		| 'drop'
		| 'flash'
		| 'transitionGhost'
	>;
	/** S10: per-track transition index of the drawn sequence and the selected transition ids. */
	transitions?: TransitionIndex;
	selectedTransitions?: ReadonlySet<string>;
	/** edit-structure: mark through edits (Sequence ▸ Show Through Edits). */
	showThroughEdits?: boolean;
};

/**
 * edit-structure: Premiere's through-edit marks — a small bow tie (two triangles meeting at the cut) at the top of a
 * cut whose two sides continue the same source (`throughEdits`).
 */
function ThroughEditMarks({ seq, layout, v }: { seq: Sequence; layout: TrackAreaLayout; v: Viewport }) {
	const edits = useMemo(() => throughEdits(seq), [seq]);
	if (edits.length === 0) return null;
	return (
		<>
			{edits.map((e) => {
				const row = rowOf(layout, e.trackId);
				if (!row) return null;
				const x = frameToX(v, e.frame);
				if (x < -8 || x > v.width + 8) return null;
				const s = Math.max(4, Math.min(7, row.height / 6));
				return (
					<svg
						key={`${e.leftId}:${e.rightId}`}
						className="pointer-events-none absolute"
						style={{ left: x - s, top: row.y + 2, width: 2 * s, height: s }}
						viewBox={`0 0 ${2 * s} ${s}`}
						data-through-edit={e.frame}
						aria-label="Through edit"
					>
						<polygon points={`0,0 ${s},${s / 2} 0,${s}`} fill="var(--pr-text-strong)" />
						<polygon points={`${2 * s},0 ${s},${s / 2} ${2 * s},${s}`} fill="var(--pr-text-strong)" />
					</svg>
				);
			})}
		</>
	);
}

function Region(props: TrackAreaProps & { region: RegionLayout; offsets: Record<string, number> }) {
	const { seq, viewport: v, region } = props;
	const rows = visibleRows(region);
	const anySolo = seq.audioTracks.some((t) => t.solo);
	// Clips and transitions share the visible frame window ± 50 % overscan (TL-151).
	const visible = v.width / v.pxPerFrame;
	const f0 = Math.floor(v.scrollFrame - visible * 0.5);
	const f1 = Math.ceil(v.scrollFrame + visible * 1.5);
	return (
		<div
			className="absolute right-0 left-0 overflow-hidden"
			style={{ top: region.top, height: region.height }}
			data-region={region.kind}
		>
			{rows.map((row) => {
				const track = findTrack(seq, row.trackId)?.track;
				if (!track) return null;
				const targeted = (region.kind === 'video' ? props.targeting.video : props.targeting.audio).includes(
					track.id,
				);
				const dimmed =
					region.kind === 'video' ? track.output === false : !!track.mute || (anySolo && !track.solo);
				const clips = clipsInRange(seq, track.id, f0, f1);
				const trans = props.transitions ? transitionsInRange(props.transitions, track.id, f0, f1) : [];
				return (
					<div
						key={track.id}
						className="absolute right-0 left-0"
						style={{
							top: row.y - region.top,
							height: row.height,
							// Track area = --pr-bg-panel-alt (R-PUI §3.2); targeted lanes lift like their headers.
							background: targeted ? 'var(--pr-bg-panel-raised)' : 'var(--pr-bg-panel-alt)',
							borderBottom: '1px solid var(--pr-border-subtle)',
						}}
						data-track-id={track.id}
					>
						{track.locked ? (
							<div
								className="pointer-events-none absolute inset-0"
								style={{ background: 'var(--pr-locked-hatch)' }}
							/>
						) : null}
						{props.gaps
							.filter((g) => g.trackId === track.id)
							.map((g) => (
								<div
									key={`${g.start}`}
									className="pointer-events-none absolute top-0 bottom-0"
									style={{
										left: frameToX(v, g.start),
										width: (g.end - g.start) * v.pxPerFrame,
										background: 'var(--pr-bg-selected-row)',
									}}
									data-gap-selected
								/>
							))}
						{clips.map((c) => {
							const x = frameToX(v, c.start);
							const mediaId = (c as { mediaId?: string }).mediaId;
							const asset = mediaId ? props.media[mediaId] : undefined;
							const rt = mediaId ? props.runtime[mediaId] : undefined;
							return (
								<ClipView
									key={c.id}
									clip={c}
									x={x}
									w={c.duration * v.pxPerFrame}
									height={row.height}
									viewportWidth={v.width}
									scrollFrame={v.scrollFrame}
									pxPerFrame={v.pxPerFrame}
									rate={seq.settings.frameRate}
									selected={props.selected.has(c.id)}
									trackLocked={track.locked}
									trackDimmed={dimmed}
									linked={!!c.linkId}
									syncOffset={props.offsets[c.id] ?? null}
									offline={!!mediaId && (!asset || rt?.availability === 'offline')}
									flash={props.overlays.flash.includes(c.id)}
									asset={asset}
									runtime={rt}
									engine={props.engine}
									display={props.display}
									mediaVersion={props.mediaVersion}
								/>
							);
						})}
						{trans.map((g) => (
							<TransitionView
								key={g.t.id}
								{...transitionViewProps(
									g,
									v,
									row.height,
									!!props.selectedTransitions?.has(g.t.id),
									seq.settings.frameRate,
									seq.settings.dropFrame,
								)}
							/>
						))}
					</div>
				);
			})}
		</div>
	);
}

function EditPointMarks(props: { points: readonly EditPointSel[]; layout: TrackAreaLayout; v: Viewport }) {
	// Premiere: Trim edit points are red brackets on one side, Ripple yellow, Roll red on both sides of the cut.
	const mark = (e: EditPointSel, side: 'in' | 'out', color: string, key: string) => {
		const row = rowOf(props.layout, e.trackId);
		if (!row) return null;
		const x = frameToX(props.v, e.frame);
		return (
			<div
				key={key}
				className="pointer-events-none absolute"
				style={{
					left: side === 'out' ? x - 6 : x,
					top: row.y + 1,
					width: 6,
					height: row.height - 2,
					borderTop: `2px solid ${color}`,
					borderBottom: `2px solid ${color}`,
					[side === 'out' ? 'borderRight' : 'borderLeft']: `2px solid ${color}`,
				}}
				data-edit-point={e.frame}
				data-edit-type={e.type}
			/>
		);
	};
	return (
		<>
			{props.points.flatMap((e) => {
				const key = `${e.trackId}:${e.frame}:${e.side}`;
				if (e.type === 'roll')
					return [
						mark(e, 'out', 'var(--pr-trim-regular)', `${key}:o`),
						mark(e, 'in', 'var(--pr-trim-regular)', `${key}:i`),
					];
				return [
					mark(e, e.side, e.type === 'ripple' ? 'var(--pr-trim-ripple)' : 'var(--pr-trim-regular)', key),
				];
			})}
		</>
	);
}

export function TrackArea(props: TrackAreaProps) {
	const { layout, viewport: v, seq, overlays } = props;
	const offsets = useMemo(() => outOfSyncOffsets(seq), [seq]);
	const inX = seq.inPoint !== null ? frameToX(v, seq.inPoint) : null;
	const outX = seq.outPoint !== null ? frameToX(v, seq.outPoint) : null;
	const razorRow =
		overlays.razor?.trackId !== undefined && overlays.razor?.trackId !== null
			? [...layout.video.rows, ...layout.audio.rows].find((r) => r.trackId === overlays.razor!.trackId)
			: null;
	const limitRow = overlays.limit
		? [...layout.video.rows, ...layout.audio.rows].find((r) => r.trackId === overlays.limit!.trackId)
		: null;
	return (
		<div className="absolute inset-0" data-testid="timeline-track-area">
			<Region {...props} region={layout.video} offsets={offsets} />
			<div
				className="absolute right-0 left-0"
				style={{ top: layout.dividerTop, height: 4, background: 'var(--pr-bg-app)' }}
				data-divider
			/>
			<Region {...props} region={layout.audio} offsets={offsets} />
			{inX !== null || outX !== null ? (
				<div
					className="pointer-events-none absolute top-0 bottom-0"
					style={{
						left: inX ?? frameToX(v, 0),
						width: Math.max(0, (outX ?? v.width + 1) - (inX ?? frameToX(v, 0))),
						background: 'var(--pr-inout-range-track)',
					}}
					data-inout-shade
				/>
			) : null}
			<EditPointMarks points={overlays.editPoints} layout={layout} v={v} />
			{props.showThroughEdits ? <ThroughEditMarks seq={seq} layout={layout} v={v} /> : null}
			{overlays.limit && limitRow ? (
				<div
					className="pointer-events-none absolute w-[3px]"
					style={{
						left: frameToX(v, overlays.limit.frame) - 1,
						top: limitRow.y,
						height: limitRow.height,
						background: 'var(--pr-trim-regular)',
					}}
					data-limit
				/>
			) : null}
			{overlays.razor ? (
				<div
					className="pointer-events-none absolute w-px"
					style={{
						left: frameToX(v, overlays.razor.frame),
						top: razorRow ? razorRow.y : 0,
						height: razorRow ? razorRow.height : layout.height,
						background: 'var(--pr-text-strong)',
					}}
					data-razor-line
				/>
			) : null}
			{overlays.insertAt !== null ? (
				<div
					className="pointer-events-none absolute top-0 bottom-0 w-[2px]"
					style={{ left: frameToX(v, overlays.insertAt) - 1, background: 'var(--pr-trim-ripple)' }}
					data-insert-arrows
				/>
			) : null}
			{overlays.drop ? (
				<div
					className="pointer-events-none absolute top-0 bottom-0 w-[2px]"
					style={{
						left: frameToX(v, overlays.drop.frame) - 1,
						background: overlays.drop.insert ? 'var(--pr-trim-ripple)' : 'var(--pr-accent)',
					}}
					data-drop-indicator
				>
					<span className="absolute top-1 left-1 rounded-[2px] bg-pr-tooltip px-1 text-pr-small whitespace-nowrap text-pr-text">
						{overlays.drop.insert ? 'Insert' : 'Overwrite'} · {overlays.drop.trackLabel}
					</span>
				</div>
			) : null}
			{overlays.transitionGhost
				? (() => {
						const row = rowOf(layout, overlays.transitionGhost.trackId);
						return row ? (
							<TransitionGhostView
								ghost={overlays.transitionGhost}
								rowY={row.y}
								rowHeight={row.height}
								v={v}
							/>
						) : null;
					})()
				: null}
			{overlays.snapFrame !== null ? (
				<div
					className="pointer-events-none absolute top-0 bottom-0"
					style={{
						left: frameToX(v, overlays.snapFrame) - 1,
						width: 3,
						background: 'var(--pr-snap-line)',
						boxShadow: '0 0 0 1px var(--pr-snap-line-casing)',
						zIndex: 5,
					}}
					data-snap-indicator
				/>
			) : null}
			{overlays.marquee ? (
				<div
					className="pointer-events-none absolute border border-dashed"
					style={{
						left: Math.min(overlays.marquee.x0, overlays.marquee.x1),
						top: Math.min(overlays.marquee.y0, overlays.marquee.y1),
						width: Math.abs(overlays.marquee.x1 - overlays.marquee.x0),
						height: Math.abs(overlays.marquee.y1 - overlays.marquee.y0),
						borderColor: 'var(--pr-text-primary)',
						background: 'var(--pr-inout-range)',
					}}
					data-marquee
				/>
			) : null}
		</div>
	);
}
