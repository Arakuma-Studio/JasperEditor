// Default insert level of a placed sound (spec 12 §2.3; Phase 2 verification B). Until the Phase 4 masking solver sets
// gains against the bed, placement gives each sound a clip gain from its own descriptors: its loudest 400 ms
// (`maxMomentaryLufs`) goes to a momentary-loudness target of its role, under a true-peak ceiling of the role, within
// the solver's gain range. The result is recorded on the clip (`AudioClip.sfx.level`) so Phase 4 can tell a default
// it may replace from a gain the user set.
//
// Targets are relative to the sequence's delivery (its integrated loudness target, spec 12 §2.4): dialogue and the
// programme sit around the integrated target, so a hero hit peaks (momentarily) just under it, support sounds 8 LU
// and layers 10 LU under it, beds (ambience, room tone) 16 LU under it — under spec 12's "ambience ≥ 10 LU under
// voice" with room for its momentary maximum to exceed its integrated level. For web delivery (−14 LUFS) that is
// hero −16, support −22, layer −24, ambience −30 LUFS momentary. Sources and reasoning: wp-note "Phase 2
// verification B". Pure.
import type { SfxRole, SoundDelivery } from '../schema/sound.ts';
import { DELIVERY_PRESETS } from './delivery.ts';
import { SOUND_BED_TYPES } from './taxonomy.ts';

/** Integrated loudness target of each delivery preset (LUFS; spec 12 §2.4; `delivery.ts`). */
export const DELIVERY_INTEGRATED_LUFS: Record<SoundDelivery, number> = {
	web: DELIVERY_PRESETS.web.integratedLufs,
	podcast: DELIVERY_PRESETS.podcast.integratedLufs,
	'broadcast-r128': DELIVERY_PRESETS['broadcast-r128'].integratedLufs,
	'atsc-a85': DELIVERY_PRESETS['atsc-a85'].integratedLufs,
};

/** What a placed sound's level follows: its role, or `ambience` for beds (ambience, room tone). */
export type SfxLevelClass = SfxRole | 'ambience';

/** Momentary-loudness target of each class, in LU relative to the delivery's integrated target. */
export const SFX_LEVEL_OFFSET_LU: Record<SfxLevelClass, number> = {
	hero: -2,
	support: -8,
	layer: -10,
	ambience: -16,
};

/**
 * True-peak ceiling of each class (dBTP). Layers of a cue are peak-aligned, so their peaks can add: a hero, a support
 * and a layer at their ceilings sum to −0.8 dBTP even exactly in phase (0.501 + 0.251 + 0.158); more layers, or a loud
 * bed under them, are the masking solver's (Phase 4).
 */
export const SFX_PEAK_CEILING_DBTP: Record<SfxLevelClass, number> = {
	hero: -6,
	support: -12,
	layer: -16,
	ambience: -20,
};

/** The masking solver's clamp (spec 12 §2.4 constraint 1); the default stays inside it. */
export const SFX_DEFAULT_GAIN_MIN_DB = -30;
export const SFX_DEFAULT_GAIN_MAX_DB = 12;

/**
 * Why the default gain is what it is: the loudness target, the true-peak ceiling (also: no measured peak, so no
 * boost), the gain range, or no loudness descriptor (0 dB, lowered only by the peak ceiling).
 */
export type SfxLevelLimit = 'loudness' | 'peak' | 'range' | 'unmeasured';

export type SfxDefaultLevel = {
	/** Clip gain (dB, 0.1 dB steps) the descriptors give, before any variation offset. */
	gainDb: number;
	/** The momentary-loudness target (LUFS). */
	targetLufs: number;
	/** The true-peak ceiling (dBTP). */
	ceilingDbtp: number;
	levelClass: SfxLevelClass;
	limitedBy: SfxLevelLimit;
};

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `ambience` when one of the sound's types is a bed type, else its role. */
export function sfxLevelClass(role: SfxRole, types: readonly unknown[] | null | undefined): SfxLevelClass {
	if (Array.isArray(types) && types.some((t) => (SOUND_BED_TYPES as readonly unknown[]).includes(t)))
		return 'ambience';
	return role;
}

/**
 * The default clip gain of a placed sound. `maxMomentaryLufs` / `truePeakDb` are its descriptors (null / absent when
 * unknown); without a measured true peak the gain never boosts. Never throws; always a finite gain in
 * [SFX_DEFAULT_GAIN_MIN_DB, SFX_DEFAULT_GAIN_MAX_DB].
 */
export function defaultSfxLevel(input: {
	role: SfxRole;
	types?: readonly unknown[] | null;
	maxMomentaryLufs?: number | null;
	truePeakDb?: number | null;
	delivery?: SoundDelivery | null;
}): SfxDefaultLevel {
	const levelClass = sfxLevelClass(input.role, input.types);
	const delivery =
		input.delivery && Object.hasOwn(DELIVERY_INTEGRATED_LUFS, input.delivery) ? input.delivery : 'web';
	const targetLufs = DELIVERY_INTEGRATED_LUFS[delivery] + SFX_LEVEL_OFFSET_LU[levelClass];
	const ceilingDbtp = SFX_PEAK_CEILING_DBTP[levelClass];
	// descriptors are bounded (±400) but stay hostile input: a value outside any real measurement counts as unknown
	const loud =
		fin(input.maxMomentaryLufs) && Math.abs(input.maxMomentaryLufs) <= 200 ? input.maxMomentaryLufs : null;
	const peak = fin(input.truePeakDb) && Math.abs(input.truePeakDb) <= 200 ? input.truePeakDb : null;
	let gain: number;
	let limitedBy: SfxLevelLimit;
	if (loud === null) {
		gain = 0;
		limitedBy = 'unmeasured';
	} else {
		gain = targetLufs - loud;
		limitedBy = 'loudness';
	}
	const cap = peak === null ? 0 : ceilingDbtp - peak;
	if (gain > cap) {
		gain = cap;
		limitedBy = 'peak';
	}
	if (gain < SFX_DEFAULT_GAIN_MIN_DB) {
		gain = SFX_DEFAULT_GAIN_MIN_DB;
		limitedBy = 'range';
	} else if (gain > SFX_DEFAULT_GAIN_MAX_DB) {
		gain = SFX_DEFAULT_GAIN_MAX_DB;
		limitedBy = 'range';
	}
	const gainDb = Math.round(gain * 10) / 10;
	return { gainDb: Object.is(gainDb, -0) ? 0 : gainDb, targetLufs, ceilingDbtp, levelClass, limitedBy };
}

/** True-peak ceiling of each delivery preset (dBTP; spec 12 §2.4): the masking solver's headroom constraint. */
export const DELIVERY_TRUE_PEAK_DBTP: Record<SoundDelivery, number> = {
	web: DELIVERY_PRESETS.web.truePeakDb,
	podcast: DELIVERY_PRESETS.podcast.truePeakDb,
	'broadcast-r128': DELIVERY_PRESETS['broadcast-r128'].truePeakDb,
	'atsc-a85': DELIVERY_PRESETS['atsc-a85'].truePeakDb,
};

/** Within this (dB) a clip's gain still equals its recorded level (levels are stored to 0.01 dB). */
export const SFX_LEVEL_MATCH_DB = 0.005;

/**
 * Who owns a placed sound's gain (Phase 2 verification B, Phase 4 WP4.1b): `default` (placement's default level) or
 * `solver` (the masking solver, `soundDesign.applyGains`) while the clip's gain still equals the recorded
 * `sfx.level.gainDb`; `user` when there is no level, the gain was changed since, or Auto gain was turned off
 * (`level.manual`, `soundDesign.setAutoGain`). Rebalancing replaces `default` and `solver` gains and keeps `user` gains
 * unless asked to replace them; a swap or a role change refreshes `default` and `solver` gains to the new default.
 * Never throws.
 */
export function sfxGainOwner(clip: {
	gainDb?: unknown;
	sfx?: { level?: { by?: unknown; gainDb?: unknown; manual?: unknown } | null } | null;
}): 'default' | 'solver' | 'user' {
	const level = clip.sfx?.level;
	if (!level || level.manual === true) return 'user';
	const { by, gainDb } = level;
	if ((by !== 'default' && by !== 'solver') || !fin(gainDb) || !fin(clip.gainDb)) return 'user';
	return Math.abs(clip.gainDb - gainDb) <= SFX_LEVEL_MATCH_DB ? by : 'user';
}
