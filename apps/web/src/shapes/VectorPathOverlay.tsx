import {
	applyMat3,
	type CommandInput,
	invertMat3,
	layerMapOf,
	nearestOnPath,
	pathToSvg,
	type ResolvedLayer,
	type ShapeAffine,
	shapePathItemsAt,
} from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { toast } from '@jasper/ui';
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
} from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';
import { resolveProgramScene } from '../three-d/scene.ts';
import { useGestureDrag } from '../tracking/TrackingOverlay.tsx';
import { addVectorClipAt, isVectorClip, useVectorUi, vectorUi } from './vector.ts';

type Pt = [number, number];
const HIT = 7;

const at = (e: { clientX: number; clientY: number; currentTarget: Element }): Pt => {
	const svg = (e.currentTarget as SVGElement).ownerSVGElement ?? (e.currentTarget as SVGSVGElement);
	const r = svg.getBoundingClientRect();
	return [e.clientX - r.left, e.clientY - r.top];
};

/** Item space ↔ screen for a path item of a vector layer. */
export type ItemSpace = { toScreen(q: Pt): Pt; fromScreen(s: Pt): Pt | null };

export function itemSpace(layer: Pick<ResolvedLayer, 'props'>, m: ShapeAffine, view: View): ItemSpace | null {
	const L = layerMapOf(layer.props);
	const inv = invertMat3(L);
	const det = m[0] * m[3] - m[1] * m[2];
	if (!inv || Math.abs(det) < 1e-12) return null;
	const { box } = layer.props;
	const cx = box.width / 2;
	const cy = box.height / 2;
	return {
		toScreen: (q) => {
			const c: Pt = [m[0] * q[0] + m[2] * q[1] + m[4] + cx, m[1] * q[0] + m[3] * q[1] + m[5] + cy];
			return toScreen(view, applyMat3(L, c) as Pt) as Pt;
		},
		fromScreen: (s) => {
			const b = applyMat3(inv, toSequence(view, s));
			const x = b[0] - cx - m[4];
			const y = b[1] - cy - m[5];
			const r: Pt = [(m[3] * x - m[2] * y) / det, (-m[1] * x + m[0] * y) / det];
			return Number.isFinite(r[0]) && Number.isFinite(r[1]) ? r : null;
		},
	};
}

export function VectorPathOverlay(props: ProgramOverlayHostProps) {
	const session = props.session;
	const doc = props.doc;
	const view = props.view;
	const transport = props.transport;
	const { frame, playing } = useOverlayFrame(transport);
	const tool = useStoreSelector(session.store, (s) => s.toggles.activeTool);
	const selectedClips = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const ui = useVectorUi((s) => s);
	const scene = useMemo(() => resolveProgramScene(doc, frame), [doc, frame]);
	const drag = useGestureDrag(session, transport);
	/** The path item the pen is drawing (open, appended to by clicks). */
	const penItem = useRef<{ clipId: string; itemId: string } | null>(null);
	const pen = tool === 'pen';
	useEffect(() => {
		if (!pen) penItem.current = null;
	}, [pen]);
	useEffect(() => {
		if (!pen) return;
		const onKey = (e: KeyboardEvent) => {
			if ((e.key === 'Enter' || e.key === 'Escape') && penItem.current) {
				e.preventDefault();
				e.stopPropagation();
				penItem.current = null;
				vectorUi.set({ vertices: [] });
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [pen]);
	if (playing && !drag.dragging) return null;

	const clipId = selectedClips.length === 1 ? selectedClips[0]! : null;
	const layer = clipId ? scene.find((l) => l.clip.clipId === clipId) : undefined;
	const source = layer?.clip.source;
	const shape = source && 'shape' in source && source.shape.type === 'vector' ? source.shape : null;
	const vector = shape ? layer : undefined;
	if (!vector && !pen) return null;

	const atSeq = { sequenceFrame: frame };
	const apply = (label: string, commands: CommandInput[]) => {
		const r = session.apply({ label, origin: 'user', commands });
		if (!r.ok) toast({ kind: 'error', title: label, detail: r.errors[0]?.message ?? '' });
		return r;
	};
	const edit = (
		cid: string,
		itemId: string,
		ops: Extract<CommandInput, { type: 'shape.editPath' }>['ops'],
	): CommandInput[] => [
		{ type: 'shape.editPath', clipId: cid, itemId, at: atSeq, ops } satisfies CommandInput,
	];

	const paths = vector && shape ? shapePathItemsAt(shape.contents, vector.contentTime) : [];
	const selId =
		ui.selected && vector && ui.selected.clipId === vector.clip.clipId ? ui.selected.itemId : null;
	const active = paths.find((p) => p.item.id === selId) ?? null;
	const space = (m: ShapeAffine) => (vector ? itemSpace(vector, m, view) : null);
	const selVerts = new Set(ui.vertices);

	const startNewPath = (e: ReactPointerEvent<SVGRectElement>) => {
		const s = at(e);
		const seqPt = toSequence(view, s) as Pt;
		const vertex = (p: Pt) => ({ closed: false, vertices: [{ p, in: [0, 0], out: [0, 0] }] });
		const items = (p: Pt) => [
			{
				type: 'group',
				name: 'Shape',
				contents: [
					{ type: 'path', path: vertex(p) },
					{ type: 'stroke', color: [1, 1, 1, 1], width: 4 },
					{ type: 'fill', color: [1, 1, 1, 1], enabled: false },
				],
			},
		];
		let cid: string;
		let itemId: string;
		if (vector) {
			const sp = space([1, 0, 0, 1, 0, 0]);
			const q = sp?.fromScreen(s);
			if (!q) return;
			const r = apply('Pen', [
				{
					type: 'shape.addItems',
					clipId: vector.clip.clipId,
					items: items(q),
					index: 0,
				} satisfies CommandInput,
			]);
			if (!r.ok) return;
			cid = vector.clip.clipId;
			const groupId = (r.results[0] as { itemIds: string[] }).itemIds[0]!;
			const st = session.getState();
			const clip = (st.transient ?? st.document).sequences[st.activeSequenceId ?? '']?.clips[cid];
			const g = isVectorClip(clip) ? clip.shape.contents.find((x) => x.id === groupId) : undefined;
			const p = g?.type === 'group' ? g.contents.find((x) => x.type === 'path') : undefined;
			if (!p) return;
			itemId = p.id;
		} else {
			// A new vector shape: its layer centre at the frame centre, the path in content px around it.
			const seqDoc = session.getState();
			const seq = (seqDoc.transient ?? seqDoc.document).sequences[seqDoc.activeSequenceId ?? ''];
			if (!seq) return;
			const q: Pt = [seqPt[0] - seq.settings.width / 2, seqPt[1] - seq.settings.height / 2];
			const id = addVectorClipAt(session, frame, items(q), 'Pen');
			if (!id) return;
			cid = id;
			const st = session.getState();
			const clip = (st.transient ?? st.document).sequences[seq.id]?.clips[id];
			const g = isVectorClip(clip) ? clip.shape.contents[0] : undefined;
			const p = g?.type === 'group' ? g.contents.find((x) => x.type === 'path') : undefined;
			if (!p) return;
			itemId = p.id;
		}
		penItem.current = { clipId: cid, itemId };
		vectorUi.set({ selected: { clipId: cid, itemId }, vertices: [0] });
		pullTangents(e, cid, itemId, 0, s);
	};

	/** Drag after a pen click pulls out the vertex's tangents (mirrored). */
	const pullTangents = (e: ReactPointerEvent, cid: string, itemId: string, vertex: number, s0: Pt) => {
		const info = paths.find((p) => p.item.id === itemId);
		const sp = space(info?.m ?? [1, 0, 0, 1, 0, 0]) ?? null;
		drag.start(e, {
			label: 'Pen Tangents',
			commandsAt: (p) => {
				// The layer of a clip created by this click is not in the scene yet: map with the frame-centred default.
				const a = sp?.fromScreen(s0) ?? (toSequence(view, s0) as Pt);
				const b = sp?.fromScreen(p) ?? (toSequence(view, p) as Pt);
				const d: Pt = [b[0] - a[0], b[1] - a[1]];
				return edit(cid, itemId, [
					{ op: 'setVertex', vertex, out: d, in: [-d[0], -d[1]], breakHandles: true },
				]);
			},
		});
	};

	const onPenSurface = (e: ReactPointerEvent<SVGRectElement>) => {
		if (e.button !== 0 || readOnly) return;
		e.stopPropagation();
		const s = at(e);
		const cur = penItem.current;
		const drawing =
			cur && vector && cur.clipId === vector.clip.clipId ? paths.find((p) => p.item.id === cur.itemId) : null;
		if (drawing && !drawing.path.closed) {
			const sp = space(drawing.m);
			const q = sp?.fromScreen(s);
			if (!sp || !q) return;
			const verts = drawing.path.vertices;
			const first = sp.toScreen(verts[0]!.p as Pt);
			if (verts.length >= 3 && Math.hypot(s[0] - first[0], s[1] - first[1]) <= HIT) {
				apply('Close Path', edit(cur!.clipId, cur!.itemId, [{ op: 'setClosed', closed: true }]));
				penItem.current = null;
				vectorUi.set({ vertices: [] });
				return;
			}
			if (!apply('Add Vertex', edit(cur!.clipId, cur!.itemId, [{ op: 'appendVertex', p: q }])).ok) return;
			vectorUi.set({ vertices: [verts.length] });
			pullTangents(e, cur!.clipId, cur!.itemId, verts.length, s);
			return;
		}
		// On the selected path: Add Vertex on a segment.
		if (active && vector) {
			const sp = space(active.m);
			const q = sp?.fromScreen(s);
			const near = q ? nearestOnPath(active.path, q) : null;
			if (sp && near) {
				const ps = sp.toScreen(near.point as Pt);
				if (Math.hypot(ps[0] - s[0], ps[1] - s[1]) <= HIT && near.t > 1e-3 && near.t < 1 - 1e-3) {
					apply(
						'Add Vertex',
						edit(vector.clip.clipId, active.item.id, [
							{ op: 'insertVertex', segment: near.segment, t: near.t },
						]),
					);
					vectorUi.set({ vertices: [near.segment + 1] });
					return;
				}
			}
		}
		startNewPath(e);
	};

	const onVertexDown = (e: ReactPointerEvent, info: (typeof paths)[number], i: number) => {
		if (e.button !== 0 || readOnly || !vector) return;
		e.stopPropagation();
		const cid = vector.clip.clipId;
		const id = info.item.id;
		(e.currentTarget as SVGElement).ownerSVGElement?.focus();
		if (selId !== id) vectorUi.set({ selected: { clipId: cid, itemId: id }, vertices: [i] });
		const v = info.path.vertices[i]!;
		const corner = v.in[0] === 0 && v.in[1] === 0 && v.out[0] === 0 && v.out[1] === 0;
		// Pen on a vertex: the first vertex of the path being drawn closes it; otherwise Delete Vertex.
		if (pen && !e.altKey) {
			const cur = penItem.current;
			if (cur?.itemId === id && i === 0 && !info.path.closed && info.path.vertices.length >= 3) {
				apply('Close Path', edit(cid, id, [{ op: 'setClosed', closed: true }]));
				penItem.current = null;
				return;
			}
			if (info.path.vertices.length <= (info.path.closed ? 3 : 1)) return;
			apply('Delete Vertex', edit(cid, id, [{ op: 'removeVertices', vertices: [i] }]));
			vectorUi.set({ vertices: [] });
			return;
		}
		if (e.ctrlKey || e.metaKey) {
			if (info.path.vertices.length <= (info.path.closed ? 3 : 1)) return;
			apply('Delete Vertex', edit(cid, id, [{ op: 'removeVertices', vertices: [i] }]));
			vectorUi.set({ vertices: [] });
			return;
		}
		if (e.altKey) {
			// Convert Vertex: a click toggles; a drag from a corner pulls out new smooth handles.
			if (!corner) {
				apply('Convert Vertex', edit(cid, id, [{ op: 'convert', vertices: [i], to: 'corner' }]));
				return;
			}
			const sp = space(info.m);
			const s0 = at(e);
			drag.start(e, {
				label: 'Convert Vertex',
				commandsAt: (p) => {
					const a = sp?.fromScreen(s0);
					const b = sp?.fromScreen(p);
					if (!a || !b) return null;
					const d: Pt = [b[0] - a[0], b[1] - a[1]];
					return edit(cid, id, [
						{ op: 'setVertex', vertex: i, out: d, in: [-d[0], -d[1]], breakHandles: true },
					]);
				},
			});
			return;
		}
		const keep = selId === id && (e.shiftKey || selVerts.has(i));
		const indices = e.shiftKey
			? selVerts.has(i)
				? [...selVerts].filter((x) => x !== i)
				: [...selVerts, i]
			: keep
				? [...selVerts]
				: [i];
		vectorUi.set({ selected: { clipId: cid, itemId: id }, vertices: indices });
		if (e.shiftKey) return;
		const sp = space(info.m);
		const s0 = at(e);
		const q0 = sp?.fromScreen(s0);
		if (!sp || !q0) return;
		drag.start(e, {
			label: 'Move Vertices',
			commandsAt: (p) => {
				const q = sp.fromScreen(p);
				return q
					? edit(cid, id, [{ op: 'moveVertices', vertices: indices, delta: [q[0] - q0[0], q[1] - q0[1]] }])
					: null;
			},
		});
	};

	const onHandleDown = (
		e: ReactPointerEvent,
		info: (typeof paths)[number],
		i: number,
		which: 'in' | 'out',
	) => {
		if (e.button !== 0 || readOnly || !vector) return;
		e.stopPropagation();
		const cid = vector.clip.clipId;
		const id = info.item.id;
		const sp = space(info.m);
		const v = info.path.vertices[i]!;
		if (!sp) return;
		const breakHandles = e.altKey;
		drag.start(e, {
			label: 'Edit Tangent',
			commandsAt: (p) => {
				const q = sp.fromScreen(p);
				if (!q) return null;
				const d: Pt = [q[0] - v.p[0], q[1] - v.p[1]];
				return edit(cid, id, [{ op: 'setVertex', vertex: i, [which]: d, breakHandles }]);
			},
		});
	};

	const onOutlineDown = (e: ReactPointerEvent, info: (typeof paths)[number]) => {
		if (e.button !== 0 || !vector || pen) return;
		e.stopPropagation();
		vectorUi.set({ selected: { clipId: vector.clip.clipId, itemId: info.item.id }, vertices: [] });
	};

	const onKeyDown = (e: ReactKeyboardEvent) => {
		if (
			(e.key !== 'Delete' && e.key !== 'Backspace') ||
			!active ||
			!vector ||
			!ui.vertices.length ||
			readOnly
		)
			return;
		e.preventDefault();
		e.stopPropagation();
		const left = active.path.vertices.length - new Set(ui.vertices).size;
		if (left < (active.path.closed ? 3 : 1)) return;
		apply(
			'Delete Vertices',
			edit(vector.clip.clipId, active.item.id, [{ op: 'removeVertices', vertices: ui.vertices }]),
		);
		vectorUi.set({ vertices: [] });
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: focus target for Delete on the selected vertices
		<svg
			ref={drag.svgRef}
			tabIndex={-1}
			onKeyDown={onKeyDown}
			className="pointer-events-none absolute inset-0 h-full w-full touch-none select-none outline-none"
			data-testid="vector-path-overlay"
			data-pen={pen ? '1' : undefined}
			role="presentation"
		>
			{pen ? (
				<rect
					x={0}
					y={0}
					width="100%"
					height="100%"
					fill="transparent"
					pointerEvents="all"
					style={{ cursor: 'crosshair' }}
					onPointerDown={onPenSurface}
					data-testid="vector-pen-surface"
				/>
			) : null}
			{paths.map((info) => {
				const sp = space(info.m);
				if (!sp) return null;
				const d = pathToSvg(info.path, (q) => sp.toScreen(q as Pt));
				const isActive = info.item.id === active?.item.id;
				return (
					<g key={info.item.id}>
						<path
							d={d}
							fill="none"
							stroke="transparent"
							strokeWidth={HIT * 2}
							pointerEvents={pen ? 'none' : 'stroke'}
							onPointerDown={(e) => onOutlineDown(e, info)}
							data-testid={`vector-outline-${info.item.id}`}
						/>
						<path
							d={d}
							fill="none"
							stroke="var(--pr-accent)"
							strokeWidth={isActive ? 1.5 : 1}
							opacity={isActive ? 1 : 0.6}
							pointerEvents="none"
						/>
					</g>
				);
			})}
			{active
				? (() => {
						const sp = space(active.m);
						if (!sp) return null;
						return active.path.vertices.map((v, i) => {
							const p = sp.toScreen(v.p as Pt);
							const showHandles = selVerts.has(i);
							const hIn = sp.toScreen([v.p[0] + v.in[0], v.p[1] + v.in[1]]);
							const hOut = sp.toScreen([v.p[0] + v.out[0], v.p[1] + v.out[1]]);
							const hasIn = v.in[0] !== 0 || v.in[1] !== 0;
							const hasOut = v.out[0] !== 0 || v.out[1] !== 0;
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: vertices are positional
								<g key={i}>
									{showHandles && hasIn ? (
										<>
											<line
												x1={p[0]}
												y1={p[1]}
												x2={hIn[0]}
												y2={hIn[1]}
												stroke="var(--pr-accent)"
												strokeWidth={1}
												pointerEvents="none"
											/>
											<circle
												cx={hIn[0]}
												cy={hIn[1]}
												r={3.5}
												fill="var(--pr-accent)"
												pointerEvents="all"
												style={{ cursor: 'move' }}
												onPointerDown={(e) => onHandleDown(e, active, i, 'in')}
												data-testid={`vector-handle-in-${i}`}
											/>
										</>
									) : null}
									{showHandles && hasOut ? (
										<>
											<line
												x1={p[0]}
												y1={p[1]}
												x2={hOut[0]}
												y2={hOut[1]}
												stroke="var(--pr-accent)"
												strokeWidth={1}
												pointerEvents="none"
											/>
											<circle
												cx={hOut[0]}
												cy={hOut[1]}
												r={3.5}
												fill="var(--pr-accent)"
												pointerEvents="all"
												style={{ cursor: 'move' }}
												onPointerDown={(e) => onHandleDown(e, active, i, 'out')}
												data-testid={`vector-handle-out-${i}`}
											/>
										</>
									) : null}
									<rect
										x={p[0] - 4}
										y={p[1] - 4}
										width={8}
										height={8}
										fill={selVerts.has(i) ? 'var(--pr-accent)' : 'var(--pr-panel)'}
										stroke="var(--pr-accent)"
										strokeWidth={1}
										pointerEvents="all"
										style={{ cursor: pen ? 'pointer' : 'move' }}
										onPointerDown={(e) => onVertexDown(e, active, i)}
										data-testid={`vector-vertex-${i}`}
									/>
								</g>
							);
						});
					})()
				: null}
		</svg>
	);
}
