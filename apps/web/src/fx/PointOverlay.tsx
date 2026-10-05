// On-canvas point handles of GPU effects (wave-1 fx framework): for the one selected clip, every `vec2` param with
// `ui.control: 'point'` (normalised to the layer box, e.g. a lens-flare centre) of the effect focused in Effect
// Controls is drawn as a crosshair in the Program monitor through the layer map (Motion, corner pin); dragging it is
// ONE gesture that writes the param at the playhead (a keyframe when the param is animated), like the corner pin.
import type { RenderDoc } from '@jasper/compositions';
import {
	applyMat3,
	type Command,
	invertMat3,
	layerMapOf,
	type ParamSpec,
	type ResolvedLayer,
	resolveSceneAt,
} from '@jasper/project';
import type { EditorSession, TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { useMemo } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { MONITOR_COLORS } from '../panels/program/monitor.tokens.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';
import { type DragSpec, useFocusedEffect, useGestureDrag } from '../tracking/TrackingOverlay.tsx';

type Vec2 = [number, number];

/** Point params of an effect spec (vec2 with `ui.control: 'point'`). */
export function pointParams(params: readonly ParamSpec[]): ParamSpec[] {
	return params.filter((p) => p.type === 'vec2' && p.ui?.control === 'point');
}

/** A normalised point of a layer → sequence pixels (through the full layer map). */
export function pointToSequence(layer: Pick<ResolvedLayer, 'props'>, n: Vec2): Vec2 {
	const { box } = layer.props;
	return applyMat3(layerMapOf(layer.props), [n[0] * box.width, n[1] * box.height]) as Vec2;
}

/** Sequence pixels → the normalised point of a layer (null when the layer map is singular). */
export function sequenceToPoint(layer: Pick<ResolvedLayer, 'props'>, s: Vec2): Vec2 | null {
	const inv = invertMat3(layerMapOf(layer.props));
	if (!inv) return null;
	const { box } = layer.props;
	const p = applyMat3(inv, s);
	const r = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
	return [r(p[0] / box.width), r(p[1] / box.height)];
}

export function FxPointOverlay(props: ProgramOverlayHostProps) {
	const session = props.session as EditorSession;
	const doc = props.doc as RenderDoc;
	const view = props.view as View;
	const transport = props.transport as TransportStore;
	const { frame, playing } = useOverlayFrame(transport);
	const focused = useFocusedEffect();
	const selected = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const scene = useMemo(() => resolveSceneAt(doc, frame), [doc, frame]);
	const drag = useGestureDrag(session, transport);
	if ((playing && !drag.dragging) || selected.length !== 1 || !focused) return null;
	const layer = scene.find((l) => l.clip.clipId === selected[0]);
	const fx = layer?.props.effects.find((e) => e.id === focused && e.enabled);
	const spec = fx ? session.ctx.registries.effects.get(fx.effectId, fx.effectVersion) : undefined;
	const points = spec ? pointParams(spec.params) : [];
	if (!layer || !fx || !spec || points.length === 0) return null;
	const tone = 'var(--pr-accent)';
	return (
		<svg
			ref={drag.svgRef}
			className="pointer-events-none absolute inset-0 h-full w-full touch-none select-none"
			data-testid="fx-point-overlay"
			role="presentation"
		>
			{points.map((p) => {
				const v = fx.params[p.name];
				const n: Vec2 = Array.isArray(v) && v.length === 2 ? (v as Vec2) : (p.default as Vec2);
				const seq = pointToSequence(layer, n);
				const at = toScreen(view, seq);
				const dragSpec = (off: Vec2): DragSpec => ({
					label: p.label,
					commandsAt: (screen) => {
						const s = toSequence(view, screen);
						const value = sequenceToPoint(layer, [s[0] + off[0], s[1] + off[1]]);
						return value
							? [
									{
										type: 'param.set',
										target: ['effect', fx.id, p.name],
										value,
										at: { sequenceFrame: frame },
									} as Command,
								]
							: null;
					},
				});
				return (
					<g key={p.name} data-testid={`fx-point-${p.name}`} data-x={at[0]} data-y={at[1]}>
						<circle cx={at[0]} cy={at[1]} r={6} fill="none" stroke={MONITOR_COLORS.casing} strokeWidth={3} />
						<circle cx={at[0]} cy={at[1]} r={6} fill="none" stroke={tone} strokeWidth={1.25} />
						<line x1={at[0] - 9} x2={at[0] + 9} y1={at[1]} y2={at[1]} stroke={tone} strokeWidth={1} />
						<line x1={at[0]} x2={at[0]} y1={at[1] - 9} y2={at[1] + 9} stroke={tone} strokeWidth={1} />
						<title>{`${spec.label}: ${p.label}`}</title>
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
								drag.start(e, dragSpec([seq[0] - s0[0], seq[1] - s0[1]]));
							}}
						/>
					</g>
				);
			})}
		</svg>
	);
}
