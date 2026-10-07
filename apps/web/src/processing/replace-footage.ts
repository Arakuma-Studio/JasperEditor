// Replace Footage (S07:PRC-018, Project panel ▸ Replace Footage…): what replacing a media's file does to the
// clips that use it, and the `media.relink` command. Pure (no React) so the dialog, tests and agents agree.
//
// "Keep source timing" moves every clip of the media by the offset between the two files (declared source
// ranges — a sidecar picked/found with the new file, or the range the media already records — else start
// timecodes; `sourceTimingShift`), so each clip keeps showing the same source frames at the same timeline
// place. Without it the in-points stay as they are (a plain re-link to a different file). Either way every clip
// is checked against the new file's length; clips it does not hold are refused or, when asked, trimmed.
import type { RegisteredMedia } from '@jasper/api';
import {
	type Clip,
	type ClipContentTiming,
	type Command,
	coverageTolerance,
	coveredClipFrames,
	frameShiftFlicks,
	isBoundedContent,
	type MediaAsset,
	mediaFrameRate,
	type ProjectDocument,
	type SourceRange,
	type SourceSidecarInfo,
	type SourceTimingShift,
	shiftedTiming,
	sourceRangeFromSidecar,
	sourceTimingShift,
} from '@jasper/project';
import { buildMediaAsset } from '../import/assets.ts';

export type ReplaceClipCheck = {
	clipId: string;
	name: string;
	/** Timeline frames the new file holds, `[from, to)` relative to the clip start; null = none. */
	covered: { from: number; to: number } | null;
	whole: boolean;
};

export type ReplacePlan = {
	sourceRange: SourceRange | null;
	timing: SourceTimingShift;
	/** Content shift applied when keeping source timing (frames of the file's rate; 0 otherwise). */
	shiftFrames: number;
	clips: ReplaceClipCheck[];
	uncovered: ReplaceClipCheck[];
};

/** Clips (any sequence) that use `mediaId`. */
function clipsUsing(doc: ProjectDocument, mediaId: string) {
	const out: { clip: Clip; seq: ProjectDocument['sequences'][string] }[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips))
			if ((c as { mediaId?: string }).mediaId === mediaId) out.push({ clip: c, seq });
	return out;
}

export function planReplaceFootage(
	doc: ProjectDocument,
	mediaId: string,
	reg: Pick<RegisteredMedia, 'originalName' | 'probe'> & { fingerprint?: string },
	hint: SourceSidecarInfo | null,
	keepSourceTiming: boolean,
): ReplacePlan {
	const asset = doc.media[mediaId] as MediaAsset;
	const sourceRange = hint
		? sourceRangeFromSidecar(doc, hint, {
				probe: reg.probe,
				id: mediaId,
				...(reg.fingerprint ? { fingerprint: reg.fingerprint } : {}),
			})
		: null;
	const timing = sourceTimingShift(asset, { originalName: reg.originalName, probe: reg.probe, sourceRange });
	const shiftFrames = keepSourceTiming && timing.ok ? timing.shiftFrames : 0;
	const shift = keepSourceTiming && timing.ok ? frameShiftFlicks(timing.shiftFrames, timing.frameRate) : 0;
	const rate = mediaFrameRate(reg);
	const clips = clipsUsing(doc, mediaId).map(({ clip, seq }): ReplaceClipCheck => {
		const seqRate = seq.settings.frameRate;
		const covered = isBoundedContent(clip)
			? coveredClipFrames(
					shiftedTiming(clip as unknown as ClipContentTiming, shift),
					seqRate,
					reg.probe.durationFlicks,
					coverageTolerance(seqRate, clip.speed.rate, rate),
				)
			: { from: 0, to: clip.duration };
		return {
			clipId: clip.id,
			name: clip.name,
			covered,
			whole: !!covered && covered.from === 0 && covered.to === clip.duration,
		};
	});
	return { sourceRange, timing, shiftFrames, clips, uncovered: clips.filter((c) => !c.whole) };
}

/** The Replace Footage command (`media.relink` with `replace`, every locator of the new file). */
export function replaceFootageCommand(
	mediaId: string,
	reg: RegisteredMedia,
	opts: { sourceRange: SourceRange | null; keepSourceTiming: boolean; trim: boolean; path?: string | null },
): Command {
	const a = buildMediaAsset(reg, { id: mediaId, now: new Date(0).toISOString(), path: opts.path ?? null });
	return {
		type: 'media.relink',
		mediaId,
		replace: true,
		locator: a.locators[0],
		locators: a.locators,
		fingerprint: a.fingerprint,
		probe: a.probe,
		sizeBytes: a.sizeBytes,
		originalName: a.originalName,
		container: a.container,
		sourceRange: opts.sourceRange,
		...(opts.keepSourceTiming ? { keepSourceTiming: true } : {}),
		...(opts.trim ? { fit: 'trim' } : {}),
	} as unknown as Command;
}
