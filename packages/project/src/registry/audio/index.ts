// The audio effect catalogue (audio-fx; docs/wp-notes/audio-fx.md). Every family file exports one
// `readonly EffectSpec[]`; `AUDIO_EFFECTS` concatenates them in Effects-panel order and is part of
// `defaultEffectRegistry` (Effects panel ▸ Audio Effects, Effect Controls, agent schema export, engine). The DSP of
// each entry is the processor with the same id in `@jasper/audio-fx`.
import type { EffectSpec } from '../effects.ts';
import { AUDIO_DELAY_MODULATION_EFFECTS } from './delay-modulation.ts';
import { AUDIO_DYNAMICS_EFFECTS } from './dynamics.ts';
import { AUDIO_FILTER_EQ_EFFECTS } from './filter-eq.ts';
import { AUDIO_PITCH_EFFECTS } from './pitch.ts';
import { AUDIO_RESTORATION_EFFECTS } from './restoration.ts';
import { AUDIO_REVERB_EFFECTS } from './reverb.ts';
import { AUDIO_SPECIAL_EFFECTS } from './special.ts';
import { AUDIO_STEREO_CHANNEL_EFFECTS } from './stereo-channel.ts';

export * from './define.ts';

/** The families, for the catalogue test (every id starts with `jasper.audio.`). */
export const AUDIO_FAMILIES: readonly { file: string; effects: readonly EffectSpec[] }[] = [
	{ file: 'dynamics', effects: AUDIO_DYNAMICS_EFFECTS },
	{ file: 'delay-modulation', effects: AUDIO_DELAY_MODULATION_EFFECTS },
	{ file: 'filter-eq', effects: AUDIO_FILTER_EQ_EFFECTS },
	{ file: 'restoration', effects: AUDIO_RESTORATION_EFFECTS },
	{ file: 'reverb', effects: AUDIO_REVERB_EFFECTS },
	{ file: 'special', effects: AUDIO_SPECIAL_EFFECTS },
	{ file: 'stereo-channel', effects: AUDIO_STEREO_CHANNEL_EFFECTS },
	{ file: 'pitch', effects: AUDIO_PITCH_EFFECTS },
];

/** Every audio effect, in Effects-panel order. */
export const AUDIO_EFFECTS: readonly EffectSpec[] = AUDIO_FAMILIES.flatMap((f) => f.effects);

const BY_ID = new Map(AUDIO_EFFECTS.map((s) => [s.id, s]));

/** The audio effect spec of an id (undefined for video and unknown effects). */
export function audioEffectSpec(id: string): EffectSpec | undefined {
	return BY_ID.get(id);
}
