// Program monitor Rectangle / Ellipse / Polygon / Star tools (S03:XF-061, S11:SHP-006, S05:TOOL-005, wp shapes).
// Registered as a Program overlay; while a shape tool is active it covers the monitor: a drag draws the shape's
// bounding box (Shift = square/circle, Alt = from the centre, re-evaluated when the modifiers change mid-drag) —
// Polygon / Star drag from the centre outwards (the drag sets the outer radius and turns the first point towards
// the pointer; Shift keeps it upright) — the outline previews the result, Escape cancels, and the release adds the
// shape in one transaction (one undo step) at the playhead, selects it and returns to the Selection tool. With one
// vector shape selected under the playhead the drawing is added to it as a new group (After Effects: drawing on a
// selected shape layer); else Rectangle / Ellipse add a rectangle / ellipse clip and Polygon / Star a new vector
// shape. Clicks without a drag add nothing.
import type { Vec2 } from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';
import { addBoxToVector, addPolystar, type DrawnStar, dragStar, polystarPreview } from './draw.ts';
import { type DrawnBox, dragShapeBox } from './geometry.ts';
import { addShapeAt } from './insert.ts';
import { selectedVectorClip } from './vector.ts';

const DRAG_THRESHOLD = 3;
type DrawKind = 'rect' | 'ellipse' | 'polygon' | 'star';
const TOOL_SHAPES: Partial<Record<string, DrawKind>> = {
	rectangle: 'rect',
	ellipse: 'ellipse',
	polygon: 'polygon',
	star: 'star',
};

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

function ShapeDrawSurface(props: ProgramOverlayHostProps & { type: DrawKind }) {
	const { session, type } = props;
	const view = props.view;
	const transport = props.transport;
	const svgRef = useRef<SVGSVGElement>(null);
	const dragRef = useRef<Drag | null>(null);
	const [box, setBox] = useState<DrawnBox | null>(null);

	const local = (e: { clientX: number; clientY: number }): Vec2 => {
		const r = svgRef.current!.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	};
	const [star, setStar] = useState<DrawnStar | null>(null);
	const refresh = () => {
		const d = dragRef.current;
		const polystar = type === 'polygon' || type === 'star';
		setBox(d?.moved && !polystar ? dragShapeBox(d.start, d.last, { shift: d.shift, alt: d.alt }) : null);
		setStar(d?.moved && polystar ? dragStar(d.start, d.last, d.shift) : null);
	};
	const cancel = () => {
		dragRef.current = null;
		setBox(null);
		setStar(null);
	};

	// Escape cancels the drag (the keymap leaves Esc to a held pointer); Shift/Alt changes re-shape the box without
	// a move. One listener for the surface's lifetime that calls the latest render's handler: re-subscribing on
	// every render would let a re-render caused by an earlier listener of the same key event remove this one
	// before it ran.
	const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
	onKeyRef.current = (e: KeyboardEvent) => {
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
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('keyup', onKey, true);
		return () => {
			window.removeEventListener('keydown', onKey, true);
			window.removeEventListener('keyup', onKey, true);
		};
	}, []);

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
		setStar(null);
		if (!d?.moved) return;
		const frame = transport.getState().frame;
		const done = () => session.setToggles({ activeTool: 'selection' });
		if (type === 'polygon' || type === 'star') {
			const star = dragStar(d.start, d.last, d.shift);
			if (star.radius < 1) return;
			if (addPolystar(session, type, frame, star)) done();
			return;
		}
		const drawn = dragShapeBox(d.start, d.last, { shift: d.shift, alt: d.alt });
		if (drawn.size[0] < 1 || drawn.size[1] < 1) return;
		const target = selectedVectorClip(session, frame);
		if (target) {
			if (addBoxToVector(session, target.id, type, frame, drawn)) done();
			return;
		}
		if (addShapeAt(session, type, frame, drawn)) done();
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
			{box && (type === 'rect' || type === 'ellipse') ? (
				<DrawPreview box={box} type={type} view={view} />
			) : null}
			{star && (type === 'polygon' || type === 'star') ? (
				<StarPreview star={star} type={type} view={view} />
			) : null}
		</svg>
	);
}

function DrawPreview({ box, type, view }: { box: DrawnBox; type: 'rect' | 'ellipse'; view: View }) {
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

function StarPreview({ star, type, view }: { star: DrawnStar; type: 'polygon' | 'star'; view: View }) {
	const pts = polystarPreview(type, star).map((p) => toScreen(view, p));
	return (
		<g data-testid="shape-tool-preview" data-radius={star.radius} pointerEvents="none">
			<polygon
				points={pts.map((p) => `${p[0]},${p[1]}`).join(' ')}
				fill="none"
				stroke="var(--pr-accent)"
				strokeWidth={1}
				vectorEffect="non-scaling-stroke"
			/>
		</g>
	);
}
