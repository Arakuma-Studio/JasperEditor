// Properties ▸ Roto (parity workstream `roto`): the roto objects of the selected video / still clip — the Roto Brush
// tool (brush size, add / Refine Edge brush, Auto-propagate), the monitor view (overlay, boundary, alpha, off), and for
// the active roto: status (computed frames, stale, model), Propagate (backward / both / forward) with progress and
// cancel, span and segmentation settings, Apply Object Matte / Object Blur, Convert to Masks, Freeze, Remove; Track
// Faces / Blur Faces and per-face "Keyframes to…".
import { type Clip, type ClipRoto, findRoto, rotoIsStale, rotoSettingsOf } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { Slider } from '@jasper/ui';
import {
	Brush,
	ChevronsLeft,
	ChevronsLeftRight,
	ChevronsRight,
	Lock,
	ScanFace,
	Shapes,
	Square,
	Trash2,
	Unlock,
	Wand2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ClipSectionProps } from '../extensions/index.ts';
import { CheckboxField, SelectField } from '../panels/properties/controls/fields.tsx';
import { useEngineOrNull } from '../state/engine.tsx';
import { Row, SmallButton, ToolButton } from '../tracking/controls.tsx';
import {
	applyEffect,
	cancelRoto,
	convertToMasks,
	faceToTracker,
	freezeRoto,
	handleRotoEvent,
	type RotoEngine,
	removeRoto,
	rotosOf,
	runRoto,
	trackFaces,
	updateRoto,
} from './actions.ts';
import { type RotoView, type RunningRoto, rotoUi, useRoto } from './store.ts';

const VIEWS: RotoView[] = ['overlay', 'boundary', 'alpha', 'off'];
const VIEW_LABELS = ['Alpha Overlay', 'Alpha Boundary', 'Alpha', 'Off'];

export function RotoSection(props: ClipSectionProps) {
	const { session } = props;
	const clip = props.clips.length === 1 ? (props.clips[0] as Clip) : null;
	const engine = useEngineOrNull();
	useEffect(() => {
		if (!engine) return;
		return engine.subscribe((_e, raw) => handleRotoEvent(raw));
	}, [engine]);
	if (!clip || (clip.kind !== 'video' && clip.kind !== 'still'))
		return <p className="px-2 py-1 text-pr-small text-pr-muted">Select a single video or still clip.</p>;
	return <RotoList session={session} clip={clip} frame={props.frame} />;
}

function RotoList({ session, clip, frame }: { session: EditorSession; clip: Clip; frame: number }) {
	const engine = useEngineOrNull();
	const tool = useRoto((s) => s.tool);
	const radius = useRoto((s) => s.radius);
	const brush = useRoto((s) => s.brush);
	const view = useRoto((s) => s.view);
	const auto = useRoto((s) => s.autoPropagate);
	const activeId = useRoto((s) => s.activeRotoId);
	const running = useRoto((s) => s.running);
	const errors = useRoto((s) => s.errors);
	const readOnly = useSessionState((s) => s.readOnly);
	const rotos = rotosOf(clip);
	const active = rotos.find((r) => r.id === activeId) ?? null;
	useEffect(() => {
		// The first roto of a newly selected clip becomes active.
		if (!active && rotos[0]) rotoUi.setActive(rotos[0].id);
	}, [active, rotos]);
	const client = engine?.client ?? null;
	return (
		<div data-testid="roto-section" className="pb-1">
			<Row label="Roto Brush">
				<ToolButton
					icon={Brush}
					label="Roto Brush tool: drag over the object (Alt-drag removes, Shift-drag draws a box, Ctrl/Cmd-drag resizes)"
					active={tool}
					disabled={readOnly}
					onClick={() => rotoUi.set({ tool: !tool })}
					data-testid="roto-tool"
				/>
				<SelectField
					value={brush}
					options={['segment', 'refine'] as const}
					labels={['Select Object', 'Refine Edge']}
					label="Brush"
					onChange={(v) => rotoUi.set({ brush: v })}
					data-testid="roto-brush-kind"
				/>
				<CheckboxField value={auto} label="Auto-propagate" onChange={(v) => rotoUi.set({ autoPropagate: v })}>
					Auto-propagate
				</CheckboxField>
			</Row>
			<Row label="Brush Size">
				<Slider
					label="Brush size"
					value={radius}
					min={2}
					max={200}
					step={1}
					defaultValue={12}
					onChange={(v) => rotoUi.set({ radius: v })}
					onCommit={(v) => rotoUi.set({ radius: v })}
					className="min-w-0 flex-1"
				/>
			</Row>
			<Row label="View">
				<SelectField
					value={view}
					options={VIEWS}
					labels={VIEW_LABELS}
					label="Monitor view"
					onChange={(v) => rotoUi.set({ view: v })}
					data-testid="roto-view"
				/>
			</Row>
			{rotos.length ? (
				<Row label="Object">
					<SelectField
						value={active?.id ?? ''}
						options={rotos.map((r) => r.id)}
						labels={rotos.map((r) => (r.kind === 'faces' ? `${r.name} (faces)` : r.name))}
						label="Roto object"
						onChange={(v) => rotoUi.setActive(v)}
						data-testid="roto-active"
					/>
				</Row>
			) : (
				<p className="px-2 py-1 text-pr-small text-pr-muted">
					Turn on the Roto Brush and drag over the object in the Program monitor.
				</p>
			)}
			<Row>
				<SmallButton
					icon={ScanFace}
					disabled={readOnly || !client}
					onClick={() => client && void trackFaces(session, client, clip.id, false)}
					title="Find and track every face of the clip"
					data-testid="roto-track-faces"
				>
					Track Faces
				</SmallButton>
				<SmallButton
					icon={ScanFace}
					disabled={readOnly || !client}
					onClick={() => client && void trackFaces(session, client, clip.id, true)}
					title="Track every face and blur it (Object Blur)"
					data-testid="roto-blur-faces"
				>
					Blur Faces
				</SmallButton>
			</Row>
			{active ? (
				<RotoDetails
					session={session}
					roto={active}
					clipId={clip.id}
					frame={frame}
					running={running[active.id]}
					error={errors[active.id]}
					readOnly={readOnly}
					client={client}
				/>
			) : null}
		</div>
	);
}

function RotoDetails(props: {
	session: EditorSession;
	roto: ClipRoto;
	clipId: string;
	frame: number;
	running: RunningRoto | undefined;
	error: string | undefined;
	readOnly: boolean;
	client: RotoEngine | null;
}) {
	const { session, roto, running, client, readOnly } = props;
	const s = rotoSettingsOf(roto);
	const caps = useEngineOrNull()?.capabilities;
	const segModel = !!(caps?.features as { roto?: { segmentationModel?: boolean } } | undefined)?.roto
		?.segmentationModel;
	const stale = rotoIsStale(roto);
	const frozen = !!roto.frozen;
	const locked = readOnly || frozen;
	const [span, setSpan] = useState<[number, number]>([roto.span[0], roto.span[1]]);
	useEffect(() => setSpan([roto.span[0], roto.span[1]]), [roto.span]);
	const status = running
		? `${running.direction === 'frame' ? 'Segmenting' : roto.kind === 'faces' ? 'Tracking faces' : 'Propagating'}${running.total ? ` ${running.done}/${running.total}` : '…'}`
		: roto.result
			? `Computed ${roto.result.start}–${roto.result.end}${roto.result.model ? '' : ' (classic)'}${stale ? ' · changed since' : ''}`
			: 'Not propagated';
	const propagate = (dir: 'both' | 'forward' | 'backward') =>
		client && void runRoto(session, client, roto.id, dir);
	const set = (patch: Record<string, unknown>) => updateRoto(session, roto.id, { settings: patch });
	const doc = useSessionState((st) => st.document);
	const seq = findRoto(doc, roto.id) ? doc.sequences[findRoto(doc, roto.id)!.sequenceId] : null;
	const targets = seq
		? Object.values(seq.clips).filter((c) => c.id !== props.clipId && 'transform' in c)
		: [];
	return (
		<div data-testid="roto-details" data-roto-id={roto.id}>
			<Row label="Status">
				<span
					className={stale || props.error ? 'text-pr-small text-pr-warning' : 'text-pr-small text-pr-text'}
					data-testid="roto-status-text"
				>
					{props.error ?? status}
				</span>
			</Row>
			<Row label="Propagate">
				{roto.kind === 'brush' ? (
					<>
						<ToolButton
							icon={ChevronsLeft}
							label="Propagate backward"
							disabled={locked || !!running || !client}
							onClick={() => propagate('backward')}
						/>
						<ToolButton
							icon={ChevronsLeftRight}
							label="Propagate both directions (the whole span)"
							disabled={locked || !!running || !client}
							onClick={() => propagate('both')}
							data-testid="roto-propagate"
						/>
						<ToolButton
							icon={ChevronsRight}
							label="Propagate forward"
							disabled={locked || !!running || !client}
							onClick={() => propagate('forward')}
						/>
					</>
				) : (
					<ToolButton
						icon={ScanFace}
						label="Track the faces again"
						disabled={locked || !!running || !client}
						onClick={() => propagate('both')}
					/>
				)}
				<ToolButton
					icon={Square}
					label="Stop"
					filled
					disabled={!running || !client}
					onClick={() => client && void cancelRoto(client, roto.id)}
					data-testid="roto-cancel"
				/>
			</Row>
			<Row label="Span">
				<input
					type="number"
					className="h-[22px] w-16 rounded-pr-control border border-pr-border-strong bg-pr-field px-1 text-pr-small"
					value={span[0]}
					min={0}
					disabled={locked}
					aria-label="Span start (media frame)"
					onChange={(e) => setSpan([Number(e.target.value), span[1]])}
					onBlur={() => span[0] !== roto.span[0] && updateRoto(session, roto.id, { span })}
				/>
				<input
					type="number"
					className="h-[22px] w-16 rounded-pr-control border border-pr-border-strong bg-pr-field px-1 text-pr-small"
					value={span[1]}
					min={0}
					disabled={locked}
					aria-label="Span end (media frame)"
					onChange={(e) => setSpan([span[0], Number(e.target.value)])}
					onBlur={() => span[1] !== roto.span[1] && updateRoto(session, roto.id, { span })}
				/>
			</Row>
			{roto.kind === 'brush' ? (
				<>
					<Row label="Engine">
						<SelectField
							value={s.engine}
							options={['model', 'classic'] as const}
							labels={['Segment Anything 2.1 + graph cut', 'Graph cut (colour models)']}
							label="Segmentation engine"
							disabled={locked}
							onChange={(v) => set({ engine: v })}
						/>
						<SelectField
							value={s.quality}
							options={['standard', 'best'] as const}
							labels={['Standard', 'Best']}
							label="Quality"
							disabled={locked}
							onChange={(v) => set({ quality: v })}
						/>
					</Row>
					{s.engine === 'model' && !segModel ? (
						<p className="px-2 text-pr-small text-pr-muted" data-testid="roto-model-hint">
							The segmentation model is not installed: colour graph cuts are used. Download it in Preferences
							▸ Roto &amp; Face Tracking.
						</p>
					) : null}
					<NumRow
						label="Search Radius"
						value={s.searchRadius}
						min={0}
						max={100}
						def={15}
						disabled={locked}
						onCommit={(v) => set({ searchRadius: v })}
					/>
					<NumRow
						label="Motion Threshold"
						value={s.motionThreshold}
						min={0}
						max={100}
						def={10}
						disabled={locked}
						onCommit={(v) => set({ motionThreshold: v })}
					/>
					<NumRow
						label="Motion Damping"
						value={s.motionDamping}
						min={0}
						max={100}
						def={20}
						disabled={locked}
						onCommit={(v) => set({ motionDamping: v })}
					/>
					<Row label="Refine Edge">
						<SelectField
							value={s.edgeMode}
							options={['off', 'guided', 'closed-form'] as const}
							labels={['Off', 'Guided filter', 'Higher Quality (closed-form)']}
							label="Edge matting"
							disabled={locked}
							onChange={(v) => set({ edgeMode: v })}
						/>
					</Row>
					<NumRow
						label="Edge Radius"
						value={s.edgeRadius}
						min={0}
						max={50}
						def={3}
						disabled={locked}
						onCommit={(v) => set({ edgeRadius: v })}
					/>
					<NumRow
						label="Smooth"
						value={s.edgeSmooth}
						min={0}
						max={20}
						def={1}
						disabled={locked}
						onCommit={(v) => set({ edgeSmooth: v })}
					/>
				</>
			) : (
				<>
					<NumRow
						label="Confidence"
						value={Math.round(s.faceThreshold * 100)}
						min={5}
						max={99}
						def={50}
						disabled={locked}
						onCommit={(v) => set({ faceThreshold: v / 100 })}
					/>
					<NumRow
						label="Expand %"
						value={s.faceExpand}
						min={-50}
						max={100}
						def={15}
						disabled={locked}
						onCommit={(v) => set({ faceExpand: v })}
					/>
					<Row label="Shape">
						<SelectField
							value={s.faceShape}
							options={['outline', 'ellipse'] as const}
							labels={['Face outline', 'Ellipse']}
							label="Face shape"
							disabled={locked}
							onChange={(v) => set({ faceShape: v })}
						/>
					</Row>
					{roto.result?.faces?.map((f) => (
						<Row key={f.id} label={`Face ${f.id + 1}`}>
							<span className="text-pr-small text-pr-muted">
								{f.present.filter((p) => p === 1).length}/{f.present.length} frames
							</span>
							<SelectField
								value=""
								options={['', ...targets.map((c) => c.id)]}
								labels={['Keyframes to…', ...targets.map((c) => c.name || c.id)]}
								label={`Face ${f.id + 1} keyframes target`}
								disabled={readOnly}
								onChange={(v) => v && faceToTracker(session, roto.id, f.id, v)}
							/>
						</Row>
					))}
				</>
			)}
			<Row>
				<SmallButton
					icon={Wand2}
					disabled={readOnly}
					onClick={() => applyEffect(session, roto.id, 'matte')}
					title="Cut the clip out by this object (Object Matte)"
				>
					Object Matte
				</SmallButton>
				<SmallButton
					icon={Wand2}
					disabled={readOnly}
					onClick={() => applyEffect(session, roto.id, 'blur')}
					title="Blur / pixelate this object (Object Blur)"
				>
					Object Blur
				</SmallButton>
			</Row>
			<Row>
				<SmallButton
					icon={Shapes}
					disabled={readOnly || !roto.result || !client}
					onClick={() => client && void convertToMasks(session, client, roto.id, 'still', props.frame)}
					title="The matte outline at the playhead becomes Opacity masks"
					data-testid="roto-to-masks"
				>
					Convert to Masks
				</SmallButton>
				<SmallButton
					icon={Shapes}
					disabled={readOnly || !roto.result || !client}
					onClick={() => client && void convertToMasks(session, client, roto.id, 'animated', props.frame)}
					title="One mask following the object over the computed frames"
				>
					Animated Mask
				</SmallButton>
			</Row>
			<Row>
				<SmallButton
					icon={frozen ? Unlock : Lock}
					disabled={readOnly || (!frozen && !roto.result)}
					onClick={() => freezeRoto(session, roto.id, !frozen)}
					title={
						frozen
							? 'Unfreeze (allow edits and re-propagation)'
							: 'Freeze the computed mattes (lock the roto)'
					}
					data-testid="roto-freeze"
				>
					{frozen ? 'Unfreeze' : 'Freeze'}
				</SmallButton>
				<ToolButton
					icon={Trash2}
					label="Remove roto (and its effects)"
					danger
					disabled={readOnly}
					onClick={() => removeRoto(session, roto.id)}
				/>
			</Row>
		</div>
	);
}

function NumRow(props: {
	label: string;
	value: number;
	min: number;
	max: number;
	def: number;
	disabled: boolean;
	onCommit(v: number): void;
}) {
	const [v, setV] = useState(props.value);
	useEffect(() => setV(props.value), [props.value]);
	return (
		<Row label={props.label}>
			<Slider
				label={props.label}
				value={v}
				min={props.min}
				max={props.max}
				step={1}
				defaultValue={props.def}
				disabled={props.disabled}
				onChange={setV}
				onCommit={(x) => x !== props.value && props.onCommit(x)}
				className="min-w-0 flex-1"
			/>
		</Row>
	);
}
