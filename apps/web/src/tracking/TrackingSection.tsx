// Properties ▸ Tracking (S09:TRU-001): the trackers of the selected video clip (name, kind, tracked span, mean
// confidence), Add Planar / Add Point, and for the selected tracker the track buttons (◀◀ ◀| |▶ ▶▶, both, from
// here, stop), quality and planar options, smoothing, "Apply to…", the clips it drives, and Remove.
import {
	type ClipTracker,
	type Command,
	mediaFrameRate,
	type Rational,
	samplesSummary,
	type TrackMode,
	trackedTargets,
	type VideoClip,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { cx, openDialog, Slider } from '@jasper/ui';
import {
	ChevronsLeft,
	ChevronsLeftRight,
	ChevronsRight,
	Crosshair,
	Link2,
	type LucideIcon,
	Scan,
	Square,
	StepBack,
	StepForward,
	Trash2,
	Undo2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ClipSectionProps } from '../extensions/index.ts';
import { CheckboxField, SelectField } from '../panels/properties/controls/fields.tsx';
import {
	addTracker,
	removeTracker,
	startTrack,
	stopTrack,
	TRACK_MODE_LABEL,
	type TrackingEngine,
} from './actions.ts';
import { useTrackingBridge } from './bridge.ts';
import { Row, SmallButton, ToolButton } from './controls.tsx';
import { confidenceTone, TONE_VAR } from './geometry.ts';
import { optionsOf, setActiveTracker, setError, setOptions, useTracking } from './store.ts';

export const APPLY_DIALOG = 'tracking.apply';

const QUALITIES = ['fast', 'balanced', 'best'] as const;
const QUALITY_LABELS = ['Fast', 'Balanced', 'Best'];

/** Short `m:ss:ff` (or `s:ff`) source timecode for the tracked span. */
export function shortTc(frame: number, rate: Rational | null): string {
	const fps = rate ? Math.round(rate.num / rate.den) : 30;
	const f = Math.max(0, Math.round(frame));
	const ff = f % fps;
	const secs = Math.floor(f / fps);
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	const pad = (n: number) => String(n).padStart(2, '0');
	return m > 0 ? `${m}:${pad(s)}:${pad(ff)}` : `${s}:${pad(ff)}`;
}

export function spanLabel(tracker: ClipTracker, rate: Rational | null): string {
	const s = tracker.samples;
	const sum = samplesSummary(s);
	if (!s || sum.count === 0) return 'Not tracked';
	const a = Math.round(s.start / s.step);
	return `${shortTc(a, rate)}–${shortTc(a + sum.count - 1, rate)}`;
}

const TRACK_BUTTONS: { mode: TrackMode; icon: LucideIcon; label: string }[] = [
	{ mode: 'backward', icon: ChevronsLeft, label: 'Track Backward' },
	{ mode: 'step-back', icon: StepBack, label: 'Step Back (track one frame)' },
	{ mode: 'step-forward', icon: StepForward, label: 'Step Forward (track one frame)' },
	{ mode: 'forward', icon: ChevronsRight, label: 'Track Forward' },
	{ mode: 'both', icon: ChevronsLeftRight, label: 'Track Both Directions' },
	{ mode: 'from-here', icon: Crosshair, label: 'Track from Here (re-track forward from the playhead)' },
];

export function TrackingSection(props: ClipSectionProps) {
	const { session } = props;
	const clip =
		props.clips.length === 1 && props.clips[0]!.kind === 'video' ? (props.clips[0] as VideoClip) : null;
	const engine = useTrackingBridge(session);
	if (!clip) {
		return <p className="px-2 py-1 text-pr-small text-pr-muted">Select a single video clip to track it.</p>;
	}
	return <TrackerList session={session} clip={clip} engine={engine} />;
}

function TrackerList({
	session,
	clip,
	engine,
}: {
	session: EditorSession;
	clip: VideoClip;
	engine: TrackingEngine | null;
}) {
	const activeId = useTracking((s) => s.activeTrackerId);
	const running = useTracking((s) => s.running);
	const readOnly = useSessionState((s) => s.readOnly);
	const rate = useSessionState((s) => mediaFrameRate(s.document.media[clip.mediaId]));
	const trackers = clip.trackers ?? [];
	const active = trackers.find((t) => t.id === activeId) ?? null;
	const add = (kind: 'planar' | 'point') => {
		try {
			addTracker(session, clip.id, kind);
		} catch (e) {
			setError(clip.id, (e as Error).message);
		}
	};
	const clipError = useTracking((s) => s.errors[clip.id]);
	return (
		<div data-testid="tracking-section" className="pb-1">
			<div className="flex items-center gap-1 px-2 py-1">
				<SmallButton
					icon={Scan}
					onClick={() => add('planar')}
					disabled={readOnly}
					title="Track a flat surface (screen, sign): four corners"
					data-testid="tracking-add-planar"
				>
					Add Planar Tracker
				</SmallButton>
				<SmallButton
					icon={Crosshair}
					onClick={() => add('point')}
					disabled={readOnly}
					title="Track a single feature point"
					data-testid="tracking-add-point"
				>
					Add Point Tracker
				</SmallButton>
			</div>
			{clipError ? <p className="px-2 text-pr-small text-pr-danger">{clipError}</p> : null}
			{trackers.length === 0 ? (
				<p className="px-2 py-1 text-pr-small text-pr-muted">
					No trackers. Add one, fit it to a flat surface on the Program monitor, then track.
				</p>
			) : (
				<ul className="py-[2px]" aria-label="Trackers">
					{trackers.map((t) => {
						const sum = samplesSummary(t.samples);
						const selected = t.id === activeId;
						const job = running[t.id];
						return (
							<li key={t.id}>
								{/* biome-ignore lint/a11y/useSemanticElements: a selectable list row with a nested button */}
								<div
									role="button"
									tabIndex={0}
									aria-pressed={selected}
									onClick={() => setActiveTracker(selected ? null : t.id)}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											setActiveTracker(selected ? null : t.id);
										}
									}}
									className={cx(
										'group flex h-[var(--pr-row-h)] cursor-default items-center gap-1.5 pr-1 pl-2 text-pr-ui outline-none',
										selected ? 'bg-pr-selected text-pr-strong' : 'text-pr-text hover:bg-pr-hover',
										'focus-visible:outline focus-visible:outline-1 focus-visible:outline-pr-focus',
									)}
									data-testid={`tracker-row-${t.id}`}
									data-tracker-id={t.id}
								>
									<span
										className="text-pr-icon"
										title={t.kind === 'planar' ? 'Planar tracker' : 'Point tracker'}
									>
										{t.kind === 'planar' ? (
											<Scan size={12} strokeWidth={1.75} aria-hidden />
										) : (
											<Crosshair size={12} strokeWidth={1.75} aria-hidden />
										)}
									</span>
									<span className="min-w-0 flex-1 truncate">{t.name}</span>
									{job ? (
										<span className="text-pr-small text-pr-accent pr-tabular">
											{job.progress
												? `${Math.round((job.progress.done / Math.max(1, job.progress.total)) * 100)}%`
												: '…'}
										</span>
									) : (
										<span
											className="shrink-0 text-pr-small text-pr-muted pr-tabular"
											data-testid={`tracker-span-${t.id}`}
										>
											{spanLabel(t, rate)}
										</span>
									)}
									{sum.meanConfidence !== null ? (
										<span
											className="inline-flex shrink-0 items-center gap-1 text-pr-small text-pr-muted pr-tabular"
											title={`Mean confidence ${Math.round(sum.meanConfidence * 100)}%${sum.lost ? ` · ${sum.lost} lost frames` : ''}`}
											data-testid={`tracker-confidence-${t.id}`}
										>
											<span
												className="inline-block size-[7px] rounded-full"
												style={{ background: TONE_VAR[confidenceTone(sum.meanConfidence)] }}
											/>
											{Math.round(sum.meanConfidence * 100)}%
										</span>
									) : null}
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{active ? <TrackerControls session={session} clip={clip} tracker={active} engine={engine} /> : null}
		</div>
	);
}

function TrackerControls({
	session,
	clip,
	tracker,
	engine,
}: {
	session: EditorSession;
	clip: VideoClip;
	tracker: ClipTracker;
	engine: TrackingEngine | null;
}) {
	const job = useTracking((s) => s.running[tracker.id]);
	const error = useTracking((s) => s.errors[tracker.id]);
	useTracking((s) => s.options[tracker.id]);
	const opts = optionsOf(tracker.id, tracker.kind);
	const readOnly = useSessionState((s) => s.readOnly);
	const targets = useSessionState((s) => trackedTargets(s.document, tracker.id), sameTargets);
	const seqClips = useSessionState((s) => {
		const id = s.activeSequenceId;
		return id ? s.document.sequences[id]?.clips : undefined;
	});
	const [smoothing, setSmoothing] = useState(tracker.smoothing ?? 0);
	useEffect(() => setSmoothing(tracker.smoothing ?? 0), [tracker.smoothing]);
	const busy = !!job;
	const track = (mode: TrackMode) => {
		if (!engine) {
			setError(tracker.id, 'The engine is not connected');
			return;
		}
		startTrack(session, engine, tracker.id, mode).catch(() => undefined);
	};
	const commitSmoothing = (v: number) => {
		if (v === (tracker.smoothing ?? 0)) return;
		const r = session.apply({
			label: 'Tracker Smoothing',
			origin: 'user',
			commands: [{ type: 'tracker.update', trackerId: tracker.id, smoothing: v } as Command],
		});
		if (!r.ok) setError(tracker.id, r.errors.map((e) => e.message).join('; '));
	};
	const pct = job?.progress ? job.progress.done / Math.max(1, job.progress.total) : null;
	return (
		<div className="mt-[2px] border-t border-pr-border-subtle pt-1" data-testid="tracker-controls">
			<Row label="Track">
				{TRACK_BUTTONS.map((b) => (
					<ToolButton
						key={b.mode}
						icon={b.icon}
						label={b.label}
						disabled={busy || readOnly || !engine}
						onClick={() => track(b.mode)}
						data-testid={`track-${b.mode}`}
					/>
				))}
				<ToolButton
					icon={Square}
					label="Stop Tracking"
					disabled={!busy}
					danger
					onClick={() => engine && void stopTrack(engine, tracker.id)}
					data-testid="track-stop"
				/>
			</Row>
			{job ? (
				<Row data-testid="tracking-progress">
					<div className="h-[4px] min-w-0 flex-1 overflow-hidden rounded-pr-pill bg-pr-field">
						<div
							className={cx('h-full bg-pr-accent-fill', pct === null && 'animate-pulse')}
							style={{ width: `${Math.round((pct ?? 1) * 100)}%` }}
						/>
					</div>
					<span className="ml-1 shrink-0 text-pr-small text-pr-muted pr-tabular">
						{TRACK_MODE_LABEL[job.mode]}
						{job.progress ? ` ${job.progress.done}/${job.progress.total}` : '…'}
					</span>
				</Row>
			) : null}
			{error ? (
				<p className="px-2 py-[2px] text-pr-small text-pr-danger" role="alert" data-testid="tracking-error">
					{error}
				</p>
			) : null}
			<Row label="Quality">
				<SelectField
					label="Tracking quality"
					value={opts.quality}
					options={QUALITIES}
					labels={QUALITY_LABELS}
					onChange={(q) => setOptions(tracker.id, tracker.kind, { quality: q })}
					disabled={busy}
					data-testid="tracking-quality"
				/>
			</Row>
			{tracker.kind === 'planar' ? (
				<Row label="Options">
					<div className="flex flex-col gap-[2px] py-[2px]">
						<CheckboxField
							label="Track surroundings"
							value={opts.surroundings}
							onChange={(v) => setOptions(tracker.id, tracker.kind, { surroundings: v })}
							disabled={busy}
						>
							<span title="Take features from a ring around the quad (screens whose content changes)">
								Track surroundings
							</span>
						</CheckboxField>
						<CheckboxField
							label="Snap to edges"
							value={opts.refineEdges}
							onChange={(v) => setOptions(tracker.id, tracker.kind, { refineEdges: v })}
							disabled={busy}
						>
							<span title="Snap the quad's sides to straight edges near them (bezels, borders)">
								Snap to edges
							</span>
						</CheckboxField>
					</div>
				</Row>
			) : null}
			<Row label="Smoothing">
				<div className="flex min-w-0 flex-1 items-center gap-2" data-testid="tracking-smoothing">
					<Slider
						label="Tracker smoothing"
						value={smoothing}
						min={0}
						max={30}
						step={1}
						defaultValue={0}
						disabled={readOnly}
						onChange={setSmoothing}
						onCommit={commitSmoothing}
						className="min-w-0 flex-1"
					/>
					<span className="w-[34px] shrink-0 text-right text-pr-small text-pr-value pr-tabular">
						{smoothing} fr
					</span>
				</div>
			</Row>
			<Row>
				<SmallButton
					icon={Link2}
					onClick={() => void openDialog(APPLY_DIALOG, { session, trackerId: tracker.id })}
					disabled={readOnly || busy}
					title={
						tracker.samples
							? 'Bake the track onto a clip above the plate'
							: 'Track first, then apply it to a clip'
					}
					data-testid="tracking-apply"
				>
					Apply to…
				</SmallButton>
				<span className="flex-1" />
				<ToolButton
					icon={Trash2}
					label="Remove Tracker"
					danger
					disabled={readOnly || busy}
					onClick={() => {
						try {
							removeTracker(session, tracker.id);
						} catch (e) {
							setError(tracker.id, (e as Error).message);
						}
					}}
					data-testid="tracking-remove"
				/>
			</Row>
			{targets.length ? (
				<div className="px-2 pt-[2px] text-pr-small text-pr-muted" data-testid="tracking-targets">
					{targets.map((t) => (
						<div key={t.clipId} className="flex items-center gap-1">
							<Undo2 size={11} className="rotate-180 text-pr-icon" aria-hidden />
							<span className="truncate">
								Drives {seqClips?.[t.clipId]?.name || 'clip'} (
								{t.mode === 'corner-pin' ? 'Corner Pin' : 'Motion'})
							</span>
						</div>
					))}
				</div>
			) : null}
			<p className="px-2 pt-1 text-pr-small text-pr-dim">
				{clip.name ? `${clip.name}: ` : ''}drag the corners on the Program monitor to fit the surface.
			</p>
		</div>
	);
}

function sameTargets(a: { clipId: string; mode: string }[], b: { clipId: string; mode: string }[]): boolean {
	return a.length === b.length && a.every((x, i) => x.clipId === b[i]!.clipId && x.mode === b[i]!.mode);
}
