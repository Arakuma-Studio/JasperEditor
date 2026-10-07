// Properties ▸ 3D Camera Tracker (three-d): After Effects' 3D Camera Tracker effect controls for the selected video
// clip — Analyze / Cancel with progress, Shot Type, Horizontal Angle of View, Show Track Points, Track Point Size,
// Target Size, Create Camera; Advanced: Solve Method, Method Used, Average Error, Detailed Analysis, lens distortion;
// with selected track points: Create Text / Solid and Camera, Set Ground Plane and Origin, Delete Points.
import {
	type Clip,
	type ClipCameraTracker,
	cameraTrackerSettingsOf,
	contentTimeAt,
	isSolveStale,
	mediaFrameAt,
	type Rational,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { Camera, Grid3x3, Square, Trash2, Type, Video } from 'lucide-react';
import type { ClipSectionProps } from '../../extensions/index.ts';
import { CheckboxField, SelectField } from '../../panels/properties/controls/fields.tsx';
import { useEngineOrNull } from '../../state/engine.tsx';
import { Row, SmallButton, ToolButton } from '../../tracking/controls.tsx';
import { NumberInput } from '../dialogs.tsx';
import {
	analyze,
	cancelAnalysis,
	createFromTracker,
	deletePoints,
	removeTracker,
	setGround,
	trackCamera,
	updateTracker,
} from './actions.ts';
import { camtrackUi, useCamTrack } from './store.ts';

const SHOTS = ['fixed', 'variable', 'specify'] as const;
const SHOT_LABELS = ['Fixed Angle of View', 'Variable Zoom', 'Specify Angle of View'];
const METHODS = ['auto', 'typical', 'flat', 'tripod'] as const;
const METHOD_LABELS = ['Auto Detect', 'Typical', 'Mostly Flat Scene', 'Tripod Pan'];
const METHOD_USED: Record<string, string> = {
	typical: 'Typical',
	flat: 'Mostly Flat Scene',
	tripod: 'Tripod Pan',
};

export function CamTrackSection(props: ClipSectionProps) {
	const clip = props.clips.length === 1 ? (props.clips[0] as Clip) : null;
	const engine = useEngineOrNull();
	const client = engine?.client ?? null;
	if (clip?.kind !== 'video')
		return <p className="px-2 py-1 text-pr-small text-pr-muted">Select a single video clip.</p>;
	const tracker = (clip as { cameraTracker?: ClipCameraTracker }).cameraTracker;
	if (!tracker)
		return (
			<Row>
				<SmallButton
					icon={Video}
					onClick={() => client && void trackCamera(props.session, client, clip.id)}
					disabled={!client}
					primary
					data-testid="camtrack-track"
				>
					Track Camera
				</SmallButton>
			</Row>
		);
	return <TrackerControls session={props.session} clip={clip} tracker={tracker} frame={props.frame} />;
}

function TrackerControls(props: {
	session: EditorSession;
	clip: Clip;
	tracker: ClipCameraTracker;
	frame: number;
}) {
	const { session, clip, tracker } = props;
	const engine = useEngineOrNull();
	const client = engine?.client ?? null;
	const running = useCamTrack((s) => s.running[clip.id]);
	const error = useCamTrack((s) => s.errors[clip.id]);
	const selection = useCamTrack((s) => (s.selection?.clipId === clip.id ? s.selection.ids : []));
	const readOnly = useSessionState((s) => s.readOnly);
	const doc = useSessionState((s) => s.document);
	const s = cameraTrackerSettingsOf(tracker.settings);
	const set = (patch: Record<string, unknown>) => updateTracker(session, clip.id, patch);
	const solve = tracker.solve;
	const stale = isSolveStale(tracker);
	const seq = Object.values(doc.sequences).find((q) => q.clips[clip.id]);
	const mediaFrame = seq
		? mediaFrameAt(
				contentTimeAt(clip, props.frame, seq.settings.frameRate as Rational),
				tracker.rate as Rational,
			)
		: undefined;
	const status = running
		? `${running.stage} (${Math.round(running.progress * 100)} %)`
		: error
			? error
			: !solve
				? 'Not analyzed'
				: stale
					? 'Solved with other settings: analyze again'
					: `Solved: ${solve.points.length - tracker.deleted.length} track points`;
	const disabled = readOnly || !!running;
	return (
		<div data-testid="camtrack-section" data-solved={solve ? '1' : '0'}>
			<Row label="Status">
				<span
					className={error || stale ? 'text-pr-small text-pr-warning' : 'text-pr-small text-pr-text'}
					data-testid="camtrack-status"
				>
					{status}
				</span>
			</Row>
			<Row label="Analyze">
				<ToolButton
					icon={Grid3x3}
					label="Analyze and solve the camera"
					disabled={disabled || !client}
					onClick={() => client && void analyze(session, client, clip.id)}
					data-testid="camtrack-analyze"
				/>
				<ToolButton
					icon={Square}
					label="Stop"
					filled
					disabled={!running || !client}
					onClick={() => client && void cancelAnalysis(client, clip.id)}
					data-testid="camtrack-cancel"
				/>
			</Row>
			<Row label="Shot Type">
				<SelectField
					value={s.shot}
					options={SHOTS}
					labels={SHOT_LABELS}
					label="Shot Type"
					disabled={disabled}
					onChange={(v) => set({ shot: v })}
				/>
			</Row>
			{s.shot === 'specify' ? (
				<Row label="Horizontal Angle of View">
					<NumberInput
						value={s.hfov}
						label="Horizontal Angle of View"
						unit="°"
						onChange={(v) => set({ hfov: v })}
					/>
				</Row>
			) : null}
			<Row label="Show Track Points">
				<SelectField
					value={s.showPoints}
					options={['3d', 'off'] as const}
					labels={['3D Solved', 'Off']}
					label="Show Track Points"
					disabled={readOnly}
					onChange={(v) => set({ showPoints: v })}
				/>
			</Row>
			<Row label="Track Point Size">
				<NumberInput
					value={s.pointSize}
					label="Track Point Size"
					unit="%"
					onChange={(v) => set({ pointSize: v })}
				/>
			</Row>
			<Row label="Target Size">
				<NumberInput
					value={s.targetSize}
					label="Target Size"
					unit="%"
					onChange={(v) => set({ targetSize: v })}
				/>
			</Row>
			<Row label="Span">
				<NumberInput
					value={tracker.span[0]}
					label="First media frame"
					onChange={(v) => set({ span: [Math.max(0, Math.round(v)), tracker.span[1]] })}
				/>
				<NumberInput
					value={tracker.span[1]}
					label="Last media frame"
					onChange={(v) => set({ span: [tracker.span[0], Math.max(0, Math.round(v))] })}
				/>
			</Row>
			<Row label="Create Camera">
				<SmallButton
					icon={Camera}
					disabled={readOnly || !solve}
					onClick={() => createFromTracker(session, clip.id, 'none', [], mediaFrame)}
					data-testid="camtrack-create-camera"
				>
					Create Camera
				</SmallButton>
			</Row>
			{selection.length ? (
				<>
					<Row label={`${selection.length} selected`}>
						<SmallButton
							icon={Type}
							disabled={readOnly}
							onClick={() => createFromTracker(session, clip.id, 'text', selection, mediaFrame)}
							data-testid="camtrack-create-text"
						>
							Text and Camera
						</SmallButton>
						<SmallButton
							icon={Square}
							disabled={readOnly}
							onClick={() => createFromTracker(session, clip.id, 'solid', selection, mediaFrame)}
						>
							Solid and Camera
						</SmallButton>
					</Row>
					<Row>
						<SmallButton
							disabled={readOnly || selection.length < 3}
							title="Three or more points define the ground plane"
							onClick={() => setGround(session, clip.id, selection, mediaFrame)}
							data-testid="camtrack-ground"
						>
							Set Ground Plane and Origin
						</SmallButton>
						<SmallButton
							icon={Trash2}
							disabled={disabled}
							onClick={() => deletePoints(session, client, clip.id, selection)}
							data-testid="camtrack-delete-points"
						>
							Delete Points
						</SmallButton>
						<SmallButton onClick={() => camtrackUi.clearSelection()}>Deselect</SmallButton>
					</Row>
				</>
			) : null}
			{tracker.ground ? (
				<Row label="Ground Plane">
					<SmallButton disabled={readOnly} onClick={() => setGround(session, clip.id, [])}>
						Reset Ground Plane
					</SmallButton>
				</Row>
			) : null}
			<Row label="Solve Method">
				<SelectField
					value={s.method}
					options={METHODS}
					labels={METHOD_LABELS}
					label="Solve Method"
					disabled={disabled}
					onChange={(v) => set({ method: v })}
				/>
			</Row>
			<Row label="Method Used">
				<span className="text-pr-small text-pr-text" data-testid="camtrack-method-used">
					{solve ? METHOD_USED[solve.methodUsed] : '–'}
				</span>
			</Row>
			<Row label="Average Error">
				<span className="text-pr-small text-pr-text" data-testid="camtrack-error">
					{solve ? `${solve.averageError.toFixed(2)} pixels` : '–'}
				</span>
			</Row>
			{solve?.distortion ? (
				<Row label="Lens Distortion">
					<span className="text-pr-small text-pr-text">
						k1 {solve.distortion.k1.toFixed(4)}, k2 {solve.distortion.k2.toFixed(4)}
					</span>
				</Row>
			) : null}
			<Row>
				<CheckboxField
					value={s.detailed}
					label="Detailed Analysis"
					disabled={disabled}
					onChange={(v) => set({ detailed: v })}
				/>
				<CheckboxField
					value={s.lensDistortion}
					label="Solve Lens Distortion"
					disabled={disabled}
					onChange={(v) => set({ lensDistortion: v })}
				/>
			</Row>
			<Row>
				<SmallButton
					icon={Trash2}
					disabled={readOnly}
					onClick={() => removeTracker(session, client, clip.id)}
					data-testid="camtrack-remove"
				>
					Remove Tracker
				</SmallButton>
			</Row>
		</div>
	);
}
