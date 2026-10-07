// `mixFingerprint`: a hash of everything a sequence's mix depends on (audio tracks and their clips, submixes, the Mix
// without its loudness settings, audio transitions, the media fingerprints and nested sequences they play). A stored
// loudness analysis whose `mixHash` differs is stale (audio-mix).
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { fnv1a64 } from '../structure/nest.ts';

const AUDIO_KINDS = new Set(['audio', 'nest-audio', 'synthetic-audio']);

function stable(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
	const keys = Object.keys(v as object).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

function parts(doc: ProjectDocument, seq: Sequence, seen: Set<string>, out: unknown[]): void {
	if (seen.has(seq.id)) return;
	seen.add(seq.id);
	const audioTrackIds = new Set([...seq.audioTracks, ...(seq.submixTracks ?? [])].map((t) => t.id));
	const clips = Object.values(seq.clips)
		.filter((c: Clip) => AUDIO_KINDS.has(c.kind) && audioTrackIds.has(c.trackId))
		.sort((a, b) => a.id.localeCompare(b.id));
	const { loudness: _l, ...master } = seq.master;
	out.push({
		rate: seq.settings.audioSampleRate,
		layout: seq.settings.masterLayout,
		fps: seq.settings.frameRate,
		tracks: seq.audioTracks,
		submixes: seq.submixTracks ?? [],
		master,
		clips,
		transitions: Object.values(seq.transitions)
			.filter((t) => audioTrackIds.has(t.trackId))
			.sort((a, b) => a.id.localeCompare(b.id)),
	});
	for (const c of clips) {
		const r = c as { mediaId?: string; sequenceId?: string; syntheticId?: string };
		if (r.mediaId) out.push({ media: r.mediaId, fp: doc.media[r.mediaId]?.fingerprint ?? null });
		if (r.syntheticId) out.push({ synthetic: doc.synthetics[r.syntheticId] ?? null });
		const nested = r.sequenceId ? doc.sequences[r.sequenceId] : undefined;
		if (nested) parts(doc, nested as Sequence, seen, out);
	}
}

/** Hash of the inputs of a sequence's mix (independent of key order in the document). */
export function mixFingerprint(doc: ProjectDocument, sequenceId: string): string {
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	if (!seq) return '';
	const out: unknown[] = [];
	parts(doc, seq, new Set(), out);
	return fnv1a64(stable(out));
}
