// The Transition section of Effect Controls and Properties (S10:TUI-040/041): type (same medium), duration
// (timecode entry), alignment (disabled for one-sided fades) and an A/B diagram — the outgoing clip "A" and
// the incoming clip "B" with their available handles, the cut line and the span — drawn from the drawn
// document so it follows edits live. The span's edges drag with the timeline's semantics (TUI-012), one
// history entry per drag.
// Transition framework (wave 2): the transition's params (`TransitionSpec.params`: Start / End, the transition's
// own options, Border, Reverse, Anti-aliasing, Center) as rows below the diagram — value editors by type, a
// stopwatch on animatable ones (keys at the playhead, inside the span: `param.set` / `param.setAnimated` on
// ["transition", id, name]), one history entry per edit and one per scrub.
import {
	type Command,
	evaluate,
	flicksPerFrame,
	formatTimecode,
	type ParamSpec,
	type ParamValue,
	type ProjectDocument,
	type RGBA,
	type Sequence,
	TRANSITION_SPECS,
	type Transition,
	type TransitionSpec,
	transitionStartFrame,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState, useTransportFrame } from '@jasper/session/react';
import { TimecodeField } from '@jasper/ui';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { TRANSITION_ALIGNMENTS } from '../effects/transition-prefs.ts';
import { CheckboxField, ColorField, MiniButton, SelectField } from '../properties/controls/fields.tsx';
import { MediaParamPicker } from '../properties/controls/MediaParamPicker.tsx';
import { StopwatchGlyph } from '../properties/controls/glyphs.tsx';
import { ScrubbyNumber } from '../properties/controls/ScrubbyNumber.tsx';
import { useInspectorData } from '../properties/lib/hooks.ts';
import type { InspectorOps } from '../properties/lib/ops.ts';
import { useInspectorOps } from '../properties/lib/ops.ts';
import {
	edgeDrag,
	resizableEdges,
	type TransitionGeom,
	transitionGeom,
} from '../timeline/model/transitions.ts';

const ALIGNMENTS = TRANSITION_ALIGNMENTS.map((a) => a.value);
const ALIGNMENT_LABELS = TRANSITION_ALIGNMENTS.map((a) => a.label);

/** The selected transition of the active sequence (last selected), from the drawn document. */
function useSelectedTransition(): { seq: Sequence; geom: TransitionGeom } | null {
	const data = useInspectorData();
	const ids = useSessionState((s) => s.selection.timeline.transitions);
	const seq = data.selection?.seq;
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
	// Same medium; Premiere's bins first (sorted by bin, then name), third-party packs after.
	const specs = TRANSITION_SPECS.filter((s) => s.appliesTo === medium).sort(
		(a, b) =>
			Number(a.bin.startsWith('Sapphire')) - Number(b.bin.startsWith('Sapphire')) ||
			a.bin.localeCompare(b.bin) ||
			a.label.localeCompare(b.label),
	);
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
				{geom.spec?.expensive ? (
					// Same marker as an expensive effect's section header (EffectControlsPanel).
					<span
						className="text-pr-small text-pr-muted"
						title="Expensive in preview"
						data-testid="transition-expensive"
					>
						●
					</span>
				) : null}
			</header>
			<Row label="Type">
				<SelectField<string>
					value={t.effectId}
					options={specs.map((s) => s.id)}
					labels={specs.map((s) => (s.gpu ? `${s.label} (${s.subBin ?? s.bin})` : s.label))}
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
			{geom.spec && geom.spec.params.length > 0 ? (
				<TransitionParams session={props.session} spec={geom.spec} t={t} seq={seq} span={geom} ops={ops} />
			) : null}
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

// ---------------------------------------------------------------- params (transition framework)

const asNumber = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Param rows of a transition: values at the playhead (keys are relative to the span's first frame). */
function TransitionParams(props: {
	session: EditorSession;
	spec: TransitionSpec;
	t: Transition;
	seq: Sequence;
	span: { start: number; end: number };
	ops: InspectorOps;
}) {
	const { spec, t, seq, ops } = props;
	const data = useInspectorData();
	const frame = useTransportFrame(100).frame;
	const F = flicksPerFrame(seq.settings.frameRate);
	// Keys are stored relative to the stored span start (what the command handler uses).
	const start = transitionStartFrame(seq, t) ?? props.span.start;
	const local = Math.min(t.duration - 1, Math.max(0, frame - start));
	// Writes use the live playhead (the displayed frame is throttled), clamped into the span.
	const liveFrame = () => props.session.transport.getState().frame;
	const inside = () => liveFrame() >= props.span.start && liveFrame() < props.span.end;
	const atNow = () => ({
		sequenceFrame: Math.max(0, start + Math.min(t.duration - 1, Math.max(0, liveFrame() - start))),
	});
	const target = (name: string) => ['transition', t.id, name];
	const paramValue = (p: ParamSpec): ParamValue => {
		const a = t.params[p.name];
		return a ? (evaluate(a as never, local * F) as ParamValue) : p.default;
	};
	const animated = (p: ParamSpec) => (t.params[p.name]?.keyframes.length ?? 0) > 0;
	const set = (p: ParamSpec, value: unknown): Command =>
		({
			type: 'param.set',
			target: target(p.name),
			value,
			...(animated(p) ? { at: atNow() } : {}),
		}) as Command;
	const completion = spec.params.find((x) => x.name === 'completion');
	const commit = (p: ParamSpec, value: unknown) => {
		// Turning Custom Completion on with an unanimated Transition Completion seeds the curve with the linear timing
		// at the span's ends (0 % on the first frame, 100 % on the last) so the user starts from a ramp to shape.
		if (p.name === 'useCompletion' && value === true && completion && !animated(completion)) {
			const key = (frame: number, v: number) =>
				({
					type: 'keyframe.add',
					target: target(completion.name),
					at: { sequenceFrame: Math.max(0, frame) },
					value: v,
				}) as Command;
			return ops.apply(`${spec.label}: ${p.label}`, [
				set(p, value),
				key(start, 0),
				key(start + Math.max(0, t.duration - 1), 100),
			]);
		}
		return ops.apply(`${spec.label}: ${p.label}`, [set(p, value)]);
	};
	return (
		<div className="pt-1" data-testid="transition-params">
			{spec.params.map((p) => (
				<div
					key={p.name}
					className="flex h-[var(--pr-row-h)] items-center gap-1 pr-2 pl-1"
					data-transition-param={p.name}
				>
					<span className="flex w-[18px] shrink-0 justify-center">
						{p.animatable ? (
							<MiniButton
								label={animated(p) ? `Turn off animation of ${p.label}` : `Animate ${p.label}`}
								active={animated(p)}
								onClick={() => {
									if (!animated(p) && !inside()) return;
									ops.apply(`${spec.label}: ${p.label}`, [
										{
											type: 'param.setAnimated',
											target: target(p.name),
											animated: !animated(p),
											at: atNow(),
										} as Command,
									]);
								}}
								data-testid={`transition-param-stopwatch-${p.name}`}
							>
								<StopwatchGlyph size={12} />
							</MiniButton>
						) : null}
					</span>
					<span className="w-[118px] shrink-0 truncate text-pr-muted" title={p.label}>
						{p.label}
					</span>
					<div className="flex min-w-0 flex-1 items-center gap-1">
						<ParamEditor
							doc={data.doc}
							p={p}
							value={paramValue(p)}
							onCommit={(v) => commit(p, v)}
							ops={ops}
							toCommand={(v) => set(p, v)}
							label={`${spec.label}: ${p.label}`}
						/>
					</div>
				</div>
			))}
		</div>
	);
}

function ParamEditor(props: {
	doc: ProjectDocument;
	p: ParamSpec;
	value: ParamValue;
	label: string;
	ops: InspectorOps;
	onCommit(v: unknown): void;
	toCommand(v: unknown): Command;
}) {
	const { p, value, ops } = props;
	const base = useRef<unknown>(null);
	const scrubbable = (get: () => number, put: (n: number) => unknown, testId: string, axis = '') => (
		<ScrubbyNumber
			key={testId}
			value={get()}
			label={`${p.label}${axis}`}
			step={p.range?.step ?? 1}
			unit={p.unit === 'deg' ? '°' : p.unit === '%' ? '%' : p.unit ? ` ${p.unit}` : undefined}
			min={p.range?.min}
			max={p.range?.max}
			onScrubStart={() => {
				base.current = get();
				ops.scrub.start(props.label);
			}}
			onScrub={(delta) => ops.scrub.update([props.toCommand(put(asNumber(base.current) + delta))])}
			onScrubEnd={(cancelled) => ops.scrub.end(cancelled)}
			onCommit={(fn) => props.onCommit(put(fn(get())))}
			data-testid={testId}
		/>
	);
	switch (p.type) {
		case 'number':
			return scrubbable(
				() => asNumber(value),
				(n) => n,
				`transition-param-${p.name}`,
			);
		case 'vec2': {
			const v = Array.isArray(value) ? (value as number[]) : [0, 0];
			return (
				<>
					{scrubbable(
						() => v[0]!,
						(n) => [n, v[1]],
						`transition-param-${p.name}-x`,
						' X',
					)}
					{scrubbable(
						() => v[1]!,
						(n) => [v[0], n],
						`transition-param-${p.name}-y`,
						' Y',
					)}
				</>
			);
		}
		case 'boolean':
			return <CheckboxField value={value === true} label={p.label} onChange={(b) => props.onCommit(b)} />;
		case 'enum':
			return (
				<SelectField<string>
					value={String(value)}
					options={p.options ?? []}
					labels={p.optionLabels ?? p.options}
					label={p.label}
					onChange={(o) => props.onCommit(o)}
					data-testid={`transition-param-${p.name}`}
				/>
			);
		case 'color':
			return (
				<ColorField
					value={Array.isArray(value) ? (value as RGBA) : null}
					label={p.label}
					alpha
					onChange={(c) => props.onCommit(c)}
					data-testid={`transition-param-${p.name}`}
				/>
			);
		case 'media':
			// Image params (Gradient Wipe's custom gradient…): the effects' picture picker; "None" = the built-in fallback.
			return (
				<MediaParamPicker
					doc={props.doc}
					value={value}
					kinds={p.mediaKinds ?? ['image']}
					label={p.label}
					onChange={(mediaId) => props.onCommit({ mediaId })}
					data-testid={`transition-param-${p.name}`}
				/>
			);
		default:
			return <span className="text-pr-small text-pr-muted">—</span>;
	}
}
