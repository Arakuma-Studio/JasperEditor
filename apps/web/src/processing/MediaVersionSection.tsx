// Properties ▸ Media Version (S07:PRU-003, `clipSections`): a dropdown "Original / <each version of the same
// original>" that swaps the selected video clips with `clip.replaceSource` (one undo entry) keeping them on the
// same source frames (S07:PRC-016), the source frames the current version holds and the clip's handles in it,
// and a Process… button that opens the Process Clip dialog for them. A version that does not hold every frame
// of the clips asks whether to trim them (S07:PRC-017).
import { type Clip, clipHandles, type MediaAsset, type ProjectDocument } from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { Button, Select, toast } from '@jasper/ui';
import type { ClipSectionProps } from '../extensions/index.ts';
import { openProcessForClips, switchMediaVersionInteractive } from './actions.ts';
import { originalOf, processedSteps, recipeLabel, versionFrames, versionLabel, versionsOf } from './model.ts';

const MIXED = '__mixed__';

function sizeOf(m: MediaAsset | undefined): string | null {
	const vs = m?.probe.streams.find((s) => s.type === 'video');
	return vs && vs.type === 'video' ? `${vs.width} × ${vs.height}` : null;
}

const fmtHandle = (n: number) => (Number.isFinite(n) ? String(n) : '∞');

/** "Handles 12 / 8 frames" of one clip in its current media (TRN-003: what transitions and trims can use). */
function handlesText(doc: ProjectDocument, clip: Clip): string | null {
	const seq = Object.values(doc.sequences).find((s) => s.clips[clip.id]);
	if (!seq) return null;
	const h = clipHandles(doc, seq, seq.clips[clip.id]!);
	return `Handles ${fmtHandle(h.head)} / ${fmtHandle(h.tail)} frames`;
}

export function MediaVersionSection({ session, clips }: ClipSectionProps) {
	const doc = useStoreSelector(session.store, (s) => s.document) as ProjectDocument;
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const video = clips.filter(
		(c): c is typeof c & { mediaId: string } => c.kind === 'video' && !!(c as { mediaId?: string }).mediaId,
	);
	const originals = new Set(video.map((c) => originalOf(doc, c.mediaId)));
	if (!video.length) return null;
	if (originals.size !== 1) {
		return (
			<p className="px-2 py-1 text-pr-small text-pr-muted" data-testid="media-version">
				The selected clips use different media.
			</p>
		);
	}
	const original = [...originals][0] as string;
	const versions = versionsOf(doc, original);
	const current = new Set(video.map((c) => c.mediaId));
	const value = current.size === 1 ? ([...current][0] as string) : MIXED;
	const currentAsset = value === MIXED ? undefined : (doc.media[value] as MediaAsset | undefined);
	const originalName = (doc.media[original] as MediaAsset | undefined)?.originalName ?? original;
	const steps = processedSteps(currentAsset);
	const frames = value === MIXED ? null : versionFrames(doc, value);
	const isOriginal = value === original;
	const live = video.length === 1 ? handlesText(doc, video[0] as Clip) : null;
	const others = versions.filter((id) => id !== original);
	const kind = others.every((id) => processedSteps(doc.media[id] as MediaAsset | undefined))
		? 'processed'
		: 'other';
	const options = [
		...(value === MIXED ? [{ value: MIXED, label: 'Mixed', disabled: true }] : []),
		...versions.map((id) => ({ value: id, label: versionLabel(doc, id) })),
	];
	const what = steps ? recipeLabel(steps) : isOriginal ? null : currentAsset?.originalName;
	return (
		<div className="flex flex-col gap-1 px-2 py-1" data-testid="media-version">
			<div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
				<span className="text-pr-muted">Version</span>
				<Select
					label="Media version"
					className="min-w-0"
					value={value}
					disabled={readOnly || versions.length < 2}
					onValueChange={(id) => {
						if (id === MIXED) return;
						void switchMediaVersionInteractive(
							session,
							video.map((c) => c.id),
							id,
						).then((r) => {
							if (r && !r.ok)
								toast({ kind: 'warning', title: 'Could not switch the version', detail: r.message });
						});
					}}
					options={options}
				/>
			</div>
			<p
				className="truncate pl-[80px] text-pr-small text-pr-dim"
				data-testid="media-version-info"
				title={originalName}
			>
				{what
					? [what, frames, sizeOf(currentAsset), `of ${originalName}`].filter(Boolean).join(' · ')
					: versions.length > 1
						? `${others.length} ${kind} version${others.length > 1 ? 's' : ''} available`
						: 'No processed versions yet'}
			</p>
			{live ? (
				<p className="truncate pl-[80px] text-pr-small text-pr-dim" data-testid="media-version-handles">
					{live}
				</p>
			) : null}
			<div className="pl-[80px]">
				<Button
					disabled={readOnly}
					onClick={() =>
						openProcessForClips(
							session,
							video.map((c) => c.id),
						)
					}
					data-testid="media-version-process"
				>
					Process…
				</Button>
			</div>
		</div>
	);
}
