// Colour wheel over a vec2 in the unit disc (S06:CGU-001, CG-020 step 11): the hue ring matches the maths
// (θ = atan2(y, x): 0° red, 120° green, 240° blue; y up), the distance from the centre is the amount. Dragging
// the puck is one gesture (one undo step); double-click resets to the centre. An optional level row draws a
// slider with its value under the wheel.
import { type MouseEvent, type PointerEvent, useEffect, useRef } from 'react';
import type { Row } from '../../panels/properties/lib/model.ts';
import { wheelFromOffset, wheelToOffset, wheelVec } from '../model.ts';
import { type RowWriteContext, useRowWriter } from '../rowEdit.ts';
import { SliderEditor } from './SliderEditor.tsx';

/** Fallback wheel diameter when layout is unavailable (tests). */
export const WHEEL_FALLBACK = 120;

export function WheelField(props: {
	row: Row;
	levelRow?: Row;
	ctx: RowWriteContext;
	/** Title under the wheel (defaults to the row label). */
	title?: string;
	disabled?: boolean;
	'data-testid'?: string;
}) {
	const { row } = props;
	const writer = useRowWriter(row, props.ctx);
	const cleanup = useRef<(() => void) | null>(null);
	useEffect(() => () => cleanup.current?.(), []);
	const v = wheelVec(row.bindings[0]?.resolved.value);
	const { dx, dy } = wheelToOffset(v, 50);

	const geometry = (el: Element) => {
		const r = el.getBoundingClientRect();
		const w = r.width || WHEEL_FALLBACK;
		const h = r.height || WHEEL_FALLBACK;
		return { cx: r.left + w / 2, cy: r.top + h / 2, radius: Math.min(w, h) / 2 };
	};

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (props.disabled || e.button !== 0) return;
		e.preventDefault();
		const g = geometry(e.currentTarget);
		const at = (x: number, y: number) => wheelFromOffset(x - g.cx, y - g.cy, g.radius);
		if (!writer.begin()) return;
		const start = at(e.clientX, e.clientY);
		let changed = start[0] !== v[0] || start[1] !== v[1];
		if (changed) writer.update(start);
		const move = (ev: globalThis.PointerEvent) => {
			changed = true;
			writer.update(at(ev.clientX, ev.clientY));
		};
		const finish = (cancelled: boolean) => {
			cleanup.current?.();
			cleanup.current = null;
			writer.end(cancelled || !changed);
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

	const onDoubleClick = (e: MouseEvent) => {
		e.preventDefault();
		if (!props.disabled && (v[0] !== 0 || v[1] !== 0)) writer.commit([0, 0]);
	};

	const title = props.title ?? row.label;
	return (
		<div className="flex min-w-0 flex-1 flex-col items-center gap-1" data-testid={props['data-testid']}>
			{title ? <span className="text-pr-small text-pr-muted">{title}</span> : null}
			<div
				role="slider"
				aria-label={`${title || row.label} wheel`}
				aria-valuemin={0}
				aria-valuemax={1}
				aria-valuenow={Math.round(Math.hypot(v[0], v[1]) * 1000) / 1000}
				aria-valuetext={`${v[0].toFixed(3)}, ${v[1].toFixed(3)}`}
				tabIndex={-1}
				className="relative aspect-square w-full max-w-[120px] cursor-crosshair rounded-full border border-pr-border-strong"
				style={{ background: 'var(--pr-wheel-desat), var(--pr-wheel-hue)', touchAction: 'none' }}
				onPointerDown={onPointerDown}
				onDoubleClick={onDoubleClick}
				data-testid={props['data-testid'] ? `${props['data-testid']}-disc` : undefined}
				data-value={JSON.stringify(v)}
			>
				<span
					className="pointer-events-none absolute top-1/2 left-1/2 h-px w-[10px] -translate-x-1/2"
					style={{ background: 'var(--pr-wheel-cross)' }}
				/>
				<span
					className="pointer-events-none absolute top-1/2 left-1/2 h-[10px] w-px -translate-y-1/2"
					style={{ background: 'var(--pr-wheel-cross)' }}
				/>
				<span
					className="pointer-events-none absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
					style={{
						left: `${50 + dx}%`,
						top: `${50 + dy}%`,
						borderColor: 'var(--pr-wheel-puck)',
						boxShadow: '0 0 0 1px var(--pr-wheel-puck-ring)',
					}}
				/>
			</div>
			{props.levelRow ? (
				<SliderEditor
					row={props.levelRow}
					ctx={props.ctx}
					disabled={props.disabled}
					compact
					data-testid={props['data-testid'] ? `${props['data-testid']}-level` : undefined}
				/>
			) : null}
		</div>
	);
}
