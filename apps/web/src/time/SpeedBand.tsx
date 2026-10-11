// The speed rubber band on timeline clips (workstream `time`, docs/wp-notes/time.md), registered as a
// `clipDecorations` overlay. Premiere's gestures (Premiere Pro CS6 reference, "Time remapping"):
// - drag the band up / down: the segment under the pointer speeds up / slows down (Shift: 5 % steps); the clip gets
//   shorter / longer (it stops at the next clip, the rest goes into its tail);
// - Ctrl/Cmd-click the band: add a speed keyframe;
// - drag a keyframe: split it into a speed transition (its halves move apart symmetrically);
// - Alt-drag a keyframe: move it (the speeds stay);
// - Ctrl/Cmd-drag a keyframe: reverse (palindrome) for the dragged length;
// - Ctrl+Alt (Cmd+Opt)-drag a keyframe: freeze frame for the dragged length;
// - click a keyframe and press Delete: remove it.
// Every drag is one session gesture (one undo step) that re-applies the document command while the pointer moves.
import { type Clip, isRemapped, type Rational, type TimedClip } from '@jasper/project';
import { useSessionOrNull } from '@jasper/session/react';
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react';
import type { ClipDecorationProps } from '../extensions/index.ts';
import { edgeZonePx } from '../panels/timeline/model/hit.ts';
import { type BandKey, bandArea, bandKeys, bandPath, bandSegments, speedLabel, yToSpeed } from './band.ts';
import { isBandShown, useBandVersion } from './store.ts';

const OVERSCAN = 64;

/** Whether a clip draws the band (time-remapped, or shown through Show Clip Keyframes). */
export function bandVisible(c: Clip): boolean {
	return (c.kind === 'video' || c.kind === 'nest-video') && (isRemapped(c as TimedClip) || isBandShown(c.id));
}

type Drag =
	| { kind: 'speed'; frame: number; startY: number; label: string }
	| { kind: 'key'; key: BandKey; mode: 'ramp' | 'move' | 'reverse' | 'freeze'; startX: number }
	| null;

export function SpeedBandOverlay(p: ClipDecorationProps) {
	useBandVersion();
	const session = useSessionOrNull();
	const c = p.clip as Clip & TimedClip;
	const rate = p.rate as Rational;
	const a = useMemo(() => bandArea(p.height), [p.height]);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
	const drag = useRef<Drag>(null);
	const gesture = useRef<ReturnType<NonNullable<typeof session>['beginGesture']> | null>(null);
	const w = c.duration * p.pxPerFrame;
	// Visible part of the clip in body-local px.
	const vx0 = Math.max(0, -p.x - OVERSCAN);
	const vx1 = Math.min(w, p.viewportWidth - p.x + OVERSCAN);
	const pts = useMemo(
		() => (vx1 > vx0 ? bandPath(c, rate, p.pxPerFrame, a, vx0, vx1) : []),
		[c, rate, p.pxPerFrame, a, vx0, vx1],
	);
	const segs = useMemo(() => bandSegments(c, rate, p.pxPerFrame, a), [c, rate, p.pxPerFrame, a]);
	const keys = useMemo(() => bandKeys(c, rate, p.pxPerFrame), [c, rate, p.pxPerFrame]);
	if (p.height < 36 || w < 12) return null;
	const edge = edgeZonePx(p.w);
	const readOnly = !session || session.getState().readOnly || p.trackLocked;
	const frameAtX = (x: number) =>
		Math.min(c.start + c.duration - 1, Math.max(c.start, c.start + Math.floor(x / p.pxPerFrame)));
	const localX = (e: ReactPointerEvent) =>
		e.clientX - (e.currentTarget as Element).closest('svg')!.getBoundingClientRect().left;
	const localY = (e: ReactPointerEvent) =>
		e.clientY - (e.currentTarget as Element).closest('svg')!.getBoundingClientRect().top;

	const apply = (label: string, commands: unknown[]) => {
		if (!session) return;
		const r = session.apply({ label, origin: 'user', commands: commands as never[] });
		if (!r.ok) setTip({ x: 0, y: a.top, text: r.errors[0]?.message ?? `${label} failed` });
	};

	const startGesture = (label: string) => {
		if (!session || readOnly) return null;
		try {
			gesture.current = session.beginGesture(label);
		} catch {
			gesture.current = null;
		}
		return gesture.current;
	};

	const onBandDown = (e: ReactPointerEvent<SVGElement>) => {
		if (readOnly || e.button !== 0) return;
		const x = localX(e);
		if (x < edge || x > w - edge) return;
		e.stopPropagation();
		e.preventDefault();
		const frame = frameAtX(x);
		if (e.ctrlKey || e.metaKey) {
			apply('Add Speed Keyframe', [{ type: 'timeRemap.addKeyframe', clipId: c.id, at: frame }]);
			return;
		}
		if (!startGesture('Change Speed')) return;
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		drag.current = { kind: 'speed', frame, startY: localY(e), label: 'Change Speed' };
	};

	const onKeyDown = (k: BandKey) => (e: ReactPointerEvent<SVGElement>) => {
		if (readOnly || e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		setSelectedKey(k.id);
		const ctrl = e.ctrlKey || e.metaKey;
		const mode = ctrl && e.altKey ? 'freeze' : ctrl ? 'reverse' : e.altKey ? 'move' : 'ramp';
		const label =
			mode === 'freeze'
				? 'Freeze Frame'
				: mode === 'reverse'
					? 'Reverse Speed Segment'
					: mode === 'move'
						? 'Move Speed Keyframe'
						: 'Speed Transition';
		if (!startGesture(label)) return;
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		drag.current = { kind: 'key', key: k, mode, startX: localX(e) };
	};

	const onMove = (e: ReactPointerEvent<SVGElement>) => {
		const d = drag.current;
		const g = gesture.current;
		if (!d || !g) return;
		if (d.kind === 'speed') {
			const speed = yToSpeed(localY(e), a, e.shiftKey ? 5 : undefined);
			const r = g.update([
				{ type: 'timeRemap.setSpeed', clipId: c.id, at: d.frame, speedPercent: speed * 100 } as never,
			]);
			setTip({
				x: (d.frame - c.start) * p.pxPerFrame,
				y: a.top,
				text: r.ok ? speedLabel(speed) : (r.errors[0]?.message ?? ''),
			});
			return;
		}
		const dx = localX(e) - d.startX;
		const frames = Math.round(Math.abs(dx) / p.pxPerFrame);
		const keyFrame = Math.round(d.key.frame);
		let cmd: unknown = null;
		let text = '';
		if (d.mode === 'ramp') {
			cmd = {
				type: 'timeRemap.setTransition',
				clipId: c.id,
				keyframeId: d.key.id,
				frames: d.key.rampFrames * 2 + 2 * (dx / p.pxPerFrame),
			};
			text = `Transition ${Math.max(0, Math.round(d.key.rampFrames * 2 + (2 * dx) / p.pxPerFrame))} frames`;
		} else if (d.mode === 'move') {
			cmd = {
				type: 'timeRemap.moveKeyframe',
				clipId: c.id,
				keyframeId: d.key.id,
				to: keyFrame + Math.round(dx / p.pxPerFrame),
			};
			text = `Move ${Math.round(dx / p.pxPerFrame)} frames`;
		} else if (frames >= 1) {
			cmd =
				d.mode === 'reverse'
					? { type: 'timeRemap.addReverse', clipId: c.id, at: keyFrame, duration: frames }
					: { type: 'timeRemap.addFreeze', clipId: c.id, at: keyFrame, duration: frames };
			text = d.mode === 'reverse' ? `-100.00% · ${frames} frames` : `0.00% · ${frames} frames`;
		}
		if (!cmd) {
			g.update([]);
			return;
		}
		if (d.mode === 'ramp' && (cmd as { frames: number }).frames < 0) (cmd as { frames: number }).frames = 0;
		const r = g.update([cmd as never]);
		setTip({ x: d.key.x + dx, y: a.top, text: r.ok ? text : (r.errors[0]?.message ?? '') });
	};

	const onUp = (e: ReactPointerEvent<SVGElement>) => {
		const g = gesture.current;
		gesture.current = null;
		drag.current = null;
		setTip(null);
		try {
			(e.currentTarget as Element).releasePointerCapture(e.pointerId);
		} catch {
			// not captured
		}
		g?.commit();
	};

	const onCancel = () => {
		gesture.current?.cancel();
		gesture.current = null;
		drag.current = null;
		setTip(null);
	};

	const onKey = (e: React.KeyboardEvent) => {
		if ((e.key === 'Delete' || e.key === 'Backspace') && selectedKey && !readOnly) {
			e.stopPropagation();
			e.preventDefault();
			apply('Delete Speed Keyframes', [
				{ type: 'timeRemap.removeKeyframes', clipId: c.id, keyframeIds: [selectedKey] },
			]);
			setSelectedKey(null);
		}
	};

	const path = pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('');
	const ticks: { x: number; y: number; kind: 'hold' | 'reverse' }[] = [];
	for (const s of segs) {
		if (s.kind === 'forward') continue;
		const x0 = Math.max(s.x0, vx0);
		const x1 = Math.min(s.x1, vx1);
		for (let x = Math.ceil(x0 / 10) * 10 + 5; x < x1; x += 10) ticks.push({ x, y: s.y, kind: s.kind });
	}
	const mid = (a.top + a.bottom) / 2;
	return (
		<svg
			className="pointer-events-none absolute left-0 top-0 overflow-visible"
			width={w}
			height={p.height}
			data-speed-band={c.id}
			onKeyDown={onKey}
		>
			<title>Speed (Time Remapping)</title>
			{/* 100 % demarcation */}
			<line
				x1={vx0}
				x2={vx1}
				y1={mid}
				y2={mid}
				stroke="var(--pr-border-strong)"
				strokeDasharray="2 3"
				strokeWidth={1}
			/>
			{/* Premiere's white speed-control track */}
			<rect
				x={vx0}
				width={Math.max(0, vx1 - vx0)}
				y={BAND_TRACK_Y}
				height={4}
				fill="var(--pr-text-tertiary)"
				opacity={0.35}
			/>
			<path d={path} fill="none" stroke="var(--pr-keyframe)" strokeWidth={1.5} />
			<path
				d={path}
				fill="none"
				stroke="transparent"
				strokeWidth={9}
				className={readOnly ? undefined : 'pointer-events-auto cursor-ns-resize'}
				onPointerDown={onBandDown}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onPointerCancel={onCancel}
				data-speed-band-line=""
			/>
			{ticks.map((t) => (
				<text
					key={`${t.kind}${t.x}`}
					x={t.x}
					y={t.y - 2}
					fontSize={9}
					textAnchor="middle"
					fill="var(--pr-keyframe)"
					className="pointer-events-none select-none"
				>
					{t.kind === 'hold' ? '|' : '<'}
				</text>
			))}
			{keys
				.filter((k) => k.xOut >= vx0 && k.xIn <= vx1)
				.map((k) => (
					<g
						key={k.id}
						className={readOnly ? undefined : 'pointer-events-auto cursor-ew-resize'}
						onPointerDown={onKeyDown(k)}
						onPointerMove={onMove}
						onPointerUp={onUp}
						onPointerCancel={onCancel}
						tabIndex={-1}
						data-speed-key={k.id}
					>
						{k.rampFrames > 0 ? (
							<rect
								x={k.xIn}
								width={k.xOut - k.xIn}
								y={BAND_TRACK_Y}
								height={4}
								fill="var(--pr-text-tertiary)"
								opacity={0.7}
							/>
						) : null}
						<path
							d={`M${k.xIn - 3},${BAND_TRACK_Y}h3v6h-3z M${k.xOut},${BAND_TRACK_Y}h3v6h-3z`}
							fill={selectedKey === k.id ? 'var(--pr-accent)' : 'var(--pr-text-strong)'}
						/>
						<rect
							x={k.xIn - 5}
							width={k.xOut - k.xIn + 10}
							y={BAND_TRACK_Y - 2}
							height={10}
							fill="transparent"
						/>
					</g>
				))}
			{tip ? (
				<g className="pointer-events-none">
					<rect
						x={tip.x + 4}
						y={tip.y - 1}
						width={tip.text.length * 6 + 8}
						height={14}
						rx={2}
						fill="var(--pr-tooltip-bg)"
					/>
					<text x={tip.x + 8} y={tip.y + 10} fontSize={10} fill="var(--pr-text-strong)">
						{tip.text}
					</text>
				</g>
			) : null}
		</svg>
	);
}

/** y of the speed-control track (just below the name strip). */
const BAND_TRACK_Y = 15;
