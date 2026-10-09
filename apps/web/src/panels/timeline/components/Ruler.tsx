// Ruler (S02 §5: TL-200…214, TL-763/764, TL-790…794; S05:TLC-004): canvas ticks and labels, In/Out
// brackets and shading, the marker lane and the render bar. Clicking/dragging scrubs (TL-203).
import { type Marker, type Sequence, sequenceDuration } from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { useCallback, useMemo, useRef } from 'react';
import type { RenderSegment } from '../model/renderbar.ts';
import { rulerTicks } from '../model/ruler.ts';
import { boundaryFrameAt, frameToX, type Viewport } from '../model/viewport.ts';
import type { TimelineController } from '../state/controller.ts';
import { markerVar } from './ClipView.tsx';
import { CanvasTiles, cssVar, type TileDraw } from './canvas.tsx';

const TICKS_H = 24;
const MARKER_LANE_H = 14;
const RENDER_BAR_H = 4;
export const RULER_H = TICKS_H + MARKER_LANE_H + RENDER_BAR_H + 2;

type RulerProps = {
	seq: Sequence;
	viewport: Viewport;
	session: EditorSession;
	controller: TimelineController;
	segments: readonly RenderSegment[];
	selectedMarkers: readonly string[];
	/** TL-455 preference: snap the playhead while scrubbing when snapping is on. */
	snapPlayhead: boolean;
	onContextMenu(e: React.MouseEvent, marker: Marker | null): void;
	onEditMarker(marker: Marker): void;
};

type MarkDrag =
	| { kind: 'scrub' }
	| { kind: 'marker'; marker: Marker; downX: number; gesture: Gesture | null }
	| {
			kind: 'in' | 'out' | 'band';
			downX: number;
			in0: number | null;
			out0: number | null;
			gesture: Gesture | null;
	  };

export function Ruler(props: RulerProps) {
	const { seq, viewport: v, session, controller } = props;
	const drag = useRef<MarkDrag | null>(null);
	// ui-perf: the ticks depend on the sequence end only (not on every clip), so a drag that keeps the end does not
	// redraw them.
	const sequenceEnd = useMemo(() => sequenceDuration({ clips: seq.clips }), [seq.clips]);
	const draw = useCallback<TileDraw>(
		(ctx, tile) => {
			const color = cssVar(ctx.canvas, '--pr-text-secondary');
			const strong = cssVar(ctx.canvas, '--pr-text-primary');
			ctx.font = `11px ${cssVar(ctx.canvas, '--pr-font-ui') || 'sans-serif'}`;
			ctx.textBaseline = 'top';
			const ticks = rulerTicks(v, seq.settings.frameRate, {
				dropFrame: seq.settings.dropFrame,
				startFrames: seq.settings.startTimecodeFrames,
				sequenceEnd,
				x0: tile.x0 - 120,
				x1: tile.x0 + tile.width + 120,
			});
			for (const t of ticks) {
				const x = Math.round(t.x) + 0.5;
				const h = t.kind === 'major' ? 8 : t.kind === 'minor' ? 4 : 2;
				ctx.fillStyle = color;
				ctx.fillRect(x - 0.5, TICKS_H - h, 1, h);
				if (t.label) {
					ctx.fillStyle = strong;
					ctx.fillText(t.label, x + 3, 3);
				}
			}
		},
		[v, seq.settings, sequenceEnd],
	);

	const setInOut = (g: Gesture, i: number | null, o: number | null) => {
		if (i !== null && o !== null && o <= i) return;
		g.update([{ type: 'sequence.setInOut', sequenceId: seq.id, in: i, out: o } as never]);
	};

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const target = (e.target as HTMLElement).closest('[data-mark]') as HTMLElement | null;
		const mark = target?.dataset.mark;
		if (mark === 'marker') {
			const m = seq.markers.find((k) => k.id === target!.dataset.id);
			if (m) {
				// TL-794: click selects the marker and seeks to it.
				session.select('markers', [m.id], e.shiftKey ? 'toggle' : 'replace');
				session.transport.seek(m.frame);
				drag.current = { kind: 'marker', marker: m, downX: x, gesture: null };
				return;
			}
		}
		if (mark === 'in' || mark === 'out' || mark === 'band') {
			drag.current = { kind: mark, downX: x, in0: seq.inPoint, out0: seq.outPoint, gesture: null };
			return;
		}
		if (y > TICKS_H + MARKER_LANE_H) return; // render bar: tooltips only
		drag.current = { kind: 'scrub' };
		controller.scrubTo(x, e.shiftKey || props.snapPlayhead);
	};

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const x = e.clientX - rect.left;
		if (d.kind === 'scrub') {
			controller.scrubTo(x, e.shiftKey || props.snapPlayhead);
			return;
		}
		const df = boundaryFrameAt(v, x) - boundaryFrameAt(v, d.downX);
		if (d.kind === 'marker') {
			if (df === 0 && !d.gesture) return;
			d.gesture ??= session.beginGesture('Move Marker');
			d.gesture.update([
				{ type: 'marker.update', markerId: d.marker.id, frame: Math.max(0, d.marker.frame + df) } as never,
			]);
			return;
		}
		if (df === 0 && !d.gesture) return;
		d.gesture ??= session.beginGesture(
			d.kind === 'band' ? 'Move In/Out' : d.kind === 'in' ? 'Mark In' : 'Mark Out',
		);
		const i = d.in0 === null ? null : d.in0 + (d.kind === 'out' ? 0 : df);
		const o = d.out0 === null ? null : d.out0 + (d.kind === 'in' ? 0 : df);
		setInOut(d.gesture, i === null ? null : Math.max(0, i), o === null ? null : Math.max(1, o));
	};

	const onPointerUp = () => {
		const d = drag.current;
		drag.current = null;
		if (d && 'gesture' in d && d.gesture) d.gesture.commit();
		controller.env.ui.setState({ snapFrame: null });
	};

	const inX = seq.inPoint !== null ? frameToX(v, seq.inPoint) : null;
	const outX = seq.outPoint !== null ? frameToX(v, seq.outPoint) : null;
	const shadeL = inX ?? frameToX(v, 0);
	const shadeR = outX ?? v.width;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer editing surface; keyboard access goes through keymap commands
		<div
			className="relative h-full w-full cursor-text overflow-hidden select-none"
			style={{ background: 'var(--pr-bg-panel)', cursor: 'default' }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onContextMenu={(e) => {
				e.preventDefault();
				const target = (e.target as HTMLElement).closest('[data-mark="marker"]') as HTMLElement | null;
				props.onContextMenu(e, target ? (seq.markers.find((m) => m.id === target.dataset.id) ?? null) : null);
			}}
			onDoubleClick={(e) => {
				const target = (e.target as HTMLElement).closest('[data-mark="marker"]') as HTMLElement | null;
				const m = target ? seq.markers.find((k) => k.id === target.dataset.id) : null;
				if (m) props.onEditMarker(m);
			}}
			data-testid="timeline-ruler"
		>
			<div className="absolute top-0 right-0 left-0" style={{ height: TICKS_H }}>
				<CanvasTiles x0={0} x1={v.width} height={TICKS_H} originX={0} draw={draw} />
			</div>
			{inX !== null || outX !== null ? (
				<>
					<div
						className="absolute"
						data-mark="band"
						style={{
							left: shadeL,
							width: Math.max(0, shadeR - shadeL),
							top: TICKS_H - 8,
							height: 8,
							background: 'var(--pr-inout-range)',
							cursor: 'grab',
						}}
						title="Drag to move In and Out"
					/>
					{inX !== null ? (
						<div
							className="absolute w-[6px]"
							data-mark="in"
							style={{
								left: inX,
								top: 2,
								height: TICKS_H - 2,
								borderLeft: '2px solid var(--pr-inout-bracket)',
								borderTop: '2px solid var(--pr-inout-bracket)',
								borderBottom: '2px solid var(--pr-inout-bracket)',
								cursor: 'ew-resize',
							}}
							title="In"
						/>
					) : null}
					{outX !== null ? (
						<div
							className="absolute w-[6px]"
							data-mark="out"
							style={{
								left: outX - 6,
								top: 2,
								height: TICKS_H - 2,
								borderRight: '2px solid var(--pr-inout-bracket)',
								borderTop: '2px solid var(--pr-inout-bracket)',
								borderBottom: '2px solid var(--pr-inout-bracket)',
								cursor: 'ew-resize',
							}}
							title="Out"
						/>
					) : null}
				</>
			) : null}
			<div
				className="absolute right-0 left-0"
				style={{ top: TICKS_H, height: MARKER_LANE_H }}
				data-marker-lane
			>
				{seq.markers.map((m) => {
					const x = frameToX(v, m.frame);
					if (x < -200 || x > v.width + 20) return null;
					const selected = props.selectedMarkers.includes(m.id);
					const color = `var(--pr-marker-${markerVar(m.color)})`;
					return (
						<div
							key={m.id}
							className="absolute top-0 h-full"
							style={{ left: x - 5 }}
							data-mark="marker"
							data-id={m.id}
							title={[m.name, m.comment].filter(Boolean).join('\n') || 'Marker'}
						>
							{m.duration > 0 ? (
								<div
									className="absolute top-[3px] left-[5px] h-[4px] opacity-70"
									style={{ width: m.duration * v.pxPerFrame, background: color }}
								/>
							) : null}
							<div
								className="h-[12px] w-[10px]"
								style={{
									background: color,
									clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)',
									outline: selected ? '1px solid var(--pr-text-strong)' : undefined,
									border: typeof m.author === 'object' ? '1px dashed var(--pr-agent)' : undefined,
								}}
							/>
						</div>
					);
				})}
			</div>
			<div
				className="absolute right-0 left-0"
				style={{ top: TICKS_H + MARKER_LANE_H, height: RENDER_BAR_H }}
				data-testid="timeline-render-bar"
			>
				{props.segments.map((s) => {
					const x0 = frameToX(v, s.startFrame);
					const x1 = frameToX(v, s.endFrame);
					if (x1 < 0 || x0 > v.width) return null;
					return (
						<div
							key={`${s.startFrame}-${s.endFrame}`}
							className="absolute top-0 h-full"
							data-render-state={s.state}
							style={{ left: x0, width: Math.max(1, x1 - x0), background: `var(--pr-render-${s.state})` }}
							title={s.title}
						/>
					);
				})}
			</div>
		</div>
	);
}
