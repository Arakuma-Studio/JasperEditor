// The Transition section of Effect Controls and Properties (S10:TUI-040/041): type (same medium), duration
// (timecode entry), alignment (disabled for one-sided fades) and an A/B diagram — the outgoing clip "A" and
// the incoming clip "B" with their available handles, the cut line and the span — drawn from the drawn
// document so it follows edits live. The span's edges drag with the timeline's semantics (TUI-012), one
// history entry per drag.
import {
	type Command,
	formatTimecode,
	type Sequence,
	TRANSITION_SPECS,
	type Transition,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { TimecodeField } from '@jasper/ui';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { SelectField } from '../properties/controls/fields.tsx';
import { useInspectorData } from '../properties/lib/hooks.ts';
import { useInspectorOps } from '../properties/lib/ops.ts';
import {
	edgeDrag,
	resizableEdges,
	type TransitionGeom,
	transitionGeom,
} from '../timeline/model/transitions.ts';

const ALIGNMENTS: readonly Transition['alignment'][] = ['center', 'start-at-cut', 'end-at-cut'];
const ALIGNMENT_LABELS = ['Center at Cut', 'Start at Cut', 'End at Cut'];

/** The selected transition of the active sequence (last selected), from the drawn document. */
export function useSelectedTransition(): { seq: Sequence; geom: TransitionGeom } | null {
	const data = useInspectorData();
	const ids = useSessionState((s) => s.selection.timeline.transitions);
	const seqId = data.activeSequenceId;
	const seq = seqId ? (data.doc.sequences[seqId] as Sequence | undefined) : undefined;
	if (!seq) return null;
	for (let i = ids.length - 1; i >= 0; i--) {
		const t = seq.transitions[ids[i]!];
		if (!t) continue;
		const geom = transitionGeom(seq, data.doc.media, t);
		if (geom) return { seq, geom };
	}
	return null;
}

export function TransitionSection(props: { session: EditorSession; host: 'effectControls' | 'properties' }) {
	const sel = useSelectedTransition();
	const ops = useInspectorOps(props.session);
	if (!sel) return null;
	const { seq, geom } = sel;
	const t = geom.t;
	const rate = seq.settings.frameRate;
	const dropFrame = seq.settings.dropFrame;
	const medium = geom.spec?.appliesTo ?? 'video';
	const specs = TRANSITION_SPECS.filter((s) => s.appliesTo === medium);
	const update = (label: string, patch: Record<string, unknown>) =>
		ops.apply(label, [{ type: 'transition.update', transitionId: t.id, ...patch } as Command]);
	const n = geom.duration || t.duration;
	return (
		<section
			className="border-b border-pr-border-subtle pb-2"
			data-testid="transition-section"
			data-inspected-transition={t.id}
			data-host={props.host}
		>
			<header className="flex h-[28px] items-center gap-1 px-2 font-semibold text-pr-strong">
				<span className="truncate">Transition</span>
				<span className="truncate font-normal text-pr-muted">· {geom.spec?.label ?? t.effectId}</span>
			</header>
			<Row label="Type">
				<SelectField<string>
					value={t.effectId}
					options={specs.map((s) => s.id)}
					labels={specs.map((s) => s.label)}
					label="Transition type"
					onChange={(effectId) => update('Replace Transition', { effectId })}
					data-testid="transition-type"
				/>
			</Row>
			<Row label="Duration">
				<span className="flex items-center gap-1" data-testid="transition-duration">
					<TimecodeField
						frame={n}
						rate={rate}
						dropFrame={dropFrame}
						label="Transition duration"
						tone="primary"
						onCommit={(f) => {
							if (f > 0) update('Transition Duration', { duration: f });
						}}
					/>
					<span className="text-pr-small text-pr-muted">({n} frames)</span>
				</span>
			</Row>
			{geom.duration > 0 && geom.duration < t.duration ? (
				<p className="px-2 text-pr-small text-pr-warning">
					Shortened from {t.duration} frames: limited by media handles
				</p>
			) : null}
			<Row label="Alignment">
				<SelectField<Transition['alignment']>
					value={t.alignment}
					options={ALIGNMENTS}
					labels={ALIGNMENT_LABELS}
					label="Transition alignment"
					disabled={!!geom.oneSided}
					onChange={(alignment) => update('Transition Alignment', { alignment })}
					data-testid="transition-alignment"
				/>
			</Row>
			<AbDiagram session={props.session} geom={geom} seq={seq} />
		</section>
	);
}

function Row(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex h-[var(--pr-row-h)] items-center gap-2 pr-2 pl-4">
			<span className="w-[72px] shrink-0 text-pr-muted">{props.label}</span>
			<div className="flex min-w-0 flex-1 items-center">{props.children}</div>
		</div>
	);
}

const fin = (n: number, cap: number) => (Number.isFinite(n) ? n : cap);

/** A/B diagram with draggable span edges (TUI-040/041). */
function AbDiagram(props: { session: EditorSession; geom: TransitionGeom; seq: Sequence }) {
	const { geom: g, seq } = props;
	const ops = useInspectorOps(props.session);
	const ref = useRef<HTMLDivElement>(null);
	const [tip, setTip] = useState<string | null>(null);
	const d = Math.max(1, g.end - g.start);
	const pad = Math.max(d, 10);
	const lo = g.start - pad;
	const hi = g.end + pad;
	const pct = (f: number) => `${((Math.min(hi, Math.max(lo, f)) - lo) / (hi - lo)) * 100}%`;
	const width = (a: number, b: number) =>
		`${((Math.min(hi, Math.max(lo, b)) - Math.min(hi, Math.max(lo, a))) / (hi - lo)) * 100}%`;
	const rate = seq.settings.frameRate;
	const edges = resizableEdges(g);

	const onEdgeDown = (edge: 'start' | 'end') => (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || !ref.current) return;
		e.preventDefault();
		e.stopPropagation();
		const box = ref.current.getBoundingClientRect();
		const g0 = g;
		const framesPerPx = (hi - lo) / Math.max(1, box.width);
		const x0 = e.clientX;
		const edge0 = edge === 'start' ? g0.start : g0.end;
		let changed = false;
		let active = false;
		const move = (ev: PointerEvent) => {
			const frame = edge0 + Math.round((ev.clientX - x0) * framesPerPx);
			if (!active) {
				if (Math.abs(ev.clientX - x0) < 2) return;
				if (!ops.scrub.start('Transition Duration')) return;
				active = true;
			}
			const want = edgeDrag(g0, edge, frame, ev.altKey);
			const r = ops.scrub.update([
				{
					type: 'transition.update',
					transitionId: g0.t.id,
					duration: want.duration,
					alignment: want.alignment,
				} as Command,
			]);
			if (r?.ok) {
				const res = r.results[0] as { duration: number; alignment: string };
				changed = res.duration !== g0.t.duration || res.alignment !== g0.t.alignment;
				const clamped = r.warnings.some((w) => w.code === 'W_TRANSITION_SHORTENED');
				setTip(
					`Duration ${formatTimecode(res.duration, rate, { dropFrame: seq.settings.dropFrame })} (${res.duration})${clamped ? ' · Limited by media handles' : ''}`,
				);
			}
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('keydown', key, true);
			if (active) ops.scrub.end(!changed);
			setTip(null);
		};
		const key = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape') return;
			changed = false;
			up();
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('keydown', key, true);
	};

	const out = g.outgoing;
	const inc = g.incoming;
	return (
		<div className="px-4 pt-1">
			<div
				ref={ref}
				className="relative h-[58px] overflow-hidden rounded-pr-control bg-pr-field-deep"
				data-testid="transition-diagram"
			>
				<div
					className="pointer-events-none absolute top-0 bottom-0"
					style={{
						left: pct(g.start),
						width: width(g.start, g.end),
						background: 'var(--pr-transition-selected-fill)',
					}}
				/>
				{out ? (
					<>
						<Bar top={6} left={pct(out.start)} width={width(out.start, g.cut)} solid label="A" />
						<Bar
							top={6}
							left={pct(g.cut)}
							width={width(g.cut, g.cut + fin(g.handles.tail, hi - g.cut))}
							data-testid="transition-handle-a"
						/>
					</>
				) : null}
				{inc ? (
					<>
						<Bar
							top={32}
							left={pct(g.cut - fin(g.handles.head, g.cut - lo))}
							width={width(g.cut - fin(g.handles.head, g.cut - lo), g.cut)}
							data-testid="transition-handle-b"
						/>
						<Bar
							top={32}
							left={pct(g.cut)}
							width={width(g.cut, inc.start + inc.duration)}
							solid
							label="B"
							labelEnd
						/>
					</>
				) : null}
				<div
					className="absolute top-0 bottom-0"
					style={{
						left: pct(g.start),
						width: width(g.start, g.end),
						boxShadow: 'inset 0 0 0 1px var(--pr-transition-selected)',
					}}
					data-testid="transition-span"
				>
					{edges.start ? (
						<div
							className="absolute top-0 bottom-0 left-[-3px] w-[7px] cursor-ew-resize"
							onPointerDown={onEdgeDown('start')}
							data-testid="transition-edge-start"
						/>
					) : null}
					{edges.end ? (
						<div
							className="absolute top-0 right-[-3px] bottom-0 w-[7px] cursor-ew-resize"
							onPointerDown={onEdgeDown('end')}
							data-testid="transition-edge-end"
						/>
					) : null}
				</div>
				<div
					className="pointer-events-none absolute top-0 bottom-0 w-px"
					style={{ left: pct(g.cut), background: 'var(--pr-text-strong)' }}
					data-testid="transition-cut"
				/>
			</div>
			<p className="h-[16px] text-pr-small text-pr-muted" data-testid="transition-diagram-tip">
				{tip ??
					(g.oneSided
						? g.oneSided === 'in'
							? 'Fade in at the head of B'
							: 'Fade out at the tail of A'
						: `Handles: A ${fmt(g.handles.tail)} after its out-point · B ${fmt(g.handles.head)} before its in-point`)}
			</p>
		</div>
	);
}

const fmt = (n: number) => (Number.isFinite(n) ? `${n} f` : 'unlimited');

function Bar(props: {
	top: number;
	left: string;
	width: string;
	solid?: boolean;
	label?: string;
	labelEnd?: boolean;
	'data-testid'?: string;
}) {
	return (
		<div
			className={`absolute flex h-[20px] items-center overflow-hidden rounded-[2px] px-1 text-[10px] font-semibold text-pr-strong ${props.labelEnd ? 'justify-end' : ''}`}
			style={{
				top: props.top,
				left: props.left,
				width: props.width,
				background: props.solid ? 'var(--pr-bg-panel-raised)' : 'var(--pr-transition-handle-band)',
				boxShadow: props.solid
					? 'inset 0 0 0 1px var(--pr-border-strong)'
					: 'inset 0 0 0 1px var(--pr-border-subtle)',
			}}
			data-testid={props['data-testid']}
		>
			{props.label}
		</div>
	);
}
