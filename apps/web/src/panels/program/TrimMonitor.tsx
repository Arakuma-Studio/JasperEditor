// edit-ux: the Trim Monitor (Premiere "Trim Monitor", helpx.adobe.com "Trimming clips"): while trim mode is on and
// edit points are selected, the Program monitor shows the outgoing clip's last frame (left) and the incoming clip's
// first frame (right), each with its track, timecode and shift counter (how far its edge moved since the edit point
// was selected), and the trim buttons −5 / −1 / Apply Default Transitions / +1 / +5 (Large Trim Offset = 5).
// Dragging in the left image ripple-trims the Out point, in the right image the In point, between them rolls
// (Premiere); one drag = one History entry (a session gesture). J/K/L trim dynamically and Space plays around the
// edit (commands/edit-ux.ts); a numeric entry field takes "+12" / "-3" + Enter.
import {
	type EditPoint,
	editPointFrame,
	type Rational,
	type Sequence,
	trackLabel,
	trimSides,
} from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { useSessionState, useStoreSelector } from '@jasper/session/react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { runCommand } from '../../commands/registry.ts';
import type { CommandCtx } from '../../commands/types.ts';
import { formatTimecode } from '../../gaps/time-display.ts';
import { activeTimeline, type TimelineHandle } from '../timeline/env.tsx';
import {
	editPointsOf,
	largeTrimOffset,
	setEditPoints,
	trimCommand,
	trimMode,
	trimSelected,
} from '../timeline/state/trim-mode.ts';
import type { EditPointSel } from '../timeline/state/ui-store.ts';
import { FrameView } from './FrameView.tsx';
import { TransportButton } from './MonitorChrome.tsx';

/** Pixels of drag per frame of trim in the Trim Monitor. */
const TRIM_MONITOR_PX_PER_FRAME = 4;

const EMPTY: readonly EditPointSel[] = [];

/** Edit points of the active Timeline (re-renders on selection changes). */
function useEditPoints(handle: TimelineHandle | null): readonly EditPointSel[] {
	return useStoreSelector(
		handle?.ui ?? { getState: () => ({ editPoints: EMPTY }), subscribe: () => () => undefined },
		(s) => (s as { editPoints: readonly EditPointSel[] }).editPoints,
	);
}

/** Whether the Trim Monitor replaces the Program view for `sequenceId` right now. */
export function useTrimMonitorVisible(session: EditorSession, sequenceId: string | null): boolean {
	const handle = activeTimeline();
	const points = useEditPoints(handle);
	const state = useStoreSelector(trimMode, (s) => s.active && s.sequenceId === sequenceId);
	const playing = useStoreSelector(
		{ getState: () => session.transport.getState(), subscribe: (l) => session.transport.subscribe(l) },
		(s) => s.playing,
	);
	return state && points.length > 0 && handle?.sequenceId() === sequenceId && !playing;
}

type DragZone = 'out' | 'roll' | 'in';

function pointsForZone(seq: Sequence, points: readonly EditPoint[], zone: DragZone): EditPoint[] {
	const out: EditPoint[] = [];
	for (const p of points) {
		const s = trimSides(seq, p);
		if (zone === 'out' && s.outgoing) out.push({ clipId: s.outgoing, edge: 'out', mode: 'ripple' });
		else if (zone === 'in' && s.incoming) out.push({ clipId: s.incoming, edge: 'in', mode: 'ripple' });
		else if (zone === 'roll' && s.outgoing && s.incoming)
			out.push({ clipId: s.outgoing, edge: 'out', mode: 'roll' });
	}
	return out;
}

export function TrimMonitor(props: { session: EditorSession; sequenceId: string; ctx: CommandCtx }) {
	const { session, sequenceId } = props;
	const handle = activeTimeline();
	const sel = useEditPoints(handle);
	const drawn = useSessionState((s) => s.transient ?? s.document);
	const st = useStoreSelector(trimMode, (s) => s);
	const seq = drawn.sequences[sequenceId] as Sequence | undefined;
	const drag = useRef<{ zone: DragZone; x0: number; gesture: Gesture; points: EditPoint[] } | null>(null);
	const [numeric, setNumeric] = useState('');
	const numericRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (st.numeric !== null) {
			setNumeric(st.numeric);
			queueMicrotask(() => numericRef.current?.focus());
		}
	}, [st.numeric]);
	if (!seq || !handle) return null;
	const points = sel.map((p) => ({ clipId: p.clipId, edge: p.side, mode: p.type }) as EditPoint);
	const primary = points[0];
	if (!primary) return null;
	const sides = trimSides(seq, primary);
	const rate = seq.settings.frameRate as Rational;
	const tc = (f: number) => formatTimecode(f, rate, { dropFrame: seq.settings.dropFrame });
	const outClip = sides.outgoing ? seq.clips[sides.outgoing] : undefined;
	const inClip = sides.incoming ? seq.clips[sides.incoming] : undefined;
	const editFrame = editPointFrame(seq, primary);
	const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;
	const trim = (n: number) => {
		const r = trimSelected(session, handle, sequenceId, n, { coalesce: true });
		if ('error' in r) props.ctx.ui.toast({ kind: 'warning', message: 'Trim: not possible', detail: r.error });
	};
	const applyNumeric = () => {
		const m = /^\s*([+-−]?)\s*(\d+)\s*$/.exec(numeric);
		trimMode.setState({ numeric: null });
		if (!m) return;
		const n = Number(m[2]) * (m[1] === '-' || m[1] === '−' ? -1 : 1);
		if (n !== 0) trim(n);
	};

	const onPointerDown = (zone: DragZone) => (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || session.gestureActive) return;
		const zonePoints = pointsForZone(seq, editPointsOf(handle.ui), zone);
		if (!zonePoints.length) return;
		e.currentTarget.setPointerCapture?.(e.pointerId);
		setEditPoints(handle.ui, seq, zonePoints);
		const label = zone === 'roll' ? 'Rolling Edit' : 'Ripple Trim';
		drag.current = { zone, x0: e.clientX, gesture: session.beginGesture(label), points: zonePoints };
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		const frames = Math.round((e.clientX - d.x0) / TRIM_MONITOR_PX_PER_FRAME);
		d.gesture.update(frames === 0 ? [] : [trimCommand(d.points, frames, true) as never]);
	};
	const onPointerUp = () => {
		const d = drag.current;
		if (!d) return;
		drag.current = null;
		const r = d.gesture.commit();
		const applied = r?.ok ? ((r.results[0] as { deltaFrames?: number } | undefined)?.deltaFrames ?? 0) : 0;
		const committed = session.getCommitted().sequences[sequenceId];
		if (committed) setEditPoints(handle.ui, committed, d.points);
		const s = trimMode.getState();
		trimMode.setState({
			outShift: s.outShift + (d.zone !== 'in' ? applied : 0),
			inShift: s.inShift + (d.zone !== 'out' ? applied : 0),
		});
	};

	const side = (which: 'out' | 'in') => {
		const clip = which === 'out' ? outClip : inClip;
		const frame = clip ? (which === 'out' ? clip.start + clip.duration - 1 : clip.start) : null;
		const shift = which === 'out' ? st.outShift : st.inShift;
		const active =
			primary.mode === 'roll' ||
			(which === 'out' ? primary.edge === 'out' : primary.edge === 'in') ||
			points.some((p) => (which === 'out' ? p.edge === 'out' : p.edge === 'in'));
		return (
			<div
				className={`relative flex min-w-0 flex-1 flex-col ${which === 'out' ? 'cursor-[w-resize]' : 'cursor-[e-resize]'}`}
				data-testid={`trim-monitor-${which === 'out' ? 'outgoing' : 'incoming'}`}
				onPointerDown={onPointerDown(which)}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
			>
				<div
					className={`relative min-h-0 flex-1 overflow-hidden bg-pr-app ${active ? 'outline outline-2 outline-[var(--pr-trim-regular)] -outline-offset-2' : ''}`}
				>
					{clip && frame !== null ? (
						<FrameView
							doc={drawn}
							sequenceId={sequenceId}
							frame={frame}
							onlyClipIds={[clip.id]}
							label={`${which === 'out' ? 'Outgoing' : 'Incoming'} frame of ${clip.name}`}
							testId={`trim-monitor-${which}-frame`}
						/>
					) : (
						<div className="flex h-full items-center justify-center text-pr-small text-pr-muted">Gap</div>
					)}
				</div>
				<div className="flex h-[20px] shrink-0 items-center gap-2 px-1 text-pr-small">
					<span className="truncate text-pr-muted">
						{clip ? `${trackLabel(seq, clip.trackId) ?? ''} · ${clip.name}` : '—'}
					</span>
					<span className="flex-1" />
					<span className="pr-tabular text-pr-text">{frame !== null ? tc(frame) : ''}</span>
					<span
						className="pr-tabular min-w-[36px] text-right text-pr-strong"
						title={which === 'out' ? 'Out Shift' : 'In Shift'}
						data-testid={`trim-monitor-${which}-shift`}
					>
						{signed(shift)}
					</span>
				</div>
			</div>
		);
	};

	const typeLabel = primary.mode === 'roll' ? 'Roll' : primary.mode === 'ripple' ? 'Ripple' : 'Trim';
	return (
		<div
			className="absolute inset-0 z-[5] flex flex-col bg-pr-panel"
			data-testid="trim-monitor"
			data-trim-type={primary.mode}
		>
			<div className="flex min-h-0 flex-1 gap-1 p-1">
				{side('out')}
				<div
					className="w-[10px] shrink-0 cursor-col-resize rounded-pr-control bg-pr-raised hover:bg-pr-hover"
					title="Drag to roll the edit"
					data-testid="trim-monitor-roll"
					onPointerDown={onPointerDown('roll')}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
				/>
				{side('in')}
			</div>
			<div className="flex h-[30px] shrink-0 items-center justify-center gap-1 px-2">
				<span className="mr-2 text-pr-small text-pr-muted" data-testid="trim-monitor-type">
					{typeLabel}
					{points.length > 1 ? ` · ${points.length} edit points` : ''}
					{editFrame !== null ? ` · ${tc(editFrame)}` : ''}
					{st.dynamic ? ` · ${st.dynamic.speed === 0 ? 'held' : `${st.dynamic.speed}×`}` : ''}
					{st.dynamic?.atLimit ? ' · limit' : ''}
				</span>
				<TransportButton
					label="Trim Backward by Large Trim Offset"
					shortcut="Ctrl+Shift+Left"
					testId="trim-btn-back-many"
					onClick={() => trim(-largeTrimOffset())}
				>
					<span className="text-pr-small">−{largeTrimOffset()}</span>
				</TransportButton>
				<TransportButton
					label="Trim Backward"
					shortcut="Ctrl+Left"
					testId="trim-btn-back"
					onClick={() => trim(-1)}
				>
					<span className="text-pr-small">−1</span>
				</TransportButton>
				<TransportButton
					label="Apply Default Transitions to Selection"
					shortcut="Shift+D"
					testId="trim-btn-transitions"
					onClick={() => void runCommand('timeline.applyDefaultTransitionsAtEditPoints', props.ctx)}
				>
					<span className="text-pr-small">⧖</span>
				</TransportButton>
				<TransportButton
					label="Trim Forward"
					shortcut="Ctrl+Right"
					testId="trim-btn-forward"
					onClick={() => trim(1)}
				>
					<span className="text-pr-small">+1</span>
				</TransportButton>
				<TransportButton
					label="Trim Forward by Large Trim Offset"
					shortcut="Ctrl+Shift+Right"
					testId="trim-btn-forward-many"
					onClick={() => trim(largeTrimOffset())}
				>
					<span className="text-pr-small">+{largeTrimOffset()}</span>
				</TransportButton>
				<TransportButton
					label="Play Around the Edit"
					shortcut="Space"
					testId="trim-btn-play-around"
					active={st.playAround}
					onClick={() => void runCommand('timeline.playAroundEdit', props.ctx)}
				>
					<span className="text-pr-small">▶︎⇆</span>
				</TransportButton>
				{st.numeric !== null ? (
					<input
						ref={numericRef}
						className="ml-2 h-[22px] w-[64px] rounded-pr-control border border-pr-border bg-pr-field px-1 text-pr-ui text-pr-text"
						aria-label="Trim by frames"
						data-testid="trim-numeric"
						value={numeric}
						onChange={(e) => setNumeric(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								applyNumeric();
							} else if (e.key === 'Escape') {
								e.preventDefault();
								trimMode.setState({ numeric: null });
							}
						}}
						onBlur={() => trimMode.setState({ numeric: null })}
					/>
				) : null}
			</div>
		</div>
	);
}
