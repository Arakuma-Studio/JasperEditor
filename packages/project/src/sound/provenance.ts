// Library provenance of a project media asset (spec 12 §2.1 "Register into a project"): which library sound the
// media came from, its licence and credit, and the descriptors placement needs. Metadata only, never a render input.
//
// Storage: `MediaAsset.library` is read leniently by the document schema (`z.unknown()`), so a malformed value never
// makes a project fail to load (AGENTS.md §0). The invariants check it against `LibraryProvenanceSchema`
// (INV-LIBRARY); `repairDocument` rewrites it with `readLibraryProvenance` (or drops it when it has no sound id),
// with a report line. Commands (`media.setLibraryInfo`, `media.register`) validate it strictly.
import { z } from 'zod';
import type { DeepStrip } from '../schema/common.ts';
import { UNKNOWN_LICENSE } from './license.ts';

/** Bounds for untrusted strings and lists. */
export const LIBRARY_LIMITS = {
	id: 128,
	title: 500,
	author: 500,
	license: 200,
	url: 2048,
	attribution: 4000,
	types: 32,
	typeId: 32,
	pathPart: 4096,
	hash: 256,
} as const;

/** A sound type id as stored: known ids and ids of newer builds (lower-case words), so they survive a round trip. */
export const StoredSoundTypeSchema = z
	.string()
	.regex(/^[a-z][a-z0-9-]*$/)
	.max(LIBRARY_LIMITS.typeId);

/** Where the library got the sound (spec 12 §2.1 `SoundEntry.source`). */
export const LibrarySourceSchema = z.discriminatedUnion('type', [
	z.looseObject({ type: z.literal('starter'), packId: z.string().max(LIBRARY_LIMITS.id).optional() }),
	z.looseObject({ type: z.literal('pack'), packId: z.string().min(1).max(LIBRARY_LIMITS.id) }),
	z.looseObject({
		type: z.literal('folder'),
		rootId: z.string().min(1).max(LIBRARY_LIMITS.id),
		relPath: z.string().min(1).max(LIBRARY_LIMITS.pathPart),
	}),
	z.looseObject({
		type: z.literal('synth'),
		recipe: z.string().min(1).max(LIBRARY_LIMITS.id),
		seed: z.number().int().min(0).max(0xffff_ffff),
	}),
]);
export type LibrarySource = DeepStrip<z.infer<typeof LibrarySourceSchema>>;

const sec = () => z.number().min(0).max(86_400);
/** The descriptors placement and the Properties "Sound" section need (spec 12 §2.1); full set in the library. */
export const LibraryDescriptorsSchema = z.looseObject({
	/** Max of the 2 ms RMS envelope (seconds from the file start). */
	peakSec: sec(),
	/** First point within 30 dB of the peak. */
	onsetSec: sec(),
	/** Head below −40 dB re the sample peak (rounded down to 0.1 ms): placement may trim this much. */
	headQuietSec: sec(),
	durationSec: sec(),
	/** Octave bands 125 Hz … 8 kHz, dBFS (7 values, floor −120). */
	octaveBandsDb: z.array(z.number().min(-400).max(400)).length(7),
	centroidHz: z.number().min(0).max(1_000_000),
	/** Highest 400 ms momentary loudness; null for silence. */
	maxMomentaryLufs: z.number().min(-400).max(400).nullable(),
});
export type LibraryDescriptors = DeepStrip<z.infer<typeof LibraryDescriptorsSchema>>;

export const LibraryProvenanceSchema = z.looseObject({
	/** Library sound id (`snd_<sha256-16>`). */
	soundId: z.string().min(1).max(LIBRARY_LIMITS.id),
	title: z.string().max(LIBRARY_LIMITS.title),
	types: z.array(StoredSoundTypeSchema).max(LIBRARY_LIMITS.types),
	/** Absent only in repaired data whose source was unreadable; registering always writes it. */
	source: LibrarySourceSchema.optional(),
	/** SPDX id, `LicenseRef-UserProvided`, `LicenseRef-UserRoyaltyFree`, `LicenseRef-JasperEditor` or `NOASSERTION`. */
	license: z.string().min(1).max(LIBRARY_LIMITS.license),
	licenseUrl: z.string().max(LIBRARY_LIMITS.url).optional(),
	author: z.string().max(LIBRARY_LIMITS.author),
	sourceUrl: z.string().max(LIBRARY_LIMITS.url).optional(),
	/** The credit line the licence asks for, verbatim; null when none is required. */
	attribution: z.string().max(LIBRARY_LIMITS.attribution).nullable(),
	descriptors: LibraryDescriptorsSchema.optional(),
	/** Hash of the library snapshot the sound was registered from. */
	snapshotHash: z.string().max(LIBRARY_LIMITS.hash).optional(),
});
export type LibraryProvenance = DeepStrip<z.infer<typeof LibraryProvenanceSchema>>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined =>
	typeof v === 'string' ? v.slice(0, max) : undefined;

/**
 * Lenient read of stored provenance: valid data is returned as is (unknown fields kept); otherwise each field is
 * repaired on its own (bad optional fields dropped, the title falls back to the sound id, the licence to
 * `NOASSERTION`, unreadable type ids dropped). Returns null when there is no usable sound id (the provenance cannot
 * be tied to a library sound). Pure; never throws.
 */
export function readLibraryProvenance(raw: unknown): LibraryProvenance | null {
	if (!isRecord(raw)) return null;
	const ok = LibraryProvenanceSchema.safeParse(raw);
	if (ok.success) return ok.data as LibraryProvenance;
	const soundId = str(raw.soundId, LIBRARY_LIMITS.id + 1);
	if (!soundId || soundId.length > LIBRARY_LIMITS.id || !soundId.trim()) return null;
	const out: Record<string, unknown> = {};
	// Unknown (newer) fields survive, like everywhere in the document (S01:DOC-005).
	for (const [k, v] of Object.entries(raw)) if (!(k in LibraryProvenanceSchema.shape)) out[k] = v;
	out.soundId = soundId;
	out.title = str(raw.title, LIBRARY_LIMITS.title) ?? soundId;
	out.types = Array.isArray(raw.types)
		? [...new Set(raw.types.filter((t) => StoredSoundTypeSchema.safeParse(t).success))].slice(
				0,
				LIBRARY_LIMITS.types,
			)
		: [];
	const src = LibrarySourceSchema.safeParse(raw.source);
	if (src.success) out.source = src.data;
	const lic = str(raw.license, LIBRARY_LIMITS.license);
	out.license = lic?.trim() ? lic : UNKNOWN_LICENSE;
	const licenseUrl = str(raw.licenseUrl, LIBRARY_LIMITS.url);
	if (licenseUrl !== undefined) out.licenseUrl = licenseUrl;
	out.author = str(raw.author, LIBRARY_LIMITS.author) ?? '';
	const sourceUrl = str(raw.sourceUrl, LIBRARY_LIMITS.url);
	if (sourceUrl !== undefined) out.sourceUrl = sourceUrl;
	out.attribution = str(raw.attribution, LIBRARY_LIMITS.attribution) ?? null;
	const d = LibraryDescriptorsSchema.safeParse(raw.descriptors);
	if (d.success) out.descriptors = d.data;
	const hash = str(raw.snapshotHash, LIBRARY_LIMITS.hash);
	if (hash !== undefined) out.snapshotHash = hash;
	const r = LibraryProvenanceSchema.safeParse(out);
	return r.success ? (r.data as LibraryProvenance) : null;
}

/** The problem with stored provenance, or null when it is valid (INV-LIBRARY). */
export function libraryProvenanceIssue(raw: unknown): string | null {
	const r = LibraryProvenanceSchema.safeParse(raw);
	if (r.success) return null;
	const i = r.error.issues[0]!;
	return `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`;
}
