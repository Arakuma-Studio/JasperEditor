// Render bar (S02:TL-214, workstream `previews`): the timeline ruler's strip coloured per render-preview segment —
// green = a preview file exists (plays from the file), yellow = plays live in real time (≈), red = probably drops
// frames live (≈, the cost model of `previewSegments`), nothing = plays natively. Segments, hashes and costs come from
// `@jasper/project` (`previewSegments`); which hashes have files from the engine (previews/store.ts).
import {
	type ProjectDocument,
	previewSegments,
	type RenderAudioPreviewSegment,
	type RenderPreviewSegment,
} from '@jasper/project';

export type RenderBarState = 'green' | 'yellow' | 'red';

export type RenderSegment = {
	startFrame: number;
	endFrame: number;
	state: RenderBarState;
	/** Tooltip: why the segment is yellow/red, or that it is rendered. */
	title: string;
};

/** The preview segments of a sequence (never throws: a document that cannot be drawn has none). */
export function segmentsOf(doc: ProjectDocument, sequenceId: string): RenderPreviewSegment[] {
	try {
		return previewSegments(doc, sequenceId);
	} catch {
		return [];
	}
}

const COLOR: Record<RenderPreviewSegment['need'], RenderBarState | null> = {
	none: null,
	realtime: 'yellow',
	render: 'red',
};

function titleOf(s: RenderPreviewSegment, state: RenderBarState): string {
	if (state === 'green') return 'Rendered: plays from its preview file';
	const cost = `≈ ${s.costMs} ms per frame (budget ${s.budgetMs} ms)`;
	const why = s.reasons.length ? ` — ${s.reasons.join(', ')}` : '';
	return state === 'red'
		? `Needs rendering to play in real time: ${cost}${why}`
		: `Plays in real time without rendering: ${cost}${why}`;
}

/** Render-bar spans: one per segment (green when its hash has a file), adjacent spans of the same state merged. */
export function renderBarSpans(
	segments: readonly RenderPreviewSegment[],
	rendered: ReadonlySet<string> | null,
): RenderSegment[] {
	const out: RenderSegment[] = [];
	for (const s of segments) {
		const state = rendered?.has(s.hash) ? 'green' : COLOR[s.need];
		if (!state) continue;
		const last = out[out.length - 1];
		if (last && last.endFrame === s.startFrame && last.state === state && state === 'green') {
			last.endFrame = s.startFrame + s.frames;
			continue;
		}
		out.push({
			startFrame: s.startFrame,
			endFrame: s.startFrame + s.frames,
			state,
			title: titleOf(s, state),
		});
	}
	return out;
}

/** Spans of the Program monitor's preview playback (only segments whose file exists). */
export function playbackSpans(
	segments: readonly (RenderPreviewSegment | RenderAudioPreviewSegment)[],
	rendered: ReadonlySet<string> | null,
	urlTemplate: string | null,
): { start: number; frames: number; url: string }[] {
	if (!rendered || !urlTemplate) return [];
	const out: { start: number; frames: number; url: string }[] = [];
	for (const s of segments)
		if (rendered.has(s.hash))
			out.push({ start: s.startFrame, frames: s.frames, url: urlTemplate.replace('{hash}', s.hash) });
	return out;
}
