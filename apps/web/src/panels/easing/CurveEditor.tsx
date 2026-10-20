// Easing panel ▸ the curve editor (SVG): x = time fraction, y = value fraction, the 0…1 square with the overshoot
// bands above 1 and below 0 shaded. Drag handles and points; Shift constrains to one axis; Alt moves one handle
// on its own (a symmetric cubic or a smooth point stays linked otherwise); Ctrl/Cmd-click the curve adds a point,
// Ctrl/Cmd-click a point removes it; double-click empty space resets to linear. Keyboard: Tab to a handle, arrows
// nudge it (Shift ×10), Delete removes a point, + adds one in the widest piece, Ctrl/Cmd+Z / Shift+Z undo / redo
// the editor's own history. A drag reports `move` previews and one `commit` (or `cancel` on Escape).
import { type EaseCurve, easeCurveSegments, evaluateEaseCurve } from '@jasper/project';
import { cx } from '@jasper/ui';
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from 'react';
import type { Platform } from '../../commands/keymap-defaults.ts';
import { t } from '../../i18n/runtime.ts';
import {
	addPoint,
	dragHandle,
	type HandleRef,
	handlePosition,
	handleRefs,
	LINEAR_EASE_CURVE,
	nudgeHandle,
	pointNear,
	removePoint,
	sameRef,
	type Vec,
} from './curve-edit.ts';
import { type CurveView, curvePath, fromPx, PAD, plotWidth, toPx, viewRange } from './geometry.ts';

export type CurveChange = 'start' | 'move' | 'commit' | 'cancel';

/** Pointer travel before a press becomes a drag (px). */
const DRAG_SLOP = 2;
/** How close (px) a Ctrl/Cmd-click must be to the curve to add a point. */
const HIT_PX = 8;

const refKey = (r: HandleRef) => (r.kind === 'cubic' ? `h${r.handle}` : `${r.kind}-${r.index}`);

function refLabel(r: HandleRef): string {
	if (r.kind === 'cubic') return r.handle === 1 ? t('First handle') : t('Second handle');
	if (r.kind === 'point') return t('Point {0}', r.index + 1);
	return r.kind === 'in' ? t('Point {0} in handle', r.index + 1) : t('Point {0} out handle', r.index + 1);
}

/** Measured size of an element (ResizeObserver), with a fallback before the first measurement. */
function useSize(fixed?: { w: number; h: number }) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ w: fixed?.w ?? 240, h: fixed?.h ?? 180 });
	useEffect(() => {
		if (fixed) return;
		const el = ref.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(([e]) => {
			const r = e?.contentRect;
			if (r && r.width > 0 && r.height > 0)
				setSize((s) =>
					Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: r.width, h: r.height },
				);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [fixed]);
	return { ref, size: fixed ?? size };
}

type Drag = {
	ref: HandleRef;
	base: EaseCurve;
	grab: Vec;
	x0: number;
	y0: number;
	view: CurveView;
	moved: boolean;
};

export function CurveEditor(props: {
	curve: EaseCurve;
	onChange(curve: EaseCurve, phase: CurveChange): void;
	onUndo(): void;
	onRedo(): void;
	platform: Platform;
	/** Fixed size (tests); measured from the container otherwise. */
	size?: { w: number; h: number };
	className?: string;
}) {
	const { curve, onChange } = props;
	const { ref, size } = useSize(props.size);
	const svgRef = useRef<SVGSVGElement | null>(null);
	const [selected, setSelected] = useState<HandleRef | null>(null);
	const drag = useRef<Drag | null>(null);
	// The vertical range is frozen while dragging, so the handle stays under the pointer.
	const [frozen, setFrozen] = useState<{ lo: number; hi: number } | null>(null);
	const range = frozen ?? viewRange(curve);
	const plotW = plotWidth(size.w, size.h);
	const view: CurveView = { w: plotW, h: size.h, ...range, ox: (size.w - plotW) / 2 };
	const primary = (e: { ctrlKey: boolean; metaKey: boolean }) =>
		props.platform === 'mac' ? e.metaKey : e.ctrlKey;

	useEffect(() => {
		// A selection that no longer exists (point removed, cubic ↔ multi) is dropped.
		if (selected && !handleRefs(curve).some((r) => sameRef(r, selected))) setSelected(null);
	}, [curve, selected]);

	const localPoint = (e: { clientX: number; clientY: number }, v: CurveView): [number, number] => {
		const box = svgRef.current?.getBoundingClientRect();
		return fromPx(v, e.clientX - (box?.left ?? 0), e.clientY - (box?.top ?? 0));
	};

	const startDrag = (e: ReactPointerEvent, r: HandleRef) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		setSelected(r);
		if (primary(e) && r.kind === 'point') {
			onChange(removePoint(curve, r.index), 'commit');
			return;
		}
		const grab = handlePosition(curve, r);
		if (!grab) return;
		const d: Drag = { ref: r, base: curve, grab, x0: e.clientX, y0: e.clientY, view, moved: false };
		drag.current = d;
		let last: { alt: boolean; shift: boolean; target: Vec } | null = null;
		const move = (ev: PointerEvent) => {
			if (!d.moved) {
				if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < DRAG_SLOP) return;
				d.moved = true;
				setFrozen({ lo: d.view.lo, hi: d.view.hi });
				onChange(d.base, 'start');
			}
			const pos = localPoint(ev, d.view);
			// Relative to where the press was, so grabbing a handle off-centre does not make it jump.
			const p0 = localPoint({ clientX: d.x0, clientY: d.y0 }, d.view);
			const target: Vec = [d.grab[0] + pos[0] - p0[0], d.grab[1] + pos[1] - p0[1]];
			onChange(dragHandle(d.base, d.ref, target, { alt: ev.altKey, shift: ev.shiftKey }, d.grab), 'move');
			last = { alt: ev.altKey, shift: ev.shiftKey, target };
		};
		const finish = (cancelled: boolean) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('keydown', key, true);
			drag.current = null;
			setFrozen(null);
			if (!d.moved) return;
			if (cancelled || !last) onChange(d.base, 'cancel');
			else onChange(dragHandle(d.base, d.ref, last.target, last, d.grab), 'commit');
		};
		const up = () => finish(false);
		const key = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape') return;
			ev.stopPropagation();
			ev.preventDefault();
			finish(true);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('keydown', key, true);
	};

	const onBackgroundPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		if (e.button !== 0 || drag.current) return;
		if (!primary(e)) {
			setSelected(null);
			return;
		}
		const [x] = localPoint(e, view);
		const at = toPx(view, [x, evaluateEaseCurve(curve, x)]);
		const box = svgRef.current?.getBoundingClientRect();
		const py = e.clientY - (box?.top ?? 0);
		if (!(x > 0 && x < 1) || Math.abs(at[1] - py) > HIT_PX) return;
		const near = pointNear(curve, x, 0.01);
		if (near > 0) {
			onChange(removePoint(curve, near), 'commit');
			return;
		}
		const added = addPoint(curve, x);
		if (added) {
			onChange(added.curve, 'commit');
			setSelected({ kind: 'point', index: added.index });
		}
	};

	const onDoubleClick = (e: ReactMouseEvent<SVGSVGElement>) => {
		if ((e.target as Element).closest('[data-ease-handle]')) return;
		onChange({ ...LINEAR_EASE_CURVE }, 'commit');
	};

	const onKeyDown = (e: ReactKeyboardEvent) => {
		const mod = primary(e);
		if (mod && (e.code === 'KeyZ' || e.code === 'KeyY')) {
			e.preventDefault();
			if (e.code === 'KeyY' || e.shiftKey) props.onRedo();
			else props.onUndo();
			return;
		}
		if (e.key === '+' || e.code === 'NumpadAdd') {
			e.preventDefault();
			// The middle of the widest piece.
			const segs = easeCurveSegments(curve);
			const widest = segs.reduce((a, s) => (s[3][0] - s[0][0] > a[3][0] - a[0][0] ? s : a), segs[0]!);
			const added = addPoint(curve, (widest[0][0] + widest[3][0]) / 2);
			if (added) {
				onChange(added.curve, 'commit');
				setSelected({ kind: 'point', index: added.index });
			}
			return;
		}
		if (!selected) return;
		if ((e.key === 'Delete' || e.key === 'Backspace') && selected.kind === 'point') {
			e.preventDefault();
			onChange(removePoint(curve, selected.index), 'commit');
			setSelected(null);
			return;
		}
		const step = e.shiftKey ? 0.1 : 0.01;
		const d: Record<string, [number, number]> = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, step],
			ArrowDown: [0, -step],
		};
		const delta = d[e.key];
		if (!delta || mod || e.altKey) return;
		e.preventDefault();
		onChange(nudgeHandle(curve, selected, delta[0], delta[1]), 'commit');
	};

	const refs = handleRefs(curve);
	const segs = easeCurveSegments(curve);
	const gridX = [0, 0.25, 0.5, 0.75, 1];
	const gridY: number[] = [];
	for (let y = Math.ceil(view.lo * 4) / 4; y <= view.hi + 1e-9; y += 0.25) gridY.push(Number(y.toFixed(2)));
	const [, top1] = toPx(view, [0, 1]);
	const [, top0] = toPx(view, [0, 0]);
	const [left0] = toPx(view, [0, 0]);
	const [right1] = toPx(view, [1, 0]);
	const overshoot = 'color-mix(in srgb, var(--pr-warning) 12%, transparent)';
	return (
		<div
			ref={ref}
			className={cx('relative min-h-[120px] min-w-[120px]', props.className)}
			style={props.size ? { width: size.w, height: size.h } : undefined}
			data-keymap-local
		>
			<svg
				ref={svgRef}
				width={size.w}
				height={size.h}
				className="absolute inset-0 block rounded-pr-control outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-pr-focus"
				aria-label="Ease curve editor"
				aria-description="Drag the handles. Ctrl or Cmd click the curve to add a point, a point to remove it. Double-click empty space to reset."
				onPointerDown={onBackgroundPointerDown}
				onDoubleClick={onDoubleClick}
				onKeyDown={onKeyDown}
				data-testid="ease-curve-editor"
				data-curve-kind={curve.kind}
			>
				<rect x={0} y={0} width={size.w} height={size.h} fill="var(--pr-graph-bg)" />
				{/* overshoot bands: value beyond the start (below 0) or the end (above 1) */}
				<rect x={left0} y={0} width={right1 - left0} height={Math.max(0, top1)} fill={overshoot} />
				<rect
					x={left0}
					y={top0}
					width={right1 - left0}
					height={Math.max(0, size.h - top0)}
					fill={overshoot}
				/>
				{gridX.map((x) => {
					const [px] = toPx(view, [x, 0]);
					return <line key={`x${x}`} x1={px} x2={px} y1={0} y2={size.h} stroke="var(--pr-graph-grid)" />;
				})}
				{gridY.map((y) => {
					const [, py] = toPx(view, [0, y]);
					const edge = Math.abs(y) < 1e-9 || Math.abs(y - 1) < 1e-9;
					return (
						<line
							key={`y${y}`}
							x1={0}
							x2={size.w}
							y1={py}
							y2={py}
							stroke={edge ? 'var(--pr-graph-zero)' : 'var(--pr-graph-grid)'}
						/>
					);
				})}
				<line
					x1={left0}
					y1={top0}
					x2={right1}
					y2={top1}
					stroke="var(--pr-graph-grid)"
					strokeDasharray="3 3"
					aria-hidden
				/>
				<text x={right1} y={size.h - 3} textAnchor="end" className="fill-pr-dim text-[9px]">
					Time
				</text>
				<text x={left0 - PAD + 3} y={10} className="fill-pr-dim text-[9px]">
					Value
				</text>
				<path
					d={curvePath(view, curve)}
					fill="none"
					stroke="var(--pr-graph-curve)"
					strokeWidth={2}
					data-testid="ease-curve-path"
				/>
				{refs
					.filter((r) => r.kind !== 'point')
					.map((r) => {
						const h = handlePosition(curve, r)!;
						const seg =
							r.kind === 'cubic' ? segs[0]! : r.kind === 'out' ? segs[r.index]! : segs[r.index - 1]!;
						const anchor =
							r.kind === 'cubic' ? (r.handle === 1 ? seg[0] : seg[3]) : r.kind === 'out' ? seg[0] : seg[3];
						const [ax, ay] = toPx(view, anchor);
						const [hx, hy] = toPx(view, h);
						return (
							<line key={`l-${refKey(r)}`} x1={ax} y1={ay} x2={hx} y2={hy} stroke="var(--pr-graph-handle)" />
						);
					})}
				{refs.map((r) => {
					const p = handlePosition(curve, r)!;
					const [px, py] = toPx(view, p);
					const on = sameRef(r, selected);
					const point = r.kind === 'point';
					const label = refLabel(r);
					return (
						<g
							key={refKey(r)}
							role="slider"
							tabIndex={0}
							aria-label={label}
							aria-valuemin={-10}
							aria-valuemax={10}
							aria-valuenow={Number(p[1].toFixed(3))}
							aria-valuetext={`x ${p[0].toFixed(3)}, y ${p[1].toFixed(3)}`}
							data-ease-handle={refKey(r)}
							data-testid={`ease-handle-${refKey(r)}`}
							className="cursor-grab outline-none"
							onFocus={() => setSelected(r)}
							onPointerDown={(e) => startDrag(e, r)}
						>
							<circle cx={px} cy={py} r={10} fill="transparent" />
							{point ? (
								<rect
									x={px - 4}
									y={py - 4}
									width={8}
									height={8}
									transform={`rotate(45 ${px} ${py})`}
									fill={on ? 'var(--pr-graph-handle)' : 'var(--pr-graph-curve)'}
									stroke="var(--pr-graph-bg)"
								/>
							) : (
								<circle
									cx={px}
									cy={py}
									r={on ? 6 : 5}
									fill={on ? 'var(--pr-graph-handle)' : 'var(--pr-graph-bg)'}
									stroke="var(--pr-graph-handle)"
									strokeWidth={2}
								/>
							)}
						</g>
					);
				})}
			</svg>
		</div>
	);
}
