// Project panel ▸ Replace Footage… (S07:PRC-018, PRU-005): replaces the file behind a media item for every clip
// that uses it. Choose File… registers the new file with the engine (desktop: in place by path, the engine reads a
// source-range sidecar next to it; web: upload, a `.json` sidecar picked together with the video is read here).
// When the files say where they sit in the source (sidecar ranges or start timecodes), "Keep source timing" is
// offered and on by default: the clips keep showing the same source frames. The dialog lists the clips the new
// file does not hold; Replace refuses them unless "Trim them" is checked. One undo entry "Replace Footage".
import type { RegisteredMedia } from '@jasper/api';
import {
	type MediaAsset,
	parseSourceSidecar,
	type SourceSidecarInfo,
	sidecarCandidates,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Checkbox, Dialog, type HostedDialogProps, toast } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { baseName, getDesktopBridge, pickFilesInBrowser } from '../import/desktop.ts';
import { useEngine } from '../state/engine.tsx';
import { errorText } from './engine-jobs.ts';
import { planReplaceFootage, replaceFootageCommand } from './replace-footage.ts';

export const REPLACE_FOOTAGE_DIALOG = 'media.replaceFootage';
export const REPLACE_FOOTAGE_TX_LABEL = 'Replace Footage';

export type ReplaceFootageDialogProps = { session: EditorSession; mediaId: string };

type Picked = { reg: RegisteredMedia; hint: SourceSidecarInfo | null; path: string | null };

function describe(probe: MediaAsset['probe'], name: string): string {
	const vs = probe.streams.find((s) => s.type === 'video');
	const parts = [name];
	if (vs && vs.type === 'video') {
		const fps = vs.frameRate.num / vs.frameRate.den;
		parts.push(`${vs.width} × ${vs.height}`, `${Number.isInteger(fps) ? fps : fps.toFixed(3)} fps`);
		if (probe.durationFlicks !== null)
			parts.push(`${Math.round((probe.durationFlicks / 705_600_000) * fps)} frames`);
	}
	if (probe.startTimecode) parts.push(`TC ${probe.startTimecode}`);
	return parts.join(' · ');
}

/** The sidecar among picked files that belongs to `video` (`<name>.json` or `<stem>.json`), else any one JSON. */
async function sidecarFromFiles(video: File, files: File[]): Promise<SourceSidecarInfo | null> {
	const json = files.filter((f) => f.name.toLowerCase().endsWith('.json'));
	const names = sidecarCandidates(video.name).map((n) => n.toLowerCase());
	const ordered = [
		...json.filter((f) => names.includes(f.name.toLowerCase())),
		...json.filter((f) => !names.includes(f.name.toLowerCase())),
	];
	for (const f of ordered) {
		try {
			const info = parseSourceSidecar(JSON.parse(await f.text()), f.name);
			if (info) return info;
		} catch {
			// not JSON
		}
	}
	return null;
}

export function ReplaceFootageDialog(props: HostedDialogProps<ReplaceFootageDialogProps>) {
	const { session, mediaId } = props;
	const client = useEngine().client;
	const doc = session.getCommitted();
	const asset = doc.media[mediaId] as MediaAsset | undefined;
	const [picked, setPicked] = useState<Picked | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [keepChoice, setKeepChoice] = useState<boolean | null>(null);
	const [trim, setTrim] = useState(false);
	const timingKinds = asset?.kind === 'video' || asset?.kind === 'audio';

	const probe = useMemo(() => {
		if (!picked || !asset) return null;
		return planReplaceFootage(doc, mediaId, picked.reg, picked.hint, false);
	}, [picked, asset, doc, mediaId]);
	const canKeep = !!probe?.timing.ok && timingKinds;
	const keep = canKeep && (keepChoice ?? true);
	const plan = useMemo(() => {
		if (!picked || !asset) return null;
		return planReplaceFootage(doc, mediaId, picked.reg, picked.hint, keep);
	}, [picked, asset, doc, mediaId, keep]);

	const choose = async () => {
		setError(null);
		const desktop = getDesktopBridge();
		try {
			if (desktop) {
				const paths = await desktop.pickMedia();
				const path = paths[0];
				if (!path) return;
				setBusy('Registering…');
				const r = await client.registerMedia({ projectId: session.projectId, paths: [path] });
				const reg = r.items[0];
				if (!reg) throw new Error(r.errors[0]?.message ?? 'The file could not be registered');
				setPicked({ reg, hint: reg.sourceHint ?? null, path });
			} else {
				const files = await pickFilesInBrowser(document);
				const video = files.find((f) => !f.name.toLowerCase().endsWith('.json'));
				if (!video) {
					if (files.length) setError('Choose a media file (a .json sidecar may be picked with it)');
					return;
				}
				const hint = await sidecarFromFiles(video, files);
				setBusy(`Uploading ${video.name}…`);
				const reg = await client.uploadFile(video, {
					projectId: session.projectId,
					fileName: video.name,
					onProgress: ({ loaded, total }) =>
						setBusy(`Uploading ${video.name}… ${total ? Math.round((loaded / total) * 100) : 0} %`),
				});
				setPicked({ reg, hint, path: null });
			}
			setKeepChoice(null);
			setTrim(false);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(null);
		}
	};

	const blockers: string[] = [];
	if (!asset) blockers.push('The media is no longer in the project');
	if (!picked) blockers.push('Choose the new file');
	else if (asset && picked.reg.kind !== asset.kind)
		blockers.push(`The new file is ${picked.reg.kind}; this media is ${asset.kind}`);
	else if (picked.reg.fingerprint === asset?.fingerprint) blockers.push('This is the same file');
	if (plan?.uncovered.length && !trim)
		blockers.push(
			`${plan.uncovered.length} clip${plan.uncovered.length > 1 ? 's' : ''} would need frames the new file does not hold`,
		);

	const replace = () => {
		if (!picked || blockers.length || !plan) return false;
		const r = session.apply({
			label: REPLACE_FOOTAGE_TX_LABEL,
			origin: 'user',
			commands: [
				replaceFootageCommand(mediaId, picked.reg, {
					sourceRange: plan.sourceRange,
					keepSourceTiming: keep,
					trim: trim && plan.uncovered.length > 0,
					path: picked.path,
				}),
			],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Replace Footage failed');
			return false;
		}
		const res = r.results[0] as { clipIds?: string[]; trimmedClipIds?: string[] } | undefined;
		toast({
			kind: 'success',
			title: `Replaced the footage of ${asset?.originalName ?? mediaId}`,
			detail: keep
				? `${res?.clipIds?.length ?? 0} clip(s) kept on the same source frames (in-points moved ${plan.shiftFrames > 0 ? '+' : ''}${plan.shiftFrames} frames)${res?.trimmedClipIds?.length ? `, ${res.trimmedClipIds.length} trimmed` : ''}`
				: 'In-points unchanged',
		});
		props.close(true);
		return false;
	};

	const usedBy =
		plan?.clips.length ??
		Object.values(doc.sequences).reduce(
			(n, s) =>
				n + Object.values(s.clips).filter((c) => (c as { mediaId?: string }).mediaId === mediaId).length,
			0,
		);
	const timing = probe?.timing;
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Replace Footage"
			size="medium"
			primaryLabel="Replace"
			primaryDisabled={blockers.length > 0 || !!busy}
			onPrimary={replace}
			data-testid="replace-footage-dialog"
		>
			<div className="flex flex-col gap-2">
				<p className="text-pr-small text-pr-muted">
					Replaces the file of <span className="text-pr-text">{asset?.originalName ?? mediaId}</span> for the{' '}
					{usedBy} clip{usedBy === 1 ? '' : 's'} that use{usedBy === 1 ? 's' : ''} it. The clips stay where
					they are on the timeline; effects and keyframes are kept.
				</p>
				<div className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1">
					<span className="text-pr-muted">Current</span>
					<span className="min-w-0 truncate" data-testid="replace-current">
						{asset ? describe(asset.probe, asset.originalName) : mediaId}
						{asset?.sourceRange
							? ` · source frames ${asset.sourceRange.firstFrame}–${asset.sourceRange.firstFrame + asset.sourceRange.frames - 1}${asset.sourceRange.sourceName ? ` of ${asset.sourceRange.sourceName}` : ''}`
							: ''}
					</span>
					<span className="text-pr-muted">New</span>
					<span className="flex min-w-0 items-center gap-2">
						<Button busy={!!busy} onClick={() => void choose()} data-testid="replace-choose">
							{picked ? 'Choose Another…' : 'Choose File…'}
						</Button>
						<span className="min-w-0 truncate" data-testid="replace-new">
							{busy ?? (picked ? describe(picked.reg.probe, picked.reg.originalName) : '')}
						</span>
					</span>
					{picked ? (
						<>
							<span className="text-pr-muted">Source</span>
							<span className="min-w-0 text-pr-small" data-testid="replace-sidecar">
								{picked.hint
									? `${picked.hint.sidecar}: starts at frame ${picked.hint.firstFrame}${picked.hint.sourceName ? ` of ${picked.hint.sourceName}` : ''}${picked.hint.handles ? ` · handles ${picked.hint.handles[0]} / ${picked.hint.handles[1]}` : ''}`
									: picked.reg.probe.startTimecode
										? 'No source-range sidecar; start timecode only'
										: `No source-range sidecar (${baseName(picked.reg.originalName).replace(/\.[^.]+$/, '')}.json) and no timecode`}
							</span>
						</>
					) : null}
				</div>

				{picked && timingKinds ? (
					<div className="flex flex-col gap-1 rounded-pr-control border border-pr-border-subtle px-2 py-1.5">
						<div data-testid="replace-keep-timing">
							<Checkbox
								checked={keep}
								disabled={!canKeep}
								onCheckedChange={(c) => setKeepChoice(c)}
								label="Keep source timing (the clips show the same source frames)"
							/>
						</div>
						<p className="pl-[22px] text-pr-small text-pr-dim" data-testid="replace-timing">
							{timing?.ok
								? `${timing.detail}. ${keep ? `In-points move by ${plan && plan.shiftFrames > 0 ? '+' : ''}${plan?.shiftFrames ?? 0} frames.` : 'In-points stay as they are (the clips show other frames of the new file).'}`
								: `${timing?.reason ?? ''}. The in-points stay as they are.`}
						</p>
						{timing?.ok && timing.warning ? (
							<p className="pl-[22px] text-pr-small text-pr-warning">{timing.warning}</p>
						) : null}
					</div>
				) : null}

				{plan?.clips.length ? (
					<div className="text-pr-small" data-testid="replace-coverage">
						{plan.uncovered.length === 0 ? (
							<span className="text-pr-muted">
								The new file holds every frame the {plan.clips.length} clip{plan.clips.length > 1 ? 's' : ''}{' '}
								show
								{plan.clips.length > 1 ? '' : 's'}.
							</span>
						) : (
							<div className="flex flex-col gap-1">
								<span className="text-pr-warning">
									{plan.uncovered.length} clip{plan.uncovered.length > 1 ? 's need' : ' needs'} frames the new
									file does not hold:{' '}
									{plan.uncovered
										.slice(0, 4)
										.map((c) =>
											c.covered
												? `${c.name} (${c.covered.to - c.covered.from} of its frames)`
												: `${c.name} (none)`,
										)
										.join(', ')}
									{plan.uncovered.length > 4 ? ', …' : ''}
								</span>
								<div data-testid="replace-trim">
									<Checkbox
										checked={trim}
										disabled={plan.uncovered.some((c) => !c.covered)}
										onCheckedChange={setTrim}
										label="Trim them to the frames the new file holds"
									/>
								</div>
							</div>
						)}
					</div>
				) : null}

				{error || (picked && blockers.length) ? (
					<p className="text-pr-small text-pr-danger" role="alert" data-testid="replace-error">
						{error ?? blockers[0]}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}
