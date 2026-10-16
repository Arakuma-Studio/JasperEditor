// Which clips are sound effects, for the masking solver (spec 12 §2.4; wp-note "Phase 4 → WP4.1b"): the bed is
// everything else (dialogue, music, ambience, any other audio), and the solver sets the gains of the effects against it.
//
//   An audio clip is a sound effect when its Essential Sound type is `sfx`, or when it has no Essential Sound type and
//   carries sound-design metadata (`AudioClip.sfx`: placed by `soundDesign.place`, or given a role / peak). A clip
//   typed dialogue, music or ambience is bed even with `sfx` metadata (Detect Peak may give project audio a peak).
//   Only clips of the sequence itself count: sound effects inside a nested sequence play as part of the nest (bed).
//
// Solver weights: a sound whose types include a bed type (ambience, room tone) is `ambient` whatever its role; a hero is
// `hero`; supports and layers are `support`. Pure; never throws.
import { readClipSfx } from '../schema/sound.ts';
import { SOUND_BED_TYPES } from './taxonomy.ts';

export type SfxSolverWeight = 'hero' | 'support' | 'ambient';

/** Whether a clip is a sound effect for the masking solver (see the module docs). */
export function isSfxClip(clip: unknown): boolean {
	if (!clip || typeof clip !== 'object') return false;
	const c = clip as { kind?: unknown; essential?: { type?: unknown } | null; sfx?: unknown };
	if (c.kind !== 'audio') return false;
	const type = c.essential && typeof c.essential === 'object' ? c.essential.type : undefined;
	if (type === 'sfx') return true;
	if (type === 'dialogue' || type === 'music' || type === 'ambience') return false;
	return c.sfx !== undefined && readClipSfx(c.sfx) !== null;
}

/** The solver weight of a placed sound: `ambient` for bed types (ambience, room tone), else by role. */
export function sfxSolverWeight(
	role: 'hero' | 'support' | 'layer' | null | undefined,
	types: readonly unknown[] | null | undefined,
): SfxSolverWeight {
	if (Array.isArray(types) && types.some((t) => (SOUND_BED_TYPES as readonly unknown[]).includes(t)))
		return 'ambient';
	return role === 'hero' ? 'hero' : 'support';
}
