// three-d: the Program monitor's 3D overlay (registered as a Program overlay):
// - the 3D view chip (View ▸ Switch 3D View) — which camera the monitor shows, switchable;
// - in views other than the active camera: wireframes of the cameras (frustum to the image plane) and lights;
// - the 3D axis gizmo of one selected 3D layer (X red, Y green, Z blue): drag an arrow to move along that world axis
//   (one undo step);
// - the Camera tool (After Effects' Unified Camera Tool): left drag orbits, middle (or Shift+left) drag pans, right (or
//   Alt+left) drag dollies, the wheel dollies — the active camera clip in the Active Camera view (one undo step per
//   drag, keys when animated), else the view's own camera (view state, not undoable).
import type { RenderDoc } from '@jasper/compositions';
import {
	activeCameraClipAt,
	clipContentTime,
	dollyRig,
	evaluate,
	mat4Apply,
	orbitRig,
	panRig,
	projectPoint,
	type Rig,
	rigFrameAt,
	type Vec2,
	type Vec3,
	VIEW_3D_LABELS,
	VIEWS_3D,
	type View3D,
	viewOfRig,
} from '@jasper/project';
import type { Gesture, TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { toScreen, type View } from '../panels/program/viewport.ts';
import { programCamera, resolveProgramScene } from './scene.ts';
import { setViewCam, switchView, threeDViews, viewCamOf } from './view-store.ts';

const AXES: { axis: 0 | 1 | 2; color: string; label: string }[] = [
	{ axis: 0, color: 'var(--pr-danger)', label: 'X' },
	{ axis: 1, color: 'var(--pr-success)', label: 'Y' },
	{ axis: 2, color: 'var(--pr-accent)', label: 'Z' },
];
const ARROW_PX = 64;

/** Whether the sequence shown has anything 3D (the overlay draws nothing otherwise). */
export function has3d(doc: RenderDoc | null | undefined): boolean {
	return !!doc && (!!doc.scene3d || doc.videoTracks.some((t) => t.clips.some((c) => c.threeD)));
}

export function Scene3DOverlay(props: ProgramOverlayHostProps) {
	const doc = props.doc as RenderDoc | null;
	if (!has3d(doc)) return null;
	return <Scene3DSurface {...props} doc={doc!} />;
}

type Drag =
	| {
			kind: 'axis';
			g: Gesture;
			clipId: string;
			axis: 0 | 1 | 2;
			start: Vec2;
			dir: Vec2;
			perUnit: number;
			p0: Vec3;
			moved: boolean;
	  }
	| {
			kind: 'camera';
			op: 'orbit' | 'pan' | 'dolly';
			start: Vec2;
			rig0: Rig;
			g: Gesture | null;
			clipId: string | null;
			moved: boolean;
	  };

function Scene3DSurface(props: ProgramOverlayHostProps & { doc: RenderDoc }) {
	const { session, doc } = props;
	const view = props.view as View;
	const transport = props.transport as TransportStore;
	const { frame, playing } = useOverlayFrame(transport);
	const tool = useStoreSelector(session.store, (s) => s.toggles.activeTool);
	const selected = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const views = useStoreSelector(threeDViews, (s) => s.bySequence[doc.sequenceId]);
	const current: View3D = views?.view ?? 'activeCamera';
	const svgRef = useRef<SVGSVGElement>(null);
	const dragRef = useRef<Drag | null>(null);
	const [, force] = useState(0);
	const W = doc.settings.width;
	const H = doc.settings.height;
	const cam = programCamera(doc, frame);
	const camClip = activeCameraClipAt(doc.scene3d, frame);
	const scr = (p: Vec3): Vec2 | null => {
		const q = projectPoint(cam, W, H, p);
		return q ? toScreen(view, q) : null;
	};
	const local = (e: { clientX: number; clientY: number }): Vec2 => {
		const r = svgRef.current!.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	};

	// ---- the selected 3D layer's gizmo
	const scene = resolveProgramScene(doc, frame);
	const sel =
		selected.length === 1 ? scene.find((l) => l.clip.clipId === selected[0] && l.clip.threeD) : undefined;
	let gizmo: { origin: Vec2; tips: { axis: 0 | 1 | 2; tip: Vec2; perUnit: number }[]; p0: Vec3 } | null =
		null;
	if (sel && !playing && tool === 'selection') {
		const tr = sel.clip.transform!;
		const t = clipContentTime(sel.clip, frame, doc.settings.fps);
		const pos = evaluate(tr.position, t) as Vec2;
		const z = Number(evaluate(sel.clip.threeD!.positionZ, t)) || 0;
		const p0: Vec3 = [pos[0], pos[1], z];
		const o = scr(p0);
		if (o) {
			// World length that projects to about ARROW_PX on screen at the anchor's depth.
			const depth = mat4Apply(cam.view, p0)[2];
			const unit = cam.ortho ? 1 / cam.zoom : Math.max(1, depth) / cam.zoom;
			const L = (ARROW_PX / Math.max(1e-6, view.scale)) * unit;
			const tips = AXES.map(({ axis }) => {
				const p = [...p0] as Vec3;
				p[axis] += L;
				const tip = scr(p);
				return tip ? { axis, tip, perUnit: Math.hypot(tip[0] - o[0], tip[1] - o[1]) / L } : null;
			}).filter((x): x is { axis: 0 | 1 | 2; tip: Vec2; perUnit: number } => !!x && x.perUnit > 1e-6);
			gizmo = { origin: o, tips, p0 };
		}
	}

	const startAxis = (e: ReactPointerEvent, axis: 0 | 1 | 2) => {
		if (!sel || !gizmo || e.button !== 0) return;
		const tip = gizmo.tips.find((x) => x.axis === axis)!;
		const d: Vec2 = [tip.tip[0] - gizmo.origin[0], tip.tip[1] - gizmo.origin[1]];
		const len = Math.hypot(d[0], d[1]);
		if (len < 1e-6) return;
		e.stopPropagation();
		svgRef.current?.setPointerCapture?.(e.pointerId);
		dragRef.current = {
			kind: 'axis',
			g: session.beginGesture(`Move ${AXES[axis]!.label}`),
			clipId: sel.clip.clipId,
			axis,
			start: local(e),
			dir: [d[0] / len, d[1] / len],
			perUnit: tip.perUnit,
			p0: gizmo.p0,
			moved: false,
		};
	};

	// ---- camera tool
	const viewRig = (): Rig | null => {
		if (current === 'activeCamera') {
			if (!camClip) return null;
			const t = clipContentTime(camClip, frame, doc.settings.fps);
			const tr = camClip.camera.transform;
			const eye = rigFrameAt(tr, t).eye;
			const poi = evaluate(tr.pointOfInterest, t) as Vec3;
			return { eye, poi, zoom: Number(evaluate(camClip.camera.zoom, t)) || 1, ortho: false };
		}
		const v = viewCamOf(doc.sequenceId, current, W, H)!;
		return { eye: v.eye, poi: v.poi, zoom: v.zoom, ortho: v.ortho };
	};
	const startCamera = (e: ReactPointerEvent) => {
		if (tool !== 'camera') return;
		e.preventDefault();
		let rig0 = viewRig();
		if (!rig0) {
			// No camera clip: the Active Camera is the default camera; navigate the Default view instead.
			switchView(doc.sequenceId, 'default');
			const v = viewCamOf(doc.sequenceId, 'default', W, H)!;
			rig0 = { eye: v.eye, poi: v.poi, zoom: v.zoom, ortho: v.ortho };
		}
		const op: 'orbit' | 'pan' | 'dolly' =
			e.button === 1 || (e.button === 0 && e.shiftKey)
				? 'pan'
				: e.button === 2 || (e.button === 0 && e.altKey)
					? 'dolly'
					: 'orbit';
		const editsClip = current === 'activeCamera' && !!camClip;
		svgRef.current?.setPointerCapture?.(e.pointerId);
		dragRef.current = {
			kind: 'camera',
			op,
			start: local(e),
			rig0,
			g: editsClip
				? session.beginGesture(op === 'orbit' ? 'Orbit Camera' : op === 'pan' ? 'Pan Camera' : 'Dolly Camera')
				: null,
			clipId: editsClip ? camClip!.clipId : null,
			moved: false,
		};
	};
	const at = { sequenceFrame: frame };
	const cameraCommand = (op: 'orbit' | 'pan' | 'dolly', clipId: string, dx: number, dy: number) =>
		op === 'orbit'
			? { type: 'camera.orbit', clipId, yaw: dx * 0.4, pitch: dy * 0.4, at }
			: op === 'pan'
				? { type: 'camera.pan', clipId, dx: dx / view.scale, dy: dy / view.scale, at }
				: { type: 'camera.dolly', clipId, amount: -dy * 4, at };
	const applyRig = (op: 'orbit' | 'pan' | 'dolly', r: Rig, dx: number, dy: number): Rig =>
		op === 'orbit'
			? orbitRig(r, dx * 0.4, dy * 0.4)
			: op === 'pan'
				? panRig(r, dx / view.scale, dy / view.scale)
				: dollyRig(r, -dy * 4, false);

	const onPointerMove = (e: ReactPointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		const p = local(e);
		const dx = p[0] - d.start[0];
		const dy = p[1] - d.start[1];
		if (Math.hypot(dx, dy) >= 2) d.moved = true;
		if (!d.moved) return;
		if (d.kind === 'axis') {
			const along = dx * d.dir[0] + dy * d.dir[1];
			const delta = along / d.perUnit;
			const p3 = [...d.p0] as Vec3;
			p3[d.axis] += delta;
			d.g.update([
				{
					type: 'param.set',
					target: ['clip', d.clipId, 'transform', 'position'],
					value: [p3[0], p3[1]],
					at,
				} as never,
				{ type: 'param.set', target: ['clip', d.clipId, 'threeD', 'positionZ'], value: p3[2], at } as never,
			]);
			return;
		}
		if (d.g && d.clipId) d.g.update([cameraCommand(d.op, d.clipId, dx, dy) as never]);
		else {
			setViewCam(doc.sequenceId, current === 'activeCamera' ? 'default' : current, {
				...viewOfRig(
					applyRig(d.op, d.rig0, dx, dy),
					viewCamOf(doc.sequenceId, current === 'activeCamera' ? 'default' : current, W, H)!.down,
				),
			});
			force((n) => n + 1);
		}
	};
	const end = (commit: boolean) => {
		const d = dragRef.current;
		dragRef.current = null;
		if (!d) return;
		const g = d.kind === 'axis' ? d.g : d.g;
		if (!g) return;
		if (commit && d.moved) g.commit();
		else g.cancel();
	};
	const onWheel = (e: React.WheelEvent) => {
		if (tool !== 'camera' || current === 'activeCamera') return;
		const v = viewCamOf(doc.sequenceId, current, W, H)!;
		const r = dollyRig({ eye: v.eye, poi: v.poi, zoom: v.zoom, ortho: v.ortho }, -e.deltaY * 2, false);
		setViewCam(doc.sequenceId, current, viewOfRig(r, v.down));
	};

	// ---- wireframes (views other than the active camera)
	const wires: { key: string; d: string; color: string }[] = [];
	if (current !== 'activeCamera') {
		for (const c of doc.scene3d?.cameras ?? []) {
			if (frame < c.start || frame >= c.start + c.duration) continue;
			const t = clipContentTime(c, frame, doc.settings.fps);
			const f = rigFrameAt(c.camera.transform, t);
			const zoom = Number(evaluate(c.camera.zoom, t)) || 1;
			const right: Vec3 = [f.rotation[0]!, f.rotation[4]!, f.rotation[8]!];
			const s = 0.25;
			const corner = (sx: number, sy: number): Vec3 => [
				f.eye[0] + (f.fwd[0] * zoom + (right[0] * sx * W) / 2 + (f.down[0] * sy * H) / 2) * s,
				f.eye[1] + (f.fwd[1] * zoom + (right[1] * sx * W) / 2 + (f.down[1] * sy * H) / 2) * s,
				f.eye[2] + (f.fwd[2] * zoom + (right[2] * sx * W) / 2 + (f.down[2] * sy * H) / 2) * s,
			];
			const e0 = scr(f.eye);
			const cs = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map(scr);
			if (!e0 || cs.some((x) => !x)) continue;
			const q = cs as Vec2[];
			const d = [
				...q.map((x) => `M${e0[0]},${e0[1]}L${x[0]},${x[1]}`),
				`M${q[0]![0]},${q[0]![1]}L${q[1]![0]},${q[1]![1]}L${q[2]![0]},${q[2]![1]}L${q[3]![0]},${q[3]![1]}Z`,
			].join('');
			wires.push({ key: c.clipId, d, color: 'var(--pr-label-rose, var(--pr-accent))' });
		}
		for (const l of doc.scene3d?.lights ?? []) {
			if (frame < l.start || frame >= l.start + l.duration) continue;
			const t = clipContentTime(l, frame, doc.settings.fps);
			const f = rigFrameAt(l.light.transform, t);
			const p = scr(f.eye);
			if (!p) continue;
			let d = `M${p[0] - 6},${p[1]}a6,6 0 1,0 12,0a6,6 0 1,0 -12,0`;
			if (l.light.type === 'spot' || l.light.type === 'parallel') {
				const poi = scr(evaluate(l.light.transform.pointOfInterest, t) as Vec3);
				if (poi) d += `M${p[0]},${p[1]}L${poi[0]},${poi[1]}`;
			}
			wires.push({ key: l.clipId, d, color: 'var(--pr-warning)' });
		}
	}

	const cameraActive = tool === 'camera';
	return (
		<>
			<svg
				ref={svgRef}
				className="absolute inset-0"
				width="100%"
				height="100%"
				style={{ pointerEvents: cameraActive ? 'auto' : 'none', cursor: cameraActive ? 'move' : undefined }}
				data-testid="scene3d-overlay"
				onPointerDown={cameraActive ? startCamera : undefined}
				onPointerMove={onPointerMove}
				onPointerUp={() => end(true)}
				onPointerCancel={() => end(false)}
				onContextMenu={(e) => cameraActive && e.preventDefault()}
				onWheel={onWheel}
				aria-label="3D view"
			>
				{wires.map((w) => (
					<path
						key={w.key}
						d={w.d}
						fill="none"
						stroke={w.color}
						strokeWidth={1}
						data-testid={`scene3d-wire-${w.key}`}
					/>
				))}
				{gizmo ? (
					<g data-testid="scene3d-gizmo">
						{gizmo.tips.map((t) => {
							const a = AXES[t.axis]!;
							return (
								<g
									key={a.label}
									style={{ pointerEvents: 'auto', cursor: 'pointer' }}
									onPointerDown={(e) => startAxis(e, t.axis)}
								>
									<line
										x1={gizmo!.origin[0]}
										y1={gizmo!.origin[1]}
										x2={t.tip[0]}
										y2={t.tip[1]}
										stroke={a.color}
										strokeWidth={3}
										data-testid={`scene3d-axis-${a.label}`}
									/>
									<circle cx={t.tip[0]} cy={t.tip[1]} r={5} fill={a.color} />
									<text x={t.tip[0] + 7} y={t.tip[1] - 5} fontSize={10} fill={a.color}>
										{a.label}
									</text>
								</g>
							);
						})}
					</g>
				) : null}
			</svg>
			<div className="absolute top-1 left-1 flex items-center gap-1" style={{ pointerEvents: 'auto' }}>
				<select
					className="rounded-[3px] bg-pr-panel px-1 py-[1px] text-pr-small text-pr-text"
					value={current}
					aria-label="3D view"
					data-testid="scene3d-view-select"
					onChange={(e) => switchView(doc.sequenceId, e.currentTarget.value as View3D)}
				>
					{VIEWS_3D.map((v) => (
						<option key={v} value={v}>
							{v === 'activeCamera' && camClip ? `Active Camera (${camClip.name})` : VIEW_3D_LABELS[v]}
						</option>
					))}
				</select>
			</div>
		</>
	);
}
