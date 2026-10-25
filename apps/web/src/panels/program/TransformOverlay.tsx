// On-canvas selection and transform overlay (S03 §9–§10, ARC-004): drawn above the Player in screen
// space, from the same RenderDoc and `resolveSceneAt` as the composition, so handles line up with
// the rendered layers under rotation and non-uniform scale. Every drag is one session gesture
// (`beginGesture` → `update` per animation frame → `commit`), i.e. exactly one undo step (XF-053).
// While playing, handles are hidden and only selected outlines are drawn by direct DOM writes.
// The motion path of the selected clip (S03:OVL-020) is drawn here too; its key squares and tangent handles are
// hit-tested before the transform handles and dragged as one gesture each.
import type { RenderDoc } from '@jasper/compositions';
import {
	applyMat3,
	applyMatrix,
	effectParamMetric,
	invertMat3,
	type LayerTransformValues,
	layerMapOf,
	layerMatrix,
	type Mat3,
	mat3FromMat2D,
	quadBounds,
	type Rect,
	type ResolvedLayer,
	type Vec2 as PVec2,
} from '@jasper/project';
import type { EditorSession, Gesture, TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { layerDoubleClickHandlers } from '../../extensions/index.ts';
// wp-m2-shapes: geometry hit-test (XF-001) and "Resize shapes by size" handles (S11:SHP-007).
import {
	hitsLayerGeometry,
	layerEditQuad,
	layerEditRect,
	resizeShapeBySize,
	shapeLayerSize,
	shapeSizeCommand,
} from '../../shapes/geometry.ts';
import { shapePrefs } from '../../shapes/prefs.ts';
import {
	applyTextAnimation,
	isTextAnimationDrag,
	readTextAnimationDrag,
} from '../../text-animation/actions.ts';
import {
	is3dLayer,
	type Move3D,
	move3dPosition,
	move3dStart,
	resolveProgramScene,
} from '../../three-d/scene.ts';
import { threeDViews } from '../../three-d/view-store.ts';
import { applyEffectToClips, isEffectDrag, readEffectDragPayload } from '../effects/drag.ts';
import { insertMotionTemplate, MG_TEMPLATE_MIME, readMgTemplateDrag } from '../motionTemplates/insert.ts';
import { inspectorFocus } from '../properties/lib/focus.ts';
import { activeSequence, addTextAt, transformAt, transformCommands } from './edits.ts';
import { MotionPathLayer } from './MotionPathLayer.tsx';
import { MONITOR_COLORS } from './monitor.tokens.ts';
import type { MonitorViewState } from './monitor-store.ts';
import { guidesOf, monitorExtras } from './monitor-view.ts';
import {
	buildEffectPointPath,
	buildMotionPath,
	convertVertexCommand,
	hitMotionPath,
	type MotionPath,
	type MotionPathDrag,
	motionPathDragCommands,
	startMotionPathDrag,
} from './motion-path.ts';
import {
	buildSnapTargets,
	type SnapHit,
	type SnapTargets,
	snapAxis,
	snapMove,
	snapThreshold,
} from './snapping.ts';
import {
	ANCHOR_HIT,
	anchorSnapPoints,
	CORNERS,
	groupScaleFactor,
	HANDLE_HIT,
	HANDLE_IDS,
	type HandleId,
	handlePoint,
	hitTest,
	moveAnchor,
	type Quad,
	RotationTracker,
	rotateAboutPoint,
	rotationZoneHit,
	SMALL_QUAD,
	scaleAboutPoint,
	scaleFromHandle,
	snapRotation,
	unionBounds,
	type Vec2,
} from './transform-math.ts';
import { type Size, toScreen, toSequence, type View } from './viewport.ts';

const SAFE_MARGINS = { action: 5, title: 10 } as const;

/**
 * spatial-points: the effect whose point paths the monitor draws — the one selected in Effect Controls, or the effect
 * of the focused param row (`effects.<fxId>.<param>`).
 */
function focusedEffectId(): string | null {
	const f = inspectorFocus.get();
	if (f.effectInstanceId) return f.effectInstanceId;
	const m = f.rowId ? /^effects\.([^.]+)\./.exec(f.rowId) : null;
	return m ? m[1]! : null;
}
const DRAG_THRESHOLD = 3;
const AXIS_LOCK_PX = 6;

type ClipStart = { id: string; v0: LayerTransformValues; move3d?: Move3D };
type GestureState =
	| { kind: 'pan'; start: Vec2; pan0: Vec2 }
	/** marquee selection on empty canvas (Premiere Program monitor; Shift/Ctrl add to the selection). */
	| { kind: 'marquee'; start: Vec2; base: string[]; startScreen: Vec2; moved: boolean }
	| {
			kind: 'move';
			g: Gesture;
			start: Vec2;
			startScreen: Vec2;
			clips: ClipStart[];
			bounds0: Rect;
			targets: SnapTargets;
			moved: boolean;
	  }
	| {
			kind: 'scale';
			g: Gesture;
			clip: ClipStart;
			rect: Rect;
			handle: HandleId;
			grab: Vec2;
			startScreen: Vec2;
			moved: boolean;
			/** wp-m2-shapes (S11:SHP-007): resize `shape.size` from `size0`, pointer at `start`. */
			bySize?: { size0: Vec2; start: Vec2 };
	  }
	| {
			kind: 'group-scale';
			g: Gesture;
			clips: ClipStart[];
			box: Rect;
			handle: HandleId;
			startScreen: Vec2;
			moved: boolean;
	  }
	| {
			kind: 'rotate';
			g: Gesture;
			clips: ClipStart[];
			center: Vec2;
			tracker: RotationTracker;
			group: boolean;
			startScreen: Vec2;
			moved: boolean;
	  }
	| {
			kind: 'anchor';
			g: Gesture;
			clip: ClipStart;
			rect: Rect;
			start: Vec2;
			startScreen: Vec2;
			moved: boolean;
	  }
	/** S03:OVL-020: a motion-path key square or tangent handle. */
	| {
			kind: 'path';
			g: Gesture;
			drag: MotionPathDrag;
			startScreen: Vec2;
			moved: boolean;
			/** snap targets of a key drag (frame, safe margins, layers, the path's other keys). */
			targets: SnapTargets | null;
	  };

type Readout = { at: Vec2; text: string } | null;

/** Frame for the overlay: follows seeks while paused (≤ 1 render per animation frame), frozen while playing. */
export function useOverlayFrame(transport: TransportStore): { frame: number; playing: boolean } {
	const [state, setState] = useState(() => ({
		frame: transport.getState().frame,
		playing: transport.getState().playing,
	}));
	useEffect(() => {
		let raf: number | null = null;
		const flush = () => {
			raf = null;
			const s = transport.getState();
			setState((prev) =>
				prev.frame === s.frame && prev.playing === s.playing ? prev : { frame: s.frame, playing: s.playing },
			);
		};
		const off = transport.subscribe((s, p) => {
			if (s.playing !== p.playing) {
				if (raf !== null) cancelAnimationFrame(raf);
				flush();
				return;
			}
			if (s.playing) return; // no React work per frame during playback
			if (raf === null) raf = requestAnimationFrame(flush);
		});
		return () => {
			off();
			if (raf !== null) cancelAnimationFrame(raf);
		};
	}, [transport]);
	return state;
}

const pts = (q: readonly Vec2[]) => q.map((p) => `${p[0]},${p[1]}`).join(' ');

type TransformOverlayProps = {
	session: EditorSession;
	doc: RenderDoc;
	view: View;
	viewport: Size;
	transport: TransportStore;
	monitor: MonitorViewState;
	onPan(pan: Vec2): void;
	/** S03:XF-050: right-click; the layer under the pointer (topmost, unlocked) is selected first. */
	onContextMenu?(at: { x: number; y: number; clipId: string | null }): void;
};

export function TransformOverlay({
	session,
	doc,
	view,
	viewport,
	transport,
	monitor,
	onPan,
	onContextMenu,
}: TransformOverlayProps) {
	const { frame, playing } = useOverlayFrame(transport);
	const selected = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const tool = useStoreSelector(session.store, (s) => s.toggles.activeTool);
	const lockedKey = useStoreSelector(session.store, (s) => {
		const seq = s.activeSequenceId ? (s.transient ?? s.document).sequences[s.activeSequenceId] : undefined;
		return seq
			? seq.videoTracks
					.filter((t) => t.locked)
					.map((t) => t.id)
					.join(',')
			: '';
	});
	const locked = useMemo(() => new Set(lockedKey ? lockedKey.split(',') : []), [lockedKey]);
	// 3D layers are resolved through the monitor's camera (active camera or 3D view).
	const views3d = useStoreSelector(threeDViews, (s) => s.bySequence[doc.sequenceId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the 3D view changes what the scene projects
	const scene = useMemo(() => resolveProgramScene(doc, frame), [doc, frame, views3d]);
	const selectedSet = useMemo(() => new Set(selected), [selected]);
	const selLayers = useMemo(
		() => scene.filter((l) => selectedSet.has(l.clip.clipId) && l.props.transform),
		[scene, selectedSet],
	);
	// S03:OVL-020: the motion path of the one selected clip; rebuilt only when its position animation or timing
	// changes (the snapshot shares the document's Animatables), never per playhead frame (ARC-010).
	const pathClip = useMemo(() => {
		if (selected.length !== 1) return null;
		// a 3D layer's 2D motion path would not lie where it is drawn.
		for (const t of doc.videoTracks)
			for (const c of t.clips) if (c.clipId === selected[0] && c.transform && !c.threeD) return c;
		return null;
	}, [doc, selected]);
	const pathKey = pathClip
		? [
				pathClip.clipId,
				pathClip.trackId,
				pathClip.start,
				pathClip.duration,
				pathClip.sourceIn,
				pathClip.speed.rate,
				pathClip.speed.reverse,
				doc.settings.fps.num,
				doc.settings.fps.den,
			].join('|')
		: '';
	const pathAnim = pathClip?.transform?.position;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the animation and timing, not the clip object
	const motionPath = useMemo(
		() => (pathClip ? buildMotionPath(pathClip, doc.settings.fps) : null),
		[pathKey, pathAnim],
	);
	// the Anchor Point path (anchor values in layer space, drawn through the layer map at the
	// playhead — the anchor point always sits at Position in the frame, so its path is shown over the layer as After
	// Effects shows it over the layer). Rebuilt when the layer map changes.
	const anchorAnim = pathClip?.transform?.anchor;
	const pathLayer = pathClip ? selLayers.find((l) => l.clip.clipId === pathClip.clipId) : undefined;
	const layerMap = pathLayer?.props.matrix ?? null;
	const layerMapKey = layerMap
		? [layerMap.a, layerMap.b, layerMap.c, layerMap.d, layerMap.e, layerMap.f].join(',')
		: '';
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the animation, timing and layer map
	const anchorPath = useMemo(
		() =>
			pathClip && (anchorAnim?.keyframes.length ?? 0) >= 2
				? buildMotionPath(pathClip, doc.settings.fps, 'anchor', layerMap)
				: null,
		[pathKey, anchorAnim, layerMapKey],
	);
	// spatial-points: the motion paths of the point params (≥ 2 keys) of the effect focused in Effect Controls, drawn
	// through the layer map at the playhead (Transform's Position / Anchor Point, Offset's Shift Center To, Corner Pin
	// corners, …), evaluated with the layer box's metric like the renderers.
	const focusedFx = useSyncExternalStore(inspectorFocus.subscribe, focusedEffectId, focusedEffectId);
	const fxClip = useMemo(() => {
		if (selected.length !== 1 || !focusedFx) return null;
		for (const t of doc.videoTracks)
			for (const c of t.clips) if (c.clipId === selected[0] && !c.threeD) return c;
		return null;
	}, [doc, selected, focusedFx]);
	const fxInst = fxClip?.effects.find((e) => e.id === focusedFx && e.enabled);
	const fxSpec = fxInst ? session.ctx.registries.effects.get(fxInst.effectId, fxInst.effectVersion) : undefined;
	const fxLayer = fxClip ? scene.find((l) => l.clip.clipId === fxClip.clipId) : undefined;
	const fxMaps = fxLayer
		? { full: layerMapOf(fxLayer.props), motion: mat3FromMat2D(fxLayer.props.matrix) }
		: null;
	const fxMapKey = fxMaps ? `${fxMaps.full.join(',')}|${fxMaps.motion.join(',')}` : '';
	const fxTiming = fxClip
		? [fxClip.clipId, fxClip.start, fxClip.duration, fxClip.sourceIn, fxClip.speed.rate, fxClip.speed.reverse].join(
				'|',
			)
		: '';
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the instance, its timing and the layer maps
	const fxPaths = useMemo((): MotionPath[] => {
		if (!fxClip || !fxInst || !fxSpec || !fxMaps) return [];
		const box = fxClip.intrinsicBox;
		// Corner Pin corners are where the box corners go before the pin's own homography (Motion only); every other
		// point param maps through the full layer map, as its on-canvas handle does.
		const map = (m: Mat3) => {
			const inv = invertMat3(m);
			const r = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
			return {
				toSeq: (n: PVec2): PVec2 => applyMat3(m, [n[0] * box.width, n[1] * box.height]),
				fromSeq: (q: PVec2): PVec2 | null => {
					if (!inv) return null;
					const v = applyMat3(inv, q);
					return [r(v[0] / box.width), r(v[1] / box.height)];
				},
			};
		};
		const pin = fxSpec.id === 'jasper.corner-pin';
		const out: MotionPath[] = [];
		for (const p of fxSpec.params) {
			if (p.type !== 'vec2' || !p.spatial || (fxInst.params[p.name]?.keyframes.length ?? 0) < 2) continue;
			const path = buildEffectPointPath(
				fxClip,
				doc.settings.fps,
				{ fxId: fxInst.id, param: p.name, label: `${fxSpec.label}: ${p.label}` },
				map(pin ? fxMaps.motion : fxMaps.full),
				effectParamMetric(fxInst, p.name, box),
			);
			if (path) out.push(path);
		}
		return out;
	}, [fxTiming, fxInst, fxSpec, fxMapKey, doc.settings.fps.num, doc.settings.fps.den]);
	const keySel = useStoreSelector(session.store, (s) => s.selection.keyframes);
	const anyPath = motionPath ?? anchorPath ?? fxPaths[0] ?? null;
	const selectedKeys = useMemo(
		() => new Set(anyPath && keySel?.clipOrTrackId === anyPath.clipId ? keySel.keyframeIds : []),
		[anyPath, keySel],
	);
	const [hover, setHover] = useState<string | null>(null);
	const [marquee, setMarquee] = useState<Rect | null>(null);
	const [snapHits, setSnapHits] = useState<{ x: SnapHit | null; y: SnapHit | null } | null>(null);
	const [readout, setReadout] = useState<Readout>(null);
	const [cursor, setCursor] = useState('default');
	const gestureRef = useRef<GestureState | null>(null);
	const pendingRef = useRef<{ cmds: Parameters<Gesture['update']>[0] } | null>(null);
	const rafRef = useRef<number | null>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const live = useRef({ scene, view, selLayers, frame, monitor, motionPath, anchorPath, fxPaths });
	live.current = { scene, view, selLayers, frame, monitor, motionPath, anchorPath, fxPaths };

	const toSeq = (e: { clientX: number; clientY: number }): { seq: Vec2; screen: Vec2 } => {
		const r = svgRef.current!.getBoundingClientRect();
		const screen: Vec2 = [e.clientX - r.left, e.clientY - r.top];
		return { screen, seq: toSequence(live.current.view, screen) };
	};

	const flushUpdate = () => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		const g = gestureRef.current;
		const p = pendingRef.current;
		pendingRef.current = null;
		if (g && g.kind !== 'pan' && g.kind !== 'marquee' && p) g.g.update(p.cmds);
	};
	const scheduleUpdate = (cmds: Parameters<Gesture['update']>[0]) => {
		pendingRef.current = { cmds };
		if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushUpdate);
	};

	const endGesture = (commit: boolean) => {
		const g = gestureRef.current;
		// Apply the last pointer position before the gesture is released.
		if (commit && g && g.kind !== 'pan' && g.kind !== 'marquee' && g.moved) flushUpdate();
		gestureRef.current = null;
		setSnapHits(null);
		setReadout(null);
		setMarquee(null);
		if (!g || g.kind === 'pan' || g.kind === 'marquee') return;
		if (commit && g.moved) {
			g.g.commit();
		} else {
			pendingRef.current = null;
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
			g.g.cancel();
		}
	};

	// Esc cancels a drag (XF-053; the keymap leaves Esc to a held pointer). One listener for the overlay's lifetime
	// calling the latest render's handler, so a re-render during the key event cannot drop it mid-dispatch.
	const escRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
	escRef.current = (e: KeyboardEvent) => {
		if (e.key === 'Escape' && gestureRef.current) {
			e.preventDefault();
			e.stopPropagation();
			endGesture(false);
		}
	};
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => escRef.current(e);
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, []);

	// A playback start ends any gesture (S02:TL-882 in reverse: playback wins).
	useEffect(() => {
		if (playing && gestureRef.current) endGesture(false);
	});

	const clipStart = (id: string): ClipStart | null => {
		const seq = activeSequence(session);
		const c = seq?.clips[id];
		if (!seq || !c || !('transform' in c)) return null;
		const v0 = transformAt(seq, c, live.current.frame);
		// a 3D layer moves in the plane facing the camera (it follows the pointer).
		const rc = doc.videoTracks.flatMap((t) => t.clips).find((x) => x.clipId === id);
		if (rc?.threeD && rc.kind !== 'adjustment')
			return { id, v0, move3d: move3dStart(doc, rc, live.current.frame, v0) };
		return { id, v0 };
	};

	const layerScreenQuad = (l: ResolvedLayer): Quad =>
		layerEditQuad(l).map((p) => toScreen(view, p as Vec2)) as Quad;

	const groupBox = (layers: readonly ResolvedLayer[]): Rect | null =>
		unionBounds(layers.map((l) => quadBounds(layerEditQuad(l))));

	const layerAt = (p: Vec2): string | null =>
		hitTest(
			live.current.scene
				.filter((l) => l.props.transform && hitsLayerGeometry(l, p))
				.map((l) => ({ clipId: l.clip.clipId, trackId: l.clip.trackId, quad: layerEditQuad(l) as Quad })),
			p,
			locked,
		);

	const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		// A text selection left by an earlier drag makes Chromium start a native drag of it on the next
		// press, which cancels the pointer stream (pointercancel → the gesture is dropped). Clear it.
		if (e.button === 0) window.getSelection?.()?.removeAllRanges();
		if (playing) transport.pause();
		const { seq: p, screen } = toSeq(e);
		const svg = svgRef.current!;
		if (e.button === 1 || tool === 'hand') {
			svg.setPointerCapture?.(e.pointerId);
			gestureRef.current = { kind: 'pan', start: screen, pan0: monitor.pan };
			return;
		}
		if (e.button !== 0) return;
		const f = live.current.frame;
		if (tool === 'type') {
			addTextAt(session, p, f);
			session.setToggles({ activeTool: 'selection' });
			return;
		}
		const sel = live.current.selLayers;
		// Motion path key squares and tangent handles (OVL-020), before the transform handles. The anchor crosshair
		// keeps priority over the square of the key under the playhead (same point).
		const found = pathHitAt(screen);
		const pathHit = found?.hit ?? null;
		if (found && pathHit) {
			const mp = found.path;
			// the Pen tool, or Ctrl (Cmd on macOS) on a key square, converts the vertex (click) or pulls
			// Continuous Bezier handles out of it (drag) — After Effects' Convert Vertex.
			const pull = pathHit.kind === 'key' && (tool === 'pen' || e.ctrlKey || e.metaKey);
			const drag = startMotionPathDrag(mp, pathHit, p, pull ? new Set() : selectedKeys, { pull });
			if (drag) {
				const cur = selectedKeys.has(pathHit.keyId) ? [...selectedKeys] : [];
				const ids =
					e.shiftKey && pathHit.kind === 'key'
						? cur.includes(pathHit.keyId)
							? cur.filter((x) => x !== pathHit.keyId)
							: [...cur, pathHit.keyId]
						: cur.includes(pathHit.keyId)
							? cur
							: [pathHit.keyId];
				session.selectKeyframes(ids.length ? { clipOrTrackId: mp.clipId, keyframeIds: ids } : null);
				svg.setPointerCapture?.(e.pointerId);
				gestureRef.current = {
					kind: 'path',
					g: session.beginGesture(pathHit.kind === 'key' ? 'Move Keyframe' : 'Edit Motion Path'),
					drag,
					startScreen: screen,
					moved: false,
					targets:
						pathHit.kind === 'key' && !pull
							? buildSnapTargets({
									width: doc.settings.width,
									height: doc.settings.height,
									safeMargins: monitor.safeMargins ? SAFE_MARGINS : null,
									guides: snapGuides(session),
									layers: [
										...live.current.scene
											.filter((l) => l.clip.clipId !== mp.clipId)
											.map((l) => quadBounds(layerEditQuad(l))),
										// The path's other keys (points) are targets too.
										...mp.keys
											.filter((k) => !drag.group.some((g) => g.id === k.id))
											.map((k) => ({ x: k.pos[0], y: k.pos[1], width: 0, height: 0 })),
									],
								})
							: null,
				};
				return;
			}
		}
		// Handles / anchor / rotation of the current selection (XF-010…012, XF-037). three-d: 3D layers are moved
		// here and transformed in 3D by Effect Controls and the Program monitor's 3D gizmo (no 2D handles).
		if (sel.length === 1 && !is3dLayer(sel[0]!)) {
			const l = sel[0]!;
			const rect = layerEditRect(l);
			const anchorScreen = toScreen(view, applyMatrix(l.props.matrix, l.props.transform!.anchor));
			const cs = clipStart(l.clip.clipId);
			if (!cs) return;
			if (Math.hypot(screen[0] - anchorScreen[0], screen[1] - anchorScreen[1]) <= ANCHOR_HIT) {
				svg.setPointerCapture?.(e.pointerId);
				gestureRef.current = {
					kind: 'anchor',
					g: session.beginGesture('Anchor Point'),
					clip: cs,
					rect,
					start: p,
					startScreen: screen,
					moved: false,
				};
				return;
			}
			const h = handleUnder(l, rect, screen);
			if (h) {
				const hp = applyMatrix(l.props.matrix, handlePoint(rect, h));
				// wp-m2-shapes (S11:SHP-007): with "Resize shapes by size", handles edit the shape's size.
				const size0 = shapePrefs.get().resizeBySize ? shapeLayerSize(l) : null;
				svg.setPointerCapture?.(e.pointerId);
				gestureRef.current = {
					kind: 'scale',
					g: session.beginGesture(size0 ? 'Resize Shape' : 'Scale'),
					clip: cs,
					rect,
					handle: h,
					grab: [p[0] - hp[0], p[1] - hp[1]],
					startScreen: screen,
					moved: false,
					...(size0 ? { bySize: { size0, start: p } } : {}),
				};
				return;
			}
			if (rotationZoneHit(layerScreenQuad(l), screen)) {
				svg.setPointerCapture?.(e.pointerId);
				const center = l.props.transform!.position as Vec2;
				gestureRef.current = {
					kind: 'rotate',
					g: session.beginGesture('Rotate'),
					clips: [cs],
					center,
					tracker: new RotationTracker(center, p, cs.v0.rotation),
					group: false,
					startScreen: screen,
					moved: false,
				};
				return;
			}
		} else if (sel.length > 1 && !sel.some(is3dLayer)) {
			const box = groupBox(sel);
			if (box) {
				const h = groupHandleUnder(box, screen);
				const clips = sel.map((l) => clipStart(l.clip.clipId)).filter((c): c is ClipStart => !!c);
				if (h) {
					svg.setPointerCapture?.(e.pointerId);
					gestureRef.current = {
						kind: 'group-scale',
						g: session.beginGesture('Scale'),
						clips,
						box,
						handle: h,
						startScreen: screen,
						moved: false,
					};
					return;
				}
				const q = CORNERS.map((c) => toScreen(view, handlePoint(box, c))) as Quad;
				if (rotationZoneHit(q, screen)) {
					svg.setPointerCapture?.(e.pointerId);
					const center: Vec2 = [box.x + box.width / 2, box.y + box.height / 2];
					gestureRef.current = {
						kind: 'rotate',
						g: session.beginGesture('Rotate'),
						clips,
						center,
						tracker: new RotationTracker(center, p, 0),
						group: true,
						startScreen: screen,
						moved: false,
					};
					return;
				}
			}
		}
		// Hit test and selection (XF-001, XF-003, XF-005).
		const hit = layerAt(p);
		if (!hit) {
			const additive = e.shiftKey || e.ctrlKey || e.metaKey;
			if (!additive) session.clearSelection('timeline');
			svg.setPointerCapture?.(e.pointerId);
			gestureRef.current = {
				kind: 'marquee',
				start: p,
				base: additive ? [...session.getState().selection.timeline.clips] : [],
				startScreen: screen,
				moved: false,
			};
			return;
		}
		if (e.shiftKey || e.ctrlKey || e.metaKey) {
			session.select('timeline', [hit], 'toggle');
			return;
		}
		if (!selectedSet.has(hit)) session.select('timeline', [hit], 'replace');
		// Move every selected visible layer (XF-020).
		const ids = new Set(session.getState().selection.timeline.clips);
		const moving = live.current.scene.filter(
			(l) => ids.has(l.clip.clipId) && l.props.transform && !locked.has(l.clip.trackId),
		);
		const clips = moving.map((l) => clipStart(l.clip.clipId)).filter((c): c is ClipStart => !!c);
		if (clips.length === 0) return;
		const others = live.current.scene
			.filter((l) => !ids.has(l.clip.clipId))
			.map((l) => quadBounds(layerEditQuad(l)));
		svg.setPointerCapture?.(e.pointerId);
		gestureRef.current = {
			kind: 'move',
			g: session.beginGesture('Move'),
			start: p,
			startScreen: screen,
			clips,
			bounds0: unionBounds(moving.map((l) => quadBounds(layerEditQuad(l))))!,
			targets: buildSnapTargets({
				width: doc.settings.width,
				height: doc.settings.height,
				safeMargins: monitor.safeMargins ? SAFE_MARGINS : null,
				guides: snapGuides(session),
				layers: others,
			}),
			moved: false,
		};
	};

	/**
	 * Motion-path target under a screen point (unlocked clip; not the anchor crosshair's spot): the Position path first,
	 * then the Anchor Point path (keyframes-blend).
	 */
	const pathHitAt = (
		screen: Vec2,
	): { path: MotionPath; hit: NonNullable<ReturnType<typeof hitMotionPath>> } | null => {
		for (const mp of [live.current.motionPath, live.current.anchorPath, ...live.current.fxPaths]) {
			if (!mp || locked.has(mp.trackId)) continue;
			const hit = hitMotionPath(mp, live.current.view, screen);
			if (!hit) continue;
			if (hit.kind !== 'key') return { path: mp, hit };
			const l = live.current.selLayers.find((x) => x.clip.clipId === mp.clipId);
			if (l?.props.transform) {
				const a = toScreen(live.current.view, applyMatrix(l.props.matrix, l.props.transform.anchor));
				if (Math.hypot(screen[0] - a[0], screen[1] - a[1]) <= ANCHOR_HIT) continue;
			}
			return { path: mp, hit };
		}
		return null;
	};

	const handleUnder = (l: ResolvedLayer, rect: Rect, screen: Vec2): HandleId | null => {
		const quad = layerScreenQuad(l);
		const small = Math.min(dist(quad[0], quad[1]), dist(quad[1], quad[2])) < SMALL_QUAD;
		const ids: readonly HandleId[] = small ? CORNERS : HANDLE_IDS;
		for (const id of ids) {
			const at = toScreen(view, applyMatrix(l.props.matrix, handlePoint(rect, id)));
			if (Math.abs(at[0] - screen[0]) <= HANDLE_HIT / 2 && Math.abs(at[1] - screen[1]) <= HANDLE_HIT / 2)
				return id;
		}
		return null;
	};
	const groupHandleUnder = (box: Rect, screen: Vec2): HandleId | null => {
		for (const id of HANDLE_IDS) {
			const at = toScreen(view, handlePoint(box, id));
			if (Math.abs(at[0] - screen[0]) <= HANDLE_HIT / 2 && Math.abs(at[1] - screen[1]) <= HANDLE_HIT / 2)
				return id;
		}
		return null;
	};

	const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
		const g = gestureRef.current;
		const { seq: p, screen } = toSeq(e);
		if (!g) {
			updateHover(screen, p);
			return;
		}
		if (g.kind === 'pan') {
			onPan([g.pan0[0] + screen[0] - g.start[0], g.pan0[1] + screen[1] - g.start[1]]);
			return;
		}
		if (g.kind === 'marquee') {
			if (!g.moved && dist(screen, g.startScreen) < DRAG_THRESHOLD) return;
			g.moved = true;
			const r: Rect = {
				x: Math.min(g.start[0], p[0]),
				y: Math.min(g.start[1], p[1]),
				width: Math.abs(p[0] - g.start[0]),
				height: Math.abs(p[1] - g.start[1]),
			};
			setMarquee(r);
			// Layers whose bounds intersect the marquee (unlocked tracks only).
			const hits = live.current.scene
				.filter((l) => l.props.transform && !locked.has(l.clip.trackId))
				.filter((l) => {
					const b = l.props.bounds;
					return b.x < r.x + r.width && b.x + b.width > r.x && b.y < r.y + r.height && b.y + b.height > r.y;
				})
				.map((l) => l.clip.clipId);
			session.select('timeline', [...new Set([...g.base, ...hits])], 'replace');
			return;
		}
		if (!g.moved && dist(screen, g.startScreen) < DRAG_THRESHOLD) return;
		g.moved = true;
		const f = live.current.frame;
		const seqId = doc.sequenceId;
		const snapOn = live.current.monitor.snapInMonitor !== (e.ctrlKey || e.metaKey); // Ctrl inverts (SNP-001)
		if (g.kind === 'path') {
			let hits: { x: SnapHit | null; y: SnapHit | null } | null = null;
			const snap =
				g.targets && snapOn
					? (at: Vec2): Vec2 => {
							const tau = snapThreshold(live.current.view.scale);
							const hx = snapAxis([{ value: at[0], role: 'center' }], g.targets!.x, tau);
							const hy = snapAxis([{ value: at[1], role: 'center' }], g.targets!.y, tau);
							hits = hx || hy ? { x: hx, y: hy } : null;
							return [at[0] + (hx?.delta ?? 0), at[1] + (hy?.delta ?? 0)];
						}
					: undefined;
			const r = motionPathDragCommands(g.drag, p, { alt: e.altKey, shift: e.shiftKey }, snap);
			setSnapHits(hits);
			setReadout({ at: screen, text: r.readout });
			scheduleUpdate(r.commands);
			return;
		}
		if (g.kind === 'move') {
			let dx = p[0] - g.start[0];
			let dy = p[1] - g.start[1];
			if (e.shiftKey && dist(screen, g.startScreen) >= AXIS_LOCK_PX) {
				if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
				else dx = 0;
			}
			let hits: { x: SnapHit | null; y: SnapHit | null } | null = null;
			if (snapOn) {
				const moved = { ...g.bounds0, x: g.bounds0.x + dx, y: g.bounds0.y + dy };
				const s = snapMove(moved, g.targets, snapThreshold(live.current.view.scale));
				if (!(e.shiftKey && dx === 0)) dx += s.dx;
				if (!(e.shiftKey && dy === 0)) dy += s.dy;
				hits = s.hits;
			}
			setSnapHits(hits);
			const lead = g.clips[0]!.v0.position;
			setReadout({ at: screen, text: `X ${fmt(lead[0] + dx)}  Y ${fmt(lead[1] + dy)}` });
			scheduleUpdate(
				g.clips.flatMap((c) => {
					if (!c.move3d)
						return transformCommands(
							c.id,
							{ position: [c.v0.position[0] + dx, c.v0.position[1] + dy] },
							f,
							seqId,
						);
					const p3 = move3dPosition(c.move3d, dx, dy);
					return [
						...transformCommands(c.id, { position: [p3[0], p3[1]] }, f, seqId),
						{
							type: 'param.set',
							target: ['clip', c.id, 'threeD', 'positionZ'],
							value: p3[2],
							at: { sequenceFrame: f },
							sequenceId: seqId,
						},
					];
				}),
			);
			return;
		}
		if (g.kind === 'scale' && g.bySize) {
			// wp-m2-shapes (S11:SHP-007): size instead of Motion scale; Shift keeps the ratio, Alt the opposite side.
			const r = resizeShapeBySize({
				values: g.clip.v0,
				size0: g.bySize.size0,
				handle: g.handle,
				start: g.bySize.start,
				pointer: p,
				shift: e.shiftKey,
				alt: e.altKey,
			});
			setReadout({ at: screen, text: `Size ${fmt(r.size[0])} × ${fmt(r.size[1])}` });
			scheduleUpdate([
				shapeSizeCommand(g.clip.id, r.size, f, seqId),
				...(r.position ? transformCommands(g.clip.id, { position: r.position }, f, seqId) : []),
			]);
			return;
		}
		if (g.kind === 'scale') {
			const r = scaleFromHandle({
				values: g.clip.v0,
				rect: g.rect,
				handle: g.handle,
				pointer: [p[0] - g.grab[0], p[1] - g.grab[1]],
				invertUniform: e.shiftKey,
				aboutOpposite: e.altKey,
			});
			const patch = {
				scale: r.scale,
				scaleWidth: r.scaleWidth,
				...(r.uniformScale !== g.clip.v0.uniformScale ? { uniformScale: r.uniformScale } : {}),
				...(e.altKey ? { position: r.position } : {}),
			};
			setReadout({
				at: screen,
				text: r.uniformScale ? `Scale ${fmt(r.scale)}%` : `Scale ${fmt(r.scaleWidth)}% × ${fmt(r.scale)}%`,
			});
			scheduleUpdate(transformCommands(g.clip.id, patch, f, seqId));
			return;
		}
		if (g.kind === 'group-scale') {
			const k = groupScaleFactor(g.box, g.handle, p);
			const center: Vec2 = [g.box.x + g.box.width / 2, g.box.y + g.box.height / 2];
			setReadout({ at: screen, text: `Scale ×${fmt(k * 100)}%` });
			scheduleUpdate(
				g.clips.flatMap((c) => transformCommands(c.id, scaleAboutPoint(c.v0, center, k), f, seqId)),
			);
			return;
		}
		if (g.kind === 'rotate') {
			const raw = g.tracker.update(p);
			if (!g.group) {
				const theta = snapRotation(raw, { shift: e.shiftKey, snap90: snapOn });
				setReadout({ at: screen, text: `Rotation ${fmt(theta)}°` });
				scheduleUpdate(transformCommands(g.clips[0]!.id, { rotation: theta }, f, seqId));
			} else {
				const delta = snapRotation(raw, { shift: e.shiftKey, snap90: false });
				setReadout({ at: screen, text: `Rotation ${fmt(delta)}°` });
				scheduleUpdate(
					g.clips.flatMap((c) => transformCommands(c.id, rotateAboutPoint(c.v0, g.center, delta), f, seqId)),
				);
			}
			return;
		}
		if (g.kind === 'anchor') {
			const delta: Vec2 = [p[0] - g.start[0], p[1] - g.start[1]];
			let next = moveAnchor(g.clip.v0, delta, e.altKey);
			if (!e.altKey) {
				// Snap the crosshair to the visible rect's corners, edge midpoints and center (8 screen px).
				const M0 = layerMatrix(g.clip.v0);
				for (const q of anchorSnapPoints(g.rect)) {
					const s = toScreen(live.current.view, applyMatrix(M0, q));
					if (dist(s, screen) <= ANCHOR_HIT) {
						next = { anchor: q, position: applyMatrix(M0, q) as Vec2 };
						break;
					}
				}
			}
			setReadout({ at: screen, text: `Anchor ${fmt(next.anchor[0])}, ${fmt(next.anchor[1])}` });
			scheduleUpdate(transformCommands(g.clip.id, next, f, seqId));
		}
	};

	const updateHover = (screen: Vec2, p: Vec2) => {
		const sel = live.current.selLayers;
		let c = 'default';
		if (tool === 'type') c = 'text';
		else if (tool === 'hand') c = 'grab';
		else if (pathHitAt(screen)) c = 'pointer';
		else if (sel.length === 1 && !is3dLayer(sel[0]!)) {
			const l = sel[0]!;
			const h = handleUnder(l, layerEditRect(l), screen);
			if (h) c = handleCursor(h, l.props.transform!.rotation);
			else if (rotationZoneHit(layerScreenQuad(l), screen)) c = 'alias';
		}
		const hit = layerAt(p);
		if (c === 'default' && hit) c = 'move';
		setCursor(c);
		setHover(hit);
	};

	const onPointerUp = () => {
		const g = gestureRef.current;
		if (g?.kind === 'pan' || g?.kind === 'marquee') {
			gestureRef.current = null;
			setMarquee(null);
			return;
		}
		// a Pen / Ctrl click on a path key (no drag) converts the vertex (corner ↔ smooth).
		if (g?.kind === 'path' && g.drag.pull && !g.moved) {
			endGesture(false);
			void session.apply({
				label: 'Convert Vertex',
				origin: 'user',
				commands: [convertVertexCommand(g.drag.key)],
			});
			return;
		}
		endGesture(true);
	};

	// Effects dropped on the Program monitor apply to the layer under the pointer (S05:EFX-010, like the
	// timeline); motion templates dropped anywhere on it are inserted at the playhead (S05:MGT-002).
	const [dropHint, setDropHint] = useState<string | null>(null);
	const onDragOver = (e: React.DragEvent<SVGSVGElement>) => {
		const dt = e.dataTransfer;
		if (isEffectDrag(dt)) {
			const hit = layerAt(toSeq(e).seq);
			if (!hit) {
				dt.dropEffect = 'none';
				setDropHint(null);
				return;
			}
			e.preventDefault();
			dt.dropEffect = 'copy';
			setDropHint(hit);
			return;
		}
		if (Array.from(dt?.types ?? []).includes(MG_TEMPLATE_MIME)) {
			e.preventDefault();
			dt.dropEffect = 'copy';
		}
		// M2 (wp-m2-text-anim, S11:TXA-020): text animation presets drop onto a text layer.
		if (isTextAnimationDrag(dt)) {
			const hit = layerAt(toSeq(e).seq);
			const ok = !!hit && scene.find((l) => l.clip.clipId === hit)?.clip.kind === 'text';
			dt.dropEffect = ok ? 'copy' : 'none';
			setDropHint(ok ? hit : null);
			if (ok) e.preventDefault();
		}
	};
	const onDrop = (e: React.DragEvent<SVGSVGElement>) => {
		setDropHint(null);
		const effect = readEffectDragPayload(e.dataTransfer);
		if (effect) {
			e.preventDefault();
			const hit = layerAt(toSeq(e).seq);
			if (hit) applyEffectToClips(session, effect.effectId, [hit]);
			return;
		}
		// M2 (wp-m2-text-anim, S11:TXA-020): left half of the text layer = In, right half = Out.
		const textAnim = readTextAnimationDrag(e.dataTransfer);
		if (textAnim) {
			e.preventDefault();
			const p = toSeq(e).seq;
			const layer = scene.find((l) => l.clip.clipId === layerAt(p));
			if (layer?.clip.kind !== 'text') return;
			const xs = (layer.props.quad as Quad).map((q) => q[0]);
			const side = p[0] < (Math.min(...xs) + Math.max(...xs)) / 2 ? 'in' : 'out';
			applyTextAnimation(session, [layer.clip.clipId], { side, ...textAnim });
			return;
		}
		const mg = readMgTemplateDrag(e.dataTransfer);
		if (mg) {
			e.preventDefault();
			try {
				insertMotionTemplate(session, mg.template, { at: transport.getState().frame });
			} catch (err) {
				console.warn('[program] motion template drop failed', err);
			}
		}
	};

	const hoverLayer =
		hover && !selectedSet.has(hover) ? scene.find((l) => l.clip.clipId === hover) : undefined;
	const frameRect: Quad = [
		toScreen(view, [0, 0]),
		toScreen(view, [doc.settings.width, 0]),
		toScreen(view, [doc.settings.width, doc.settings.height]),
		toScreen(view, [0, doc.settings.height]),
	];
	const groupRect = selLayers.length > 1 && !selLayers.some(is3dLayer) ? groupBox(selLayers) : null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer/drag surface over the canvas (keyboard: monitor scope)
		<svg
			ref={svgRef}
			data-testid="program-overlay"
			className="absolute inset-0 h-full w-full touch-none select-none"
			style={{ cursor }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={() => endGesture(false)}
			// wp-m3-mgtext (S08:MGU-005): double-click a layer → registered handlers (on-canvas text editing).
			onDoubleClick={(e) => {
				if (gestureRef.current || tool === 'hand' || tool === 'type') return;
				const p = toSeq(e).seq;
				const id = layerAt(p);
				const clip = id ? activeSequence(session)?.clips[id] : undefined;
				if (!clip) return;
				for (const h of layerDoubleClickHandlers.list()) {
					try {
						if (h.run({ session, clip, point: [p[0], p[1]], frame: live.current.frame })) break;
					} catch (err) {
						console.warn('[program] double-click handler failed', err);
					}
				}
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				if (gestureRef.current) return;
				const id = layerAt(toSeq(e).seq);
				if (id && !selectedSet.has(id)) session.select('timeline', [id], 'replace', { primary: id });
				onContextMenu?.({ x: e.clientX, y: e.clientY, clipId: id });
			}}
			onPointerLeave={() => !gestureRef.current && setHover(null)}
			onDragOver={onDragOver}
			onDragLeave={() => setDropHint(null)}
			onDrop={onDrop}
			data-drop-target={dropHint ?? undefined}
			role="presentation"
		>
			{monitor.safeMargins ? <SafeMarginsLayer frame={frameRect} /> : null}
			{playing ? (
				<PlaybackOutlines doc={doc} view={view} selected={selected} transport={transport} />
			) : (
				<>
					{hoverLayer ? (
						<polygon
							data-testid="overlay-hover"
							points={pts(layerScreenQuad(hoverLayer))}
							fill="none"
							stroke="var(--pr-accent)"
							strokeOpacity={0.5}
							strokeWidth={1}
						/>
					) : null}
					{selLayers.length === 1 && !is3dLayer(selLayers[0]!) ? (
						<SelectionBox layer={selLayers[0]!} view={view} />
					) : (
						selLayers.map((l) => (
							<polygon
								key={l.clip.clipId}
								points={pts(layerScreenQuad(l))}
								fill="none"
								stroke="var(--pr-accent)"
								strokeWidth={1}
							/>
						))
					)}
					{groupRect ? <GroupBox box={groupRect} view={view} /> : null}
					{snapHits ? <SnapLines hits={snapHits} view={view} viewport={viewport} /> : null}
				</>
			)}
			{motionPath ? <MotionPathLayer path={motionPath} view={view} selected={selectedKeys} /> : null}
			{anchorPath ? <MotionPathLayer path={anchorPath} view={view} selected={selectedKeys} /> : null}
			{fxPaths.map((p) => (
				<MotionPathLayer key={p.effect!.param} path={p} view={view} selected={selectedKeys} />
			))}
			{marquee ? (
				<rect
					x={toScreen(view, [marquee.x, marquee.y])[0]}
					y={toScreen(view, [marquee.x, marquee.y])[1]}
					width={marquee.width * view.scale}
					height={marquee.height * view.scale}
					fill="var(--pr-marquee-fill, transparent)"
					stroke="var(--pr-accent)"
					strokeDasharray="4 3"
					pointerEvents="none"
					data-testid="program-marquee"
				/>
			) : null}
			{readout ? (
				<g pointerEvents="none">
					<rect
						x={readout.at[0] + 16}
						y={readout.at[1] + 16}
						width={readout.text.length * 6.5 + 12}
						height={18}
						rx={3}
						fill="var(--pr-tooltip-bg)"
					/>
					<text x={readout.at[0] + 22} y={readout.at[1] + 29} fontSize={11} fill="var(--pr-text-strong)">
						{readout.text}
					</text>
				</g>
			) : null}
		</svg>
	);
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

function handleCursor(h: HandleId, rotation: number): string {
	const base: Record<HandleId, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
	const a = (((base[h] + rotation) % 180) + 180) % 180;
	const names = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
	return names[Math.round(a / 45) % 4]!;
}

function SelectionBox({ layer, view }: { layer: ResolvedLayer; view: View }) {
	const quad = layerEditQuad(layer).map((p) => toScreen(view, p as Vec2)) as Quad;
	const t = layer.props.transform!;
	const rect = layerEditRect(layer);
	const small = Math.min(dist(quad[0], quad[1]), dist(quad[1], quad[2])) < SMALL_QUAD;
	const ids: readonly HandleId[] = small ? CORNERS : HANDLE_IDS;
	const anchor = toScreen(view, applyMatrix(layer.props.matrix, t.anchor));
	return (
		<g data-testid="overlay-selection" data-clip-id={layer.clip.clipId}>
			<polygon points={pts(quad)} fill="none" stroke={MONITOR_COLORS.casing} strokeWidth={3} />
			<polygon
				data-testid="overlay-quad"
				points={pts(quad)}
				fill="none"
				stroke="var(--pr-accent)"
				strokeWidth={1}
			/>
			{ids.map((id) => {
				const at = toScreen(view, applyMatrix(layer.props.matrix, handlePoint(rect, id)));
				return (
					<rect
						key={id}
						data-handle={id}
						x={at[0] - 3.5}
						y={at[1] - 3.5}
						width={7}
						height={7}
						fill={MONITOR_COLORS.handleFill}
						stroke="var(--pr-accent)"
						strokeWidth={1}
						transform={`rotate(${t.rotation} ${at[0]} ${at[1]})`}
					/>
				);
			})}
			<g data-testid="overlay-anchor" stroke="var(--pr-accent)" strokeWidth={1} fill="none">
				<circle cx={anchor[0]} cy={anchor[1]} r={5} />
				<line x1={anchor[0] - 8} x2={anchor[0] + 8} y1={anchor[1]} y2={anchor[1]} />
				<line x1={anchor[0]} x2={anchor[0]} y1={anchor[1] - 8} y2={anchor[1] + 8} />
			</g>
		</g>
	);
}

function GroupBox({ box, view }: { box: Rect; view: View }) {
	const a = toScreen(view, [box.x, box.y]);
	const b = toScreen(view, [box.x + box.width, box.y + box.height]);
	return (
		<g data-testid="overlay-group">
			<rect
				x={a[0]}
				y={a[1]}
				width={b[0] - a[0]}
				height={b[1] - a[1]}
				fill="none"
				stroke="var(--pr-accent)"
				strokeWidth={1}
			/>
			{HANDLE_IDS.map((id) => {
				const at = toScreen(view, handlePoint(box, id));
				return (
					<rect
						key={id}
						x={at[0] - 3.5}
						y={at[1] - 3.5}
						width={7}
						height={7}
						fill={MONITOR_COLORS.handleFill}
						stroke="var(--pr-accent)"
						strokeWidth={1}
					/>
				);
			})}
		</g>
	);
}

function SafeMarginsLayer({ frame }: { frame: Quad }) {
	const [a, , c] = frame;
	const w = c[0] - a[0];
	const h = c[1] - a[1];
	const inset = (pct: number) => ({
		x: a[0] + (w * pct) / 100,
		y: a[1] + (h * pct) / 100,
		width: w * (1 - (2 * pct) / 100),
		height: h * (1 - (2 * pct) / 100),
	});
	const cx = a[0] + w / 2;
	const cy = a[1] + h / 2;
	return (
		<g
			data-testid="overlay-safe-margins"
			pointerEvents="none"
			fill="none"
			stroke={MONITOR_COLORS.safeMargin}
			strokeWidth={1}
		>
			<rect {...inset(SAFE_MARGINS.action)} />
			<rect {...inset(SAFE_MARGINS.title)} />
			<line x1={cx - 10} x2={cx + 10} y1={cy} y2={cy} />
			<line x1={cx} x2={cx} y1={cy - 10} y2={cy + 10} />
		</g>
	);
}

function SnapLines({
	hits,
	view,
	viewport,
}: {
	hits: { x: SnapHit | null; y: SnapHit | null };
	view: View;
	viewport: Size;
}) {
	const lines: { x1: number; y1: number; x2: number; y2: number; key: string }[] = [];
	if (hits.x) {
		const sx = toScreen(view, [hits.x.target.value, 0])[0];
		const ext = hits.x.target.extent;
		lines.push(
			ext && hits.x.target.kind === 'layer'
				? { key: 'x', x1: sx, x2: sx, y1: toScreen(view, [0, ext[0]])[1], y2: toScreen(view, [0, ext[1]])[1] }
				: { key: 'x', x1: sx, x2: sx, y1: 0, y2: viewport.height },
		);
	}
	if (hits.y) {
		const sy = toScreen(view, [0, hits.y.target.value])[1];
		const ext = hits.y.target.extent;
		lines.push(
			ext && hits.y.target.kind === 'layer'
				? { key: 'y', y1: sy, y2: sy, x1: toScreen(view, [ext[0], 0])[0], x2: toScreen(view, [ext[1], 0])[0] }
				: { key: 'y', y1: sy, y2: sy, x1: 0, x2: viewport.width },
		);
	}
	return (
		<g data-testid="overlay-snap" pointerEvents="none">
			{lines.map((l) => (
				<g key={l.key}>
					<line {...l} stroke="var(--pr-snap-line-casing)" strokeWidth={3} />
					<line {...l} stroke="var(--pr-snap-line)" strokeWidth={1} />
				</g>
			))}
		</g>
	);
}

/**
 * Selected-layer outlines during playback (S03:PGM-022), updated by direct DOM writes from the
 * transport subscription (no React render per frame).
 */
function PlaybackOutlines({
	doc,
	view,
	selected,
	transport,
}: {
	doc: RenderDoc;
	view: View;
	selected: readonly string[];
	transport: TransportStore;
}) {
	const refs = useRef(new Map<string, SVGPolygonElement>());
	const live = useRef({ doc, view });
	live.current = { doc, view };
	useLayoutEffect(() => {
		let raf: number | null = null;
		const draw = () => {
			raf = null;
			const { doc: d, view: v } = live.current;
			const scene = resolveProgramScene(d, transport.getState().frame);
			for (const [id, el] of refs.current) {
				const l = scene.find((x) => x.clip.clipId === id);
				el.setAttribute('points', l ? pts(layerEditQuad(l).map((p) => toScreen(v, p as Vec2))) : '');
			}
		};
		draw();
		const off = transport.subscribe(() => {
			if (raf === null) raf = requestAnimationFrame(draw);
		});
		return () => {
			off();
			if (raf !== null) cancelAnimationFrame(raf);
		};
	}, [transport]);
	return (
		<g data-testid="overlay-playback-outlines" pointerEvents="none">
			{selected.map((id) => (
				<polygon
					key={id}
					ref={(el) => {
						if (el) refs.current.set(id, el);
						else refs.current.delete(id);
					}}
					fill="none"
					stroke="var(--pr-accent)"
					strokeWidth={1}
				/>
			))}
		</g>
	);
}

/** visible guides of the active sequence are snap targets (Premiere: Snap in Program Monitor). */
function snapGuides(session: EditorSession) {
	if (!monitorExtras.getState().showGuides) return [];
	return guidesOf(session.getState().activeSequenceId);
}
