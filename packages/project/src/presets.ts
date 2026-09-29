// Sequence presets (S01:SEQ-003) and the default track layout (V1–V3, A1–A3).
import type { RGBA } from './schema/common.ts';
import type { SequenceSettings } from './schema/sequence.ts';
import { type Rational, RATES, supportsDropFrame } from './time.ts';

export type SequencePreset = {
	id: string;
	name: string;
	settings: SequenceSettings;
	tracks: { video: number; audio: number };
};

export interface PresetRegistry {
	get(id: string): SequencePreset | undefined;
	list(): SequencePreset[];
}

export const DEFAULT_TRACK_LAYOUT = { video: 3, audio: 3 } as const;
export const BLACK: RGBA = [0, 0, 0, 1];

export function makeSequenceSettings(width: number, height: number, frameRate: Rational): SequenceSettings {
	return {
		frameRate: { num: frameRate.num, den: frameRate.den },
		width,
		height,
		pixelAspect: { num: 1, den: 1 },
		// NTSC presets default to drop-frame timecode (S01 AC-01).
		dropFrame: supportsDropFrame(frameRate),
		startTimecodeFrames: 0,
		audioSampleRate: 48000,
		masterLayout: 'stereo',
		backgroundColor: [...BLACK],
		workingColorSpace: 'rec709',
	};
}

const RATE_LABELS: [string, Rational][] = [
	['23.976', RATES.r23_976],
	['24', RATES.r24],
	['25', RATES.r25],
	['29.97', RATES.r29_97],
	['30', RATES.r30],
	['50', RATES.r50],
	['59.94', RATES.r59_94],
	['60', RATES.r60],
];
const rate = (label: string) => RATE_LABELS.find(([l]) => l === label)![1];

function preset(id: string, name: string, w: number, h: number, r: string): SequencePreset {
	return { id, name, settings: makeSequenceSettings(w, h, rate(r)), tracks: { ...DEFAULT_TRACK_LAYOUT } };
}

export const BUILTIN_PRESETS: readonly SequencePreset[] = [
	...RATE_LABELS.map(([l]) => preset(`hd-1080p-${l}`, `1080p ${l} fps`, 1920, 1080, l)),
	...['24', '25', '30', '60'].map((l) => preset(`uhd-2160p-${l}`, `2160p ${l} fps`, 3840, 2160, l)),
	preset('vertical-1080x1920-30', 'Vertical 1080×1920 30 fps', 1080, 1920, '30'),
	preset('vertical-1080x1920-60', 'Vertical 1080×1920 60 fps', 1080, 1920, '60'),
	preset('square-1080-30', 'Square 1080×1080 30 fps', 1080, 1080, '30'),
	preset('hd-720p-30', '720p 30 fps', 1280, 720, '30'),
];

export const DEFAULT_PRESET_ID = 'hd-1080p-30';

export function createPresetRegistry(presets: readonly SequencePreset[] = BUILTIN_PRESETS): PresetRegistry {
	const map = new Map(presets.map((p) => [p.id, p]));
	return { get: (id) => map.get(id), list: () => [...map.values()] };
}

export const defaultPresetRegistry = createPresetRegistry();
