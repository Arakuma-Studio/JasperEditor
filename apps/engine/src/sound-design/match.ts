// Which stored cue a derived cue stands for (shared by the cue route and the sound-design plan).
import { type CueAnchor, type DerivedCue, type Sequence, soundCuesOf } from '@jasper/project';

/** Keys sorted at every depth: two anchors with the same content compare equal. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	if (v && typeof v === 'object')
		return `{${Object.keys(v)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	return JSON.stringify(v) ?? 'null';
}

/**
 * The stored cue each derived cue stands for: one with the same anchor (or one of the merged anchors), else one at
 * the same frame with the same kind. A stored cue matches at most one suggestion.
 */
export function matchStoredCues(seq: Sequence, cues: readonly DerivedCue[]): (string | null)[] {
	const stored = soundCuesOf(seq);
	const byAnchor = new Map<string, string>();
	const byFrameKind = new Map<string, string>();
	for (const c of stored) {
		if (c.anchor) byAnchor.set(canonical(c.anchor), c.id);
		const k = `${c.frame}|${c.kind}`;
		if (!byFrameKind.has(k)) byFrameKind.set(k, c.id);
	}
	const used = new Set<string>();
	return cues.map((d) => {
		for (const a of [d.anchor, ...(d.also ?? [])] as CueAnchor[]) {
			const id = byAnchor.get(canonical(a));
			if (id && !used.has(id)) {
				used.add(id);
				return id;
			}
		}
		const id = byFrameKind.get(`${d.frame}|${d.kind}`);
		if (id && !used.has(id)) {
			used.add(id);
			return id;
		}
		return null;
	});
}

