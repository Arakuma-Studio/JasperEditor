// Effect Controls mask UI (wp masks; Premiere: the mask tools under Opacity and every effect, then one twirl per mask
// with its mode, Inverted, tracking controls and the Mask Path / Feather / Opacity / Expansion rows). The property
// rows themselves are ordinary inspector rows (stopwatch, keyframes, graphs) drawn by the panel; this file draws the
// tool row and the mask header rows.
import {
	MASK_MODE_LABELS,
	MASK_MODES,
	MASK_TRACK_METHOD_LABELS,
	MASK_TRACK_METHODS,
	type Mask,
	type MaskMode,
	type MaskTrackMethod,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx, toast } from '@jasper/ui';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { CheckboxField, MiniButton, SelectField, TextField } from '../panels/properties/controls/fields.tsx';
import { CaretGlyph, TrashGlyph } from '../panels/properties/controls/glyphs.tsx';
import { inspectorFocus } from '../panels/properties/lib/focus.ts';
import {
	autoTrace,
	createMask,
	DEFAULT_TRACE,
	deleteMasks,
	type MaskEngine,
	startPen,
	stopMaskTrack,
	stopPen,
	type TraceOptions,
	trackMask,
} from './actions.ts';
import { type MaskOwner, maskUi, useMaskUi } from './store.ts';

const g = (d: ReactNode) => (
	<svg
		width={13}
		height={13}
		viewBox="0 0 13 13"
		fill="none"
		stroke="currentColor"
		strokeWidth={1.2}
		aria-hidden="true"
	>
		{d}
	</svg>
);
export const EllipseGlyph = () => g(<ellipse cx={6.5} cy={6.5} rx={5} ry={4} />);
export const PolygonGlyph = () => g(<rect x={2} y={2.5} width={9} height={8} />);
export const PenGlyph = () =>
	g(
		<>
			<path d="M2 11 L4 6 L8 2 L11 5 L7 9 Z" />
			<circle cx={6.3} cy={6.7} r={0.9} />
		</>,
	);
const TraceGlyph = () =>
	g(
		<>
			<path d="M2 9 C3 3 6 2 8 4 C10 6 11 8 10 11" strokeDasharray="1.5 1.2" />
			<circle cx={2} cy={9} r={1} />
		</>,
	);
const BackAll = () =>
	g(<path d="M11 2 L6 6.5 L11 11 Z M6 2 L1 6.5 L6 11 Z" fill="currentColor" stroke="none" />);
const BackOne = () => g(<path d="M10 2 L4 6.5 L10 11 Z M2.5 2 V11" fill="currentColor" />);
const FwdOne = () => g(<path d="M3 2 L9 6.5 L3 11 Z M10.5 2 V11" fill="currentColor" />);
const FwdAll = () =>
	g(<path d="M2 2 L7 6.5 L2 11 Z M7 2 L12 6.5 L7 11 Z" fill="currentColor" stroke="none" />);

type Layout = { left: CSSProperties; lane(children: ReactNode): ReactNode };

/** The tool row of a section: Create ellipse / 4-point polygon mask, free draw Bézier (pen), auto-trace. */
export function MaskToolsRow(props: {
	session: EditorSession;
	engine: MaskEngine | null;
	owner: MaskOwner;
	canTrace: boolean;
	readOnly: boolean;
	layout: Layout;
}) {
	const { session, owner, layout } = props;
	const pen = useMaskUi((s) => s.pen);
	const penOn = !!pen && pen.clipId === owner.clipId && pen.effectId === owner.effectId;
	const [trace, setTrace] = useState<TraceOptions | null>(null);
	const id = owner.effectId ?? `${owner.clipId}:opacity`;
	return (
		<>
			<div className="flex items-stretch" data-testid={`mask-tools-${id}`}>
				<div style={layout.left} className="flex h-[var(--pr-row-h)] shrink-0 items-center gap-1 pl-6">
					<MiniButton
						label="Create ellipse mask"
						disabled={props.readOnly}
						onClick={() => createMask(session, owner, 'ellipse')}
						data-testid={`mask-ellipse-${id}`}
					>
						<EllipseGlyph />
					</MiniButton>
					<MiniButton
						label="Create 4-point polygon mask"
						disabled={props.readOnly}
						onClick={() => createMask(session, owner, 'polygon')}
						data-testid={`mask-polygon-${id}`}
					>
						<PolygonGlyph />
					</MiniButton>
					<MiniButton
						label={penOn ? 'Stop drawing (Esc)' : 'Free draw bezier (click to add points, drag for curves)'}
						active={penOn}
						disabled={props.readOnly}
						onClick={() => (penOn ? stopPen() : startPen(owner))}
						data-testid={`mask-pen-${id}`}
					>
						<PenGlyph />
					</MiniButton>
					{props.canTrace ? (
						<MiniButton
							label="Auto-trace masks from the picture…"
							active={!!trace}
							disabled={props.readOnly || !props.engine}
							onClick={() => setTrace(trace ? null : { ...DEFAULT_TRACE })}
							data-testid={`mask-trace-${id}`}
						>
							<TraceGlyph />
						</MiniButton>
					) : null}
					{penOn ? (
						<span className="truncate text-pr-small text-pr-accent">Click in the Program monitor</span>
					) : null}
				</div>
				{layout.lane(null)}
			</div>
			{trace ? (
				<div
					style={layout.left}
					className="flex flex-wrap items-center gap-2 py-1 pl-6 text-pr-small"
					data-testid={`mask-trace-panel-${id}`}
				>
					<SelectField
						value={trace.channel}
						options={['alpha', 'luma', 'red', 'green', 'blue'] as const}
						labels={['Alpha', 'Luminance', 'Red', 'Green', 'Blue']}
						label="Channel"
						onChange={(channel) => setTrace({ ...trace, channel })}
					/>
					<NumberInput
						label="Threshold %"
						value={trace.threshold * 100}
						onChange={(v) => setTrace({ ...trace, threshold: v / 100 })}
					/>
					<NumberInput
						label="Tolerance px"
						value={trace.tolerance}
						onChange={(v) => setTrace({ ...trace, tolerance: v })}
					/>
					<NumberInput
						label="Corner roundness %"
						value={trace.cornerRoundness * 100}
						onChange={(v) => setTrace({ ...trace, cornerRoundness: v / 100 })}
					/>
					<NumberInput
						label="Minimum area px²"
						value={trace.minArea}
						onChange={(v) => setTrace({ ...trace, minArea: v })}
					/>
					<CheckboxField
						value={trace.invert}
						label="Invert"
						onChange={(invert) => setTrace({ ...trace, invert })}
					>
						Invert
					</CheckboxField>
					<button
						type="button"
						className="rounded-pr-control bg-pr-accent px-2 text-pr-small text-pr-on-accent"
						onClick={() => {
							if (!props.engine) return;
							autoTrace(session, props.engine, owner, trace)
								.then((n) => {
									if (n === 0)
										toast({ kind: 'info', title: 'Auto-trace', detail: 'No outline found at the playhead' });
									setTrace(null);
								})
								.catch((e: Error) => toast({ kind: 'error', title: 'Auto-trace failed', detail: e.message }));
						}}
						data-testid={`mask-trace-run-${id}`}
					>
						Trace
					</button>
				</div>
			) : null}
		</>
	);
}

function NumberInput(props: { label: string; value: number; onChange(v: number): void }) {
	return (
		<label className="inline-flex items-center gap-1 text-pr-muted">
			{props.label}
			<input
				type="number"
				aria-label={props.label}
				className="w-[56px] rounded-pr-control bg-pr-field px-1 text-pr-text"
				value={Math.round(props.value * 100) / 100}
				onChange={(e) => {
					const v = Number(e.target.value);
					if (Number.isFinite(v)) props.onChange(v);
				}}
			/>
		</label>
	);
}

/** One mask's header row: twirl, name, mode, Inverted, tracking, delete. Click selects it for the monitor. */
export function MaskHeaderRow(props: {
	session: EditorSession;
	engine: MaskEngine | null;
	mask: Mask;
	clipId: string;
	open: boolean;
	onToggle(): void;
	readOnly: boolean;
	layout: Layout;
}) {
	const { session, mask, layout } = props;
	const selected = useMaskUi((s) => s.selected?.maskId === mask.id);
	const run = useMaskUi((s) => s.tracking[mask.id]);
	const apply = (label: string, patch: Record<string, unknown>) =>
		session.apply({
			label,
			origin: 'user',
			commands: [{ type: 'mask.update', maskId: mask.id, ...patch } as never],
		});
	const method: MaskTrackMethod = mask.trackMethod ?? 'position-scale-rotation';
	const track = (mode: 'forward' | 'backward' | 'step-forward' | 'step-back') => {
		if (!props.engine) {
			toast({ kind: 'error', title: 'Mask tracking', detail: 'The engine is not connected' });
			return;
		}
		void trackMask(session, props.engine, mask.id, mode, method);
	};
	const disabled = props.readOnly || !!run;
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: row selection like the timeline; keyboard via Delete */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
			<div
				className={cx('flex items-stretch', selected && 'bg-pr-selected')}
				data-mask-id={mask.id}
				data-testid={`mask-row-${mask.id}`}
				onClick={() => {
					maskUi.select({ maskId: mask.id, clipId: props.clipId });
					// Delete then removes the mask, not the effect it belongs to.
					inspectorFocus.set({ effectInstanceId: null });
				}}
			>
				<div
					style={layout.left}
					className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-1 pl-4 pr-1"
				>
					<MiniButton
						label={props.open ? `Collapse ${mask.name}` : `Expand ${mask.name}`}
						onClick={props.onToggle}
					>
						<CaretGlyph open={props.open} size={11} />
					</MiniButton>
					<span className="min-w-[72px] flex-1 truncate">
						<TextField
							value={mask.name}
							label="Mask name"
							onCommit={(name) => name.trim() && apply('Rename Mask', { name: name.trim() })}
							disabled={props.readOnly}
							data-testid={`mask-name-${mask.id}`}
						/>
					</span>
					<SelectField<MaskMode>
						value={mask.mode}
						options={MASK_MODES}
						labels={MASK_MODES.map((m) => MASK_MODE_LABELS[m])}
						label="Mask mode"
						disabled={props.readOnly}
						onChange={(mode) => apply('Mask Mode', { mode })}
						data-testid={`mask-mode-${mask.id}`}
					/>
					<CheckboxField
						value={mask.inverted}
						label="Inverted"
						disabled={props.readOnly}
						onChange={(inverted) => apply('Invert Mask', { inverted })}
					>
						<span className="text-pr-small">Inv</span>
					</CheckboxField>
					<MiniButton
						label={`Delete ${mask.name}`}
						disabled={props.readOnly}
						onClick={() => deleteMasks(session, [mask.id])}
						data-testid={`mask-delete-${mask.id}`}
					>
						<TrashGlyph size={12} />
					</MiniButton>
				</div>
				{layout.lane(null)}
			</div>
			{props.open ? (
				<div className="flex items-stretch" data-testid={`mask-tracking-${mask.id}`}>
					<div
						style={layout.left}
						className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-1 pl-[34px] pr-1"
					>
						<span className="mr-1 truncate text-pr-small text-pr-muted">Track</span>
						{run ? (
							<>
								<span className="text-pr-small text-pr-accent" data-testid={`mask-track-progress-${mask.id}`}>
									{run.progress === null ? '…' : `${Math.round(run.progress * 100)}%`}
								</span>
								<MiniButton label="Stop tracking" onClick={() => void stopMaskTrack(props.engine, mask.id)}>
									<span className="text-pr-small">■</span>
								</MiniButton>
							</>
						) : null}
						<MiniButton
							label="Track selected mask backward"
							disabled={disabled}
							onClick={() => track('backward')}
							data-testid={`mask-track-back-${mask.id}`}
						>
							<BackAll />
						</MiniButton>
						<MiniButton
							label="Track selected mask backward 1 frame"
							disabled={disabled}
							onClick={() => track('step-back')}
							data-testid={`mask-track-back1-${mask.id}`}
						>
							<BackOne />
						</MiniButton>
						<MiniButton
							label="Track selected mask forward 1 frame"
							disabled={disabled}
							onClick={() => track('step-forward')}
							data-testid={`mask-track-fwd1-${mask.id}`}
						>
							<FwdOne />
						</MiniButton>
						<MiniButton
							label="Track selected mask forward"
							disabled={disabled}
							onClick={() => track('forward')}
							data-testid={`mask-track-fwd-${mask.id}`}
						>
							<FwdAll />
						</MiniButton>
						<SelectField<MaskTrackMethod>
							value={method}
							options={MASK_TRACK_METHODS}
							labels={MASK_TRACK_METHODS.map((m) => MASK_TRACK_METHOD_LABELS[m])}
							label="Tracking method"
							disabled={props.readOnly}
							className="w-[96px]"
							onChange={(trackMethod) => apply('Tracking Method', { trackMethod })}
							data-testid={`mask-method-${mask.id}`}
						/>
					</div>
					{layout.lane(null)}
				</div>
			) : null}
		</>
	);
}
