// Older copies of a library sound (WP6.5b): registration writes a new managed copy whenever its rules change (lead
// silence in Phase 1, PCM for lossy sources, trailing silence in "Fix: SFX tail truncation", long sounds and the
// narrowest exact PCM in WP6.5b), and a copy has its own fingerprint — so a project holding an older copy got a SECOND
// media of the same sound on its next insert. A copy is always the same sound (`soundId` is the library file's content
// fingerprint) with some silence in front and after it, so an older copy can be replaced by the new one in place: the
// content time of every clip moves by the difference of the lead silences and each clip plays the same samples
// (`media.upgradeLibraryCopy`). Pure; never throws.
import { FLICKS_PER_SECOND } from '../time.ts';
import { type LibraryProvenance, readLibraryProvenance } from './provenance.ts';

/** Largest difference (s) between the lengths of the sound inside two copies that are still the same sound. */
export const LIBRARY_COPY_LENGTH_TOLERANCE_SEC = 0.05;

const sec = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * How far (content flicks) the content of a clip moves from an older copy to a new copy of the same library sound:
 * the new lead silence minus the old one (exact: both are whole samples). Refused when they are not copies of the same
 * sound, or when the sound inside them differs in length by more than `LIBRARY_COPY_LENGTH_TOLERANCE_SEC` (another
 * sound under the same id, or a broken probe).
 */
export function libraryCopyShift(
	from: { library: unknown; durationFlicks: number | null | undefined },
	to: { library: unknown; durationFlicks: number | null | undefined },
): { ok: true; shiftFlicks: number } | { ok: false; reason: string } {
	const a = readLibraryProvenance(from.library);
	const b = readLibraryProvenance(to.library);
	if (!a || !b) return { ok: false, reason: 'both media must be Sound Library sounds' };
	if (a.soundId !== b.soundId)
		return { ok: false, reason: `not the same library sound (${a.soundId}, ${b.soundId})` };
	const da = sec(from.durationFlicks) / FLICKS_PER_SECOND;
	const db = sec(to.durationFlicks) / FLICKS_PER_SECOND;
	if (!(da > 0) || !(db > 0)) return { ok: false, reason: 'a copy has no length' };
	const inner = (d: number, p: LibraryProvenance) => d - sec(p.leadSilenceSec) - sec(p.trailSilenceSec);
	const diff = Math.abs(inner(da, a) - inner(db, b));
	if (!(diff <= LIBRARY_COPY_LENGTH_TOLERANCE_SEC))
		return {
			ok: false,
			reason: `the copies do not hold the same sound (lengths differ by ${Math.round(diff * 1000)} ms)`,
		};
	return {
		ok: true,
		shiftFlicks: Math.round((sec(b.leadSilenceSec) - sec(a.leadSilenceSec)) * FLICKS_PER_SECOND),
	};
}

type DocLike = {
	media: Readonly<
		Record<string, { id: string; kind: string; fingerprint: string; derivation?: unknown; library?: unknown }>
	>;
	sequences: Readonly<Record<string, { clips: Readonly<Record<string, { mediaId?: unknown }>> }>>;
};

/**
 * The project's older copy of a library sound — an audio media (not a processed version) with the same `soundId` but
 * another file than `fingerprint` — that a fresh registration should replace; with several, the one most clips use
 * (then the first in id order). Null when there is none, or when the project already holds `fingerprint` itself.
 */
export function olderLibraryCopyOf(doc: DocLike, soundId: string, fingerprint: string): string | null {
	const candidates: string[] = [];
	for (const m of Object.values(doc.media)) {
		if (m.fingerprint === fingerprint && !m.derivation) return null;
		if (m.kind !== 'audio' || m.derivation || m.fingerprint === fingerprint) continue;
		if (readLibraryProvenance(m.library)?.soundId === soundId) candidates.push(m.id);
	}
	if (!candidates.length) return null;
	const uses = new Map(candidates.map((id) => [id, 0]));
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips))
			if (typeof c.mediaId === 'string' && uses.has(c.mediaId)) uses.set(c.mediaId, uses.get(c.mediaId)! + 1);
	return candidates.sort((x, y) => uses.get(y)! - uses.get(x)! || (x < y ? -1 : x > y ? 1 : 0))[0]!;
}
