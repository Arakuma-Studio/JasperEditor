// sound-design (spec 12 §2.7 "Insert"): the text that follows the pointer while a library sound is dragged over the
// timeline: "peak → 00;00;01;15", "<title> → A2" (or "new track SFX 1 (A4)") and which edge snapped, in the UI
// language. A drag from another window has no plan: its destination is the audio track under the pointer, named by
// its label ("A2"), never by its internal id. Pure.
import type { Sequence } from '@jasper/project';
import { t, withoutContext } from '../../../i18n/runtime.ts';
import type { SoundDropTarget } from './sound-drop.ts';

/** The word for an aligned point / snapped edge (peak, start, end). */
export function soundEdgeLabel(edge: 'peak' | 'start' | 'end'): string {
	return withoutContext(
		edge === 'peak'
			? t('peak [sound point]')
			: edge === 'end'
				? t('end [sound point]')
				: t('start [sound point]'),
	);
}

/** "A2" for an audio track id of the sequence (null when it is not one of its audio tracks). */
export function audioTrackLabel(seq: Pick<Sequence, 'audioTracks'>, trackId: string | null): string | null {
	if (!trackId) return null;
	const i = seq.audioTracks.findIndex((x) => x.id === trackId);
	return i >= 0 ? `A${i + 1}` : null;
}

/** Where the dragged sound goes ("A2", "new track SFX 1 (A4)"). */
export function soundDropDestination(
	seq: Pick<Sequence, 'audioTracks'>,
	target: Pick<SoundDropTarget, 'plan' | 'preferredTrackId'>,
): string {
	const p = target.plan;
	if (p)
		return p.track.kind === 'new' ? t('new track {0} ({1})', p.track.name, p.track.label) : p.track.label;
	return audioTrackLabel(seq, target.preferredTrackId) ?? 'A1';
}

/** The tooltip lines of a sound drag over the timeline. */
export function soundDropTooltip(
	seq: Pick<Sequence, 'audioTracks'>,
	target: Pick<SoundDropTarget, 'plan' | 'preferredTrackId' | 'align' | 'snapEdge'>,
	title: string | null,
	timecode: string,
): string[] {
	const where = soundDropDestination(seq, target);
	return [
		`${soundEdgeLabel(target.align)} → ${timecode}`,
		`${title ?? t('Sound')} → ${where}`,
		...(target.snapEdge && target.snapEdge !== target.align
			? [t('{0} edge snapped', soundEdgeLabel(target.snapEdge))]
			: []),
	];
}
