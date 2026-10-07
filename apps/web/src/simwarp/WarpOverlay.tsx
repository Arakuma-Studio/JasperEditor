// Program-monitor tools of the sim-warp effects, for the effect focused in Effect Controls on the one selected clip:
// - Puppet: the deformed mesh, the pins (drag to move: one gesture writing `puppet.movePins` at the playhead — a key
//   when animated), and with the Puppet Pin tool on, clicks on the layer add pins (`puppet.addPin`; the first pin on
//   an image with transparency builds its mesh from the image's alpha outline, like After Effects);
// - Liquify: with the brush on, a drag paints one stroke of the effect's Tool (`liquify.stroke`, live while dragging);
// - Mesh Warp: the Bézier grid with its vertices and, for the selected vertex, its tangent handles (`meshWarp.setVertex`).
import type { RenderDoc } from '@jasper/compositions';
import {
	alphaOutline,
	applyMat3,
	type Command,
	layerMapOf,
	MW_STRIDE,
	meshWarpOf,
	type Pt,
	type ResolvedLayer,
	type ResolvedPuppet,
	resolveSceneAt,
	solvePuppet,
} from '@jasper/project';
import type { EditorSession, TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { toast } from '@jasper/ui';
import { type PointerEvent as ReactPointerEvent, useMemo, useState } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { pointToSequence, sequenceToPoint } from '../fx/PointOverlay.tsx';
import { MONITOR_COLORS } from '../panels/program/monitor.tokens.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';
import { useFocusedEffect, useGestureDrag } from '../tracking/TrackingOverlay.tsx';
import { simWarpUi, useSimWarpUi } from './store.ts';

type Vec2 = [number, number];
const TONE = 'var(--pr-accent)';

/** Layer px → screen px through the layer map. */
const layerToScreen = (layer: ResolvedLayer, view: View, p: Vec2): Vec2 =>
	toScreen(view, applyMat3(layerMapOf(layer.props), p) as Vec2);

// ---------------------------------------------------------------- alpha outlines of images (first Puppet pin)

const outlineCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(url: string): Promise<HTMLImageElement | null> {
	let p = outlineCache.get(url);
	if (!p) {
		p = new Promise((resolve) => {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => resolve(img);
			img.onerror = () => resolve(null);
			img.src = url;
		});
		outlineCache.set(url, p);
	}
	return p;
}

/**
 * The alpha outline (layer-normalised) of the clip's image under `seed` (layer-normalised), or null when the clip is
 * not an image, the image is opaque everywhere (the box mesh is the same) or cannot be read.
 */
export async function imageAlphaOutline(
	doc: RenderDoc,
	layer: ResolvedLayer,
	seed: Vec2,
): Promise<Pt[] | null> {
	const src = layer.clip.source as { mediaId?: string };
	const h = src.mediaId ? doc.media[src.mediaId] : null;
	if (h?.kind !== 'image') return null;
	const img = await loadImage(h.url);
	if (!img) return null;
	try {
		const w = img.naturalWidth;
		const hh = img.naturalHeight;
		const c = document.createElement('canvas');
		c.width = w;
		c.height = hh;
		const ctx = c.getContext('2d', { willReadFrequently: true });
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0);
		return alphaOutline(ctx.getImageData(0, 0, w, hh).data, w, hh, seed);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- overlay

export function SimWarpOverlay(props: ProgramOverlayHostProps) {
	const session = props.session as EditorSession;
	const doc = props.doc as RenderDoc;
	const view = props.view as View;
	const transport = props.transport as TransportStore;
	const { frame, playing } = useOverlayFrame(transport);
	const focused = useFocusedEffect();
	const selected = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const scene = useMemo(() => resolveSceneAt(doc, frame), [doc, frame]);
	const drag = useGestureDrag(session, transport);
	const ui = useSimWarpUi((s) => s);
	const [mwSel, setMwSel] = useState<[number, number] | null>(null);
	const [cursor, setCursor] = useState<Vec2 | null>(null);
	if ((playing && !drag.dragging) || selected.length !== 1 || !focused) return null;
	const layer = scene.find((l) => l.clip.clipId === selected[0]);
	const fx = layer?.props.effects.find((e) => e.id === focused && e.enabled);
	if (!layer || !fx) return null;
	const box = layer.props.box;
	const screenOf = (e: ReactPointerEvent): Vec2 => {
		const rect = (
			(e.currentTarget as SVGElement).ownerSVGElement ?? (e.currentTarget as SVGSVGElement)
		).getBoundingClientRect();
		return [e.clientX - rect.left, e.clientY - rect.top];
	};
	const normAt = (screen: Vec2) => sequenceToPoint(layer, toSequence(view, screen));
	const svgProps = {
		ref: drag.svgRef,
		className: 'pointer-events-none absolute inset-0 h-full w-full touch-none select-none',
	} as const;

	// ---- Puppet
	if (fx.effectId === 'jasper.puppet') {
		const pup = (fx as { puppet?: ResolvedPuppet }).puppet ?? { meshes: [], pins: [] };
		const refine = Math.min(10, Math.max(0, Math.round(Number(fx.params.refinement ?? 20) / 10)));
		const solved = pup.meshes.length ? solvePuppet(pup, box.width, box.height, refine) : [];
		const edges: string[] = [];
		for (const m of solved)
			for (const t of m.geometry.tris) {
				const [a, b, c] = t.map((i) => layerToScreen(layer, view, m.deformed[i] as Vec2));
				edges.push(`M${a![0]},${a![1]}L${b![0]},${b![1]}L${c![0]},${c![1]}Z`);
			}
		// A pin is drawn where its rest point went: its position (moving pins) or the deformed nearest vertex.
		const pinScreen = (pin: ResolvedPuppet['pins'][number]): Vec2 => {
			if (pin.kind === 'position' || pin.kind === 'advanced')
				return layerToScreen(layer, view, [pin.position[0] * box.width, pin.position[1] * box.height]);
			const m = solved.find((s) => s.mesh.id === pin.meshId);
			if (!m) return layerToScreen(layer, view, [pin.rest[0] * box.width, pin.rest[1] * box.height]);
			let best = 0;
			let bd = Number.POSITIVE_INFINITY;
			m.geometry.verts.forEach((v, i) => {
				const d = (v[0] - pin.rest[0] * box.width) ** 2 + (v[1] - pin.rest[1] * box.height) ** 2;
				if (d < bd) {
					bd = d;
					best = i;
				}
			});
			return layerToScreen(layer, view, m.deformed[best] as Vec2);
		};
		const addPin = async (e: ReactPointerEvent) => {
			if (e.button !== 0 || !ui.pinTool) return;
			e.stopPropagation();
			e.preventDefault();
			const at = normAt(screenOf(e));
			if (!at || at[0] < 0 || at[1] < 0 || at[0] > 1 || at[1] > 1) return;
			const inMesh = solved.some((m) =>
				m.geometry.tris.some((t) => {
					const [a, b, c] = t.map((i) => m.geometry.verts[i]!);
					const q: Vec2 = [at[0] * box.width, at[1] * box.height];
					const s1 = (b![0] - a![0]) * (q[1] - a![1]) - (b![1] - a![1]) * (q[0] - a![0]);
					const s2 = (c![0] - b![0]) * (q[1] - b![1]) - (c![1] - b![1]) * (q[0] - b![0]);
					const s3 = (a![0] - c![0]) * (q[1] - c![1]) - (a![1] - c![1]) * (q[0] - c![0]);
					return s1 >= 0 && s2 >= 0 && s3 >= 0;
				}),
			);
			const outline = inMesh ? null : await imageAlphaOutline(doc, layer, at);
			const r = session.apply({
				label: 'Add Puppet Pin',
				origin: 'user',
				commands: [
					{
						type: 'puppet.addPin',
						effectInstanceId: fx.id,
						position: at,
						kind: ui.pinTool,
						...(outline ? { outline } : {}),
					},
				] as never,
			});
			if (!r.ok)
				toast({
					kind: 'error',
					title: 'Puppet Pin',
					detail: r.errors[0]?.message ?? 'Cannot add a pin there',
				});
			else simWarpUi.set({ pins: [(r.results[0] as { pinId: string }).pinId] });
		};
		return (
			<svg {...svgProps} role="presentation" data-testid="puppet-overlay">
				{ui.pinTool ? (
					<rect
						x={0}
						y={0}
						width="100%"
						height="100%"
						fill="transparent"
						pointerEvents="all"
						style={{ cursor: 'crosshair' }}
						onPointerDown={(e) => void addPin(e)}
						data-testid="puppet-tool-target"
					/>
				) : null}
				<path
					d={edges.join('')}
					fill="none"
					stroke={TONE}
					strokeOpacity={0.35}
					strokeWidth={0.75}
					data-testid="puppet-mesh"
				/>
				{pup.pins.map((pin) => {
					const at = pinScreen(pin);
					const sel = ui.pins.includes(pin.id);
					const moves = pin.kind === 'position' || pin.kind === 'advanced';
					const fill =
						pin.kind === 'starch'
							? 'var(--pr-warning)'
							: pin.kind === 'overlap'
								? 'var(--pr-agent)'
								: 'var(--pr-accent)';
					return (
						<g key={pin.id} data-testid={`puppet-pin-handle-${pin.id}`} data-x={at[0]} data-y={at[1]}>
							<circle
								cx={at[0]}
								cy={at[1]}
								r={sel ? 6 : 5}
								fill={fill}
								stroke={MONITOR_COLORS.casing}
								strokeWidth={1.5}
							/>
							<title>{pin.id}</title>
							<circle
								cx={at[0]}
								cy={at[1]}
								r={9}
								fill="transparent"
								pointerEvents="all"
								style={{ cursor: moves ? 'move' : 'pointer' }}
								onPointerDown={(e) => {
									simWarpUi.set({ pins: [pin.id] });
									if (!moves) return;
									const s0 = toSequence(view, screenOf(e));
									const seq0 = applyMat3(layerMapOf(layer.props), [
										pin.position[0] * box.width,
										pin.position[1] * box.height,
									]);
									const off: Vec2 = [seq0[0] - s0[0], seq0[1] - s0[1]];
									drag.start(e, {
										label: 'Move Puppet Pins',
										commandsAt: (screen) => {
											const s = toSequence(view, screen);
											const v = sequenceToPoint(layer, [s[0] + off[0], s[1] + off[1]]);
											return v
												? [
														{
															type: 'puppet.movePins',
															moves: [{ pinId: pin.id, position: v }],
															at: { sequenceFrame: frame },
														} as unknown as Command,
													]
												: null;
										},
									});
								}}
							/>
						</g>
					);
				})}
			</svg>
		);
	}

	// ---- Liquify
	if (fx.effectId === 'jasper.liquify') {
		if (!ui.brush) return null;
		const size = Number(fx.params.brushSize ?? 64);
		const c0 = layerToScreen(layer, view, [0, 0]);
		const c1 = layerToScreen(layer, view, [size / 2, 0]);
		const r = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
		return (
			<svg {...svgProps} role="presentation" data-testid="liquify-overlay">
				<rect
					x={0}
					y={0}
					width="100%"
					height="100%"
					fill="transparent"
					pointerEvents="all"
					style={{ cursor: 'none' }}
					onPointerMove={(e) => setCursor(screenOf(e))}
					onPointerLeave={() => setCursor(null)}
					onPointerDown={(e) => {
						const toLayer = (screen: Vec2): Vec2 | null => {
							const n = normAt(screen);
							return n ? [n[0] * box.width, n[1] * box.height] : null;
						};
						const first = toLayer(screenOf(e));
						if (!first) return;
						const pts: Vec2[] = [first];
						drag.start(e, {
							label: 'Liquify',
							commandsAt: (screen) => {
								setCursor(screen);
								const p = toLayer(screen);
								if (p) pts.push(p);
								return [
									{
										type: 'liquify.stroke',
										effectInstanceId: fx.id,
										points: pts.slice(),
										at: { sequenceFrame: frame },
									} as unknown as Command,
								];
							},
						});
					}}
					data-testid="liquify-brush-target"
				/>
				{cursor ? (
					<circle cx={cursor[0]} cy={cursor[1]} r={r} fill="none" stroke={TONE} strokeWidth={1} />
				) : null}
			</svg>
		);
	}

	// ---- Mesh Warp
	if (fx.effectId === 'jasper.mesh-warp') {
		const cols = Math.min(31, Math.max(1, Math.round(Number(fx.params.columns ?? 7))));
		const rows = Math.min(31, Math.max(1, Math.round(Number(fx.params.rows ?? 7))));
		const m = meshWarpOf(fx.params.distortionMesh, cols, rows);
		const V = (i: number, j: number) => {
			const o = 3 + (j * (cols + 1) + i) * MW_STRIDE;
			return {
				p: [m[o]!, m[o + 1]!] as Vec2,
				l: [m[o + 2]!, m[o + 3]!] as Vec2,
				r: [m[o + 4]!, m[o + 5]!] as Vec2,
				u: [m[o + 6]!, m[o + 7]!] as Vec2,
				d: [m[o + 8]!, m[o + 9]!] as Vec2,
			};
		};
		const S = (n: Vec2) => toScreen(view, pointToSequence(layer, n));
		const bez = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => {
			const pts: string[] = [];
			for (let k = 0; k <= 12; k++) {
				const t = k / 12;
				const s = 1 - t;
				const q = S([
					a[0] * s * s * s + b[0] * 3 * s * s * t + c[0] * 3 * s * t * t + d[0] * t * t * t,
					a[1] * s * s * s + b[1] * 3 * s * s * t + c[1] * 3 * s * t * t + d[1] * t * t * t,
				]);
				pts.push(`${k ? 'L' : 'M'}${q[0]},${q[1]}`);
			}
			return pts.join('');
		};
		const add = (p: Vec2, o: Vec2): Vec2 => [p[0] + o[0], p[1] + o[1]];
		const paths: string[] = [];
		for (let j = 0; j <= rows; j++)
			for (let i = 0; i < cols; i++) {
				const a = V(i, j);
				const b = V(i + 1, j);
				paths.push(bez(a.p, add(a.p, a.r), add(b.p, b.l), b.p));
			}
		for (let i = 0; i <= cols; i++)
			for (let j = 0; j < rows; j++) {
				const a = V(i, j);
				const b = V(i, j + 1);
				paths.push(bez(a.p, add(a.p, a.d), add(b.p, b.u), b.p));
			}
		const handle = (
			key: string,
			n: Vec2,
			onDrag: (v: Vec2) => Record<string, unknown>,
			size = 4,
			round = false,
		) => {
			const at = S(n);
			return (
				<g key={key} data-testid={`mesh-warp-${key}`} data-x={at[0]} data-y={at[1]}>
					{round ? (
						<circle cx={at[0]} cy={at[1]} r={size} fill={MONITOR_COLORS.casing} stroke={TONE} />
					) : (
						<rect
							x={at[0] - size}
							y={at[1] - size}
							width={size * 2}
							height={size * 2}
							fill={MONITOR_COLORS.casing}
							stroke={TONE}
						/>
					)}
					<circle
						cx={at[0]}
						cy={at[1]}
						r={8}
						fill="transparent"
						pointerEvents="all"
						style={{ cursor: 'move' }}
						onPointerDown={(e) => {
							const s0 = toSequence(view, screenOf(e));
							const seq0 = pointToSequence(layer, n);
							const off: Vec2 = [seq0[0] - s0[0], seq0[1] - s0[1]];
							drag.start(e, {
								label: 'Edit Distortion Mesh',
								commandsAt: (screen) => {
									const s = toSequence(view, screen);
									const v = sequenceToPoint(layer, [s[0] + off[0], s[1] + off[1]]);
									return v
										? [
												{
													type: 'meshWarp.setVertex',
													effectInstanceId: fx.id,
													...onDrag(v),
													at: { sequenceFrame: frame },
												} as unknown as Command,
											]
										: null;
								},
							});
						}}
					/>
				</g>
			);
		};
		const sel = mwSel && mwSel[0] <= cols && mwSel[1] <= rows ? mwSel : null;
		return (
			<svg {...svgProps} role="presentation" data-testid="mesh-warp-overlay">
				<path d={paths.join('')} fill="none" stroke={TONE} strokeOpacity={0.6} strokeWidth={1} />
				{sel
					? (['l', 'r', 'u', 'd'] as const).map((k) => {
							const v = V(sel[0], sel[1]);
							const tip = add(v.p, v[k]);
							const a = S(v.p);
							const b = S(tip);
							const name = { l: 'left', r: 'right', u: 'up', d: 'down' }[k];
							return (
								<g key={`t${k}`}>
									<line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={TONE} strokeWidth={1} />
									{handle(
										`tangent-${name}`,
										tip,
										(nv) => ({
											column: sel[0],
											row: sel[1],
											tangents: { [name]: [nv[0] - v.p[0], nv[1] - v.p[1]] },
										}),
										3,
										true,
									)}
								</g>
							);
						})
					: null}
				{Array.from({ length: (cols + 1) * (rows + 1) }, (_, k) => {
					const i = k % (cols + 1);
					const j = Math.floor(k / (cols + 1));
					return (
						<g key={`v${i}-${j}`} onPointerDownCapture={() => setMwSel([i, j])}>
							{handle(`vertex-${i}-${j}`, V(i, j).p, (v) => ({ column: i, row: j, position: v }))}
						</g>
					);
				})}
			</svg>
		);
	}
	return null;
}
