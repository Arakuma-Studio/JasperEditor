// Value and Velocity graphs of one twirled-open property row (S03:KF-022, S05:ECP-006). Left: the
// graphs' min/max labels; right (in the mini-timeline): the value curve(s) with draggable keys and
// Bezier handles, and the velocity curve with direction handles. Every drag is one gesture (one undo
// entry, S03:PRP-023) whose transient document previews live in the Program Monitor (S03:ARC-005).
import {
	type Animatable,
	bindExpressions,
	type Command,
	type Ease,
	locateExpressionTarget,
	type ProjectDocument,
	propertyEvaluateOptions,
	type Sequence,
} from '@jasper/project';
import {
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { useExpressionsFor } from '../../expressions/engine.ts';
import { rowExpressionOf } from '../../expressions/row.ts';
import { formatTimecode } from '../../gaps/time-display.ts';
import type { Row } from '../properties/lib/model.ts';
import type { InspectorOps } from '../properties/lib/ops.ts';
import {
	componentsOf,
	easeFromValueDrag,
	easeFromVec2ValueDrag,
	easeFromVelocityDrag,
	fitRange,
	formatGraphValue,
	graphKindOf,
	type Pt,
	panRange,
	planEaseEdit,
	roundToStep,
	samplePostValueCurves,
	samplePostVelocityCurve,
	sampleValueCurves,
	sampleVelocityCurve,
	sideHasHandle,
	timeMapOf,
	type ValueHandle,
	type Vec2ValueHandle,
	type VelocityHandle,
	valueHandles,
	vec2ValueHandles,
	velocityHandles,
	type YRange,
	yScale,
	zoomRange,
} from './graph.ts';
import { type Range, snapDelta } from './lib.ts';

export const GRAPH_HEIGHT = { initial: 150, min: 80, max: 480 } as const;
/** Fallback width when layout is unavailable (tests); matches the lanes' drag fallback. */
const FALLBACK_WIDTH = 300;
const DRAG_THRESHOLD = 3;
/** Horizontal dead zone (px) before a value drag also moves the key in time. */
const TIME_DEAD_ZONE = 5;
const DIM_COLORS = ['var(--pr-graph-x)', 'var(--pr-graph-y)'];
const DIM_NAMES = ['x', 'y'];

type KeySelection = { clipOrTrackId: string; keyframeIds: string[] } | null;

/** Manual vertical ranges of a row's two graphs (absent = auto-fit). */
export type GraphView = { value?: YRange; velocity?: YRange };

type GraphHost = {
	ops: InspectorOps;
	selected: ReadonlySet<string>;
	keySel: KeySelection;
	selectKeys(clipId: string, ids: string[]): void;
	onKeyContextMenu(e: ReactMouseEvent, clipId: string, keyframeId: string): void;
	/** Pointer-down on empty graph space (marquee / deselect, like the lanes). */
	onBackgroundPointerDown(e: ReactPointerEvent<Element>): void;
	/** Snap targets in sequence frames (playhead, clip edges, other keys), excluding moving keys. */
	snapCandidates(clipId: string, exclude: ReadonlySet<string>): number[];
	setTip(text: string | null): void;
};

function pathOf(pts: readonly Pt[], px: (x: number) => number, py: (y: number) => number): string {
	let d = '';
	for (const p of pts) d += `${d ? 'L' : 'M'}${px(p.x).toFixed(2)} ${py(p.y).toFixed(2)}`;
	return d;
}

function useWidth(ref: RefObject<HTMLDivElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => setWidth(el.clientWidth);
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return width || FALLBACK_WIDTH;
}

type Drag = {
	label: string;
	onMove(dx: number, dy: number, ev: PointerEvent): { commands: Command[]; tip: string } | null;
};

export function PropertyGraphs(
	props: {
		row: Row;
		seq: Sequence;
		/** Wave expressions: the drawn document (the post-expression curve of a row with an active expression). */
		doc?: ProjectDocument;
		range: Range;
		height: number;
		onResize(height: number): void;
		leftStyle: CSSProperties;
		showTimeline: boolean;
		/**
		 * each graph's own vertical range (Ctrl/Cmd + wheel zooms about the pointer, Shift + wheel pans,
		 * Auto-fit returns to the fitted range); absent = auto-fit. Persisted per panel instance by the host.
		 */
		view?: GraphView;
		onView?(view: GraphView): void;
	} & GraphHost,
) {
	const { row, seq, range, height, ops } = props;
	const b = row.bindings[0]!;
	const kind = graphKindOf(row.spec) ?? 'number';
	const anim: Animatable<unknown> = useMemo(
		() => b.resolved.anim ?? { value: b.resolved.value, keyframes: [] },
		[b.resolved.anim, b.resolved.value],
	);
	const kfs = anim.keyframes;
	const clip = b.clip;
	const map = useMemo(() => timeMapOf(clip, seq.settings.frameRate), [clip, seq.settings.frameRate]);
	// spatial-points: effect points are sampled with the metric they were resolved with (layer box px).
	const metric = b.resolved.metric;
	const metricKey = metric ? `${metric[0]}x${metric[1]}` : '';
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the metric's values (a new array per resolve)
	const opts = useMemo(
		() => ({ ...propertyEvaluateOptions(row.spec), ...(metric ? { metric } : {}) }),
		[row.spec, metricKey],
	);
	const boxRef = useRef<HTMLDivElement>(null);
	const width = useWidth(boxRef);
	const [frozen, setFrozen] = useState<{ value: YRange; velocity: YRange } | null>(null);

	const span = Math.max(1e-9, range.end - range.start);
	const toPx = (x: number) => ((x - range.start) / span) * width;
	const fromPx = (px: number) => range.start + (px / width) * span;
	const framesPerPx = span / width;

	const valueCurves = useMemo(
		() => sampleValueCurves(anim, map, range, width, opts),
		[anim, map, range, width, opts],
	);
	const velocityCurve = useMemo(
		() => sampleVelocityCurve(anim, map, range, width, opts),
		[anim, map, range, width, opts],
	);
	// Wave expressions: the post-expression graph (keys and handles stay on the keyframed curve, as in AE).
	const exprReady = useExpressionsFor(props.doc ?? null);
	const bound = useMemo(() => {
		if (!props.doc || !exprReady) return null;
		const rx = rowExpressionOf(props.doc, b, seq.id);
		if (!rx?.expression?.enabled || !rx.expression.text.trim()) return null;
		const loc = locateExpressionTarget(bindExpressions(props.doc), rx.ref);
		return loc?.kind === 'anim' ? (loc.target as Animatable<unknown>) : null;
	}, [props.doc, exprReady, b, seq.id]);
	const postCurves = useMemo(
		() => (bound ? samplePostValueCurves(bound, map, range, width, opts) : null),
		[bound, map, range, width, opts],
	);
	const postVelocity = useMemo(
		() => (bound ? samplePostVelocityCurve(bound, map, range, width, opts) : null),
		[bound, map, range, width, opts],
	);
	const vHandles = useMemo(
		() => kfs.map((_, i) => velocityHandles(anim, i, map, opts)),
		[anim, kfs, map, opts],
	);

	const valueBox = Math.max(30, Math.round((height - 1) * 0.55));
	const velocityBox = Math.max(24, height - valueBox - 1);
	const vr =
		frozen?.value ??
		props.view?.value ??
		fitRange(
			[...valueCurves, ...(postCurves ?? [])].flatMap((c) =>
				c.filter((p) => p.x >= range.start && p.x <= range.end).map((p) => p.y),
			),
		);
	const velR =
		frozen?.velocity ??
		props.view?.velocity ??
		fitRange(
			[...velocityCurve, ...(postVelocity ?? [])]
				.filter((p) => p.x >= range.start && p.x <= range.end)
				.map((p) => p.y),
			{ includeZero: true },
		);
	const vy = yScale(vr, valueBox);
	const vely = yScale(velR, velocityBox);
	const precision = row.spec.ui.precision ?? 1;
	const unit =
		row.spec.unit === 'deg' ? '°' : row.spec.unit === '%' ? '%' : row.spec.unit ? ` ${row.spec.unit}` : '';
	// spatial-points: the speed of a point normalised to its layer box is measured in the box's pixels.
	const speedUnit = metric ? ' px' : unit;

	const startDrag = (e: ReactPointerEvent, drag: Drag) => {
		const x0 = e.clientX;
		const y0 = e.clientY;
		let active = false;
		const ranges = { value: vr, velocity: velR };
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - x0;
			const dy = ev.clientY - y0;
			if (!active) {
				if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
				if (!ops.scrub.start(drag.label)) return;
				active = true;
				setFrozen(ranges); // the vertical scale stays put while dragging
			}
			const r = drag.onMove(dx, dy, ev);
			if (!r) return;
			ops.scrub.update(r.commands);
			props.setTip(r.tip);
		};
		const finish = (cancelled: boolean) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('keydown', key, true);
			if (active) ops.scrub.end(cancelled);
			setFrozen(null);
			props.setTip(null);
		};
		const up = () => finish(false);
		const key = (ev: KeyboardEvent) => {
			if (ev.key === 'Escape') finish(true);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('keydown', key, true);
	};

	/** Shared selection rule with the lanes: modifier toggles (no drag), else select and drag. */
	const pickKey = (e: ReactPointerEvent, id: string): string[] | null => {
		e.stopPropagation();
		if (e.button !== 0) return null;
		const sel = props.keySel;
		const sameClip = sel?.clipOrTrackId === clip.id;
		if (e.shiftKey || e.ctrlKey || e.metaKey) {
			const cur = new Set(sameClip ? sel!.keyframeIds : []);
			if (cur.has(id)) cur.delete(id);
			else cur.add(id);
			props.selectKeys(clip.id, [...cur]);
			return null;
		}
		const ids = sameClip && sel!.keyframeIds.includes(id) ? sel!.keyframeIds : [id];
		props.selectKeys(clip.id, ids);
		return ids;
	};

	const onValueKeyDown = (e: ReactPointerEvent, keyIndex: number, dim: number) => {
		const k = kfs[keyIndex]!;
		const ids = pickKey(e, k.id);
		if (!ids) return;
		const own = kfs.filter((x) => ids.includes(x.id));
		const grabbed = Math.round(map.toX(k.time));
		const candidates = props.snapCandidates(clip.id, new Set(ids));
		const step = row.spec.range?.step ?? 1;
		startDrag(e, {
			label: ids.length > 1 ? `Edit ${ids.length} Keyframes` : `Edit Keyframe: ${row.label}`,
			onMove: (dx, dy, ev) => {
				const dv = -dy * vy.perPx;
				let delta = Math.abs(dx) < TIME_DEAD_ZONE ? 0 : Math.round(dx * framesPerPx);
				if (delta !== 0 && !ev.shiftKey) delta = snapDelta(grabbed, delta, candidates, 5 * framesPerPx);
				const commands: Command[] = own.map((x) => {
					let value: unknown;
					if (kind === 'vec2') {
						const v = [...(x.value as number[])];
						v[dim] = roundToStep(v[dim]! + dv, step);
						value = v;
					} else value = roundToStep((x.value as number) + dv, step);
					return { type: 'keyframe.update', keyframeId: x.id, value } as Command;
				});
				if (delta !== 0)
					commands.push({ type: 'keyframe.move', keyframeIds: ids, delta: { frames: delta } } as Command);
				const shown = kind === 'vec2' ? (k.value as number[])[dim]! + dv : (k.value as number) + dv;
				return {
					commands,
					tip: `${formatGraphValue(shown, precision)}${unit}${delta ? ` · ${delta > 0 ? '+' : ''}${delta} f → ${grabbed + delta}` : ''}`,
				};
			},
		});
	};

	/** Handle drags: `ease` maps the pointer delta to the new ease; `unit` = velocity per unit slope. */
	const easeDrag = (
		e: ReactPointerEvent,
		keyIndex: number,
		side: 'in' | 'out',
		unitSpeed: number,
		ease: (dx: number, dy: number) => Ease,
	) => {
		e.stopPropagation();
		if (e.button !== 0) return;
		const base = kfs;
		const alt0 = e.altKey;
		startDrag(e, {
			label: `Keyframe Velocity: ${row.label}`,
			onMove: (dx, dy, ev) => {
				const next = ease(dx, dy);
				return {
					commands: planEaseEdit(base, keyIndex, side, next, alt0 || ev.altKey),
					tip: `Speed ${formatGraphValue(next.slope * unitSpeed, precision)}${speedUnit}/s · Influence ${Math.round(next.influence * 100)}%`,
				};
			},
		});
	};

	const onVelocityHandleDown = (e: ReactPointerEvent, h: VelocityHandle) => {
		const tip0 = toPx(h.tipX);
		easeDrag(e, h.key, h.side, h.unit, (dx, dy) =>
			easeFromVelocityDrag(anim, h, fromPx(tip0 + dx), h.velocity - dy * vely.perPx, map),
		);
	};

	const onValueHandleDown = (e: ReactPointerEvent, h: ValueHandle) => {
		const tip0 = toPx(h.tipX);
		const unitSpeed = vHandles[h.key]?.find((v) => v.side === h.side)?.unit ?? 0;
		easeDrag(e, h.key, h.side, unitSpeed, (dx, dy) =>
			easeFromValueDrag(anim as Animatable<number>, h, fromPx(tip0 + dx), h.tipY - dy * vy.perPx, map),
		);
	};

	const onVec2HandleDown = (e: ReactPointerEvent, h: Vec2ValueHandle) => {
		const tip0 = toPx(h.tipX);
		const unitSpeed = vHandles[h.key]?.find((v) => v.side === h.side)?.unit ?? 0;
		easeDrag(e, h.key, h.side, unitSpeed, (dx, dy) =>
			easeFromVec2ValueDrag(anim, h, fromPx(tip0 + dx), h.tipY - dy * vy.perPx, map),
		);
	};

	// independent vertical zoom / pan per graph (non-passive wheel listeners so the panel does not
	// scroll while zooming).
	const valueSvg = useRef<SVGSVGElement>(null);
	const velocitySvg = useRef<SVGSVGElement>(null);
	const viewRef = useRef({ vr, velR, valueBox, velocityBox, view: props.view, onView: props.onView });
	viewRef.current = { vr, velR, valueBox, velocityBox, view: props.view, onView: props.onView };
	useEffect(() => {
		const attach = (el: SVGSVGElement | null, which: 'value' | 'velocity') => {
			if (!el) return () => {};
			const onWheel = (ev: WheelEvent) => {
				const zoom = ev.ctrlKey || ev.metaKey;
				if (!zoom && !ev.shiftKey) return;
				const st = viewRef.current;
				if (!st.onView) return;
				ev.preventDefault();
				const r = which === 'value' ? st.vr : st.velR;
				const h = which === 'value' ? st.valueBox : st.velocityBox;
				const rect = el.getBoundingClientRect();
				const y = rect.height > 0 ? ev.clientY - rect.top : h / 2;
				const at = r.max - (y / Math.max(1, h)) * (r.max - r.min);
				const amount = ev.deltaY || ev.deltaX;
				const next = zoom
					? zoomRange(r, at, 1.1 ** Math.sign(amount))
					: panRange(r, (Math.sign(amount) * (r.max - r.min)) / 10);
				st.onView({ ...st.view, [which]: next });
			};
			el.addEventListener('wheel', onWheel, { passive: false });
			return () => el.removeEventListener('wheel', onWheel);
		};
		const a = attach(valueSvg.current, 'value');
		const b = attach(velocitySvg.current, 'velocity');
		return () => {
			a();
			b();
		};
	}, []);
	const fitButton = (which: 'value' | 'velocity') => {
		const auto = !props.view?.[which];
		return (
			<button
				type="button"
				className="absolute top-1/2 left-1 -translate-y-1/2 rounded-pr-control px-[3px] text-[9px] leading-[11px] text-pr-muted hover:bg-pr-field aria-pressed:text-pr-text"
				aria-pressed={auto}
				title={
					auto ? 'Auto-fit (Ctrl/Cmd + wheel to zoom, Shift + wheel to pan)' : 'Auto-fit the vertical range'
				}
				data-testid={`graph-fit-${which}-${row.id}`}
				onClick={() => {
					if (!props.onView) return;
					const next = { ...props.view };
					delete next[which];
					props.onView(next);
				}}
			>
				Fit
			</button>
		);
	};

	const onResizeDown = (e: ReactPointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const y0 = e.clientY;
		const h0 = height;
		const move = (ev: PointerEvent) =>
			props.onResize(
				Math.min(GRAPH_HEIGHT.max, Math.max(GRAPH_HEIGHT.min, Math.round(h0 + ev.clientY - y0))),
			);
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};

	const selectedIdx = kfs.flatMap((k, i) => (props.selected.has(k.id) ? [i] : []));
	const keyLabel = (i: number) =>
		`${row.label} key at ${formatTimecode(Math.round(map.toX(kfs[i]!.time)), seq.settings.frameRate, { dropFrame: seq.settings.dropFrame })}`;
	const contextMenu = (e: ReactMouseEvent, id: string) => {
		e.stopPropagation();
		props.onKeyContextMenu(e, clip.id, id);
	};
	const square = (x: number, y: number, selected: boolean) => (
		<rect
			x={x - 3}
			y={y - 3}
			width={6}
			height={6}
			fill={selected ? 'var(--pr-keyframe-selected)' : 'var(--pr-keyframe)'}
			stroke={selected ? 'var(--pr-keyframe-selected-stroke)' : 'var(--pr-keyframe-stroke)'}
			strokeWidth={0.75}
		/>
	);
	const handleTip = (x: number, y: number) => (
		<circle
			cx={x}
			cy={y}
			r={3.5}
			fill="var(--pr-graph-bg)"
			stroke="var(--pr-graph-handle)"
			strokeWidth={1.25}
		/>
	);
	const grid = (h: number) =>
		[0.25, 0.5, 0.75].map((f) => (
			<line key={f} x1={0} x2={width} y1={h * f} y2={h * f} stroke="var(--pr-graph-grid)" strokeWidth={1} />
		));

	const valueHandleList: ValueHandle[] =
		kind === 'number'
			? selectedIdx.flatMap((i) =>
					// keyframe-sides: a handle on each Bezier side (an Ease In key has one on its incoming side only).
					valueHandles(anim as Animatable<number>, i, map).filter((h) => sideHasHandle(kfs[i]!, h.side)),
				)
			: [];

	const vec2HandleList: Vec2ValueHandle[] =
		kind === 'vec2'
			? selectedIdx.flatMap((i) =>
					vec2ValueHandles(anim, i, map, opts).filter((h) => sideHasHandle(kfs[i]!, h.side)),
				)
			: [];

	const labels = (r: YRange, h: number, suffix: string, testid: string, which: 'value' | 'velocity') => (
		<div className="relative" style={{ height: h }} data-testid={testid}>
			<span className="absolute top-[1px] right-2">{`${formatGraphValue(r.max, precision)}${suffix}`}</span>
			{h >= 30 ? fitButton(which) : null}
			<span className="absolute right-2 bottom-[1px]">{`${formatGraphValue(r.min, precision)}${suffix}`}</span>
		</div>
	);

	return (
		<div
			className="relative flex items-stretch border-b border-pr-border-subtle"
			style={{ height }}
			data-graph-row={row.id}
			data-testid={`graphs-${row.id}`}
		>
			<div
				style={props.leftStyle}
				className="pr-tabular flex shrink-0 flex-col text-[10px] leading-[12px] text-pr-muted select-none"
			>
				{labels(vr, valueBox, unit, `graph-value-labels-${row.id}`, 'value')}
				<div className="h-px bg-pr-border-subtle" />
				{labels(velR, velocityBox, `${speedUnit}/s`, `graph-velocity-labels-${row.id}`, 'velocity')}
			</div>
			{props.showTimeline ? (
				<div
					ref={boxRef}
					className="flex min-w-0 flex-1 flex-col self-stretch border-l border-pr-border-subtle"
					data-lane
				>
					<svg
						ref={valueSvg}
						width="100%"
						height={valueBox}
						className="block shrink-0 overflow-hidden"
						style={{ background: 'var(--pr-graph-bg)' }}
						data-testid={`graph-value-${row.id}`}
						onPointerDown={props.onBackgroundPointerDown}
						aria-label={`${row.label} value graph`}
						role="img"
					>
						{grid(valueBox)}
						{valueCurves.map((c, d) => (
							<path
								// biome-ignore lint/suspicious/noArrayIndexKey: one curve per value component
								key={d}
								d={pathOf(c, toPx, vy.toPx)}
								fill="none"
								stroke={kind === 'vec2' ? DIM_COLORS[d] : 'var(--pr-graph-curve)'}
								strokeWidth={1.25}
								data-testid={`graph-value-curve-${row.id}-${d}`}
							/>
						))}
						{postCurves?.map((c, d) => (
							<path
								// biome-ignore lint/suspicious/noArrayIndexKey: one curve per value component
								key={`post-${d}`}
								d={pathOf(c, toPx, vy.toPx)}
								fill="none"
								stroke="var(--pr-graph-post)"
								strokeWidth={1.25}
								strokeDasharray={kind === 'vec2' && d === 1 ? '4 2' : undefined}
								data-testid={`graph-post-curve-${row.id}-${d}`}
							>
								<title>Post-expression value</title>
							</path>
						))}
						{valueHandleList.map((h) => {
							const k = kfs[h.key]!;
							const kx = toPx(map.toX(k.time));
							const ky = vy.toPx(k.value as number);
							const tx = toPx(h.tipX);
							const ty = vy.toPx(h.tipY);
							return (
								<g key={`${k.id}:${h.side}`}>
									<line x1={kx} y1={ky} x2={tx} y2={ty} stroke="var(--pr-graph-handle)" strokeWidth={1} />
									<g
										className="cursor-pointer"
										data-testid={`graph-value-handle-${k.id}-${h.side}`}
										onPointerDown={(e) => onValueHandleDown(e, h)}
									>
										{handleTip(tx, ty)}
									</g>
								</g>
							);
						})}
						{vec2HandleList.map((h) => {
							const k = kfs[h.key]!;
							const kx = toPx(map.toX(k.time));
							const ky = vy.toPx(h.keyY);
							const tx = toPx(h.tipX);
							const ty = vy.toPx(h.tipY);
							return (
								<g key={`${k.id}:${h.side}:${h.dim}`}>
									<line x1={kx} y1={ky} x2={tx} y2={ty} stroke={DIM_COLORS[h.dim]} strokeWidth={1} />
									<g
										className="cursor-pointer"
										data-testid={`graph-value-handle-${k.id}-${h.side}-${h.dim}`}
										onPointerDown={(e) => onVec2HandleDown(e, h)}
									>
										{handleTip(tx, ty)}
									</g>
								</g>
							);
						})}
						{kfs.map((k, i) =>
							componentsOf(k.value)
								.map((v, d) => [v, d, DIM_NAMES[d] ?? String(d)] as const)
								.map(([v, d, name]) => (
									// biome-ignore lint/a11y/noStaticElementInteractions: pointer-only key; keyboard via the row navigator
									<g
										key={`${k.id}:${name}`}
										className="cursor-pointer"
										data-kf-id={k.id}
										data-kf-clip={clip.id}
										data-testid={`graph-value-key-${k.id}${kind === 'vec2' ? `-${d}` : ''}`}
										aria-label={keyLabel(i)}
										onPointerDown={(e) => onValueKeyDown(e, i, d)}
										onContextMenu={(e) => contextMenu(e, k.id)}
									>
										{square(toPx(map.toX(k.time)), vy.toPx(v), props.selected.has(k.id))}
									</g>
								)),
						)}
					</svg>
					<div className="h-px shrink-0 bg-pr-border-subtle" />
					<svg
						ref={velocitySvg}
						width="100%"
						height={velocityBox}
						className="block shrink-0 overflow-hidden"
						style={{ background: 'var(--pr-graph-bg)' }}
						data-testid={`graph-velocity-${row.id}`}
						onPointerDown={props.onBackgroundPointerDown}
						aria-label={`${row.label} velocity graph`}
						role="img"
					>
						{grid(velocityBox)}
						<line
							x1={0}
							x2={width}
							y1={vely.toPx(0)}
							y2={vely.toPx(0)}
							stroke="var(--pr-graph-zero)"
							strokeWidth={1}
						/>
						<path
							d={pathOf(velocityCurve, toPx, vely.toPx)}
							fill="none"
							stroke="var(--pr-graph-curve)"
							strokeWidth={1.25}
							data-testid={`graph-velocity-curve-${row.id}`}
						/>
						{postVelocity ? (
							<path
								d={pathOf(postVelocity, toPx, vely.toPx)}
								fill="none"
								stroke="var(--pr-graph-post)"
								strokeWidth={1.25}
								data-testid={`graph-post-velocity-${row.id}`}
							>
								<title>Post-expression velocity</title>
							</path>
						) : null}
						{vHandles.map((hs, i) => {
							const k = kfs[i]!;
							const kx = toPx(map.toX(k.time));
							const sel = props.selected.has(k.id);
							return (
								<g key={k.id}>
									{sel
										? hs.map((h) => (
												<g key={h.side}>
													<line
														x1={kx}
														y1={vely.toPx(h.velocity)}
														x2={toPx(h.tipX)}
														y2={vely.toPx(h.velocity)}
														stroke="var(--pr-graph-handle)"
														strokeWidth={1}
													/>
													<g
														className="cursor-pointer"
														data-testid={`graph-velocity-handle-${k.id}-${h.side}`}
														onPointerDown={(e) => onVelocityHandleDown(e, h)}
													>
														{handleTip(toPx(h.tipX), vely.toPx(h.velocity))}
													</g>
												</g>
											))
										: null}
									{(hs.length ? hs : [{ side: 'out' as const, velocity: 0 }]).map((h) => (
										// biome-ignore lint/a11y/noStaticElementInteractions: pointer-only key marker (selects the key)
										<g
											key={`k:${h.side}`}
											className="cursor-pointer"
											data-testid={`graph-velocity-key-${k.id}-${h.side}`}
											onPointerDown={(e) => {
												pickKey(e, k.id);
											}}
											onContextMenu={(e) => contextMenu(e, k.id)}
										>
											{square(kx, vely.toPx(h.velocity), sel)}
										</g>
									))}
								</g>
							);
						})}
					</svg>
				</div>
			) : (
				<div className="flex-1" />
			)}
			<div
				className="absolute inset-x-0 bottom-[-2px] z-[1] h-[5px] cursor-row-resize"
				onPointerDown={onResizeDown}
				title="Drag to resize the graphs"
				data-testid={`graph-resize-${row.id}`}
			/>
		</div>
	);
}
