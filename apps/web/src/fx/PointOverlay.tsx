import type { Vec2 } from '@jasper/project';
import { type Command, type ParamSpec, resolveSceneAt } from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { useMemo } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { MONITOR_COLORS } from '../panels/program/monitor.tokens.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { toScreen, toSequence } from '../panels/program/viewport.ts';
import { type DragSpec, useFocusedEffect, useGestureDrag } from '../tracking/TrackingOverlay.tsx';
import { pointToSequence, sequenceToPoint } from './point-map.ts';

/** Point params of an effect spec (vec2 with `ui.control: 'point'`). */
export function pointParams(params: readonly ParamSpec[]): ParamSpec[] {
	return params.filter((p) => p.type === 'vec2' && p.ui?.control === 'point');
}

// The point ↔ sequence mapping lives in `point-map.ts` (shared with the Program monitor's effect-point motion paths).
export { pointToSequence, sequenceToPoint } from './point-map.ts';

export function FxPointOverlay(props: ProgramOverlayHostProps) {
	const session = props.session;
	const doc = props.doc;
	const view = props.view;
	const transport = props.transport;
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
