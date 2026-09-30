// Render bar segments (S02:TL-214, ARCHITECTURE §10.4) from the client-side engine affinity in
// @jasper/project. M1 has no render cache, so green never appears: yellow = live-previewable,
// red = motion graphics (fframes master not known to be ready) and nothing else.
import { buildRenderSnapshot, engineAffinity, type MediaHandle, type ProjectDocument } from '@jasper/project';

export type RenderState = 'green' | 'yellow' | 'red';
export type RenderSegment = { startFrame: number; endFrame: number; state: RenderState };

const stubMedia = (): MediaHandle => ({
	url: '',
	proxyUrl: null,
	kind: 'video',
	width: null,
	height: null,
	durationFlicks: null,
	hasAudio: false,
	rotation: 0,
});

const cache = new WeakMap<object, RenderSegment[]>();

/** Segments for a sequence, memoized by the sequence object (recomputed only on commits). */
export function renderSegments(doc: ProjectDocument, sequenceId: string): RenderSegment[] {
	const seq = doc.sequences[sequenceId];
	if (!seq) return [];
	const hit = cache.get(seq);
	if (hit) return hit;
	let out: RenderSegment[] = [];
	try {
		const snap = buildRenderSnapshot(doc, sequenceId, { resolveMedia: stubMedia, resolveFont: () => null });
		const { ranges } = engineAffinity(snap);
		out = ranges
			.filter((r) => r.engines.length > 0)
			.map((r) => ({
				startFrame: r.start,
				endFrame: r.end,
				state: r.engines.includes('fframes') ? ('red' as const) : ('yellow' as const),
			}));
	} catch {
		out = [];
	}
	cache.set(seq, out);
	return out;
}
