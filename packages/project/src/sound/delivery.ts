// Loudness delivery presets (spec 12 §2.4 "Delivery presets", P4-R4; wp-note "Phase 4 → WP4.2a"): the integrated
// loudness and true-peak ceiling a sequence is mixed to, and the relative targets of the bed under the voice. Applied
// through ordinary commands (`soundDesign.applyDelivery`: settings, `mixer.setLoudness`, Essential Sound Auto-Match and
// ducking); the default SFX levels (`level.ts`) and the masking solver's programme loudness follow the same preset.
//
// Sources: EBU R 128 (2020) −23 LUFS integrated / −1 dBTP max true peak; ATSC A/85 (2013) −24 LKFS / −2 dBTP; the
// −14 LUFS / −1 dBTP that streaming platforms normalise web video to; AES TD1008 (−16 LUFS for podcasts, −1 dBTP). The
// relative targets (music ≥ 8 LU, ambience ≥ 10 LU under the voice) are spec 12's. Pure.
import type { SoundDelivery } from '../schema/sound.ts';

export type DeliveryPreset = {
	id: SoundDelivery;
	label: string;
	/** Integrated programme loudness (LUFS). */
	integratedLufs: number;
	/** Maximum true peak (dBTP). */
	truePeakDb: number;
	/** Where the numbers come from. */
	source: string;
	/**
	 * The audio encoding a deliverable to this target typically has: what Sound Check checks for until the sequence has
	 * been exported (wp-note "Fix: preview loudness parity, codec-aware Sound Check, delivery speed"). Web: the
	 * editor's own export default (H.264 + AAC 256 kb/s); podcast: Apple Podcasts' audio requirements (AAC recommended
	 * over MP3, stereo 128–256 kb/s — the lowest, the strictest check); broadcast: PCM masters (no codec headroom).
	 */
	typicalAudio: { codec: 'aac' | 'opus' | 'pcm'; bitrateKbps?: number };
};

export const DELIVERY_PRESETS: Readonly<Record<SoundDelivery, DeliveryPreset>> = {
	web: {
		id: 'web',
		label: 'Web / streaming (−14 LUFS)',
		integratedLufs: -14,
		truePeakDb: -1,
		source: 'Streaming platforms normalise to about −14 LUFS; −1 dBTP for lossy encoding headroom',
		typicalAudio: { codec: 'aac', bitrateKbps: 256 },
	},
	podcast: {
		id: 'podcast',
		label: 'Podcast (−16 LUFS)',
		integratedLufs: -16,
		truePeakDb: -1,
		source: 'AES TD1008 (−16 LUFS, −1 dBTP)',
		typicalAudio: { codec: 'aac', bitrateKbps: 128 },
	},
	'broadcast-r128': {
		id: 'broadcast-r128',
		label: 'Broadcast EBU R 128 (−23 LUFS)',
		integratedLufs: -23,
		truePeakDb: -1,
		source: 'EBU R 128 (2020): −23 LUFS ±1 LU, −1 dBTP',
		typicalAudio: { codec: 'pcm' },
	},
	'atsc-a85': {
		id: 'atsc-a85',
		label: 'Broadcast ATSC A/85 (−24 LKFS)',
		integratedLufs: -24,
		truePeakDb: -2,
		source: 'ATSC A/85: −24 LKFS ±2 dB, −2 dBTP',
		typicalAudio: { codec: 'pcm' },
	},
};

/** How far the bed sits under the voice (LU, spec 12 §2.4): music ≥ 8 LU, ambience ≥ 10 LU. */
export const DELIVERY_RELATIVE_LU = { music: 8, ambience: 10 } as const;

/**
 * Ducking depth (dB) `applyDelivery` uses for a Music / Ambience clip whose Ducking amount is still its type's default
 * (Phase 4 verification decision): the Auto-Match already puts the bed its relative target under the voice (music
 * −8 LU, ambience −10 LU of the programme), so during speech the duck only adds headroom on top of the spec's minimum:
 * music ≈ 14 LU, ambience ≈ 16 LU under the voice (the type defaults −15 / −10 dB gave ≈ 23 / 20 LU). 6 dB keeps the
 * minimum with margin for bed swells, fades and the ±1 LU tolerance while leaving the bed audible. A depth the user
 * set is kept.
 */
export const DELIVERY_DUCK_DB = 6;

/** Integrated loudness tolerance an export of a preset is checked against (LU; R 128 allows ±1 LU live, ±0.5 file). */
export const DELIVERY_TOLERANCE_LU = 1;

/** The preset of a delivery id (unknown → web). Never throws. */
export function deliveryPreset(d: unknown): DeliveryPreset {
	return typeof d === 'string' && Object.hasOwn(DELIVERY_PRESETS, d)
		? DELIVERY_PRESETS[d as SoundDelivery]
		: DELIVERY_PRESETS.web;
}

/**
 * Auto-Match targets per Essential Sound type for a delivery (LUFS, the integrated loudness of each clip's own signal):
 * with dialogue in the sequence the voice sits at the programme target and the bed under it (music −8 LU, ambience
 * −10 LU); without dialogue the music is the programme. Sound effects are left to the masking solver (null).
 */
export function deliveryMatchTargets(
	d: unknown,
	hasDialogue: boolean,
): { dialogue: number; music: number; ambience: number; sfx: null } {
	const p = deliveryPreset(d).integratedLufs;
	return {
		dialogue: p,
		music: hasDialogue ? p - DELIVERY_RELATIVE_LU.music : p,
		ambience: p - DELIVERY_RELATIVE_LU.ambience,
		sfx: null,
	};
}
