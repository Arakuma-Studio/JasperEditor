// rulers and guides on the Program monitor (Premiere View ▸ Show Rulers / Show Guides / Lock Guides, helpx
// "Guides and rulers in the Program Monitor"): rulers in frame pixels along the top and left; drag out of the top
// ruler for a horizontal guide, out of the left one for a vertical guide; drag a guide to move it (unless guides are
// locked) and drop it outside the picture to remove it. Guides snap transform moves when Snap in Program Monitor is
// on (snapping.ts `guides`).
import { useStoreSelector } from '@jasper/session/react';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { addGuide, type Guide, guidesOf, monitorExtras, moveGuide, removeGuide } from './monitor-view.ts';
import type { Size } from './viewport.ts';

const RULER_PX = 16;

type View = { x: number; y: number; scale: number };

/** Ruler tick spacing in frame pixels for a view scale: ~60 screen px between labels. */
export function rulerStep(scale: number): number {
	const target = 60 / Math.max(1e-6, scale);
	for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) if (s >= target) return s;
	return 10000;
}

function Ruler(props: {
	axis: 'x' | 'y';
	view: View;
	length: number;
	frame: Size;
	onDragOut(e: ReactPointerEvent): void;
}) {
	const { axis, view, length } = props;
	const step = rulerStep(view.scale);
	const origin = axis === 'x' ? view.x : view.y;
	const first = Math.ceil(-origin / view.scale / step) * step;
	const ticks: number[] = [];
	for (let v = first; origin + v * view.scale <= length && ticks.length < 400; v += step) ticks.push(v);
	const horizontal = axis === 'x';
	return (
		<div
			className="absolute bg-pr-panel-alt text-[9px] text-pr-muted select-none"
			style={
				horizontal
					? { left: 0, top: 0, right: 0, height: RULER_PX, cursor: 's-resize' }
					: { left: 0, top: 0, bottom: 0, width: RULER_PX, cursor: 'e-resize' }
			}
			onPointerDown={props.onDragOut}
			data-testid={horizontal ? 'program-ruler-top' : 'program-ruler-left'}
			role="presentation"
		>
			{ticks.map((v) => {
				const p = origin + v * view.scale;
				return (
					<span
						key={v}
						className="absolute border-pr-border-strong"
						style={
							horizontal
								? { left: p, top: 0, height: RULER_PX, borderLeftWidth: 1, paddingLeft: 2 }
								: { top: p, left: 0, width: RULER_PX, borderTopWidth: 1, writingMode: 'vertical-rl' }
						}
					>
						{v}
					</span>
				);
			})}
		</div>
	);
}

export function GuidesOverlay(props: { sequenceId: string; view: View; viewport: Size; frame: Size }) {
	const { sequenceId, view, viewport, frame } = props;
	const st = useStoreSelector(
		monitorExtras,
		(s) => ({
			showRulers: s.showRulers,
			showGuides: s.showGuides,
			lockGuides: s.lockGuides,
			guides: s.guides[sequenceId] ?? [],
		}),
		(a, b) =>
			a.showRulers === b.showRulers &&
			a.showGuides === b.showGuides &&
			a.lockGuides === b.lockGuides &&
			a.guides === b.guides,
	);
	const root = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<{ id: string; orientation: Guide['orientation'] } | null>(null);
	const local = (e: { clientX: number; clientY: number }) => {
		const r = root.current?.getBoundingClientRect();
		return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
	};
	const toFrame = (p: { x: number; y: number }, o: Guide['orientation']) =>
		o === 'horizontal' ? (p.y - view.y) / view.scale : (p.x - view.x) / view.scale;
	const startDrag = (id: string, orientation: Guide['orientation'], e: ReactPointerEvent) => {
		e.stopPropagation();
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		setDrag({ id, orientation });
	};
	const onMove = (e: ReactPointerEvent) => {
		if (!drag) return;
		moveGuide(sequenceId, drag.id, toFrame(local(e), drag.orientation));
	};
	const onUp = (e: ReactPointerEvent) => {
		if (!drag) return;
		const pos = toFrame(local(e), drag.orientation);
		const max = drag.orientation === 'horizontal' ? frame.height : frame.width;
		if (pos < 0 || pos > max) removeGuide(sequenceId, drag.id);
		setDrag(null);
	};
	if (!st.showRulers && (!st.showGuides || st.guides.length === 0)) return null;
	const create = (orientation: Guide['orientation']) => (e: ReactPointerEvent) => {
		if (st.lockGuides || e.button !== 0) return;
		const g = addGuide(sequenceId, { orientation, position: toFrame(local(e), orientation) });
		startDrag(g.id, orientation, e);
	};
	return (
		<div
			ref={root}
			className="pointer-events-none absolute inset-0 z-[3]"
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={() => setDrag(null)}
			style={drag ? { pointerEvents: 'auto' } : undefined}
			data-testid="program-guides"
		>
			{st.showGuides
				? guidesOf(sequenceId).map((g, i) => {
						const vertical = g.orientation === 'vertical';
						const p = (vertical ? view.x : view.y) + g.position * view.scale;
						return (
							<div
								key={g.id}
								className="absolute"
								style={{
									...(vertical
										? {
												left: p - 3,
												top: 0,
												bottom: 0,
												width: 7,
												cursor: st.lockGuides ? 'default' : 'ew-resize',
											}
										: {
												top: p - 3,
												left: 0,
												right: 0,
												height: 7,
												cursor: st.lockGuides ? 'default' : 'ns-resize',
											}),
									pointerEvents: st.lockGuides ? 'none' : 'auto',
								}}
								onPointerDown={(e) => !st.lockGuides && e.button === 0 && startDrag(g.id, g.orientation, e)}
								title={`${vertical ? 'Vertical' : 'Horizontal'} guide at ${g.position} px`}
								data-testid={`program-guide-${i}`}
								data-guide-position={g.position}
								role="presentation"
							>
								<div
									className="absolute bg-pr-accent opacity-80"
									style={
										vertical
											? { left: 3, top: 0, bottom: 0, width: 1 }
											: { top: 3, left: 0, right: 0, height: 1 }
									}
								/>
							</div>
						);
					})
				: null}
			{st.showRulers ? (
				<div className="pointer-events-auto">
					<Ruler
						axis="x"
						view={view}
						length={viewport.width}
						frame={frame}
						onDragOut={create('horizontal')}
					/>
					<Ruler axis="y" view={view} length={viewport.height} frame={frame} onDragOut={create('vertical')} />
				</div>
			) : null}
		</div>
	);
}
