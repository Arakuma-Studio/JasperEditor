// Spec 19 TL-092: the layer selected in a look's stack, on the Program monitor: an outline with its name, and handles the
// layer's schema declares (`layerHandles`). A handle edit is one gesture and one undo step, written at the playhead like
// any other param. The light has a handle of its own. Selecting draws; nothing here changes the clip selection.
import {
	type Command,
	clipLookUnit,
	GLOBAL_LIGHT_PATH,
	type LayerHandle,
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
import { t } from '../i18n/runtime.ts';
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

/**
 * Silhouette growth under this layer, percent of the unit (the renderer's `s.base`): the layers above it in the stack, or
 * every other layer for one that starts from the whole look's silhouette (`outermost`: a reflection, Deep Glow).
 */
export function growthAbove(layers: readonly ResolvedLayer[], index: number): number {
	const own = titleLayerType(layers[index]?.type ?? '');
	let base = 0;
	for (let i = layers.length - 1; i >= 0; i--) {
		if (i === index || (i < index && !own?.outermost)) continue;
		const def = titleLayerType(layers[i]!.type);
		if (def) base += Math.max(0, num(def.grows?.(withDefaults(def, layers[i]!.params as never))));
	}
	return base;
}

/** Where a declared line points (`LayerHandle.along`): an angle param or a gradient paint's direction, plus a turn. */
function alongDeg(h: LayerHandle, p: Record<string, unknown>, fallback: number): number {
	const turn = h.along?.turn ?? 0;
	if (h.along?.paint) {
		const paint = p[h.along.paint] as Paint | undefined;
		const g = paint?.kind === 'gradient' ? paint.gradient.angle : 0;
		return g + num(p[`${h.along.paint}Angle`]) + turn;
	}
	const name = h.along?.param ?? 'angle';
	return (name in p ? num(p[name]) : fallback) + turn;
}

/** The handles of one layer on a frame, placed where the layer type declares them (`LayerHandle`). */
export function handlesOf(
	f: LookFrame,
	layer: ResolvedLayer,
	base: number,
	light: { angle: number },
	/** Radius of the light's ring, sequence px: outside the box, clear of the clip's own handles (the Light row's ring). */
	lightRing = Math.max(f.halfW, f.halfH) * 1.15,
): Handle[] {
	const def = titleLayerType(layer.type);
	if (!def) return [];
	const p = withDefaults(def, layer.params as never) as LayerParams & Record<string, unknown>;
	/** A drag stops at the param's range (a reflection's gap goes below 0, a rim's width does not). */
	const limits = (name: string): { min?: number; max?: number } => {
		const spec = def.params.find((x) => x.name === name);
		const range =
			spec && 'range' in spec ? (spec.range as { min?: number; max?: number } | undefined) : undefined;
		return {
			...(range?.min !== undefined ? { min: range.min } : {}),
			...(range?.max !== undefined ? { max: range.max } : {}),
		};
	};
	const ring = Math.min(f.halfW, f.halfH) * 0.8;
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
				radius: lightRing,
				light: true,
			});
		} else if (h.kind === 'distance' && p.useLight === true && name === 'distance') {
			// A shadow following the light moves along it.
			out.push({
				kind: 'axis',
				param: name,
				dir: direction(f, light.angle + 180),
				value: num(p[name]),
				...limits(name),
			});
		} else if (h.kind === 'distance') {
			const from = h.from ?? 'edge';
			const before = (h.after ?? []).reduce((sum, a) => sum + num(p[a]), 0);
			// One place per declaration; its params chain from there (an inline's inset, then its width).
			let at: { anchor: Vec2; dir: Vec2 };
			let start = before;
			if (from === 'edge') {
				at = edgeAnchor(f, edge++);
				start += base;
			} else if (from === 'inside') {
				const e = edgeAnchor(f, edge++);
				at = { anchor: e.anchor, dir: [0 - e.dir[0], 0 - e.dir[1]] };
			} else if (from === 'below') {
				at = { anchor: [f.center[0] + f.v[0] * f.halfH, f.center[1] + f.v[1] * f.halfH], dir: f.v };
				start += base;
			} else if (from === 'corner') {
				// The top-left corner of the box grown by the growth and what comes before (a plate's Grow), along its top.
				const g = (base + before) * f.perPercent;
				at = {
					anchor: [
						f.center[0] - f.u[0] * (f.halfW + g) - f.v[0] * (f.halfH + g),
						f.center[1] - f.u[1] * (f.halfW + g) - f.v[1] * (f.halfH + g),
					],
					dir: f.u,
				};
				start = 0;
			} else {
				const dir = direction(f, alongDeg(h, p, 0));
				// `band`: from the centre of this layer's band, at its `position` along the same line.
				const t0 = from === 'band' ? (num(p.position) * 0.02 - 1) * extentAlong(f, dir) : 0;
				at = { anchor: [f.center[0] + dir[0] * t0, f.center[1] + dir[1] * t0], dir };
			}
			for (const param of h.params) {
				const value = num(p[param]);
				out.push({ kind: 'distance', param, ...at, start, value, ...limits(param) });
				start += value;
			}
		} else if (h.kind === 'offset') {
			const [angle, distance] = h.params as readonly [string, string];
			if (p.useLight === true)
				out.push({
					kind: 'axis',
					param: distance,
					dir: direction(f, light.angle + 180),
					value: num(p[distance]),
					...limits(distance),
				});
			else
				out.push({
					kind: 'offset',
					angleParam: angle,
					distanceParam: distance,
					angle: num(p[angle]),
					distance: num(p[distance]),
					...limits(distance),
				});
		} else if (h.kind === 'angle') {
			const paint = name.endsWith('Angle')
				? (p[name.slice(0, -'Angle'.length)] as Paint | undefined)
				: undefined;
			out.push({
				kind: 'angle',
				param: name,
				base: (paint?.kind === 'gradient' ? paint.gradient.angle : 0) + (h.along?.turn ?? 0),
				value: num(p[name]),
				radius: ring,
				...limits(name),
			});
		} else {
			const dir = direction(f, alongDeg(h, p, 90));
			const ext = extentAlong(f, dir);
			// `{ band }`: ±100 % carries the band's centre from fully before the bounds to fully past them.
			const band = typeof h.range === 'object' ? num(p[h.range.band]) * f.perPercent * 0.5 : null;
			out.push({
				kind: 'position',
				param: name,
				dir,
				extent: band === null ? ext : Math.max(1, ext) + band,
				value: num(p[name]),
				...(band === null ? {} : { map: 'centred' as const }),
				...limits(name),
			});
		}
	}
	return out;
}

/** What a handle edits, in words: its param's label (or the light's angle). */
function handleLabel(def: ReturnType<typeof titleLayerType>, h: Handle): string {
	if (h.kind === 'angle' && h.light) return t('Light Angle');
	const param = h.kind === 'offset' ? h.distanceParam : h.param;
	const spec = def?.params.find((x) => x.name === param);
	return spec ? t(spec.label) : param;
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
		? t('Light')
		: ((
				session.getCommitted().sequences[seqId ?? '']?.clips[focus.clipId] as
					| { effects?: { appearance?: { layers: { id: string; name?: string }[] } }[] }
					| undefined
			)?.effects
				?.flatMap((e) => e.appearance?.layers ?? [])
				.find((l) => l.id === focus.target)?.name ??
			(def ? t(def.label) : undefined) ??
			target!.type);
	const lightRing = Math.max(f.halfW, f.halfH) + 24 / Math.max(view.scale, 1e-3);
	const handles: Handle[] = target
		? handlesOf(f, target, base, look.light, lightRing)
		: [
				{
					kind: 'angle',
					param: 'angle',
					base: 0,
					value: look.light.angle,
					radius: lightRing,
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
		label: `${name}: ${isLight ? t('Light Angle') : handleLabel(def, h)}`,
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
						<title>{`${name}: ${isLight ? t('Light Angle') : handleLabel(def, h)}`}</title>
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
