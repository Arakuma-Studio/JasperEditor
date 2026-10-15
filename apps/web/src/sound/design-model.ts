// Pure helpers of the sound-design UI (spec 12 §2.7, WP2.4b): which sound a clip plays and where its aligned point
// is, the layers of a cue or a linked set, the search that ranks sounds for a cue (Fill With ▸, Fill Unfilled Cues), the
// variation candidates of a clip, labels ("Crunch on A3 at 00:00:01:15", "Hero Land cue at …") and licence warnings.
// No React, no I/O, never throws on damaged documents.
import type { SoundSearchRequest } from '@jasper/api';
import {
	type AudioClip,
	type Clip,
	type ClipSfx,
	FLICKS_PER_SECOND,
	formatTimecode,
	type LibraryProvenance,
	type LicenseClass,
	licenseClass,
	type MediaAsset,
	type ProjectDocument,
	type Rational,
	readClipSfx,
	readLibraryProvenance,
	type Sequence,
	SOUND_TYPES,
	type SoundCue,
	type SoundFamily,
	soundDesignSettingsOf,
	typesForVisualKind,
	typesOfFamily,
	VISUAL_KINDS,
	type VisualKind,
} from '@jasper/project';
import { t } from '../i18n/runtime.ts';
import {
	CUE_WEIGHT_LABELS,
	clipPeakFrame,
	cuesOf,
	kindLabel,
	peakFrameOf,
	placedClips,
} from './cues/model.ts';

export type SfxAudioClip = AudioClip & { sfx?: ClipSfx };

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The clip's `sfx` metadata read leniently (null when absent or unreadable). */
export function sfxOf(clip: Clip | null | undefined): ClipSfx | null {
	if (clip?.kind !== 'audio') return null;
	const raw = (clip as { sfx?: unknown }).sfx;
	return raw === undefined ? null : readClipSfx(raw);
}

/** The library provenance of a clip's media (null for project audio). */
export function clipProvenance(
	doc: Pick<ProjectDocument, 'media'>,
	clip: Clip | null | undefined,
): LibraryProvenance | null {
	const id = (clip as { mediaId?: string } | null | undefined)?.mediaId;
	if (!id || !Object.hasOwn(doc.media, id)) return null;
	return readLibraryProvenance((doc.media[id] as { library?: unknown }).library);
}

/** The library sound id a clip plays (its `sfx`, else its media's provenance), or null. */
export function clipSoundId(
	doc: Pick<ProjectDocument, 'media'>,
	clip: Clip | null | undefined,
): string | null {
	return sfxOf(clip)?.soundId ?? clipProvenance(doc, clip)?.soundId ?? null;
}

/** Whether a clip is a library sound (placed by sound design or of library media). */
export function isLibraryClip(doc: Pick<ProjectDocument, 'media'>, clip: Clip | null | undefined): boolean {
	return !!clip && clip.kind === 'audio' && !!clipSoundId(doc, clip);
}

/** "A3" of a clip's audio track ("A?" when the track is gone). */
export function trackLabelOf(seq: Pick<Sequence, 'audioTracks' | 'videoTracks'>, trackId: string): string {
	const a = seq.audioTracks.findIndex((x) => x.id === trackId);
	if (a >= 0) return `A${a + 1}`;
	const v = seq.videoTracks.findIndex((x) => x.id === trackId);
	return v >= 0 ? `V${v + 1}` : '?';
}

/** Timecode of a sequence frame with the sequence's settings. */
export function seqTimecode(seq: Pick<Sequence, 'settings'>, frame: number): string {
	return formatTimecode(Math.max(0, Math.floor(frame)), seq.settings.frameRate as Rational, {
		dropFrame: seq.settings.dropFrame,
		startFrames: seq.settings.startTimecodeFrames,
	});
}

/** The display name of a clip's sound: the provenance title, else the clip name. */
export function clipSoundTitle(doc: Pick<ProjectDocument, 'media'>, clip: Clip): string {
	return clipProvenance(doc, clip)?.title || clip.name || clip.id;
}

/**
 * The sequence frame (fractional) where a clip's aligned point plays: the placement's point (peak, start or end) when
 * it has one, else the media's peak; null when unknown (reversed, remapped, no descriptor).
 */
export function alignedFrameOf(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Pick<Sequence, 'settings'>,
	clip: Clip,
): number | null {
	if (clip.kind !== 'audio') return null;
	const rate = seq.settings.frameRate as Rational;
	const sfx = sfxOf(clip);
	const c = clip as SfxAudioClip;
	if (sfx && fin(sfx.placement.peakFlicks)) {
		const f = peakFrameOf(c as never, sfx.placement.peakFlicks, rate);
		if (f !== null) return f;
	}
	return clipPeakFrame(c as never, doc.media[c.mediaId] as never, rate);
}

/** Which point of the clip's sound is aligned (its placement's, else the peak). */
export function alignOf(clip: Clip): 'peak' | 'start' | 'end' {
	return sfxOf(clip)?.placement.align ?? 'peak';
}

/** "Crunch on A3 at 00:00:01:15" (the aligned point's timecode). */
export function clipSoundLabel(doc: Pick<ProjectDocument, 'media'>, seq: Sequence, clip: Clip): string {
	const at = alignedFrameOf(doc, seq, clip) ?? clip.start;
	return t(
		'{0} on {1} at {2}',
		clipSoundTitle(doc, clip),
		trackLabelOf(seq, clip.trackId),
		seqTimecode(seq, at),
	);
}

/** "Hero Land cue at 00:00:04:02". */
export function cueLabel(seq: Pick<Sequence, 'settings'>, cue: SoundCue): string {
	return t(
		'{0} {1} cue at {2}',
		CUE_WEIGHT_LABELS[cue.weight] ?? cue.weight,
		kindLabel(cue.kind),
		seqTimecode(seq, cue.frame),
	);
}

/** The cue a clip fills (its `sfx.cueId`, when the cue still exists). */
export function cueOfClip(seq: Sequence, clip: Clip): SoundCue | null {
	const id = sfxOf(clip)?.cueId;
	if (!id) return null;
	return cuesOf(seq).find((c) => c.id === id) ?? null;
}

/**
 * The layers a clip belongs to (spec 12 §2.7 "Layering"): the clips filling its cue, else the audio clips linked with
 * it that carry `sfx`; ordered by layer index, then track. A clip on its own is "Layer 1 of 1".
 */
export function layersOf(seq: Sequence, clip: Clip): { clipIds: string[]; index: number } {
	const cue = cueOfClip(seq, clip);
	let ids: string[] = [];
	if (cue) ids = placedClips(seq, cue);
	if (ids.length < 2 && clip.linkId) {
		const members = seq.links?.[clip.linkId]?.members ?? [];
		const linked = members.filter((id) => {
			const c = seq.clips[id];
			return !!c && c.kind === 'audio' && !!sfxOf(c);
		});
		if (linked.length > ids.length) ids = linked;
	}
	if (!ids.includes(clip.id)) ids = [clip.id, ...ids];
	const trackIndex = (id: string) => {
		const c = seq.clips[id];
		return c ? seq.audioTracks.findIndex((x) => x.id === c.trackId) : 999;
	};
	ids.sort(
		(a, b) =>
			(sfxOf(seq.clips[a])?.layer ?? 0) - (sfxOf(seq.clips[b])?.layer ?? 0) ||
			trackIndex(a) - trackIndex(b) ||
			(a < b ? -1 : 1),
	);
	return { clipIds: ids, index: ids.indexOf(clip.id) };
}

/** Whether a clip is one of several layers (chain badge). */
export function isLayered(seq: Sequence, clip: Clip): boolean {
	return layersOf(seq, clip).clipIds.length > 1;
}

/** Whether the layers of a clip are linked together (Link / Unlink Layers). */
export function layersLinked(seq: Sequence, clipIds: readonly string[]): boolean {
	const first = seq.clips[clipIds[0] ?? '']?.linkId;
	return !!first && clipIds.every((id) => seq.clips[id]?.linkId === first);
}

// ---------------------------------------------------------------------------------------------------------------
// Ranking requests

/** Library sound ids played near a frame (nearest first; ±10 s; ≤ 64): rotation ranks them lower. */
export function soundsUsedNear(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	frame: number,
	opts: { exclude?: readonly string[]; seconds?: number } = {},
): string[] {
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.den > 0 ? rate.num / rate.den : 30;
	const span = (opts.seconds ?? 10) * fps;
	const near: { id: string; d: number }[] = [];
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'audio' || opts.exclude?.includes(c.id)) continue;
		const id = clipSoundId(doc, c);
		if (!id) continue;
		const at = alignedFrameOf(doc, seq, c) ?? c.start;
		const d = Math.abs(at - frame);
		if (d <= span) near.push({ id, d });
	}
	near.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
	return [...new Set(near.map((x) => x.id))].slice(0, 64);
}

const isVisualKind = (k: string): k is VisualKind => (VISUAL_KINDS as readonly string[]).includes(k);

/** The engine search that ranks sounds for a cue: its types (else the kind's), visual kind, window, align, rotation. */
export function cueSearchRequest(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	cue: SoundCue,
	limit = 8,
): SoundSearchRequest {
	const kind = isVisualKind(cue.kind) ? cue.kind : null;
	const types = cue.types?.length ? cue.types : kind ? typesForVisualKind(kind).slice(0, 4) : [];
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.den > 0 ? rate.num / rate.den : 30;
	const win =
		cue.window && cue.window.end > cue.window.start ? (cue.window.end - cue.window.start) / fps : null;
	const used = soundsUsedNear(doc, seq, cue.frame, { exclude: placedClips(seq, cue) });
	return {
		...(types.length ? { types: types.slice(0, 32) } : {}),
		...(kind ? { visualKind: kind } : {}),
		...(win && win > 0 && win <= 600 ? { windowSec: Math.round(win * 1000) / 1000 } : {}),
		...(cue.align ? { align: cue.align } : {}),
		...(used.length ? { usedNearby: used } : {}),
		limit,
	};
}

/** The family of a sound's first known type. */
export function familyOf(types: readonly string[]): SoundFamily | null {
	for (const ty of types) {
		const info = (SOUND_TYPES as Record<string, { family: SoundFamily } | undefined>)[ty];
		if (info) return info.family;
	}
	return null;
}

/**
 * Variation candidates of a clip (spec 12 §2.7 "Variation cycling"): the agent's / Fill's alternatives (the clip's, and
 * its cue's first layer's), then sounds of the same family, then the nearest descriptors (engine `similarTo`); the
 * clip's own sound first (index 0: cycling past the end comes back to it). Deduplicated, ≤ 32.
 */
export function variationList(
	current: string | null,
	alternatives: readonly string[],
	family: readonly string[],
	similar: readonly string[],
): string[] {
	const out: string[] = [];
	for (const id of [current, ...alternatives, ...family, ...similar])
		if (typeof id === 'string' && /^snd_[0-9a-f]{16}$/.test(id) && !out.includes(id)) out.push(id);
	return out.slice(0, 32);
}

/** Alternatives a clip carries for cycling: its own, else those of its cue's other layers. */
export function alternativesOf(seq: Sequence, clip: Clip): string[] {
	const own = sfxOf(clip)?.alternatives ?? [];
	if (own.length) return [...own];
	const cue = cueOfClip(seq, clip);
	if (!cue) return [];
	for (const id of placedClips(seq, cue)) {
		const alt = sfxOf(seq.clips[id])?.alternatives;
		if (alt?.length) return [...alt];
	}
	return [];
}

/** The search of the same family as a sound's types (ranked by the engine). */
export function familyRequest(types: readonly string[], limit = 12): SoundSearchRequest | null {
	const fam = familyOf(types);
	return fam ? { types: typesOfFamily(fam), limit } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Licence

/** Licence classes that need the user's attention (NC / ND, unknown, undeclared folders). */
export function licenceWarns(license: string | null | undefined): boolean {
	const cls: LicenseClass = licenseClass(license ?? '');
	return cls === 'nc' || cls === 'nd' || cls === 'unknown' || cls === 'user-provided';
}

/** The media ids whose library licence needs attention (badge dot). */
export function warnMediaIds(media: Readonly<Record<string, MediaAsset>>): Set<string> {
	const out = new Set<string>();
	for (const [id, m] of Object.entries(media)) {
		const lib = readLibraryProvenance((m as { library?: unknown }).library);
		if (lib && licenceWarns(lib.license)) out.add(id);
	}
	return out;
}

/** Peak (seconds into the media) as text. */
export function peakSecondsText(flicks: number): string {
	return `${(flicks / FLICKS_PER_SECOND).toFixed(3)} s`;
}

/** The sequence's palette (preferred library sounds). */
export function paletteOf(seq: Sequence | null | undefined): string[] {
	if (!seq) return [];
	try {
		return [...(soundDesignSettingsOf(seq as { soundDesign?: unknown }).palette ?? [])];
	} catch {
		return [];
	}
}

/** Pitch shift of a clip in semitones: its Pitch Shifter (semitones + cents), else its varispeed in whole semitones. */
export function clipPitchSt(clip: Clip): number {
	if (clip.kind !== 'audio') return 0;
	const c = clip as AudioClip;
	for (const fx of c.effects ?? []) {
		if ((fx as { effectId?: string }).effectId !== 'jasper.audio.pitch-shifter') continue;
		const p = fx.params as Record<string, { value?: unknown } | undefined>;
		const st = typeof p.semitones?.value === 'number' ? p.semitones.value : 0;
		const cents = typeof p.cents?.value === 'number' ? p.cents.value : 0;
		return Math.round((st + cents / 100) * 100) / 100;
	}
	const rate = c.speed?.rate;
	if (!fin(rate) || rate <= 0) return 0;
	const st = Math.round(12 * Math.log2(rate));
	return Math.abs(st) <= 3 ? st : 0;
}
