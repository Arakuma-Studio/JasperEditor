// "Apply Tracking" dialog (S09:TRU-001, TRK-020…023): pick a target among the clips overlapping the plate on
// tracks above it, and a mode — Corner Pin (planar trackers), Position, or Position + Scale + Rotation. Applying
// is one history entry "Apply Tracking".
import { type Clip, findTracker, formatTimecode } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx, Dialog, type HostedDialogProps } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { type ApplyMode, activeSeq, applyCandidates, applyTracking } from './actions.ts';

export type ApplyTrackingDialogProps = { session: EditorSession; trackerId: string; targetClipId?: string };

const MODES: { id: ApplyMode; label: string; hint: string; planarOnly?: boolean }[] = [
	{
		id: 'corner-pin',
		label: 'Corner Pin',
		hint: 'Pins the clip’s four corners to the tracked surface (perspective)',
		planarOnly: true,
	},
	{ id: 'position', label: 'Position', hint: 'The clip’s anchor follows the tracked centre' },
	{
		id: 'position-scale-rotation',
		label: 'Position, Scale and Rotation',
		hint: 'Follows the centre, size and angle of the tracked surface',
		planarOnly: true,
	},
];

export function ApplyTrackingDialog(props: HostedDialogProps<ApplyTrackingDialogProps>) {
	const { session, trackerId, close, targetClipId } = props;
	const [open, setOpen] = useState(true);
	const info = useMemo(() => {
		const doc = session.getState().document;
		const loc = findTracker(doc, trackerId);
		const seq = activeSeq(session);
		if (!loc || !seq) return null;
		return { loc, seq, candidates: applyCandidates(seq, loc.clip) };
	}, [session, trackerId]);
	const planar = info?.loc.tracker.kind === 'planar';
	const linked = info?.candidates.find(
		(c) => (c as { trackedBy?: { trackerId: string } }).trackedBy?.trackerId === trackerId,
	);
	const [target, setTarget] = useState<string | null>(
		(targetClipId && info?.candidates.some((c) => c.id === targetClipId) ? targetClipId : null) ??
			linked?.id ??
			info?.candidates[0]?.id ??
			null,
	);
	const [mode, setMode] = useState<ApplyMode>(planar ? 'corner-pin' : 'position');
	const [error, setError] = useState<string | null>(null);
	const finish = () => {
		setOpen(false);
		close();
	};
	const apply = () => {
		if (!info || !target) return false;
		try {
			applyTracking(session, trackerId, target, mode);
		} catch (e) {
			setError((e as Error).message);
			return false;
		}
		return true; // the dialog closes itself (onOpenChange → finish)
	};
	const trackName = (c: Clip) => {
		const i = info?.seq.videoTracks.findIndex((t) => t.id === c.trackId) ?? -1;
		return i >= 0 ? `V${i + 1}` : '';
	};
	const tc = (f: number) =>
		info ? formatTimecode(f, info.seq.settings.frameRate, { dropFrame: info.seq.settings.dropFrame }) : '';
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) finish();
			}}
			title="Apply Tracking"
			description="Bake the tracker onto a clip as keyframes"
			size="small"
			primaryLabel="Apply"
			primaryDisabled={!target}
			onPrimary={apply}
			data-testid="tracking-apply-dialog"
		>
			{!info ? (
				<p className="text-pr-ui text-pr-muted">The tracker no longer exists.</p>
			) : (
				<div className="flex flex-col gap-3 text-pr-ui">
					<p className="text-pr-muted">
						<span className="text-pr-text">{info.loc.tracker.name}</span> on{' '}
						<span className="text-pr-text">{info.loc.clip.name || 'clip'}</span>
						{info.loc.tracker.samples ? '' : ' — not tracked yet: the reference geometry is used'}
					</p>
					<fieldset className="flex flex-col gap-1">
						<legend className="mb-1 text-pr-small text-pr-muted">Target clip</legend>
						{info.candidates.length === 0 ? (
							<p className="text-pr-small text-pr-warning" data-testid="tracking-apply-empty">
								Place the clip to follow the track on a track above {trackName(info.loc.clip)}, overlapping
								the plate.
							</p>
						) : (
							<div
								className="max-h-[180px] overflow-auto rounded-pr-control border border-pr-border-subtle bg-pr-field-deep"
								role="radiogroup"
								aria-label="Target clip"
							>
								{info.candidates.map((c) => (
									<label
										key={c.id}
										className={cx(
											'flex h-[var(--pr-row-h)] cursor-pointer items-center gap-2 px-2',
											target === c.id ? 'bg-pr-selected text-pr-strong' : 'text-pr-text hover:bg-pr-hover',
										)}
										data-testid={`tracking-target-${c.id}`}
									>
										<input
											type="radio"
											name="tracking-target"
											checked={target === c.id}
											onChange={() => setTarget(c.id)}
											className="size-[12px] accent-[var(--pr-accent)]"
										/>
										<span className="w-[24px] shrink-0 text-pr-small text-pr-muted">{trackName(c)}</span>
										<span className="min-w-0 flex-1 truncate">{c.name || c.kind}</span>
										<span className="shrink-0 text-pr-small text-pr-muted pr-tabular">{tc(c.start)}</span>
									</label>
								))}
							</div>
						)}
					</fieldset>
					<fieldset className="flex flex-col gap-1" aria-label="Apply as">
						<legend className="mb-1 text-pr-small text-pr-muted">Apply as</legend>
						{MODES.map((m) => {
							const disabled = !!m.planarOnly && !planar;
							return (
								<label
									key={m.id}
									className={cx(
										'flex items-start gap-2',
										disabled ? 'cursor-default text-pr-dim' : 'cursor-pointer text-pr-text',
									)}
									data-testid={`tracking-mode-${m.id}`}
								>
									<input
										type="radio"
										name="tracking-mode"
										checked={mode === m.id}
										disabled={disabled}
										onChange={() => setMode(m.id)}
										className="mt-[3px] size-[12px] accent-[var(--pr-accent)]"
									/>
									<span className="flex flex-col">
										<span>{m.label}</span>
										<span className="text-pr-small text-pr-muted">{m.hint}</span>
									</span>
								</label>
							);
						})}
					</fieldset>
					{error ? (
						<p className="text-pr-small text-pr-danger" role="alert">
							{error}
						</p>
					) : null}
				</div>
			)}
		</Dialog>
	);
}
