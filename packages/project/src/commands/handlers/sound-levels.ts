// Default and refreshed levels of placed sounds (spec 12 §2.3; Phase 2 verification B, Phase 4): shared by the placement
// handlers (`sound.ts`) and the delivery preset (`sound-mix.ts`).
import type { Draft } from 'immer';
import type { AudioClip } from '../../schema/sequence.ts';
import {
	type ClipSfx,
	readSoundDesignSettings,
	type SfxLevel,
	type SoundDesign,
	type SoundDesignSettings,
} from '../../schema/sound.ts';
import { defaultSfxLevel, sfxGainOwner } from '../../sound/level.ts';
import { type LibraryProvenance, readLibraryProvenance } from '../../sound/provenance.ts';
import type { DDoc, DSeq } from '../context.ts';

type DAudio = Draft<AudioClip> & { sfx?: ClipSfx };

/**
 * The default level of a library sound placed with `role` (`defaultSfxLevel` on its descriptors), plus `offsetDb`, as
 * stored in `sfx.level`.
 */
export function sfxDefaultLevel(
	prov: LibraryProvenance | null,
	role: ClipSfx['role'],
	types: readonly unknown[],
	delivery: SoundDesignSettings['delivery'],
	offsetDb = 0,
): SfxLevel {
	const d = prov?.descriptors as
		| (LibraryProvenance['descriptors'] & { truePeakDb?: number | null })
		| undefined;
	const l = defaultSfxLevel({
		role,
		types,
		maxMomentaryLufs: d?.maxMomentaryLufs ?? null,
		truePeakDb: d?.truePeakDb ?? null,
		delivery,
	});
	const off = Number.isFinite(offsetDb) ? Math.max(-12, Math.min(12, offsetDb)) : 0;
	const gainDb = Math.round((l.gainDb + off) * 100) / 100;
	return {
		by: 'default',
		gainDb: Object.is(gainDb, -0) ? 0 : gainDb,
		...(off !== 0 ? { offsetDb: off } : {}),
		targetLufs: l.targetLufs,
		limitedBy: l.limitedBy,
	};
}

/**
 * After a swap or a role change: a clip whose gain is still the default placement gave it or the masking solver's
 * (`sfx.level`, untouched) gets the default of its current sound and role (with the same variation offset): a solved
 * gain belongs to the old sound or role (rebalance again to solve the new one). A gain set since is kept.
 */
export function refreshDefaultLevel(
	doc: DDoc,
	seq: DSeq,
	clip: DAudio,
	opts: { onlyDefault?: boolean } = {},
): boolean {
	const level = clip.sfx?.level;
	if (!clip.sfx || !level) return false;
	const owner = sfxGainOwner(clip);
	if (owner === 'user' || (opts.onlyDefault && owner !== 'default')) return false;
	const prov = readLibraryProvenance((doc.media[clip.mediaId] as { library?: unknown } | undefined)?.library);
	const settings = readSoundDesignSettings((seq as { soundDesign?: SoundDesign }).soundDesign?.settings);
	const next = sfxDefaultLevel(
		prov,
		clip.sfx.role,
		prov?.types ?? [],
		settings.delivery,
		level.offsetDb ?? 0,
	);
	clip.gainDb = next.gainDb;
	clip.sfx.level = next as Draft<SfxLevel>;
	return true;
}
