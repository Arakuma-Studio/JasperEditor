// Program monitor Rectangle / Ellipse tools (S03:XF-061, S11:SHP-006, S05:TOOL-005). Registered as a Program
// overlay; while a shape tool is active it covers the monitor: a drag draws the shape's bounding box (Shift =
// square/circle, Alt = from the centre, re-evaluated when the modifiers change mid-drag), the outline previews
// the result, Escape cancels, and the release adds the shape in one transaction (one undo step) at the playhead,
// selects it and returns to the Selection tool. Clicks without a drag add nothing.
import type { ShapeType, Vec2 } from '@jasper/project';
import type { TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';
import { type DrawnBox, dragShapeBox } from './geometry.ts';
import { addShapeAt } from './insert.ts';

const DRAG_THRESHOLD = 3;
const TOOL_SHAPES: Partial<Record<string, ShapeType>> = { rectangle: 'rect', ellipse: 'ellipse' };

type Drag = {
	start: Vec2;
	startScreen: Vec2;
	last: Vec2;
	moved: boolean;
	shift: boolean;
	alt: boolean;
};

export function ShapeToolOverlay(props: ProgramOverlayHostProps) {
	const { session } = props;
	const tool = useStoreSelector(session.store, (s) => s.toggles.activeTool);
	const type = TOOL_SHAPES[tool];
	if (!type) return null;
	return <ShapeDrawSurface {...props} type={type} />;
}

function ShapeDrawSurface(props: ProgramOverlayHostProps & { type: ShapeType }) {
	const { session, type } = props;
	const view = props.view as View;
	const transport = props.transport as TransportStore;
	const svgRef = useRef<SVGSVGElement>(null);
	const dragRef = useRef<Drag | null>(null);
	const [box, setBox] = useState<DrawnBox | null>(null);

	const local = (e: { clientX: number; clientY: number }): Vec2 => {
		const r = svgRef.current!.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	};
	const refresh = () => {
		const d = dragRef.current;
		setBox(d?.moved ? dragShapeBox(d.start, d.last, { shift: d.shift, alt: d.alt }) : null);
	};
	const cancel = () => {
		dragRef.current = null;
		setBox(null);
	};

	// Escape cancels the drag before the keymap sees it; Shift/Alt changes re-shape the box without a move.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const d = dragRef.current;
			if (!d) return;
			if (e.type === 'keydown' && e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				cancel();
				return;
			}
			if (e.key === 'Shift' || e.key === 'Alt') {
				e.preventDefault();
				e.stopPropagation();
				d.shift = e.shiftKey;
				d.alt = e.altKey;
				refresh();
			}
		};
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('keyup', onKey, true);
		return () => {
			window.removeEventListener('keydown', onKey, true);
			window.removeEventListener('keyup', onKey, true);
		};
	});

	const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		if (e.button !== 0) return;
		e.preventDefault();
		if (transport.getState().playing) transport.pause();
		svgRef.current?.setPointerCapture?.(e.pointerId);
		const screen = local(e);
		const p = toSequence(view, screen);
		dragRef.current = {
			start: p,
			startScreen: screen,
			last: p,
			moved: false,
			shift: e.shiftKey,
			alt: e.altKey,
		};
	};
	const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
		const d = dragRef.current;
		if (!d) return;
		const screen = local(e);
		d.last = toSequence(view, screen);
		d.shift = e.shiftKey;
		d.alt = e.altKey;
		if (!d.moved && Math.hypot(screen[0] - d.startScreen[0], screen[1] - d.startScreen[1]) < DRAG_THRESHOLD)
			return;
		d.moved = true;
		refresh();
	};
	const onPointerUp = () => {
		const d = dragRef.current;
		dragRef.current = null;
		setBox(null);
		if (!d?.moved) return;
		const drawn = dragShapeBox(d.start, d.last, { shift: d.shift, alt: d.alt });
		if (drawn.size[0] < 1 || drawn.size[1] < 1) return;
		if (addShapeAt(session, type, transport.getState().frame, drawn))
			session.setToggles({ activeTool: 'selection' });
	};

	return (
		<svg
			ref={svgRef}
			data-testid="shape-tool-overlay"
			data-shape-tool={type}
			className="absolute inset-0 h-full w-full touch-none select-none"
			style={{ cursor: 'crosshair' }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={cancel}
			role="presentation"
		>
			{box ? <DrawPreview box={box} type={type} view={view} /> : null}
		</svg>
	);
}

function DrawPreview({ box, type, view }: { box: DrawnBox; type: ShapeType; view: View }) {
	const [w, h] = box.size;
	const a = toScreen(view, [box.center[0] - w / 2, box.center[1] - h / 2]);
	const b = toScreen(view, [box.center[0] + w / 2, box.center[1] + h / 2]);
	const sw = b[0] - a[0];
	const sh = b[1] - a[1];
	const common = {
		fill: 'none',
		stroke: 'var(--pr-accent)',
		strokeWidth: 1,
		vectorEffect: 'non-scaling-stroke',
	};
	return (
		<g data-testid="shape-tool-preview" data-size={`${w}x${h}`} pointerEvents="none">
			{type === 'ellipse' ? (
				<ellipse cx={a[0] + sw / 2} cy={a[1] + sh / 2} rx={sw / 2} ry={sh / 2} {...common} />
			) : (
				<rect x={a[0]} y={a[1]} width={sw} height={sh} {...common} />
			)}
			<rect
				x={b[0] + 16}
				y={b[1] + 16}
				width={`${w} × ${h}`.length * 6.5 + 12}
				height={18}
				rx={3}
				fill="var(--pr-tooltip-bg)"
			/>
			<text x={b[0] + 22} y={b[1] + 29} fontSize={11} fill="var(--pr-text-strong)">
				{`${w} × ${h}`}
			</text>
		</g>
	);
}
