// Program monitor overlays of the tracking package (S09:TRU-002/003), drawn above the transform overlay:
//  - the active tracker of the selected plate clip at the current frame (quad or point + patch + search boxes)
//    from its samples (or the reference before tracking), a confidence colour and the last 30 tracked centres;
//    during a track job it follows the live `tracking.progress` geometry. Corners, edges and the body drag in
//    ONE gesture that commits `tracker.update {at: playhead, corners}` (media px via the inverse plate map).
//  - corner-pin handles on a selected clip whose `jasper.corner-pin` is focused in Effect Controls (or with the
//    Corner Pin handles toggle on): ONE gesture writes the corner param at the playhead (keyframe when animated).
// The SVG root ignores the pointer so the transform overlay underneath keeps working; only handles take it.
import type { RenderDoc } from '@jasper/compositions';
import {
	type ClipTracker,
	CORNER_PIN_EFFECT_ID,
	CORNER_PIN_PARAMS,
	type Command,
	findTracker,
	layerMapOf,
	type Mat3,
	mat3FromMat2D,
	type ResolvedLayer,
	resolveSceneAt,
	trackerGeometryAt,
} from '@jasper/project';
import type { EditorSession, Gesture, TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { MONITOR_COLORS } from '../panels/program/monitor.tokens.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';
import { inspectorFocus } from '../panels/properties/lib/focus.ts';
import { useTrackingBridge } from './bridge.ts';
import {
	confidenceTone,
	dragQuadInMedia,
	layerOf,
	mediaToScreen,
	pinIsConvex,
	pinnedCornersSeq,
	pinParams,
	progressGeometry,
	type Quad,
	type QuadPart,
	quadToScreen,
	screenToMedia,
	seqToPinParam,
	sizeFromCorner,
	squareAround,
	TONE_VAR,
	trailAt,
	type Vec2,
} from './geometry.ts';
import { type RunningTrack, useTracking } from './store.ts';

const pts = (q: readonly Vec2[]) => q.map((p) => `${p[0]},${p[1]}`).join(' ');

type DragSpec = {
	label: string;
	/** Commands for the pointer at `screen` (px relative to the overlay), or null to keep the last update. */
	commandsAt(screen: Vec2): Command[] | null;
};

/** One gesture per drag (beginGesture → update per animation frame → commit), Esc cancels. */
function useGestureDrag(session: EditorSession, transport: TransportStore) {
	const svgRef = useRef<SVGSVGElement>(null);
	const [dragging, setDragging] = useState(false);
	const start = (e: ReactPointerEvent, spec: DragSpec) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		window.getSelection?.()?.removeAllRanges();
		if (transport.getState().playing) transport.pause();
		const svg = svgRef.current;
		if (!svg) return;
		let g: Gesture;
		try {
			g = session.beginGesture(spec.label);
		} catch {
			return; // another gesture is active
		}
		const rect = svg.getBoundingClientRect();
		const at = (ev: { clientX: number; clientY: number }): Vec2 => [
			ev.clientX - rect.left,
			ev.clientY - rect.top,
		];
		const startScreen = at(e);
		let moved = false;
		let pending: Command[] | null = null;
		let raf: number | null = null;
		const flush = () => {
			if (raf !== null) cancelAnimationFrame(raf);
			raf = null;
			if (pending && g.active) g.update(pending);
			pending = null;
		};
		const onMove = (ev: PointerEvent) => {
			const p = at(ev);
			if (!moved && Math.hypot(p[0] - startScreen[0], p[1] - startScreen[1]) < 2) return;
			moved = true;
			const cmds = spec.commandsAt(p);
			if (!cmds) return;
			pending = cmds;
			if (raf === null) raf = requestAnimationFrame(flush);
		};
		const end = (commit: boolean) => {
			window.removeEventListener('pointermove', onMove, true);
			window.removeEventListener('pointerup', onUp, true);
			window.removeEventListener('pointercancel', onCancel, true);
			window.removeEventListener('keydown', onKey, true);
			setDragging(false);
			if (commit && moved) {
				flush();
				if (g.active) g.commit();
			} else {
				if (raf !== null) cancelAnimationFrame(raf);
				g.cancel();
			}
		};
		const onUp = () => end(true);
		const onCancel = () => end(false);
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape') return;
			ev.preventDefault();
			ev.stopPropagation();
			end(false);
		};
		window.addEventListener('pointermove', onMove, true);
		window.addEventListener('pointerup', onUp, true);
		window.addEventListener('pointercancel', onCancel, true);
		window.addEventListener('keydown', onKey, true);
		setDragging(true);
	};
	return { svgRef, start, dragging };
}

function useFocusedEffect(): string | null {
	return useSyncExternalStore(
		inspectorFocus.subscribe,
		() => inspectorFocus.get().effectInstanceId,
		() => inspectorFocus.get().effectInstanceId,
	);
}

/** Registered overlay: decides between the tracker and the corner-pin handles. */
export function TrackingOverlay(props: ProgramOverlayHostProps) {
	const session = props.session;
	const doc = props.doc as RenderDoc;
	const view = props.view as View;
	const transport = props.transport as TransportStore;
	useTrackingBridge(session);
	const { frame, playing } = useOverlayFrame(transport);
	const activeId = useTracking((s) => s.activeTrackerId);
	const running = useTracking((s) => s.running);
	const pinTool = useTracking((s) => s.cornerPinTool);
	const focusedFx = useFocusedEffect();
	const selected = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const drawn = useStoreSelector(session.store, (s) => s.transient ?? s.document);
	const scene = useMemo(() => resolveSceneAt(doc, frame), [doc, frame]);
	const drag = useGestureDrag(session, transport);
	if (playing && !drag.dragging) return null;

	// A running job of a selected plate wins (live overlay), then the active tracker.
	const runningId = Object.keys(running).find((id) => {
		const loc = findTracker(drawn, id);
		return loc && selected.includes(loc.clip.id);
	});
	const trackerId = runningId ?? activeId;
	const loc = trackerId ? findTracker(drawn, trackerId) : null;
	let content: ReactNode = null;
	if (loc && selected.includes(loc.clip.id)) {
		const layer = layerOf(scene, loc.clip.id);
		if (layer)
			content = (
				<TrackerLayer
					session={session}
					layer={layer}
					tracker={loc.tracker}
					job={running[loc.tracker.id]}
					frame={frame}
					view={view}
					start={drag.start}
				/>
			);
	} else if (selected.length === 1) {
		const layer = layerOf(scene, selected[0]!);
		const pin = layer?.props.effects.find((e) => e.enabled && e.effectId === CORNER_PIN_EFFECT_ID);
		if (layer && pin && (pinTool || focusedFx === pin.id))
			content = (
				<CornerPinLayer
					layer={layer}
					fxId={pin.id}
					params={pin.params}
					frame={frame}
					view={view}
					start={drag.start}
				/>
			);
	}
	if (!content) return null;
	return (
		<svg
			ref={drag.svgRef}
			className="pointer-events-none absolute inset-0 h-full w-full touch-none select-none"
			data-testid="tracking-overlay"
			role="presentation"
		>
			{content}
		</svg>
	);
}

// ------------------------------------------------------------------ tracker

type StartDrag = (e: ReactPointerEvent, spec: DragSpec) => void;

function TrackerLayer(props: {
	session: EditorSession;
	layer: ResolvedLayer;
	tracker: ClipTracker;
	job: RunningTrack | undefined;
	frame: number;
	view: View;
	start: StartDrag;
}) {
	const { layer, tracker, job, frame, view } = props;
	const map: Mat3 = layerMapOf(layer.props);
	const live = job?.progress ? progressGeometry(job.progress.data) : null;
	const g = live
		? { ...live, confidence: job!.progress!.confidence, tracked: true }
		: trackerGeometryAt(tracker, layer.contentTime, { smoothing: 0 });
	const tone = g.tracked ? TONE_VAR[confidenceTone(g.confidence)] : 'var(--pr-accent)';
	const trail = (job ? job.trail : trailAt(tracker, layer.contentTime)).map((p) =>
		mediaToScreen(map, view, p),
	);
	const editable = !job;
	const update = (patch: Record<string, unknown>): Command[] => [
		{ type: 'tracker.update', trackerId: tracker.id, at: { sequenceFrame: frame }, ...patch } as Command,
	];
	const label = `${tracker.name}${g.tracked ? ` · ${Math.round(g.confidence * 100)}%` : ''}`;
	return (
		<g data-testid="tracker-overlay" data-tracker-id={tracker.id} data-tracked={g.tracked ? '1' : '0'}>
			{trail.length > 1 ? (
				<g data-testid="tracker-trail" pointerEvents="none">
					<polyline points={pts(trail)} fill="none" stroke={MONITOR_COLORS.casing} strokeWidth={3} />
					<polyline points={pts(trail)} fill="none" stroke={tone} strokeWidth={1} strokeOpacity={0.8} />
					{trail.map((p, i) => (
						<circle
							// biome-ignore lint/suspicious/noArrayIndexKey: trail dots are positional (oldest → newest)
							key={i}
							cx={p[0]}
							cy={p[1]}
							r={1.5}
							fill={tone}
							fillOpacity={0.4 + (0.6 * i) / trail.length}
						/>
					))}
				</g>
			) : null}
			{g.corners ? (
				<PlanarQuad
					corners={g.corners}
					map={map}
					view={view}
					tone={tone}
					label={label}
					editable={editable}
					onGrab={(e, part) => {
						const startMedia = g.corners!;
						const rect = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
						const s0: Vec2 = [e.clientX - rect.left, e.clientY - rect.top];
						props.start(e, {
							label: 'Adjust Tracker',
							commandsAt: (p) => {
								const q = dragQuadInMedia(startMedia, part, map, view, s0, p);
								return q ? update({ corners: q.map((c) => [round2(c[0]), round2(c[1])]) }) : null;
							},
						});
					}}
				/>
			) : g.point ? (
				<PointTarget
					point={g.point}
					patch={tracker.reference.patch ?? 24}
					search={tracker.reference.search ?? 72}
					map={map}
					view={view}
					tone={tone}
					label={label}
					editable={editable}
					onGrab={(e, part) => {
						const rect = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
						const s0: Vec2 = [e.clientX - rect.left, e.clientY - rect.top];
						const p0 = g.point!;
						props.start(e, {
							label: 'Adjust Tracker',
							commandsAt: (p) => {
								const m = screenToMedia(map, view, p);
								if (!m) return null;
								if (part === 'point') {
									const m0 = screenToMedia(map, view, s0);
									if (!m0) return null;
									return update({ point: [round2(p0[0] + m[0] - m0[0]), round2(p0[1] + m[1] - m0[1])] });
								}
								return update({ [part]: sizeFromCorner(p0, m) });
							},
						});
					}}
				/>
			) : null}
		</g>
	);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function PlanarQuad(props: {
	corners: Quad;
	map: Mat3;
	view: View;
	tone: string;
	label: string;
	editable: boolean;
	onGrab(e: ReactPointerEvent, part: QuadPart): void;
}) {
	const q = quadToScreen(props.map, props.view, props.corners);
	const grab = (part: QuadPart) =>
		props.editable ? (e: ReactPointerEvent) => props.onGrab(e, part) : undefined;
	const pe = props.editable ? 'all' : 'none';
	return (
		<g data-testid="tracker-quad" data-points={pts(q)}>
			<polygon
				points={pts(q)}
				fill="transparent"
				pointerEvents={pe}
				style={{ cursor: props.editable ? 'move' : 'default' }}
				onPointerDown={grab({ kind: 'body' })}
				data-testid="tracker-body"
			/>
			<polygon
				points={pts(q)}
				fill="none"
				stroke={MONITOR_COLORS.casing}
				strokeWidth={3}
				pointerEvents="none"
			/>
			<polygon points={pts(q)} fill="none" stroke={props.tone} strokeWidth={1.25} pointerEvents="none" />
			{q.map((a, i) => {
				const b = q[(i + 1) % 4]!;
				return (
					<line
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed four edges
						key={`e${i}`}
						x1={a[0]}
						y1={a[1]}
						x2={b[0]}
						y2={b[1]}
						stroke="transparent"
						strokeWidth={10}
						pointerEvents={props.editable ? 'stroke' : 'none'}
						style={{ cursor: 'move' }}
						onPointerDown={grab({ kind: 'edge', index: i })}
						data-testid={`tracker-edge-${i}`}
					/>
				);
			})}
			<Crosshair at={centreOf(q)} tone={props.tone} />
			{q.map((c, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed four corners
				<g key={`c${i}`} data-testid={`tracker-corner-${i}`} data-x={c[0]} data-y={c[1]}>
					<rect
						x={c[0] - 4}
						y={c[1] - 4}
						width={8}
						height={8}
						fill={MONITOR_COLORS.casing}
						stroke={props.tone}
						strokeWidth={1.25}
						pointerEvents="none"
					/>
					<rect
						x={c[0] - 7}
						y={c[1] - 7}
						width={14}
						height={14}
						fill="transparent"
						pointerEvents={pe}
						style={{ cursor: props.editable ? 'crosshair' : 'default' }}
						onPointerDown={grab({ kind: 'corner', index: i })}
					/>
				</g>
			))}
			<OverlayLabel at={topLeftOf(q)} text={props.label} />
		</g>
	);
}

function PointTarget(props: {
	point: Vec2;
	patch: number;
	search: number;
	map: Mat3;
	view: View;
	tone: string;
	label: string;
	editable: boolean;
	onGrab(e: ReactPointerEvent, part: 'point' | 'patch' | 'search'): void;
}) {
	const { map, view } = props;
	const c = mediaToScreen(map, view, props.point);
	const patch = quadToScreen(map, view, squareAround(props.point, props.patch));
	const search = quadToScreen(map, view, squareAround(props.point, props.search));
	const pe = props.editable ? 'all' : 'none';
	const grab = (part: 'point' | 'patch' | 'search') =>
		props.editable ? (e: ReactPointerEvent) => props.onGrab(e, part) : undefined;
	const corner = (q: Quad, part: 'patch' | 'search') => (
		<rect
			x={q[2][0] - 6}
			y={q[2][1] - 6}
			width={12}
			height={12}
			fill="transparent"
			pointerEvents={pe}
			style={{ cursor: 'nwse-resize' }}
			onPointerDown={grab(part)}
			data-testid={`tracker-${part}-handle`}
		/>
	);
	return (
		<g data-testid="tracker-point" data-x={c[0]} data-y={c[1]}>
			<polygon
				points={pts(search)}
				fill="none"
				stroke={props.tone}
				strokeWidth={1}
				strokeDasharray="4 3"
				pointerEvents="none"
			/>
			<polygon
				points={pts(patch)}
				fill="none"
				stroke={MONITOR_COLORS.casing}
				strokeWidth={3}
				pointerEvents="none"
			/>
			<polygon points={pts(patch)} fill="none" stroke={props.tone} strokeWidth={1.25} pointerEvents="none" />
			<rect x={search[2][0] - 2.5} y={search[2][1] - 2.5} width={5} height={5} fill={props.tone} />
			<rect x={patch[2][0] - 2.5} y={patch[2][1] - 2.5} width={5} height={5} fill={props.tone} />
			{corner(search, 'search')}
			{corner(patch, 'patch')}
			<Crosshair at={c} tone={props.tone} size={7} />
			<circle
				cx={c[0]}
				cy={c[1]}
				r={8}
				fill="transparent"
				pointerEvents={pe}
				style={{ cursor: 'move' }}
				onPointerDown={grab('point')}
				data-testid="tracker-point-handle"
			/>
			<OverlayLabel at={search[0]} text={props.label} />
		</g>
	);
}

function Crosshair({ at, tone, size = 5 }: { at: Vec2; tone: string; size?: number }) {
	return (
		<g pointerEvents="none">
			<line
				x1={at[0] - size}
				x2={at[0] + size}
				y1={at[1]}
				y2={at[1]}
				stroke={MONITOR_COLORS.casing}
				strokeWidth={3}
			/>
			<line
				x1={at[0]}
				x2={at[0]}
				y1={at[1] - size}
				y2={at[1] + size}
				stroke={MONITOR_COLORS.casing}
				strokeWidth={3}
			/>
			<line x1={at[0] - size} x2={at[0] + size} y1={at[1]} y2={at[1]} stroke={tone} strokeWidth={1} />
			<line x1={at[0]} x2={at[0]} y1={at[1] - size} y2={at[1] + size} stroke={tone} strokeWidth={1} />
		</g>
	);
}

function OverlayLabel({ at, text }: { at: Vec2; text: string }) {
	const w = text.length * 6 + 10;
	return (
		<g pointerEvents="none" data-testid="tracker-label">
			<rect
				x={at[0]}
				y={at[1] - 22}
				width={w}
				height={16}
				rx={3}
				fill="var(--pr-tooltip-bg)"
				fillOpacity={0.9}
			/>
			<text x={at[0] + 5} y={at[1] - 10} fontSize={11} fill="var(--pr-text-strong)">
				{text}
			</text>
		</g>
	);
}

function centreOf(q: Quad): Vec2 {
	return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

function topLeftOf(q: Quad): Vec2 {
	return [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1]))];
}

// ------------------------------------------------------------------ corner pin handles

function CornerPinLayer(props: {
	layer: ResolvedLayer;
	fxId: string;
	params: Record<string, unknown>;
	frame: number;
	view: View;
	start: StartDrag;
}) {
	const { layer, view } = props;
	const box = layer.props.box;
	const motion = mat3FromMat2D(layer.props.matrix);
	const params = pinParams(props.params);
	const seqQ = pinnedCornersSeq(motion, params, box);
	const q = seqQ.map((p) => toScreen(view, p)) as Quad;
	const convex = pinIsConvex(params, box);
	const tone = convex ? 'var(--pr-accent)' : 'var(--pr-warning)';
	return (
		<g data-testid="corner-pin-overlay" data-fx-id={props.fxId} data-convex={convex ? '1' : '0'}>
			<polygon
				points={pts(q)}
				fill="none"
				stroke={MONITOR_COLORS.casing}
				strokeWidth={3}
				pointerEvents="none"
			/>
			<polygon
				points={pts(q)}
				fill="none"
				stroke={tone}
				strokeWidth={1}
				strokeDasharray={convex ? undefined : '5 4'}
				pointerEvents="none"
			/>
			{q.map((c, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed four corners
				<g key={i} data-testid={`corner-pin-handle-${i}`} data-x={c[0]} data-y={c[1]}>
					<circle cx={c[0]} cy={c[1]} r={6} fill={MONITOR_COLORS.casing} stroke={tone} strokeWidth={1.25} />
					<Crosshair at={c} tone={tone} size={3} />
					<circle
						cx={c[0]}
						cy={c[1]}
						r={9}
						fill="transparent"
						pointerEvents="all"
						style={{ cursor: 'crosshair' }}
						onPointerDown={(e) => {
							const rect = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
							const s0 = toSequence(view, [e.clientX - rect.left, e.clientY - rect.top]);
							const off: Vec2 = [seqQ[i]![0] - s0[0], seqQ[i]![1] - s0[1]];
							props.start(e, {
								label: 'Corner Pin',
								commandsAt: (p) => {
									const s = toSequence(view, p);
									const v = seqToPinParam(motion, [s[0] + off[0], s[1] + off[1]], box);
									return v
										? [
												{
													type: 'param.set',
													target: ['effect', props.fxId, CORNER_PIN_PARAMS[i]!],
													value: v,
													at: { sequenceFrame: props.frame },
												} as Command,
											]
										: null;
								},
							});
						}}
					/>
				</g>
			))}
			{!convex ? <OverlayLabel at={topLeftOf(q)} text="Non-convex: drawn unpinned" /> : null}
		</g>
	);
}
