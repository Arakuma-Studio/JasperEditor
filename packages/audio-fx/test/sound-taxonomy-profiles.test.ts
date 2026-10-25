// The pure project taxonomy and the DSP judge must apply the same sound profile (ARCHITECTURE §3.1;
// spec 12 §2.1). The project layer cannot import audio-fx, so compare the independently shipped public tables.
import { SOUND_TYPE_PROFILES } from '@jasper/project/sound';
import { expect, it } from 'vitest';
import { DEFAULT_TYPE_PROFILES } from '../src/index.ts';

it('project and DSP judge profiles agree for every sound type', () => {
	expect(SOUND_TYPE_PROFILES).toEqual(DEFAULT_TYPE_PROFILES);
});
