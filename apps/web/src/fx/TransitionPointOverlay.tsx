// On-canvas point handles of GPU transitions (wave-4 transition polish): while a transition is selected in the
// Timeline (it is then what Effect Controls' Transition section shows), every point param of its type — `vec2` with
// `ui.control: 'point'`: Center, Swish3D's / WhipLash's centres, MochaWhip's mask and cut-out centres… — is drawn as
// the effects' crosshair (apps/web/src/fx/PointOverlay.tsx) in the Program monitor. Transition points are normalised
// to the FRAME ([0,0] top-left … [1,1]; the stage is frame space), so no layer map is involved. Dragging is ONE
// gesture that writes the param (`param.set` on ["transition", id, name]); an animated param gets a key at the
// playhead clamped into the span, exactly what the Transition section's rows write.
import {
	type Command,
	evaluate,
	flicksPerFrame,
	type ProjectDocument,
	type Rational,
	type Sequence,
	type Transition,
	type TransitionSpec,
	transitionSpec,
	transitionStartFrame,
} from '@jasper/project';
import type { EditorSession, TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { MONITOR_COLORS } from '../panels/program/monitor.tokens.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';
import { type DragSpec, useGestureDrag } from '../tracking/TrackingOverlay.tsx';
import { pointParams } from './PointOverlay.tsx';

type Vec2 = [number, number];

/** The selected transition (last selected) of the active sequence with its type, or null. */
function selectedTransition(
	doc: ProjectDocument,
	seqId: string | null,
	ids: readonly string[],
): { seq: Sequence; t: Transition; spec: TransitionSpec } | null {
	const seq = seqId ? doc.sequences[seqId] : undefined;
	if (!seq) return null;
	for (let i = ids.length - 1; i >= 0; i--) {
		const t = seq.transitions[ids[i]!];
		const spec = t ? transitionSpec(t.effectId) : null;
		if (t && spec) return { seq, t, spec };
	}
	return null;
}

/** Frame-normalised point → sequence px, and back (rounded like the effects' handles). */
export const framePointToSequence = (seq: Pick<Sequence, 'settings'>, n: Vec2): Vec2 => [
	n[0] * seq.settings.width,
	n[1] * seq.settings.height,
];
export function sequenceToFramePoint(seq: Pick<Sequence, 'settings'>, s: Vec2): Vec2 {
	const r = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
	return [r(s[0] / Math.max(1, seq.settings.width)), r(s[1] / Math.max(1, seq.settings.height))];
}

export function TransitionPointOverlay(props: ProgramOverlayHostProps) {
	const session = props.session as EditorSession;
	const view = props.view as View;
	const transport = props.transport as TransportStore;
	const { frame, playing } = useOverlayFrame(transport);
	const doc = useStoreSelector(session.store, (s) => s.transient ?? s.document);
	const seqId = useStoreSelector(session.store, (s) => s.activeSequenceId);
	const ids = useStoreSelector(session.store, (s) => s.selection.timeline.transitions);
	const drag = useGestureDrag(session, transport);
	if (playing && !drag.dragging) return null;
	const sel = selectedTransition(doc, seqId, ids);
	const points = sel && sel.spec.appliesTo === 'video' ? pointParams(sel.spec.params) : [];
	if (!sel || points.length === 0) return null;
	const { seq, t, spec } = sel;
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	const start = transitionStartFrame(seq, t) ?? 0;
	const local = Math.min(t.duration - 1, Math.max(0, frame - start));
	const tone = 'var(--pr-accent)';
	return (
		<svg
			ref={drag.svgRef}
			className="pointer-events-none absolute inset-0 h-full w-full touch-none select-none"
			data-testid="transition-point-overlay"
			data-transition-id={t.id}
			role="presentation"
		>
			{points.map((p) => {
				const a = t.params[p.name];
				const v = a ? evaluate(a as never, local * F) : p.default;
				const n: Vec2 = Array.isArray(v) && v.length === 2 ? (v as Vec2) : (p.default as Vec2);
				const seqPx = framePointToSequence(seq, n);
				const at = toScreen(view, seqPx);
				const animated = (a?.keyframes.length ?? 0) > 0;
				const dragSpec = (off: Vec2): DragSpec => ({
					label: `${spec.label}: ${p.label}`,
					commandsAt: (screen) => {
						const s = toSequence(view, screen);
						const value = sequenceToFramePoint(seq, [s[0] + off[0], s[1] + off[1]]);
						// Keys of an animated param at the playhead, clamped into the span (as the Transition section).
						const live = transport.getState().frame;
						const keyFrame = start + Math.min(t.duration - 1, Math.max(0, live - start));
						return [
							{
								type: 'param.set',
								target: ['transition', t.id, p.name],
								value,
								...(animated ? { at: { sequenceFrame: Math.max(0, keyFrame) } } : {}),
							} as Command,
						];
					},
				});
				return (
					<g key={p.name} data-testid={`transition-point-${p.name}`} data-x={at[0]} data-y={at[1]}>
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
								drag.start(e, dragSpec([seqPx[0] - s0[0], seqPx[1] - s0[1]]));
							}}
						/>
					</g>
				);
			})}
		</svg>
	);
}
