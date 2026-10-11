// Separate RenderOptions for each side let before/after comparisons bypass colour effects on the reference.
import type { RenderOptions } from '@jasper/compositions';
import {
	nextEditPoint,
	type ProjectDocument,
	prevEditPoint,
	type Sequence,
	sequenceDuration,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState, useStoreSelector } from '@jasper/session/react';
import { type ReactNode, useRef } from 'react';
import { FrameView } from './FrameView.tsx';
import { type ComparisonMode, monitorExtras, setComparison } from './monitor-view.ts';

const MODES: { id: ComparisonMode; label: string }[] = [
	{ id: 'side-by-side', label: 'Side by Side' },
	{ id: 'vertical', label: 'Vertical Split' },
	{ id: 'horizontal', label: 'Horizontal Split' },
];

/** Two pictures in a comparison mode; `split` 0..1, `onSplit` makes the divider draggable. */
export function ComparisonLayout(props: {
	mode: ComparisonMode;
	split: number;
	swapped: boolean;
	reference: ReactNode;
	current: ReactNode;
	onSplit?(split: number): void;
	testId?: string;
}) {
	const box = useRef<HTMLDivElement>(null);
	const [a, b] = props.swapped ? [props.current, props.reference] : [props.reference, props.current];
	const dragSplit = (e: React.PointerEvent) => {
		if (!props.onSplit) return;
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture?.(e.pointerId);
		const move = (ev: PointerEvent) => {
			const r = box.current?.getBoundingClientRect();
			if (!r) return;
			const f =
				props.mode === 'horizontal' ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width;
			props.onSplit?.(Math.min(0.95, Math.max(0.05, f)));
		};
		const up = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
	};
	if (props.mode === 'side-by-side')
		return (
			<div ref={box} className="flex h-full w-full gap-1" data-testid={props.testId} data-mode={props.mode}>
				<div className="relative min-w-0 flex-1">{a}</div>
				<div className="relative min-w-0 flex-1">{b}</div>
			</div>
		);
	const pct = `${props.split * 100}%`;
	const vertical = props.mode === 'vertical';
	return (
		<div ref={box} className="relative h-full w-full" data-testid={props.testId} data-mode={props.mode}>
			<div className="absolute inset-0">{b}</div>
			<div
				className="absolute inset-0"
				style={{
					clipPath: vertical ? `inset(0 calc(100% - ${pct}) 0 0)` : `inset(0 0 calc(100% - ${pct}) 0)`,
				}}
			>
				{a}
			</div>
			<div
				className="absolute bg-pr-accent"
				style={
					vertical
						? { left: pct, top: 0, bottom: 0, width: 2, marginLeft: -1, cursor: 'col-resize' }
						: { top: pct, left: 0, right: 0, height: 2, marginTop: -1, cursor: 'row-resize' }
				}
				onPointerDown={dragSplit}
				data-testid="comparison-divider"
				role="presentation"
			/>
		</div>
	);
}

function editTarget(seq: Sequence, frame: number, dir: 1 | -1): number | null {
	return dir > 0 ? nextEditPoint(seq, frame) : prevEditPoint(seq, frame);
}

/** The Program monitor's comparison view (paused only: playback shows the program). */
export function ProgramComparison(props: {
	session: EditorSession;
	sequenceId: string;
	doc: ProjectDocument;
	currentOptions?: Partial<RenderOptions>;
	referenceOptions?: Partial<RenderOptions>;
}) {
	const { session, sequenceId, doc } = props;
	const c = useStoreSelector(monitorExtras, (s) => s.comparison);
	const frame = useStoreSelector(
		{ getState: () => session.transport.getState(), subscribe: (l) => session.transport.subscribe(l) },
		(s) => s.frame,
	);
	const sequences = useSessionState((s) => s.document.sequences);
	const items = useSessionState((s) => s.document.items);
	const ref = c.reference ?? { kind: 'sequence-frame' as const, sequenceId, frame };
	const refSeq = (sequences[ref.sequenceId] ?? sequences[sequenceId]) as Sequence | undefined;
	if (!refSeq) return null;
	const refId = refSeq.id;
	const nameOf = (id: string) =>
		Object.values(items).find((i) => i.kind === 'sequence' && i.sequenceId === id)?.name ?? id;
	const setRef = (f: number, seqId = refId) => {
		const s = sequences[seqId] as Sequence | undefined;
		const max = s ? Math.max(0, sequenceDuration(s) - 1) : 0;
		setComparison({
			reference: { kind: 'sequence-frame', sequenceId: seqId, frame: Math.max(0, Math.min(max, f)) },
		});
	};
	const step = (dir: 1 | -1) => {
		const t = editTarget(refSeq, ref.frame, dir);
		if (t !== null) setRef(t);
	};
	return (
		<div className="absolute inset-0 z-[4] flex flex-col bg-pr-panel" data-testid="comparison-view">
			<div className="min-h-0 flex-1 p-1">
				<ComparisonLayout
					mode={c.mode}
					split={c.split}
					swapped={c.swapped}
					onSplit={(split) => setComparison({ split })}
					testId="comparison-layout"
					reference={
						<FrameView
							doc={doc}
							sequenceId={refId}
							frame={ref.frame}
							options={props.referenceOptions}
							label={`Reference: ${nameOf(refId)} frame ${ref.frame}`}
							testId="comparison-reference"
						/>
					}
					current={
						<FrameView
							doc={doc}
							sequenceId={sequenceId}
							frame={frame}
							options={props.currentOptions}
							label={`Current frame ${frame}`}
							testId="comparison-current"
						/>
					}
				/>
			</div>
			<div className="flex h-[26px] shrink-0 items-center gap-1 px-2 text-pr-small">
				<span className="text-pr-muted">Reference</span>
				<select
					aria-label="Reference sequence"
					className="h-[20px] rounded-pr-control border border-pr-border bg-pr-field px-1 text-pr-small text-pr-text"
					value={refId}
					onChange={(e) => setRef(0, e.target.value)}
					data-testid="comparison-sequence"
				>
					{Object.keys(sequences).map((id) => (
						<option key={id} value={id}>
							{nameOf(id)}
						</option>
					))}
				</select>
				<button
					type="button"
					className="rounded-pr-control px-1 hover:bg-pr-hover"
					aria-label="Previous edit point as reference"
					onClick={() => step(-1)}
					data-testid="comparison-prev"
				>
					◀|
				</button>
				<span className="pr-tabular min-w-[48px] text-center text-pr-text" data-testid="comparison-frame">
					{ref.frame}
				</span>
				<button
					type="button"
					className="rounded-pr-control px-1 hover:bg-pr-hover"
					aria-label="Next edit point as reference"
					onClick={() => step(1)}
					data-testid="comparison-next"
				>
					|▶
				</button>
				<button
					type="button"
					className="rounded-pr-control px-1 hover:bg-pr-hover"
					aria-label="Set reference to the playhead"
					onClick={() => setRef(frame, sequenceId)}
					data-testid="comparison-set"
				>
					Set to Playhead
				</button>
				<div className="flex-1" />
				{MODES.map((m) => (
					<button
						key={m.id}
						type="button"
						aria-pressed={c.mode === m.id}
						className={`rounded-pr-control px-1 hover:bg-pr-hover ${c.mode === m.id ? 'text-pr-accent' : 'text-pr-muted'}`}
						onClick={() => setComparison({ mode: m.id })}
						data-testid={`comparison-mode-${m.id}`}
					>
						{m.label}
					</button>
				))}
				<button
					type="button"
					aria-pressed={c.swapped}
					className="rounded-pr-control px-1 text-pr-muted hover:bg-pr-hover"
					onClick={() => setComparison({ swapped: !c.swapped })}
					data-testid="comparison-swap"
				>
					Swap Sides
				</button>
			</div>
		</div>
	);
}
