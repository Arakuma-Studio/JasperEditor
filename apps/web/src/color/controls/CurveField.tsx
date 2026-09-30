// Tone-curve editor for one `curve` param (S06:CGU-001): click adds a point, drag moves it (x stays between
// its neighbours), dragging out of the box or double-clicking removes it; at most 64 points. Every pointer
// gesture is one undo step and writes a sorted `{curve}` value. The spline drawn is the model's PCHIP
// (`sampleCurve`), so the line is exactly what the grade applies.
import { MAX_CURVE_POINTS, sampleCurve } from '@jasper/project';
import { type MouseEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import type { Row } from '../../panels/properties/lib/model.ts';
import {
	addCurvePoint,
	type CurvePoint,
	curvePoints,
	curveValue,
	hitCurvePoint,
	moveCurvePoint,
	removeCurvePoint,
} from '../model.ts';
import { type RowWriteContext, useRowWriter } from '../rowEdit.ts';

/** SVG units of the square editor (also the fallback pixel size when layout is unavailable). */
export const CURVE_BOX = 200;
/** Pointer tolerance of a point, in px. */
const HIT_PX = 7;
/** Distance outside the box (px) at which a dragged point is removed. */
const REMOVE_PX = 14;

export type CurveChannel = 'master' | 'red' | 'green' | 'blue';
const STROKE: Record<CurveChannel, string> = {
	master: 'var(--pr-curve-master)',
	red: 'var(--pr-curve-red)',
	green: 'var(--pr-curve-green)',
	blue: 'var(--pr-curve-blue)',
};

const pathOf = (pts: readonly (readonly number[])[], n = 97) => {
	const ys = sampleCurve(pts, n);
	return ys
		.map((y, i) => {
			const x = (i / (n - 1)) * CURVE_BOX;
			const yy = (1 - Math.min(1, Math.max(0, y))) * CURVE_BOX;
			return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${yy.toFixed(2)}`;
		})
		.join(' ');
};

type Drag = { base: CurvePoint[]; index: number; changed: boolean; removed: boolean };

export function CurveField(props: {
	row: Row;
	ctx: RowWriteContext;
	channel?: CurveChannel;
	/** Other curves drawn faintly behind the edited one. */
	ghosts?: { channel: CurveChannel; value: unknown }[];
	disabled?: boolean;
	'data-testid'?: string;
}) {
	const { row } = props;
	const channel = props.channel ?? 'master';
	const writer = useRowWriter(row, props.ctx);
	const value = row.bindings[0]?.resolved.value;
	const stored = curvePoints(value);
	const [preview, setPreview] = useState<CurvePoint[] | null>(null);
	const [active, setActive] = useState<number | null>(null);
	const drag = useRef<Drag | null>(null);
	const cleanup = useRef<(() => void) | null>(null);
	useEffect(() => () => cleanup.current?.(), []);
	const pts = preview ?? stored;

	const toUnit = (el: Element, clientX: number, clientY: number) => {
		const r = el.getBoundingClientRect();
		const w = r.width || CURVE_BOX;
		const h = r.height || CURVE_BOX;
		return {
			x: (clientX - r.left) / w,
			y: 1 - (clientY - r.top) / h,
			outside:
				clientX < r.left - REMOVE_PX ||
				clientX > r.left + w + REMOVE_PX ||
				clientY < r.top - REMOVE_PX ||
				clientY > r.top + h + REMOVE_PX,
			tol: HIT_PX / w,
		};
	};

	const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
		if (props.disabled || e.button !== 0) return;
		e.preventDefault();
		const svg = e.currentTarget;
		const p = toUnit(svg, e.clientX, e.clientY);
		let base = stored;
		let index = hitCurvePoint(base, p.x, p.y, p.tol);
		let changed = false;
		if (index < 0) {
			const added = addCurvePoint(base, p.x, p.y);
			if (!added) return;
			base = added.points;
			index = added.index;
			changed = true;
		}
		if (!writer.begin()) return;
		const d: Drag = { base, index, changed, removed: false };
		drag.current = d;
		setActive(index);
		if (changed) {
			setPreview(base);
			writer.update(curveValue(base));
		}
		const move = (ev: globalThis.PointerEvent) => {
			const q = toUnit(svg, ev.clientX, ev.clientY);
			const removed = q.outside ? removeCurvePoint(d.base, d.index) : null;
			const next = removed ?? moveCurvePoint(d.base, d.index, q.x, q.y);
			d.removed = !!removed;
			d.changed = true;
			setPreview(next);
			setActive(removed ? null : d.index);
			writer.update(curveValue(next));
		};
		const finish = (cancelled: boolean) => {
			cleanup.current?.();
			cleanup.current = null;
			drag.current = null;
			writer.end(cancelled || !d.changed);
			setPreview(null);
			setActive(null);
		};
		const up = () => finish(false);
		const key = (ev: globalThis.KeyboardEvent) => {
			if (ev.key !== 'Escape') return;
			ev.preventDefault();
			finish(true);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
		window.addEventListener('keydown', key, true);
		cleanup.current = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			window.removeEventListener('keydown', key, true);
		};
	};

	const onDoubleClick = (e: MouseEvent<SVGSVGElement>) => {
		if (props.disabled) return;
		const p = toUnit(e.currentTarget, e.clientX, e.clientY);
		const i = hitCurvePoint(stored, p.x, p.y, p.tol);
		const next = i >= 0 ? removeCurvePoint(stored, i) : null;
		if (next) writer.commit(curveValue(next));
	};

	const grid = [0.25, 0.5, 0.75].map((t) => t * CURVE_BOX);
	return (
		<div className="flex w-full flex-col items-center gap-1">
			<svg
				viewBox={`0 0 ${CURVE_BOX} ${CURVE_BOX}`}
				className="aspect-square w-full max-w-[240px] cursor-crosshair rounded-pr-control"
				style={{ background: 'var(--pr-curve-bg)', touchAction: 'none' }}
				role="img"
				aria-label={`${row.label} editor (${pts.length} points)`}
				onPointerDown={onPointerDown}
				onDoubleClick={onDoubleClick}
				data-testid={props['data-testid']}
				data-points={JSON.stringify(pts)}
			>
				{grid.map((g) => (
					<g key={g} stroke="var(--pr-curve-grid)" strokeWidth={1}>
						<line x1={g} y1={0} x2={g} y2={CURVE_BOX} />
						<line x1={0} y1={g} x2={CURVE_BOX} y2={g} />
					</g>
				))}
				<line
					x1={0}
					y1={CURVE_BOX}
					x2={CURVE_BOX}
					y2={0}
					stroke="var(--pr-curve-grid)"
					strokeWidth={1}
					strokeDasharray="3 3"
				/>
				{(props.ghosts ?? []).map((gh) => (
					<path
						key={gh.channel}
						d={pathOf(curvePoints(gh.value))}
						fill="none"
						stroke={STROKE[gh.channel]}
						strokeOpacity={0.35}
						strokeWidth={1}
					/>
				))}
				<path d={pathOf(pts)} fill="none" stroke={STROKE[channel]} strokeWidth={1.5} />
				{pts.map(([x, y], i) => (
					<circle
						// biome-ignore lint/suspicious/noArrayIndexKey: points are ordered by x; the index is their identity
						key={i}
						cx={x * CURVE_BOX}
						cy={(1 - y) * CURVE_BOX}
						r={active === i ? 4.5 : 3.5}
						fill={active === i ? STROKE[channel] : 'var(--pr-curve-bg)'}
						stroke={STROKE[channel]}
						strokeWidth={1.5}
						data-curve-point={i}
					/>
				))}
			</svg>
			{pts.length >= MAX_CURVE_POINTS ? (
				<span className="text-pr-small text-pr-muted">Maximum of {MAX_CURVE_POINTS} points</span>
			) : null}
		</div>
	);
}
