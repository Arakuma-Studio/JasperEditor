// audio-fx: the one way family files declare audio effects (docs/wp-notes/audio-fx.md). Every entry gets the same
// defaults — version 1, `appliesTo: 'audio'`, `preview: 'webaudio'` (the AudioWorklet chain), native + Remotion
// export (the shared TypeScript DSP of `@jasper/audio-fx` streams into ffmpeg on both paths) — and Premiere's Audio
// Effects folder as its category. The DSP processor of an effect (`@jasper/audio-fx`, keyed by the same id) reads
// the parameters declared here by name: names, ranges and defaults are the single source of truth.
//
// Import rule (keeps `@jasper/project/audio` light enough for the AudioWorklet bundle): family files import from
// `./define.ts` only, and only TYPES from `../effects.ts`.
import type {
	AudioEffectEditor,
	AudioEffectInfo,
	EffectCategory,
	EffectSpec,
	ParamSpec,
} from '../effects.ts';

/** Premiere's Audio Effects folders (the effect's category; helpx "Audio effects and transitions"). */
export const AUDIO_EFFECT_FOLDERS = [
	'Amplitude and Compression',
	'Delay and Echo',
	'Filter and EQ',
	'Modulation',
	'Noise Reduction/Restoration',
	'Reverb',
	'Special',
	'Stereo Imagery',
	'Time and Pitch',
] as const satisfies readonly EffectCategory[];
export type AudioEffectFolder = (typeof AUDIO_EFFECT_FOLDERS)[number];

export type AudioEffectInit = {
	/** `jasper.audio.<kebab>`. */
	id: string;
	label: string;
	category: AudioEffectFolder;
	params: ParamSpec[];
	description: string;
	keywords?: readonly string[];
	editor?: AudioEffectEditor;
	meters?: AudioEffectInfo['meters'];
	/** Heavy DSP (spectral, convolution): flagged in the Effects panel like expensive video effects. */
	expensive?: boolean;
	version?: number;
	migrate?: EffectSpec['migrate'];
	/** Values new instances get (`effect.add`) where they differ from the defaults stored instances read. */
	instanceDefaults?: EffectSpec['instanceDefaults'];
};

export function defineAudioEffect(init: AudioEffectInit): EffectSpec {
	return {
		id: init.id,
		version: init.version ?? 1,
		label: init.label,
		category: init.category,
		appliesTo: 'audio',
		params: init.params,
		preview: {},
		native: null,
		audio: {
			dsp: true,
			...(init.editor ? { editor: init.editor } : {}),
			...(init.meters ? { meters: init.meters } : {}),
		},
		capabilities: { preview: 'webaudio', export: ['native', 'remotion'] },
		...(init.expensive ? { expensive: true } : {}),
		description: init.description,
		...(init.keywords ? { keywords: init.keywords } : {}),
		...(init.migrate ? { migrate: init.migrate } : {}),
		...(init.instanceDefaults ? { instanceDefaults: init.instanceDefaults } : {}),
	};
}

type Extra = { group?: string; animatable?: boolean; step?: number; softMin?: number; softMax?: number };

function number(
	name: string,
	label: string,
	def: number,
	min: number,
	max: number,
	unit: ParamSpec['unit'] | undefined,
	ui: ParamSpec['ui'] | undefined,
	extra?: Extra,
): ParamSpec {
	return {
		name,
		label,
		type: 'number',
		default: def,
		range: {
			min,
			max,
			...(extra?.softMin !== undefined ? { softMin: extra.softMin } : {}),
			...(extra?.softMax !== undefined ? { softMax: extra.softMax } : {}),
			step: extra?.step ?? defaultStep(min, max),
		},
		...(unit ? { unit } : {}),
		animatable: extra?.animatable ?? true,
		...(ui ? { ui } : {}),
		...(extra?.group ? { group: extra.group } : {}),
	};
}

function defaultStep(min: number, max: number): number {
	const span = max - min;
	return span > 1000 ? 1 : span > 100 ? 0.1 : 0.01;
}

/**
 * Audio parameter builders. Every number is keyframable (S01:KF-001); toggles and choices are keyframable with hold
 * interpolation (S01:KF-007). Choices store the option id (string) in the document; the DSP reads its index.
 */
export const audioParam = {
	/** A level or gain in dB (bipolar slider when the range spans 0). */
	db(name: string, label: string, def: number, min: number, max: number, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, 'dB', min < 0 && max > 0 ? { bipolar: true } : undefined, {
			step: 0.1,
			...extra,
		});
	},
	/** A frequency in Hz (logarithmic control). */
	hz(name: string, label: string, def: number, min: number, max: number, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, 'Hz', { scale: 'log' }, { step: 1, ...extra });
	},
	/** A time in milliseconds (logarithmic control when the range is wide). */
	ms(name: string, label: string, def: number, min: number, max: number, extra?: Extra): ParamSpec {
		return number(
			name,
			label,
			def,
			min,
			max,
			'ms',
			min > 0 && max / min >= 50 ? { scale: 'log' } : undefined,
			{ step: 0.1, ...extra },
		);
	},
	/** A time in seconds. */
	seconds(name: string, label: string, def: number, min: number, max: number, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, 's', undefined, { step: 0.01, ...extra });
	},
	/** Filter quality (logarithmic). */
	q(name: string, label: string, def: number, min = 0.1, max = 30, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, 'Q', { scale: 'log' }, { step: 0.01, ...extra });
	},
	/** Compression ratio `x:1`. */
	ratio(name: string, label: string, def: number, min = 1, max = 30, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, 'ratio', { scale: 'log' }, { step: 0.1, ...extra });
	},
	/** A percentage (slider). */
	pct(name: string, label: string, def: number, min = 0, max = 100, extra?: Extra): ParamSpec {
		return number(
			name,
			label,
			def,
			min,
			max,
			'%',
			{ control: 'slider', ...(min < 0 ? { bipolar: true } : {}) },
			{
				step: 0.1,
				...extra,
			},
		);
	},
	/** Semitones. */
	semitones(name: string, label: string, def: number, min: number, max: number, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, 'st', { bipolar: true }, { step: 0.01, ...extra });
	},
	/** Cents. */
	cents(name: string, label: string, def: number, min: number, max: number, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, 'cents', { bipolar: true }, { step: 1, ...extra });
	},
	/** A loudness in LUFS. */
	lufs(name: string, label: string, def: number, min: number, max: number, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, 'LUFS', undefined, { step: 0.1, ...extra });
	},
	/** Tempo in beats per minute. */
	bpm(name: string, label: string, def: number, min: number, max: number, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, 'bpm', undefined, { step: 0.1, ...extra });
	},
	/** Pan / balance −100 (left) … +100 (right). */
	pan(name: string, label: string, def = 0, extra?: Extra): ParamSpec {
		return number(
			name,
			label,
			def,
			-100,
			100,
			undefined,
			{ control: 'slider', bipolar: true },
			{
				step: 0.1,
				...extra,
			},
		);
	},
	/** A unitless number. */
	num(name: string, label: string, def: number, min: number, max: number, extra?: Extra): ParamSpec {
		return number(name, label, def, min, max, undefined, undefined, extra);
	},
	/** An on/off switch (hold keyframes). */
	toggle(name: string, label: string, def: boolean, extra?: Pick<Extra, 'group' | 'animatable'>): ParamSpec {
		return {
			name,
			label,
			type: 'boolean',
			default: def,
			animatable: extra?.animatable ?? true,
			ui: { control: 'toggle' },
			...(extra?.group ? { group: extra.group } : {}),
		};
	},
	/** A choice: `options` are `[id, label]` pairs; the document stores the id (hold keyframes). */
	choice(
		name: string,
		label: string,
		options: readonly (readonly [string, string])[],
		def: string,
		extra?: Pick<Extra, 'group' | 'animatable'>,
	): ParamSpec {
		if (!options.some(([id]) => id === def))
			throw new Error(`audio param ${name}: default ${def} not an option`);
		return {
			name,
			label,
			type: 'enum',
			default: def,
			options: options.map(([id]) => id),
			optionLabels: options.map(([, l]) => l),
			animatable: extra?.animatable ?? true,
			ui: { control: 'select' },
			...(extra?.group ? { group: extra.group } : {}),
		};
	},
};
