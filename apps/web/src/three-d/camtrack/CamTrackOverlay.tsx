// Program monitor overlay of the 3D Camera Tracker (three-d): the solved track points of the selected video clip at
// the playhead (After Effects' "3D Solved" display: X marks sized by distance, Track Point Size), click / Shift-click
// to select them, the target of the selection (a disc in the plane of the points, Target Size) and a context menu
// (right-click) with Create Text and Camera, Create Solid and Camera, Create Camera, Set Ground Plane and Origin and
// Delete Selected Points. Points project through the solved camera into media px, then through the clip's Motion.
import type { RenderDoc } from '@jasper/compositions';
import {
	applyMat3,
	type Clip,
	type ClipCameraTracker,
	cameraTrackerSettingsOf,
	contentTimeAt,
	distortPoint,
	layerMapOf,
	type Mat3,
	mediaFrameAt,
	type Rational,
	solvedCameraAt,
	targetOf,
	trackPointsAt,
	type Vec3,
} from '@jasper/project';
import type { EditorSession, TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { useEffect, useMemo, useState } from 'react';
import type { ProgramOverlayHostProps } from '../../extensions/index.ts';
import { useOverlayFrame } from '../../panels/program/TransformOverlay.tsx';
import { toScreen, type View } from '../../panels/program/viewport.ts';
import { useEngineOrNull } from '../../state/engine.tsx';
import { resolveProgramScene } from '../scene.ts';
import { createFromTracker, deletePoints, setCamTrackEngine, setGround } from './actions.ts';
import { CAMTRACK_COLORS } from './camtrack.tokens.ts';
import { camtrackUi, useCamTrack } from './store.ts';

type Vec2 = [number, number];

export function CamTrackOverlay(props: ProgramOverlayHostProps) {
	const session = props.session as EditorSession;
	const doc = props.doc as RenderDoc;
	const view = props.view as View;
	const transport = props.transport as TransportStore;
	const engine = useEngineOrNull();
	const { frame } = useOverlayFrame(transport);
	const selectedClips = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const drawn = useStoreSelector(session.store, (s) => s.transient ?? s.document);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const selection = useCamTrack((s) => s.selection);
	const [menu, setMenu] = useState<Vec2 | null>(null);

	useEffect(() => {
		if (engine) setCamTrackEngine(engine.client);
	}, [engine]);

	const scene = useMemo(() => resolveProgramScene(doc, frame), [doc, frame]);
	if (selectedClips.length !== 1) return null;
	const seq = Object.values(drawn.sequences).find((s) => s.clips[selectedClips[0]!]);
	const clip = seq?.clips[selectedClips[0]!] as (Clip & { cameraTracker?: ClipCameraTracker }) | undefined;
	const tracker = clip?.cameraTracker;
	if (!seq || !clip || clip.kind !== 'video' || !tracker?.solve) return null;
	const settings = cameraTrackerSettingsOf(tracker.settings);
	if (settings.showPoints === 'off') return null;
	const layer = scene.find((l) => l.clip.clipId === clip.id);
	if (!layer) return null;
	const map: Mat3 = layerMapOf(layer.props);
	const mediaFrame = mediaFrameAt(
		contentTimeAt(clip, frame, seq.settings.frameRate as Rational),
		tracker.rate as Rational,
	);
	const points = trackPointsAt(tracker, mediaFrame);
	if (points.length === 0) return null;
	const screen = (uv: Vec2): Vec2 => toScreen(view, applyMat3(map, uv) as Vec2);
	const depths = points.map((p) => p.depth).sort((a, b) => a - b);
	const refDepth = depths[depths.length >> 1]!;
	const chosen = new Set(selection?.clipId === clip.id ? selection.ids : []);
	const solve = tracker.solve;

	// The target: a disc in the plane of the selected points, Target Size.
	let target: Vec2[] | null = null;
	let targetCentre: Vec2 | null = null;
	const cam = solvedCameraAt(solve, mediaFrame);
	const picked = solve.points.filter((p) => chosen.has(p.id));
	if (cam && picked.length) {
		const t = targetOf(
			picked.map((p) => p.pos as Vec3),
			cam,
		);
		if (t) {
			const depth = cam.r[2][0] * (t.c[0] - cam.c[0]) + cam.r[2][1] * (t.c[1] - cam.c[1]) + cam.r[2][2] * (t.c[2] - cam.c[2]);
			const radius = (0.125 * solve.size[0] * Math.max(1e-6, depth) * settings.targetSize) / (100 * cam.f);
			const helper: Vec3 = Math.abs(t.n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
			const u = norm(cross(t.n, helper));
			const v = cross(t.n, u);
			const proj = (p: Vec3): Vec2 | null => {
				const d: Vec3 = [p[0] - cam.c[0], p[1] - cam.c[1], p[2] - cam.c[2]];
				const q = cam.r.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]);
				if (q[2]! <= 1e-9) return null;
				const k = distortPoint(solve.distortion, [(cam.f * q[0]!) / q[2]!, (cam.f * q[1]!) / q[2]!]);
				return screen([k[0] + solve.size[0] / 2, k[1] + solve.size[1] / 2]);
			};
			const ring: Vec2[] = [];
			for (let i = 0; i < 48; i++) {
				const a = (i / 48) * Math.PI * 2;
				const p = proj([
					t.c[0] + radius * (Math.cos(a) * u[0] + Math.sin(a) * v[0]),
					t.c[1] + radius * (Math.cos(a) * u[1] + Math.sin(a) * v[1]),
					t.c[2] + radius * (Math.cos(a) * u[2] + Math.sin(a) * v[2]),
				]);
				if (p) ring.push(p);
			}
			target = ring.length > 8 ? ring : null;
			targetCentre = proj(t.c);
		}
	}

	const select = (id: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) =>
		camtrackUi.select(clip.id, [id], e.shiftKey || e.metaKey || e.ctrlKey ? 'toggle' : 'replace');
	const ids = [...chosen];
	const run = (f: () => void) => {
		setMenu(null);
		f();
	};
	return (
		<>
			<svg
				className="pointer-events-none absolute inset-0 h-full w-full select-none"
				data-testid="camtrack-overlay"
				data-points={points.length}
				data-media-frame={mediaFrame}
				role="presentation"
			>
				{target ? (
					<g pointerEvents="none" data-testid="camtrack-target">
						<polygon points={pts(target)} fill={CAMTRACK_COLORS.target} fillOpacity={0.35} stroke={CAMTRACK_COLORS.target} strokeWidth={2} />
						{targetCentre ? (
							<circle cx={targetCentre[0]} cy={targetCentre[1]} r={3} fill={CAMTRACK_COLORS.targetInner} />
						) : null}
					</g>
				) : null}
				{points.map((p) => {
					const [x, y] = screen(p.uv);
					const s = Math.max(2, Math.min(12, (4 * settings.pointSize * refDepth) / (100 * p.depth)));
					const on = chosen.has(p.id);
					const color = on ? CAMTRACK_COLORS.selected : CAMTRACK_COLORS.points[p.id % CAMTRACK_COLORS.points.length]!;
					return (
						<g key={p.id} data-point-id={p.id} data-selected={on ? '1' : '0'}>
							<path
								d={`M${x - s} ${y - s}L${x + s} ${y + s}M${x - s} ${y + s}L${x + s} ${y - s}`}
								stroke={CAMTRACK_COLORS.casing}
								strokeWidth={on ? 4 : 3}
							/>
							<path
								d={`M${x - s} ${y - s}L${x + s} ${y + s}M${x - s} ${y + s}L${x + s} ${y - s}`}
								stroke={color}
								strokeWidth={on ? 2 : 1.25}
							/>
							<circle
								cx={x}
								cy={y}
								r={Math.max(6, s + 2)}
								fill="transparent"
								pointerEvents={readOnly ? 'none' : 'all'}
								style={{ cursor: 'pointer' }}
								onPointerDown={(e) => {
									if (e.button !== 0) return;
									e.stopPropagation();
									select(p.id, e);
								}}
								onContextMenu={(e) => {
									e.preventDefault();
									e.stopPropagation();
									if (!chosen.has(p.id)) camtrackUi.select(clip.id, [p.id], 'add');
									const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
									setMenu([e.clientX - box.left, e.clientY - box.top]);
								}}
							/>
						</g>
					);
				})}
			</svg>
			{menu && !readOnly ? (
				<div
					className="absolute z-10 flex min-w-[220px] flex-col rounded-pr-control border border-pr-border-strong bg-pr-panel py-1 text-pr-small text-pr-text shadow-pr-popover"
					style={{ left: menu[0], top: menu[1] }}
					role="menu"
					data-testid="camtrack-menu"
					onPointerLeave={() => setMenu(null)}
				>
					{[
						['Create Text and Camera', () => createFromTracker(session, clip.id, 'text', [...chosen], mediaFrame)],
						['Create Solid and Camera', () => createFromTracker(session, clip.id, 'solid', [...chosen], mediaFrame)],
						['Create Camera', () => createFromTracker(session, clip.id, 'none', [], mediaFrame)],
						...(chosen.size >= 3
							? [['Set Ground Plane and Origin', () => setGround(session, clip.id, ids, mediaFrame)] as const]
							: []),
						['Delete Selected Points', () => deletePoints(session, engine?.client ?? null, clip.id, ids)],
					].map(([label, f]) => (
						<button
							key={label as string}
							type="button"
							role="menuitem"
							className="px-3 py-1 text-left hover:bg-pr-hover"
							onClick={() => run(f as () => void)}
						>
							{label as string}
						</button>
					))}
				</div>
			) : null}
		</>
	);
}

const pts = (q: readonly Vec2[]) => q.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
	const l = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
};
