// Transitions drawn in a track row (S10:TUI-001…006): a semi-opaque rect over the span, positioned with
// translateX like clip bodies, with the "ramp" glyph (fade-in rising, fade-out falling, both for a
// dissolve between two clips; quarter-sine curves for constant-power audio), an elided label, selection
// accent and hatched end caps where the span reaches the end of the available media. Memoised on
// primitive props: never re-rendered per playhead frame (S02:TL-155).
import { fadeCurve, type Rational } from '@jasper/project';
import { memo } from 'react';
import { formatTimecode } from '../../../gaps/time-display.ts';
import type { TransitionGeom } from '../model/transitions.ts';
import { transitionBand } from '../model/transitions.ts';
import { frameToX, snapPx, type Viewport } from '../model/viewport.ts';
import type { TransitionGhost } from '../state/ui-store.ts';
import { dpr } from './canvas.tsx';

type TransitionViewProps = {
	id: string;
	x: number;
	w: number;
	rowHeight: number;
	label: string;
	title: string;
	selected: boolean;
	shape: 'in' | 'out' | 'both';
	curve: 'linear' | 'equal-power' | 'exponential';
	capStart: boolean;
	capEnd: boolean;
	broken: boolean;
	dip: boolean;
	/** freeze-frame handles (repeated frames) — Premiere's warning stripe. */
	freeze: boolean;
};

const ALIGN_LABEL = { center: 'Center at Cut', 'start-at-cut': 'Start at Cut', 'end-at-cut': 'End at Cut' };

/** Tooltip text (TUI-001): type, duration (timecode + frames), alignment, handles used. */
function transitionTitle(g: TransitionGeom, rate: Rational, dropFrame: boolean): string {
	const label = g.spec?.label ?? g.t.effectId;
	const d = g.end - g.start;
	const lines = [
		label,
		`Duration ${formatTimecode(g.duration || d, rate, { dropFrame })} (${g.duration || d} frames)`,
		g.oneSided
			? g.oneSided === 'in'
				? 'Fade in at the clip head'
				: 'Fade out at the clip tail'
			: ALIGN_LABEL[g.t.alignment],
	];
	if (!g.oneSided) {
		const headUsed = Math.max(0, g.cut - g.start);
		const tailUsed = Math.max(0, g.end - g.cut);
		lines.push(
			`Handles used: ${tailUsed} after A (of ${fmtHandle(g.handles.tail)}), ${headUsed} before B (of ${fmtHandle(g.handles.head)})`,
		);
	}
	if (g.duration > 0 && g.duration < g.t.duration)
		lines.push(`Shortened from ${g.t.duration} frames to fit the media`);
	if (g.t.freezeHandles) lines.push('Insufficient media: this transition contains repeated frames');
	if (g.broken)
		lines.push(g.spec ? 'Not rendered: no media handles left' : 'Not rendered: unknown transition');
	return lines.join('\n');
}

const fmtHandle = (n: number) => (Number.isFinite(n) ? String(n) : '∞');

/** Props for a transition in a row at the current viewport. */
export function transitionViewProps(
	g: TransitionGeom,
	v: Viewport,
	rowHeight: number,
	selected: boolean,
	rate: Rational,
	dropFrame: boolean,
): TransitionViewProps {
	return {
		id: g.t.id,
		x: frameToX(v, g.start),
		w: (g.end - g.start) * v.pxPerFrame,
		rowHeight,
		label: g.spec?.label ?? g.t.effectId,
		title: transitionTitle(g, rate, dropFrame),
		selected,
		shape: g.oneSided === 'in' ? 'in' : g.oneSided === 'out' ? 'out' : 'both',
		curve:
			g.t.effectId === 'jasper.constant-power'
				? 'equal-power'
				: g.t.effectId === 'jasper.exponential-fade'
					? 'exponential'
					: 'linear',
		capStart: g.capStart,
		capEnd: g.capEnd,
		broken: g.broken,
		dip: g.t.effectId === 'jasper.dip-to-black',
		freeze: g.t.freezeHandles === true,
	};
}

/** SVG path (viewBox 100×100, y down) of a fade: `in` rises from bottom-left, `out` falls. */
function rampPath(
	kind: 'in' | 'out',
	curve: 'linear' | 'equal-power' | 'exponential',
	x0 = 0,
	x1 = 100,
): string {
	if (curve === 'linear') return kind === 'in' ? `M${x0} 100 L${x1} 0` : `M${x0} 0 L${x1} 100`;
	const pts: string[] = [];
	for (let i = 0; i <= 16; i++) {
		const p = i / 16;
		const gain = fadeCurve(curve, kind === 'in' ? p : 1 - p);
		pts.push(`${(x0 + (x1 - x0) * p).toFixed(2)} ${(100 - gain * 100).toFixed(2)}`);
	}
	return `M${pts.join(' L')}`;
}

function TransitionViewImpl(p: TransitionViewProps) {
	const d = dpr();
	const x = snapPx(p.x, d);
	const w = Math.max(1, snapPx(p.x + p.w, d) - x);
	const band = transitionBand(p.rowHeight);
	const stroke = p.selected ? 'var(--pr-transition-selected)' : 'var(--pr-transition-border)';
	const paths: string[] = [];
	if (w >= 6) {
		if (p.dip && p.shape === 'both') {
			// Dip to black: down to the middle, then up.
			paths.push(rampPath('out', 'linear', 0, 50), rampPath('in', 'linear', 50, 100));
		} else {
			if (p.shape !== 'out') paths.push(rampPath('in', p.curve));
			if (p.shape !== 'in') paths.push(rampPath('out', p.curve));
		}
	}
	return (
		<div
			className="absolute left-0 overflow-hidden"
			data-transition-id={p.id}
			data-selected={p.selected || undefined}
			title={p.title}
			style={{
				transform: `translateX(${x}px)`,
				top: band.top,
				width: w,
				height: band.height,
				background: p.selected ? 'var(--pr-transition-selected-fill)' : 'var(--pr-transition-fill)',
				boxShadow: `inset 0 0 0 ${p.selected ? 2 : 1}px ${p.broken ? 'var(--pr-transition-broken)' : stroke}`,
				borderRadius: 2,
				zIndex: 2,
			}}
		>
			{paths.length ? (
				<svg
					className="pointer-events-none absolute inset-0 size-full"
					viewBox="0 0 100 100"
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					{paths.map((d) => (
						<path
							key={d}
							d={d}
							fill="none"
							stroke="var(--pr-transition-glyph)"
							strokeWidth={1}
							vectorEffect="non-scaling-stroke"
						/>
					))}
				</svg>
			) : null}
			{w >= 40 && band.height >= 12 ? (
				<span
					className="pointer-events-none absolute top-0 right-1 left-1 truncate text-[10px] leading-[12px]"
					style={{ color: 'var(--pr-transition-label)', textShadow: '0 0 2px var(--pr-bg-app)' }}
				>
					{p.label}
				</span>
			) : null}
			{p.freeze ? (
				<div
					className="pointer-events-none absolute right-0 bottom-0 left-0 h-[3px]"
					style={{
						background: 'repeating-linear-gradient(-45deg, var(--pr-warning) 0 3px, transparent 3px 6px)',
					}}
					data-transition-freeze=""
				/>
			) : null}
			{p.capStart ? (
				<div
					className="pointer-events-none absolute top-0 bottom-0 left-0 w-[3px]"
					style={{ background: 'var(--pr-transition-cap)' }}
					data-transition-cap="start"
				/>
			) : null}
			{p.capEnd ? (
				<div
					className="pointer-events-none absolute top-0 right-0 bottom-0 w-[3px]"
					style={{ background: 'var(--pr-transition-cap)' }}
					data-transition-cap="end"
				/>
			) : null}
		</div>
	);
}

export const TransitionView = memo(TransitionViewImpl);

/** Drop / edge-drag ghost with handle availability (TUI-021/022), in track-area coordinates. */
export function TransitionGhostView(props: {
	ghost: TransitionGhost;
	rowY: number;
	rowHeight: number;
	v: Viewport;
}) {
	const { ghost: g, v } = props;
	const band = transitionBand(props.rowHeight);
	const top = props.rowY + band.top;
	const rect = (s: { start: number; end: number }) => ({
		left: (s.start - v.scrollFrame) * v.pxPerFrame,
		width: Math.max(1, (s.end - s.start) * v.pxPerFrame),
		top,
		height: band.height,
	});
	return (
		<div className="pointer-events-none absolute inset-0" style={{ zIndex: 6 }} data-transition-ghost>
			{g.bands.map((b) => (
				<div
					key={`b${b.start}`}
					className="absolute"
					style={{ ...rect(b), background: 'var(--pr-transition-handle-band)' }}
					data-ghost-band
				/>
			))}
			{g.fitted ? (
				<div
					className="absolute"
					style={{
						...rect(g.fitted),
						background: 'var(--pr-transition-ghost-fill)',
						boxShadow: 'inset 0 0 0 1px var(--pr-transition-ghost-border)',
					}}
					data-ghost-span
				/>
			) : null}
			{g.missing.map((m) => (
				<div
					key={`m${m.start}`}
					className="absolute"
					style={{ ...rect(m), background: 'var(--pr-transition-missing)' }}
					data-ghost-missing
				/>
			))}
			{g.refused ? (
				<div
					className="absolute"
					style={{ ...rect(g.wanted), boxShadow: 'inset 0 0 0 1px var(--pr-transition-refused)' }}
					data-ghost-refused
				/>
			) : null}
		</div>
	);
}
