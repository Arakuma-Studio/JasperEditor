// The kept spans of a sequence's dialogue track, for the repeats-in-the-edit check (`edit-repeats.ts`;
// docs/wp-notes/transcript-cleanup.md "Repeats at cuts"). Pure.
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import type { EditSpan } from './edit-repeats.ts';
import { type CleanupRefusal, type CleanupScope, speechClipsOf } from './sequence.ts';

/**
 * The kept spans of a sequence's dialogue track — the audio track whose speech clips (transcribed, 100 % speed) play
 * the most frames in the scope — in sequence order.
 */
export function editSpans(
	doc: Pick<ProjectDocument, 'transcripts'>,
	seq: Sequence,
	scope: CleanupScope = {},
): { ok: true; spans: EditSpan[]; trackId: string } | CleanupRefusal {
	const sc = speechClipsOf(doc, seq, scope);
	if (!sc.ok) return sc;
	const r = scope.range ?? null;
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	const extent = (c: { start: number; duration: number }): [number, number] => [
		Math.max(c.start, r?.from ?? c.start),
		Math.min(c.start + c.duration, r?.to ?? c.start + c.duration),
	];
	const frames = new Map<string, number>();
	for (const c of sc.clips) {
		const [a, b] = extent(c);
		frames.set(c.trackId, (frames.get(c.trackId) ?? 0) + Math.max(0, b - a));
	}
	const trackId = [...frames.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
	const spans: EditSpan[] = [];
	for (const c of sc.clips) {
		if (c.trackId !== trackId) continue;
		const [a, b] = extent(c);
		if (b <= a) continue;
		spans.push({
			clipId: c.id,
			mediaId: c.mediaId,
			stream: c.channels.streamIndex,
			seqStart: a,
			seqEnd: b,
			mediaStart: c.sourceIn + (a - c.start) * F,
			mediaEnd: c.sourceIn + (b - c.start) * F,
		});
	}
	spans.sort((x, y) => x.seqStart - y.seqStart);
	return { ok: true, spans, trackId };
}
