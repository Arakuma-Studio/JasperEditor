// Program monitor mask editing (wp masks; Premiere's on-monitor mask controls + After Effects' pen behaviours):
// - the masks of the selected clip are outlined; click an outline to select that mask;
// - the selected mask shows its vertices, the tangent handles of the selected / smooth vertices, the Mask Expansion
//   guide (square handle) and the Mask Feather guide (circle handle), and a bounding box (corner squares scale about
//   the centre, outside the corners rotates);
// - drag a vertex (the selected vertices move together; Shift-click adds to the selection), a tangent handle (the
//   opposite one mirrors; Alt breaks it), the inside of the mask (moves the whole path); Alt-click a vertex converts
//   it between smooth and corner, Ctrl/Cmd-click deletes it; a click on the path inserts a vertex; Delete removes the
//   selected vertices;
// - the pen (Effect Controls ▸ free draw bezier) adds a vertex per click, a drag pulls out its tangents, clicking
//   the first vertex closes the path.
// Every drag is ONE session gesture writing the path at the playhead (a keyframe when Mask Path is animated).
import type { RenderDoc } from '@jasper/compositions';
import {
	type BezierPath,
	type Command,
	type ResolvedLayer,
	type ResolvedMask,
	resolveSceneAt,
} from '@jasper/project';
import type { EditorSession, TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { toast } from '@jasper/ui';
import { type PointerEvent as ReactPointerEvent, useMemo } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { MONITOR_COLORS } from '../panels/program/monitor.tokens.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import type { View } from '../panels/program/viewport.ts';
import { type DragSpec, useGestureDrag } from '../tracking/TrackingOverlay.tsx';
import {
	type MaskSpace,
	maskSpace,
	offsetPolyline,
	outwardDistance,
	type Pt,
	pointInPolygon,
	screenPolyline,
	segmentAt,
	svgPathOf,
	topAnchor,
} from './geometry.ts';
import { maskUi, useMaskUi } from './store.ts';

const TONE = 'var(--pr-accent)';
const HIT = 7;
const ROTATE_ZONE = 18;

/** The resolved masks of a layer: Opacity masks, then each enabled effect's. */
function layerMasks(layer: ResolvedLayer): ResolvedMask[] {
	return [...layer.props.masks, ...layer.props.effects.flatMap((fx) => fx.masks ?? [])];
}

const at = (e: { clientX: number; clientY: number; currentTarget: Element }): Pt => {
	const svg = (e.currentTarget as SVGElement).ownerSVGElement ?? (e.currentTarget as SVGSVGElement);
	const r = svg.getBoundingClientRect();
	return [e.clientX - r.left, e.clientY - r.top];
};

export function MaskOverlay(props: ProgramOverlayHostProps) {
	const session = props.session as EditorSession;
	const doc = props.doc as RenderDoc;
	const view = props.view as View;
	const transport = props.transport as TransportStore;
	const { frame, playing } = useOverlayFrame(transport);
	const selectedClips = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const ui = useMaskUi((s) => s);
	const scene = useMemo(() => resolveSceneAt(doc, frame), [doc, frame]);
	const drag = useGestureDrag(session, transport);
	if (playing && !drag.dragging) return null;

	const penClip = ui.pen?.clipId ?? null;
	const clipId = penClip ?? ui.selected?.clipId ?? (selectedClips.length === 1 ? selectedClips[0]! : null);
	const layer = clipId ? scene.find((l) => l.clip.clipId === clipId) : undefined;
	const sp = layer ? maskSpace(layer, view) : null;
	if (!layer || !sp) {
		if (ui.pen)
			return (
				<div className="pointer-events-none absolute top-2 left-2 rounded-pr-control bg-pr-raised px-2 text-pr-small text-pr-warning">
					Move the playhead over the clip to draw its mask
				</div>
			);
		return null;
	}
	const masks = layerMasks(layer);
	const sel = ui.selected ? masks.find((m) => m.id === ui.selected!.maskId) : undefined;
	const penMask = ui.pen?.maskId ? masks.find((m) => m.id === ui.pen!.maskId) : undefined;
	const active = penMask ?? sel;
	const atSeq = { sequenceFrame: frame };
	const edit = (maskId: string, ops: unknown[]): Command[] => [
		{ type: 'mask.editPath', maskId, at: atSeq, ops } as Command,
	];
	const apply = (label: string, commands: Command[]) => {
		const r = session.apply({ label, origin: 'user', commands });
		if (!r.ok) toast({ kind: 'error', title: label, detail: r.errors[0]?.message ?? '' });
		return r;
	};

	// ------------------------------------------------------------ pen
	const onPenDown = (e: ReactPointerEvent<SVGRectElement>) => {
		if (e.button !== 0 || readOnly || !ui.pen) return;
		const s = at(e);
		const n = sp.fromScreen(s);
		if (!n) return;
		const pen = ui.pen;
		let maskId = pen.maskId;
		let vertex: number;
		if (!maskId || !penMask) {
			const r = apply('Draw Mask', [
				{
					type: 'mask.add',
					...(pen.effectId ? { effectId: pen.effectId } : { clipId: pen.clipId }),
					shape: 'bezier',
					path: { closed: false, vertices: [{ p: n, in: [0, 0], out: [0, 0] }] },
					ref: '$pen',
				} as Command,
			]);
			if (!r.ok) return;
			maskId = r.refs.$pen!;
			maskUi.set({ pen: { ...pen, maskId }, selected: { maskId, clipId: pen.clipId } });
			vertex = 0;
		} else {
			const verts = penMask.path.vertices;
			const first = sp.toScreen(verts[0]!.p);
			if (verts.length >= 3 && Math.hypot(s[0] - first[0], s[1] - first[1]) <= HIT) {
				apply('Close Mask', edit(maskId, [{ op: 'setClosed', closed: true }]));
				maskUi.set({ pen: null, selected: { maskId, clipId: pen.clipId }, vertices: [] });
				return;
			}
			if (!apply('Add Mask Vertex', edit(maskId, [{ op: 'appendVertex', p: n }])).ok) return;
			vertex = verts.length;
		}
		const id = maskId;
		// Dragging after the click pulls out the new vertex's tangents (mirrored).
		drag.start(e, {
			label: 'Mask Vertex Tangents',
			commandsAt: (p) => {
				const q = sp.fromScreen(p);
				if (!q) return null;
				const d: Pt = [q[0] - n[0], q[1] - n[1]];
				return edit(id, [{ op: 'setVertex', vertex, out: d, in: [-d[0], -d[1]], breakHandles: true }]);
			},
		});
	};

	// ------------------------------------------------------------ selected mask editing
	const drawPath = (m: ResolvedMask) => screenPolyline(m.path, sp);
	const selPts = active ? drawPath(active) : [];
	const selectedVerts = new Set(ui.vertices);

	const startMoveVertices = (e: ReactPointerEvent, m: ResolvedMask, indices: number[], label: string) => {
		const s0 = at(e);
		const n0 = sp.fromScreen(s0);
		if (!n0) return;
		drag.start(e, {
			label,
			commandsAt: (p) => {
				const n = sp.fromScreen(p);
				return n
					? edit(m.id, [{ op: 'moveVertices', vertices: indices, delta: [n[0] - n0[0], n[1] - n0[1]] }])
					: null;
			},
		});
	};

	const onVertexDown = (e: ReactPointerEvent, m: ResolvedMask, i: number) => {
		if (e.button !== 0 || readOnly) return;
		e.stopPropagation();
		// Premiere: Ctrl/Cmd-click deletes a vertex; Alt-click converts it (smooth ↔ corner).
		if (e.ctrlKey || e.metaKey) {
			apply('Delete Mask Vertex', edit(m.id, [{ op: 'removeVertices', vertices: [i] }]));
			maskUi.set({ vertices: [] });
			return;
		}
		if (e.altKey) {
			const v = m.path.vertices[i]!;
			const corner = v.in[0] === 0 && v.in[1] === 0 && v.out[0] === 0 && v.out[1] === 0;
			apply(
				'Convert Mask Vertex',
				edit(m.id, [{ op: 'convert', vertices: [i], to: corner ? 'smooth' : 'corner' }]),
			);
			maskUi.set({ vertices: [i] });
			return;
		}
		let next: number[];
		if (e.shiftKey) {
			next = selectedVerts.has(i) ? ui.vertices.filter((x) => x !== i) : [...ui.vertices, i];
			maskUi.set({ vertices: next });
			return;
		}
		next = selectedVerts.has(i) ? ui.vertices : [i];
		maskUi.set({ vertices: next });
		startMoveVertices(e, m, next, next.length > 1 ? 'Move Mask Vertices' : 'Move Mask Vertex');
	};

	const onHandleDown = (e: ReactPointerEvent, m: ResolvedMask, i: number, side: 'in' | 'out') => {
		if (e.button !== 0 || readOnly) return;
		e.stopPropagation();
		const v = m.path.vertices[i]!;
		drag.start(e, {
			label: 'Edit Mask Tangent',
			commandsAt: (p) => {
				const n = sp.fromScreen(p);
				if (!n) return null;
				const h: Pt = [n[0] - v.p[0], n[1] - v.p[1]];
				return edit(m.id, [{ op: 'setVertex', vertex: i, [side]: h, breakHandles: e.altKey }]);
			},
		});
	};

	/** Premiere: a click on the mask path adds a vertex there (the pointer shows a pen with +). */
	const onOutlineDown = (e: ReactPointerEvent, m: ResolvedMask) => {
		if (e.button !== 0 || readOnly) return;
		const seg = segmentAt(m.path, sp, at(e), HIT);
		if (!seg) return onBodyDown(e, m);
		e.stopPropagation();
		apply('Add Mask Vertex', edit(m.id, [{ op: 'insertVertex', segment: seg.segment, t: seg.t }]));
		maskUi.set({ vertices: [seg.segment + 1] });
	};

	const onBodyDown = (e: ReactPointerEvent, m: ResolvedMask) => {
		if (e.button !== 0 || readOnly) return;
		e.stopPropagation();
		maskUi.set({ vertices: [] });
		startMoveVertices(
			e,
			m,
			m.path.vertices.map((_, i) => i),
			'Move Mask',
		);
	};

	const ringDrag = (e: ReactPointerEvent, m: ResolvedMask, kind: 'feather' | 'expansion') => {
		if (e.button !== 0 || readOnly) return;
		e.stopPropagation();
		drag.start(e, {
			label: kind === 'feather' ? 'Mask Feather' : 'Mask Expansion',
			commandsAt: (p) => {
				const n = sp.fromScreen(p);
				if (!n) return null;
				// The feather handle sits 10 screen px outside its guide.
				const d = outwardDistance(m.path, sp, n) - (kind === 'feather' ? 10 / sp.scale : 0);
				const value =
					kind === 'feather'
						? Math.max(0, Math.round(2 * (d - m.expansion) * 10) / 10)
						: Math.round(d * 10) / 10;
				return [{ type: 'param.set', target: ['mask', m.id, kind], value, at: atSeq } as Command];
			},
		});
	};

	// Bounding box (screen) of the selected mask.
	const bbox = (() => {
		if (!active || selPts.length < 2) return null;
		let x0 = Number.POSITIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (const [x, y] of selPts) {
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x);
			y1 = Math.max(y1, y);
		}
		return { x0, y0, x1, y1 };
	})();

	const transformDrag = (e: ReactPointerEvent, m: ResolvedMask, kind: 'scale' | 'rotate') => {
		if (e.button !== 0 || readOnly || !bbox) return;
		e.stopPropagation();
		const c: Pt = [(bbox.x0 + bbox.x1) / 2, (bbox.y0 + bbox.y1) / 2];
		const origin = sp.fromScreen(c);
		if (!origin) return;
		const s0 = at(e);
		const d0 = Math.hypot(s0[0] - c[0], s0[1] - c[1]) || 1;
		const a0 = Math.atan2(s0[1] - c[1], s0[0] - c[0]);
		const spec: DragSpec = {
			label: kind === 'scale' ? 'Scale Mask' : 'Rotate Mask',
			commandsAt: (p) => {
				if (kind === 'scale') {
					const k = Math.max(0.01, Math.hypot(p[0] - c[0], p[1] - c[1]) / d0);
					return edit(m.id, [{ op: 'transform', origin, scale: k }]);
				}
				let deg = ((Math.atan2(p[1] - c[1], p[0] - c[0]) - a0) * 180) / Math.PI;
				if (sp.mirrored) deg = -deg;
				return edit(m.id, [{ op: 'transform', origin, rotation: Math.round(deg * 100) / 100 }]);
			},
		};
		drag.start(e, spec);
	};

	const others = masks.filter((m) => m !== active);
	return (
		<svg
			ref={drag.svgRef}
			className="pointer-events-none absolute inset-0 h-full w-full touch-none select-none"
			data-testid="mask-overlay"
			role="presentation"
		>
			{ui.pen ? (
				<rect
					x={0}
					y={0}
					width="100%"
					height="100%"
					fill="transparent"
					pointerEvents="all"
					style={{ cursor: 'crosshair' }}
					onPointerDown={onPenDown}
					data-testid="mask-pen-surface"
				/>
			) : null}
			{others.map((m) => {
				const pts = drawPath(m);
				return (
					<g key={m.id} data-testid={`mask-outline-${m.id}`}>
						<path
							d={svgPathOf(pts, m.path.closed)}
							fill="none"
							stroke={MONITOR_COLORS.casing}
							strokeWidth={3}
						/>
						<path
							d={svgPathOf(pts, m.path.closed)}
							fill="none"
							stroke={TONE}
							strokeWidth={1}
							strokeOpacity={0.7}
						/>
						{/* A wide transparent stroke selects the mask. */}
						<path
							d={svgPathOf(pts, m.path.closed)}
							fill="none"
							stroke="transparent"
							strokeWidth={2 * HIT}
							pointerEvents={ui.pen ? 'none' : 'stroke'}
							style={{ cursor: 'pointer' }}
							onPointerDown={(e) => {
								if (e.button !== 0) return;
								e.stopPropagation();
								maskUi.select({ maskId: m.id, clipId: layer.clip.clipId });
							}}
						/>
					</g>
				);
			})}
			{active ? renderSelected() : null}
		</svg>
	);

	function renderSelected() {
		const m = active!;
		const closed = m.path.closed;
		const d = svgPathOf(selPts, closed);
		const exp = closed ? offsetPolyline(selPts, m.expansion * sp!.scale) : [];
		const fea = closed ? offsetPolyline(selPts, (m.expansion + m.feather / 2) * sp!.scale) : [];
		const expA = topAnchor(exp);
		const feaA = topAnchor(fea);
		const verts = m.path.vertices;
		return (
			<g data-testid={`mask-selected-${m.id}`}>
				{closed ? (
					<path
						d={d}
						fill="transparent"
						pointerEvents={ui.pen ? 'none' : 'fill'}
						style={{ cursor: 'move' }}
						onPointerDown={(e) => onBodyDown(e, m)}
						data-testid="mask-body"
					/>
				) : null}
				{closed && Math.abs(m.expansion) > 0.01 ? (
					<path d={svgPathOf(exp, true)} fill="none" stroke={TONE} strokeWidth={1} strokeDasharray="2 3" />
				) : null}
				{closed && m.feather > 0.01 ? (
					<path
						d={svgPathOf(fea, true)}
						fill="none"
						stroke={TONE}
						strokeWidth={1}
						strokeDasharray="5 4"
						strokeOpacity={0.8}
					/>
				) : null}
				<path d={d} fill="none" stroke={MONITOR_COLORS.casing} strokeWidth={3} />
				<path d={d} fill="none" stroke={TONE} strokeWidth={1.25} />
				{/* Ctrl/Cmd-click on the outline inserts a vertex. */}
				<path
					d={d}
					fill="none"
					stroke="transparent"
					strokeWidth={2 * HIT}
					pointerEvents={ui.pen ? 'none' : 'stroke'}
					style={{ cursor: 'copy' }}
					onPointerDown={(e) => onOutlineDown(e, m)}
					data-testid="mask-outline-hit"
				/>
				{bbox && !ui.pen && closed ? (
					<g data-testid="mask-bbox">
						<rect
							x={bbox.x0}
							y={bbox.y0}
							width={bbox.x1 - bbox.x0}
							height={bbox.y1 - bbox.y0}
							fill="none"
							stroke={TONE}
							strokeOpacity={0.35}
							strokeDasharray="3 3"
						/>
						{(
							[
								[bbox.x0, bbox.y0],
								[bbox.x1, bbox.y0],
								[bbox.x1, bbox.y1],
								[bbox.x0, bbox.y1],
							] as Pt[]
						).map((c, k) => (
							<g key={['tl', 'tr', 'br', 'bl'][k]}>
								<circle
									cx={c[0]}
									cy={c[1]}
									r={ROTATE_ZONE}
									fill="transparent"
									pointerEvents="all"
									style={{ cursor: 'alias' }}
									onPointerDown={(e) => transformDrag(e, m, 'rotate')}
									data-testid={`mask-rotate-${k}`}
								/>
								<rect
									x={c[0] - 3.5}
									y={c[1] - 3.5}
									width={7}
									height={7}
									fill={MONITOR_COLORS.handleFill}
									stroke={TONE}
									pointerEvents="all"
									style={{ cursor: k % 2 ? 'nesw-resize' : 'nwse-resize' }}
									onPointerDown={(e) => transformDrag(e, m, 'scale')}
									data-testid={`mask-scale-${k}`}
								/>
							</g>
						))}
					</g>
				) : null}
				{verts.map((v, i) => {
					const p = sp!.toScreen(v.p);
					const smooth = !(v.in[0] === 0 && v.in[1] === 0 && v.out[0] === 0 && v.out[1] === 0);
					const showHandles = selectedVerts.has(i) || (smooth && verts.length <= 64);
					const handle = (side: 'in' | 'out') => {
						const h = v[side];
						if (h[0] === 0 && h[1] === 0) return null;
						const q = sp!.toScreen([v.p[0] + h[0], v.p[1] + h[1]]);
						return (
							<g key={side}>
								<line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={TONE} strokeWidth={1} />
								<circle
									cx={q[0]}
									cy={q[1]}
									r={3.5}
									fill={MONITOR_COLORS.handleFill}
									stroke={TONE}
									pointerEvents="all"
									style={{ cursor: 'pointer' }}
									onPointerDown={(e) => onHandleDown(e, m, i, side)}
									data-testid={`mask-handle-${i}-${side}`}
								/>
							</g>
						);
					};
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: vertices are identified by their index (the path model)
						<g key={i}>
							{showHandles && !ui.pen ? (
								<>
									{handle('in')}
									{handle('out')}
								</>
							) : null}
							<rect
								x={p[0] - 3.5}
								y={p[1] - 3.5}
								width={7}
								height={7}
								fill={selectedVerts.has(i) ? TONE : MONITOR_COLORS.handleFill}
								stroke={TONE}
								strokeWidth={1}
								pointerEvents={ui.pen && !(i === 0 && verts.length >= 3) ? 'none' : 'all'}
								style={{ cursor: 'move' }}
								onPointerDown={(e) => (ui.pen ? undefined : onVertexDown(e, m, i))}
								data-testid={`mask-vertex-${i}`}
								data-x={p[0]}
								data-y={p[1]}
							/>
						</g>
					);
				})}
				{expA && !ui.pen ? (
					<rect
						x={expA.p[0] - 4}
						y={expA.p[1] - 4}
						width={8}
						height={8}
						fill={MONITOR_COLORS.handleFill}
						stroke={TONE}
						pointerEvents="all"
						style={{ cursor: 'ns-resize' }}
						onPointerDown={(e) => ringDrag(e, m, 'expansion')}
						data-testid="mask-expansion-handle"
					>
						<title>Mask Expansion</title>
					</rect>
				) : null}
				{feaA && !ui.pen ? (
					<circle
						cx={feaA.p[0]}
						cy={feaA.p[1] - 10}
						r={4.5}
						fill={MONITOR_COLORS.handleFill}
						stroke={TONE}
						pointerEvents="all"
						style={{ cursor: 'ns-resize' }}
						onPointerDown={(e) => ringDrag(e, m, 'feather')}
						data-testid="mask-feather-handle"
					>
						<title>Mask Feather</title>
					</circle>
				) : null}
			</g>
		);
	}
}

/** Re-exported for tests: whether a screen point lies inside a mask's outline. */
export function insideMask(path: BezierPath, sp: MaskSpace, s: Pt): boolean {
	return pointInPolygon(s, screenPolyline(path, sp));
}
