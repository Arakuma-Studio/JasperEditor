// On-canvas selection and transform overlay (S03 §9–§10, ARC-004): drawn above the Player in screen
// space, from the same RenderDoc and `resolveSceneAt` as the composition, so handles line up with
// the rendered layers under rotation and non-uniform scale. Every drag is one session gesture
// (`beginGesture` → `update` per animation frame → `commit`), i.e. exactly one undo step (XF-053).
// While playing, handles are hidden and only selected outlines are drawn by direct DOM writes.
import type { RenderDoc } from '@jasper/compositions';
import {
	applyMatrix,
	type LayerTransformValues,
	layerMatrix,
	type Rect,
	type ResolvedLayer,
	resolveSceneAt,
	visibleRect,
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
} from 'react';
import { applyEffectToClips, isEffectDrag, readEffectDragPayload } from '../effects/drag.ts';
import { insertMotionTemplate, MG_TEMPLATE_MIME, readMgTemplateDrag } from '../motionTemplates/insert.ts';
import { activeSequence, addTextAt, transformAt, transformCommands } from './edits.ts';
import { MONITOR_COLORS } from './monitor.tokens.ts';
import type { MonitorViewState } from './monitor-store.ts';
import { buildSnapTargets, type SnapHit, type SnapTargets, snapMove, snapThreshold } from './snapping.ts';
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

export const SAFE_MARGINS = { action: 5, title: 10 } as const;
const DRAG_THRESHOLD = 3;
const AXIS_LOCK_PX = 6;

type ClipStart = { id: string; v0: LayerTransformValues };
type GestureState =
	| { kind: 'pan'; start: Vec2; pan0: Vec2 }
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

export type TransformOverlayProps = {
	session: EditorSession;
	doc: RenderDoc;
	view: View;
	viewport: Size;
	transport: TransportStore;
	monitor: MonitorViewState;
	onPan(pan: Vec2): void;
};

export function TransformOverlay({
	session,
	doc,
	view,
	viewport,
	transport,
	monitor,
	onPan,
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
	const scene = useMemo(() => resolveSceneAt(doc, frame), [doc, frame]);
	const selectedSet = useMemo(() => new Set(selected), [selected]);
	const selLayers = useMemo(
		() => scene.filter((l) => selectedSet.has(l.clip.clipId) && l.props.transform),
		[scene, selectedSet],
	);
	const [hover, setHover] = useState<string | null>(null);
	const [snapHits, setSnapHits] = useState<{ x: SnapHit | null; y: SnapHit | null } | null>(null);
	const [readout, setReadout] = useState<Readout>(null);
	const [cursor, setCursor] = useState('default');
	const gestureRef = useRef<GestureState | null>(null);
	const pendingRef = useRef<{ cmds: Parameters<Gesture['update']>[0] } | null>(null);
	const rafRef = useRef<number | null>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const live = useRef({ scene, view, selLayers, frame, monitor });
	live.current = { scene, view, selLayers, frame, monitor };

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
		if (g && g.kind !== 'pan' && p) g.g.update(p.cmds);
	};
	const scheduleUpdate = (cmds: Parameters<Gesture['update']>[0]) => {
		pendingRef.current = { cmds };
		if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushUpdate);
	};

	const endGesture = (commit: boolean) => {
		const g = gestureRef.current;
		// Apply the last pointer position before the gesture is released.
		if (commit && g && g.kind !== 'pan' && g.moved) flushUpdate();
		gestureRef.current = null;
		setSnapHits(null);
		setReadout(null);
		if (!g || g.kind === 'pan') return;
		if (commit && g.moved) {
			g.g.commit();
		} else {
			pendingRef.current = null;
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
			g.g.cancel();
		}
	};

	// Esc cancels a drag (XF-053) before the keymap sees it.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && gestureRef.current) {
				e.preventDefault();
				e.stopPropagation();
				endGesture(false);
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});

	// A playback start ends any gesture (S02:TL-882 in reverse: playback wins).
	useEffect(() => {
		if (playing && gestureRef.current) endGesture(false);
	});

	const clipStart = (id: string): ClipStart | null => {
		const seq = activeSequence(session);
		const c = seq?.clips[id];
		if (!seq || !c || !('transform' in c)) return null;
		return { id, v0: transformAt(seq, c as never, live.current.frame) };
	};

	const layerScreenQuad = (l: ResolvedLayer): Quad =>
		l.props.quad.map((p) => toScreen(view, p as Vec2)) as Quad;

	const groupBox = (layers: readonly ResolvedLayer[]): Rect | null =>
		unionBounds(layers.map((l) => l.props.bounds));

	const layerAt = (p: Vec2): string | null =>
		hitTest(
			live.current.scene
				.filter((l) => l.props.transform)
				.map((l) => ({ clipId: l.clip.clipId, trackId: l.clip.trackId, quad: l.props.quad as Quad })),
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
		// Handles / anchor / rotation of the current selection (XF-010…012, XF-037).
		if (sel.length === 1) {
			const l = sel[0]!;
			const rect = visibleRect(l.props.box, l.props.crop ?? undefined);
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
				svg.setPointerCapture?.(e.pointerId);
				gestureRef.current = {
					kind: 'scale',
					g: session.beginGesture('Scale'),
					clip: cs,
					rect,
					handle: h,
					grab: [p[0] - hp[0], p[1] - hp[1]],
					startScreen: screen,
					moved: false,
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
		} else if (sel.length > 1) {
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
			if (!e.shiftKey && !e.ctrlKey && !e.metaKey) session.clearSelection('timeline');
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
			.map((l) => ({ clipId: l.clip.clipId, bounds: l.props.bounds }));
		svg.setPointerCapture?.(e.pointerId);
		gestureRef.current = {
			kind: 'move',
			g: session.beginGesture('Move'),
			start: p,
			startScreen: screen,
			clips,
			bounds0: unionBounds(moving.map((l) => l.props.bounds))!,
			targets: buildSnapTargets({
				width: doc.settings.width,
				height: doc.settings.height,
				safeMargins: monitor.safeMargins ? SAFE_MARGINS : null,
				layers: others,
			}),
			moved: false,
		};
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
		if (!g.moved && dist(screen, g.startScreen) < DRAG_THRESHOLD) return;
		g.moved = true;
		const f = live.current.frame;
		const seqId = doc.sequenceId;
		const snapOn = live.current.monitor.snapInMonitor !== (e.ctrlKey || e.metaKey); // Ctrl inverts (SNP-001)
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
				g.clips.flatMap((c) =>
					transformCommands(c.id, { position: [c.v0.position[0] + dx, c.v0.position[1] + dy] }, f, seqId),
				),
			);
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
		else if (sel.length === 1) {
			const l = sel[0]!;
			const h = handleUnder(l, visibleRect(l.props.box, l.props.crop ?? undefined), screen);
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
		if (g?.kind === 'pan') {
			gestureRef.current = null;
			return;
		}
		endGesture(true);
	};

	// ------------------------------------------------------------------ drops (WP-3I)
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

	// ------------------------------------------------------------------ drawing
	const hoverLayer =
		hover && !selectedSet.has(hover) ? scene.find((l) => l.clip.clipId === hover) : undefined;
	const frameRect: Quad = [
		toScreen(view, [0, 0]),
		toScreen(view, [doc.settings.width, 0]),
		toScreen(view, [doc.settings.width, doc.settings.height]),
		toScreen(view, [0, doc.settings.height]),
	];
	const groupRect = selLayers.length > 1 ? groupBox(selLayers) : null;

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
					{selLayers.length === 1 ? (
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
	const quad = layer.props.quad.map((p) => toScreen(view, p as Vec2)) as Quad;
	const t = layer.props.transform!;
	const rect = visibleRect(layer.props.box, layer.props.crop ?? undefined);
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
			const scene = resolveSceneAt(d, transport.getState().frame);
			for (const [id, el] of refs.current) {
				const l = scene.find((x) => x.clip.clipId === id);
				el.setAttribute('points', l ? pts(l.props.quad.map((p) => toScreen(v, p as Vec2))) : '');
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
