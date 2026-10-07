// audio-fx: channel utilities and stereo imagery (ported from filmcraft `audio-dsp/src/effects/channel.rs`,
// `essential.rs` StereoWidth and `special.rs` ChannelMixer / StereoExpander / Binauralizer / AmbisonicsPanner;
// Mono Maker is ours). Folders follow Premiere's Audio Effects panel.
import type { EffectSpec } from '../effects.ts';
import { defineAudioEffect, audioParam as P } from './define.ts';

const percent = (name: string, label: string, def: number) => P.pct(name, label, def, -100, 100);

export const AUDIO_STEREO_CHANNEL_EFFECTS: readonly EffectSpec[] = [
	defineAudioEffect({
		id: 'jasper.audio.amplify',
		label: 'Amplify',
		category: 'Amplitude and Compression',
		description: 'Boosts or attenuates the left and right channels (linked by default); −96 dB = silence.',
		keywords: ['gain', 'volume', 'boost', 'level'],
		params: [
			P.db('leftGain', 'Left Gain', 0, -96, 24),
			P.db('rightGain', 'Right Gain', 0, -96, 24),
			P.toggle('link', 'Link Gain Knobs', true),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.channel-mixer',
		label: 'Channel Mixer',
		category: 'Amplitude and Compression',
		description:
			'Remixes the stereo channels: each output is a percentage of both inputs, with polarity inversion.',
		keywords: ['matrix', 'routing', 'mono', 'swap'],
		params: [
			percent('leftFromLeft', 'Left - Left', 100),
			percent('leftFromRight', 'Left - Right', 0),
			percent('rightFromLeft', 'Right - Left', 0),
			percent('rightFromRight', 'Right - Right', 100),
			P.toggle('invertLeft', 'Invert Left', false),
			P.toggle('invertRight', 'Invert Right', false),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.channel-volume',
		label: 'Channel Volume',
		category: 'Amplitude and Compression',
		description: 'Sets the level of the left and right channels independently.',
		keywords: ['gain', 'left', 'right', 'level'],
		params: [P.db('left', 'Left', 0, -96, 24), P.db('right', 'Right', 0, -96, 24)],
	}),
	defineAudioEffect({
		id: 'jasper.audio.balance',
		label: 'Balance',
		category: 'Stereo Imagery',
		description:
			'Balance attenuates the opposite side of a stereo signal (cosine law); Pan sums to mono and places it with the constant-power law.',
		keywords: ['pan', 'stereo', 'left', 'right'],
		params: [
			P.pan('balance', 'Balance'),
			P.choice(
				'mode',
				'Mode',
				[
					['balance', 'Balance'],
					['pan', 'Pan (constant power)'],
				],
				'balance',
			),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.fill-left-with-right',
		label: 'Fill Left with Right',
		category: 'Special',
		description: 'Copies the right channel into the left one (a right-only recording plays on both sides).',
		keywords: ['mono', 'channel', 'duplicate', 'copy'],
		params: [],
	}),
	defineAudioEffect({
		id: 'jasper.audio.fill-right-with-left',
		label: 'Fill Right with Left',
		category: 'Special',
		description: 'Copies the left channel into the right one (a left-only recording plays on both sides).',
		keywords: ['mono', 'channel', 'duplicate', 'copy'],
		params: [],
	}),
	defineAudioEffect({
		id: 'jasper.audio.invert',
		label: 'Invert',
		category: 'Special',
		description: 'Inverts the polarity (phase) of all channels or of one channel.',
		keywords: ['phase', 'polarity', 'flip'],
		params: [
			P.choice(
				'channels',
				'Channels',
				[
					['all', 'All'],
					['left', 'Left'],
					['right', 'Right'],
				],
				'all',
			),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.swap-channels',
		label: 'Swap Channels',
		category: 'Special',
		description: 'Exchanges the left and right channels.',
		keywords: ['reverse stereo', 'left', 'right', 'flip'],
		params: [],
	}),
	defineAudioEffect({
		id: 'jasper.audio.mono-maker',
		label: 'Mono Maker',
		category: 'Stereo Imagery',
		description:
			'Sums the stereo signal to mono — fully, or only below a crossover frequency (flat Linkwitz–Riley split) to tighten the low end.',
		keywords: ['mono', 'sum', 'bass', 'low end', 'collapse'],
		params: [
			P.choice(
				'mode',
				'Mode',
				[
					['full', 'Full Range'],
					['below', 'Below Frequency'],
				],
				'full',
			),
			P.hz('frequency', 'Frequency', 150, 20, 2000),
			P.pct('amount', 'Amount', 100),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.stereo-expander',
		label: 'Stereo Expander',
		category: 'Stereo Imagery',
		description:
			'Mid/side imaging: Stereo Expand scales the side signal; Center Channel Pan places the centre.',
		keywords: ['width', 'wide', 'mid side', 'imaging'],
		params: [P.pan('centerPan', 'Center Channel Pan'), P.pct('expand', 'Stereo Expand', 100, 0, 300)],
	}),
	defineAudioEffect({
		id: 'jasper.audio.stereo-width',
		label: 'Stereo Width',
		category: 'Stereo Imagery',
		description: 'Narrows (0 % = mono) or widens (up to 200 %) the stereo image with mid/side scaling.',
		keywords: ['width', 'wide', 'narrow', 'mid side'],
		params: [P.pct('width', 'Width', 100, 0, 200)],
	}),
	defineAudioEffect({
		id: 'jasper.audio.binauralizer',
		label: 'Binauralizer - Ambisonics',
		category: 'Special',
		description:
			'Renders the stereo pair as two virtual loudspeakers heard through a spherical head model (interaural delay and head shadow), for headphones.',
		keywords: ['binaural', 'headphones', 'hrtf', '3d', 'spatial'],
		params: [
			P.num('angle', 'Speaker Angle', 30, 0, 90, { step: 0.1 }),
			P.num('headSize', 'Head Size (cm)', 17.5, 12, 24, { step: 0.1 }),
			P.pct('mix', 'Mix', 100),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.ambisonics-panner',
		label: 'Panner - Ambisonics',
		category: 'Special',
		description:
			'Rotates the sound field of the stereo pair (pan, tilt, roll) and re-renders it to stereo; sources turned behind are attenuated.',
		keywords: ['rotate', 'sound field', 'vr', '360', 'spatial'],
		params: [
			P.num('pan', 'Pan', 0, -180, 180, { step: 0.1 }),
			P.num('tilt', 'Tilt', 0, -90, 90, { step: 0.1 }),
			P.num('roll', 'Roll', 0, -180, 180, { step: 0.1 }),
		],
	}),
];
