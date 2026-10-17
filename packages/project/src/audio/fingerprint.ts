// `mixFingerprint`: a hash of everything a sequence's mix depends on (audio tracks and their clips, submixes, the Mix
// without its loudness settings, audio transitions, the media fingerprints and interpretations and the nested sequences
// they play). Entity ids and names are not part of it: they name things, they do not change the sound — every id is replaced by
// its order of first appearance and clips are ordered by where they play, so the same mix built again (a re-applied
// dip, an accepted proposal measured on its preview, a copy) has the same fingerprint (sound-design Phase 4
// verification; WP4.2a dropped keyframe ids only). A stored loudness analysis whose `mixHash` differs is stale.
import { looksLikeId } from '../ids.ts';
import { mediaTimeMap } from '../interpret/model.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { fnv1a64 } from '../structure/nest.ts';

const AUDIO_KINDS = new Set(['audio', 'nest-audio', 'synthetic-audio']);

/** A keyframe: its id names it, it does not change the sound. */
const isKeyframe = (o: object) => 'time' in o && 'value' in o && 'interpolation' in o;

/** Serialises `v` with sorted keys; entity ids (values and keys) become `#<order of first appearance>`. */
function stable(v: unknown, ids: Map<string, string>, depth = 0): string {
	if (depth > 200) return 'null';
	if (typeof v === 'string' && looksLikeId(v)) return JSON.stringify(canon(v, ids));
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map((x) => stable(x, ids, depth + 1)).join(',')}]`;
	// Keyframe ids are left out altogether (WP4.2a: a curve written again is the same mix), and so are names (a
	// renamed clip, track or submix sounds the same) and keys holding undefined, as JSON drops them (WP6.5b: the engine
	// measures a JSON copy of the edit, an editor session checks its in-memory document: both must hash the same).
	const keys = Object.keys(v as object)
		.filter(
			(k) =>
				!(k === 'id' && isKeyframe(v as object)) &&
				k !== 'name' &&
				(v as Record<string, unknown>)[k] !== undefined,
		)
		.sort();
	return `{${keys
		.map(
			(k) =>
				`${JSON.stringify(looksLikeId(k) ? canon(k, ids) : k)}:${stable((v as Record<string, unknown>)[k], ids, depth + 1)}`,
		)
		.join(',')}}`;
}

function canon(id: string, ids: Map<string, string>): string {
	let c = ids.get(id);
	if (c === undefined) {
		c = `#${ids.size}`;
		ids.set(id, c);
	}
	return c;
}

/** The frame of a transition's cut (ordering only: its clips' edges, not their ids). */
function cutOf(seq: Sequence, t: { outgoingClipId: string | null; incomingClipId: string | null }): number {
	const out = t.outgoingClipId ? seq.clips[t.outgoingClipId] : undefined;
	if (out) return out.start + out.duration;
	const inc = t.incomingClipId ? seq.clips[t.incomingClipId] : undefined;
	return inc ? inc.start : 0;
}

function parts(doc: ProjectDocument, seq: Sequence, seen: Set<string>, out: unknown[]): void {
	if (seen.has(seq.id)) return;
	seen.add(seq.id);
	const trackOrder = new Map([...seq.audioTracks, ...(seq.submixTracks ?? [])].map((t, i) => [t.id, i]));
	// ordered by where they play (track, start, length), not by id; the id breaks only full ties (overlaps in handles)
	const clips = Object.values(seq.clips)
		.filter((c: Clip) => AUDIO_KINDS.has(c.kind) && trackOrder.has(c.trackId))
		.sort(
			(a, b) =>
				trackOrder.get(a.trackId)! - trackOrder.get(b.trackId)! ||
				a.start - b.start ||
				a.duration - b.duration ||
				a.id.localeCompare(b.id),
		);
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
			.filter((t) => trackOrder.has(t.trackId))
			.sort(
				(a, b) =>
					trackOrder.get(a.trackId)! - trackOrder.get(b.trackId)! ||
					cutOf(seq, a) - cutOf(seq, b) ||
					a.duration - b.duration ||
					a.id.localeCompare(b.id),
			),
	});
	for (const c of clips) {
		const r = c as { mediaId?: string; sequenceId?: string; syntheticId?: string };
		if (r.mediaId) {
			const asset = doc.media[r.mediaId];
			// Interpret Footage (assumed frame rate, loop) changes how the media plays (the snapshot's `mediaTime`);
			// only hashed when set, so analyses of uninterpreted media stay current.
			const time = asset ? mediaTimeMap(asset) : null;
			out.push({ media: r.mediaId, fp: asset?.fingerprint ?? null, ...(time ? { time } : {}) });
		}
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
	return fnv1a64(stable(out, new Map()));
}
