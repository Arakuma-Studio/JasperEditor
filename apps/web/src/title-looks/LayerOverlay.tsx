// Spec 19 TL-092: the layer selected in a look's stack, on the Program monitor: an outline with its name, and handles the
// layer's schema declares (`layerHandles`). A handle edit is one gesture and one undo step, written at the playhead like
// any other param. The light has a handle of its own. Selecting draws; nothing here changes the clip selection.
import {
	type Command,
	clipLookUnit,
	GLOBAL_LIGHT_PATH,
	type LayerParams,
	layerHandles,
	type Paint,
	resolveSceneAt,
	titleLayerType,
	withDefaults,
} from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { useMemo } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { MONITOR_COLORS } from '../panels/program/monitor.tokens.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { toScreen, toSequence, type Vec2 } from '../panels/program/viewport.ts';
import { type DragSpec, useGestureDrag } from '../tracking/TrackingOverlay.tsx';
import { LIGHT_TARGET, useLookFocus } from './focus.ts';
import {
	direction,
	edgeAnchor,
	extentAlong,
	type Handle,
	handlePoint,
	handleValues,
	type LookFrame,
	lookFrame,
	outlineQuad,
	type Quad,
	type Sides,
} from './overlay-geometry.ts';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const sides = (r: number | Sides | undefined): Sides =>
	typeof r === 'number' || r === undefined ? { left: r ?? 0, top: r ?? 0, right: r ?? 0, bottom: r ?? 0 } : r;

type ResolvedLayer = { id: string; type: string; params: Record<string, unknown> };

/** Silhouette growth of the layers above this one, percent of the unit (the renderer's `base`). */
function growthAbove(layers: readonly ResolvedLayer[], index: number): number {
	let base = 0;
	for (let i = layers.length - 1; i > index; i--) {
		const def = titleLayerType(layers[i]!.type);
		if (def) base += Math.max(0, num(def.grows?.(withDefaults(def, layers[i]!.params as never))));
	}
	return base;
}

/** The handles of one layer on a frame. */
export function handlesOf(
	f: LookFrame,
	layer: ResolvedLayer,
	base: number,
	light: { angle: number },
): Handle[] {
	const def = titleLayerType(layer.type);
	if (!def) return [];
	const p = withDefaults(def, layer.params as never) as LayerParams & Record<string, unknown>;
	const out: Handle[] = [];
	let edge = 0;
	for (const h of layerHandles(def, p)) {
		const name = h.params[0]!;
		if (h.target === 'light') {
			// The look's light, from the layer that follows it (TL-092 `target: 'light'`).
			out.push({
				kind: 'angle',
				param: name,
				base: 0,
				value: num(light.angle),
				radius: Math.min(f.halfW, f.halfH) * 0.8,
				light: true,
			});
		} else if (h.kind === 'distance' && p.useLight === true && name === 'distance') {
			// A shadow following the light moves along it.
			out.push({ kind: 'axis', param: name, dir: direction(f, light.angle + 180), value: num(p[name]) });
		} else if (h.kind === 'distance') {
			const start = base + (name === 'width' ? num(p.offset) : 0);
			out.push({ kind: 'distance', param: name, ...edgeAnchor(f, edge++), start, value: num(p[name]) });
		} else if (h.kind === 'offset') {
			const [angle, distance] = h.params as readonly [string, string];
			if (p.useLight === true)
				out.push({
					kind: 'axis',
					param: distance,
					dir: direction(f, light.angle + 180),
					value: num(p[distance]),
				});
			else
				out.push({
					kind: 'offset',
					angleParam: angle,
					distanceParam: distance,
					angle: num(p[angle]),
					distance: num(p[distance]),
				});
		} else if (h.kind === 'angle') {
			const paint = name.endsWith('Angle')
				? (p[name.slice(0, -'Angle'.length)] as Paint | undefined)
				: undefined;
			out.push({
				kind: 'angle',
				param: name,
				base: paint?.kind === 'gradient' ? paint.gradient.angle : 0,
				value: num(p[name]),
				radius: Math.min(f.halfW, f.halfH) * 0.8,
			});
		} else {
			const dir = direction(f, 'angle' in p ? num(p.angle) : 90);
			out.push({ kind: 'position', param: name, dir, extent: extentAlong(f, dir), value: num(p[name]) });
		}
	}
	return out;
}

function path(q: Quad, view: ProgramOverlayHostProps['view']): string {
	return `${q.map((p, i) => `${i ? 'L' : 'M'}${toScreen(view, p as Vec2).join(' ')}`).join(' ')} Z`;
}

const handleKey = (h: Handle) =>
	h.kind === 'offset' ? h.distanceParam : h.kind === 'angle' && h.light ? `light-${h.param}` : h.param;

export function LookLayerOverlay(props: ProgramOverlayHostProps) {
	const { session, doc, view, transport } = props;
	const { frame, playing } = useOverlayFrame(transport);
	const focus = useLookFocus();
	const selected = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const seqId = useStoreSelector(session.store, (s) => s.activeSequenceId);
	const on = !!focus && selected.includes(focus.clipId);
	const scene = useMemo(() => (on ? resolveSceneAt(doc, frame) : null), [on, doc, frame]);
	const drag = useGestureDrag(session, transport);
	if (!focus || !scene || (playing && !drag.dragging)) return null;
	const layer = scene.find((l) => l.clip.clipId === focus.clipId);
	const fx = layer?.props.effects.find((e) => e.id === focus.fxId);
	const look = fx?.appearance;
	if (!layer || !fx || !look) return null;
	const box = layer.clip.intrinsicBox;
	const f = lookFrame(layer.props.quad as Quad, box, clipLookUnit(layer.clip));
	const isLight = focus.target === LIGHT_TARGET;
	const index = look.layers.findIndex((l) => l.id === focus.target);
	const target = index >= 0 ? (look.layers[index] as ResolvedLayer) : null;
	if (!isLight && !target) return null;
	const def = target ? titleLayerType(target.type) : undefined;
	const base = target ? growthAbove(look.layers as ResolvedLayer[], index) : 0;
	const reach = def?.reach?.(withDefaults(def, target!.params as never));
	const grown = sides(reach);
	const outline = outlineQuad(f, {
		left: base + grown.left,
		top: base + grown.top,
		right: base + grown.right,
		bottom: base + grown.bottom,
	});
	const name = isLight
		? 'Light'
		: ((
				session.getCommitted().sequences[seqId ?? '']?.clips[focus.clipId] as
					| { effects?: { appearance?: { layers: { id: string; name?: string }[] } }[] }
					| undefined
			)?.effects
				?.flatMap((e) => e.appearance?.layers ?? [])
				.find((l) => l.id === focus.target)?.name ??
			def?.label ??
			target!.type);
	const handles: Handle[] = target
		? handlesOf(f, target, base, look.light)
		: [
				{
					kind: 'angle',
					param: 'angle',
					base: 0,
					value: look.light.angle,
					radius: Math.max(f.halfW, f.halfH) + 24 / Math.max(view.scale, 1e-3),
				},
			];
	const lightPath = (): string[] => {
		const seq = session.getCommitted().sequences[seqId ?? ''];
		const stored = (
			seq?.clips[focus.clipId] as
				| { effects?: { id: string; appearance?: { light?: { source?: string } } }[] }
				| undefined
		)?.effects?.find((e) => e.id === focus.fxId);
		return stored?.appearance?.light?.source === 'sequence'
			? [GLOBAL_LIGHT_PATH, seqId ?? '', 'angle']
			: ['appearance', focus.fxId, 'light', 'angle'];
	};
	const spec = (h: Handle, grab: Vec2): DragSpec => ({
		label: `${name}: ${h.kind === 'offset' ? h.distanceParam : h.param}`,
		commandsAt: (screen) => {
			const s = toSequence(view, screen);
			const values = handleValues(f, h, [s[0] + grab[0], s[1] + grab[1]]);
			return Object.entries(values).map(
				([param, value]) =>
					({
						type: 'param.set',
						target:
							isLight || (h.kind === 'angle' && h.light)
								? lightPath()
								: ['appearance', focus.fxId, focus.target, param],
						value,
						at: { sequenceFrame: frame },
					}) as Command,
			);
		},
	});
	const label = toScreen(view, outline[0] as Vec2);
	const tone = 'var(--pr-accent)';
	const center = toScreen(view, f.center);
	return (
		<svg
			ref={drag.svgRef}
			className="pointer-events-none absolute inset-0 h-full w-full touch-none select-none"
			data-testid="look-layer-overlay"
			data-target={focus.target}
			role="presentation"
		>
			<path d={path(outline, view)} fill="none" stroke={MONITOR_COLORS.casing} strokeWidth={3} />
			<path d={path(outline, view)} fill="none" stroke={tone} strokeWidth={1} strokeDasharray="4 3" />
			<text
				x={label[0]}
				y={label[1] - 6}
				fill={tone}
				fontSize={11}
				paintOrder="stroke"
				stroke={MONITOR_COLORS.casing}
				strokeWidth={3}
				data-testid="look-layer-name"
			>
				{name}
			</text>
			{handles.map((h) => {
				const seqAt = handlePoint(f, h);
				const at = toScreen(view, seqAt);
				const radial = h.kind === 'angle' || h.kind === 'offset' || h.kind === 'axis';
				return (
					<g
						key={`${h.kind}:${handleKey(h)}`}
						data-testid={`look-handle-${handleKey(h)}`}
						data-x={at[0]}
						data-y={at[1]}
					>
						{radial ? (
							<line x1={center[0]} y1={center[1]} x2={at[0]} y2={at[1]} stroke={tone} strokeWidth={1} />
						) : null}
						<circle
							cx={at[0]}
							cy={at[1]}
							r={5}
							fill={MONITOR_COLORS.casing}
							stroke={tone}
							strokeWidth={1.5}
						/>
						<title>{`${name}: ${handleKey(h)}`}</title>
						<circle
							cx={at[0]}
							cy={at[1]}
							r={10}
							fill="transparent"
							pointerEvents="all"
							style={{ cursor: 'crosshair' }}
							onPointerDown={(e) => {
								const rect = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
								const s0 = toSequence(view, [e.clientX - rect.left, e.clientY - rect.top]);
								drag.start(e, spec(h, [seqAt[0] - s0[0], seqAt[1] - s0[1]]));
							}}
						/>
					</g>
				);
			})}
		</svg>
	);
}
