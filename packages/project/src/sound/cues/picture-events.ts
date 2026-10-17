// Picture events of a range, every one (spec 12 §4 P6-E6; wp-note "Phase 6 → WP-E3"): the listening transcript matches
// each cut and transition to the sound that answers it, so it needs all of them — not the cue suggestions `deriveCues`
// keeps after its density budgets and dialogue rules. The same detection as the `edits` and `transitions` sources
// (through edits and edits under a transition are not cuts; a transition is at its visual centre). Pure; never throws.
import type { ProjectDocument } from '../../schema/document.ts';
import { sequenceDuration } from '../../derive/index.ts';
import { deriveEditCues } from './edits.ts';
import { deriveTransitionCues } from './transitions.ts';
import { makeContext } from './util.ts';

export type PictureEditEvent = {
	kind: 'cut' | 'transition';
	/** The cue source's key: `edit:<track>:<out>><in>`, `transition:<id>`. */
	key: string;
	frame: number;
	/** "Cut on V1: 'A' → 'B'", "Cross Dissolve, 0.5 s on V1 between 'A' and 'B'". */
	label: string;
	/** A transition's span (frames, end exclusive). */
	window?: { start: number; end: number };
};

/** The cuts and transitions of `[range.start, range.end)` (default the whole sequence), in frame order. */
export function pictureEditEvents(
	doc: ProjectDocument,
	sequenceId: string,
	range?: { start: number; end: number },
): PictureEditEvent[] {
	try {
		const seq = doc?.sequences?.[sequenceId];
		if (!seq || typeof seq !== 'object' || !seq.clips) return [];
		let duration = 0;
		try {
			duration = sequenceDuration(seq);
		} catch {
			duration = 0;
		}
		if (!Number.isFinite(duration) || duration < 0) duration = 0;
		const start = Number.isFinite(range?.start) ? Math.max(0, Math.floor(range!.start)) : 0;
		const end = Number.isFinite(range?.end) ? Math.min(duration, Math.ceil(range!.end)) : duration;
		const ctx = makeContext(doc, seq, duration, { start: Math.min(start, duration), end: Math.max(start, end) }, () => {});
		const out: PictureEditEvent[] = [];
		for (const c of deriveEditCues(ctx, { respectDialogue: false }).cues)
			out.push({ kind: 'cut', key: c.key, frame: c.frame, label: c.reason });
		for (const c of deriveTransitionCues(ctx))
			out.push({
				kind: 'transition',
				key: c.key,
				frame: c.frame,
				label: c.reason,
				...(c.window ? { window: { start: c.window.start, end: c.window.end } } : {}),
			});
		return out.sort((a, b) => a.frame - b.frame || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	} catch {
		return [];
	}
}
