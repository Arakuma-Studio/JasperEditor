// Worked examples for describe_commands. Every example is dry-run against a real project in
// test/integration.test.ts, so they stay valid when schemas change. Semantic addresses
// ({mediaByName}, {clipAt}, {markerByName}) keep them independent of generated ids; examples using the "$clip" /
// "$title" refs are dry-run after the clip.place / clip.addText example that binds them.

// ---- wp-clipboard: a self-contained clipboard payload (a rounded rectangle; no media to resolve).
const HEADER = {
	format: 'jasper-clipboard',
	version: 1,
	sourceProjectId: 'prj_00000000000000EX',
	sourceSequenceId: null,
	media: [],
	synthetics: [],
	transcripts: [],
	fonts: [],
};
const still = <T>(value: T) => ({ value, keyframes: [] });
const TIMING = { start: 0, duration: 60, sourceIn: 0, speed: { rate: 1, reverse: false } };
const EASE = { influence: 1 / 3, slope: 0 };
const FADE_KEYS = [0, 30].map((f, i) => ({
	id: `kf_example${i}`,
	time: f * 23_520_000, // flicks at 30 fps
	value: i === 0 ? 0 : 100,
	interpolation: 'linear',
	easeIn: EASE,
	easeOut: EASE,
}));
const SHAPE_PAYLOAD = {
	...HEADER,
	kind: 'clips',
	clips: {
		clips: [
			{
				id: 'clp_example',
				trackId: 'trk_example',
				...TIMING,
				speed: { rate: 1, reverse: false, maintainPitch: true },
				name: 'Badge',
				label: 'mango',
				enabled: true,
				linkId: null,
				groupId: null,
				markers: [],
				kind: 'shape',
				shape: {
					type: 'rect',
					size: still([400, 120]),
					fill: still([1, 0.8, 0, 1]),
					stroke: null,
					cornerRadius: still(16),
				},
				transform: {
					position: still([960, 900]),
					anchor: still([200, 60]),
					scale: still(100),
					scaleWidth: still(100),
					uniformScale: true,
					rotation: still(0),
					flipH: false,
					flipV: false,
				},
				opacity: { value: 100, keyframes: FADE_KEYS },
				blendMode: 'normal',
				effects: [],
			},
		],
		transitions: [],
		originFrame: 0,
		trackOffsets: { trk_example: 0 },
		trackKinds: { trk_example: 'video' },
		frameRate: { num: 30, den: 1 },
	},
};

export const COMMAND_EXAMPLES: Record<string, unknown> = {
	'clip.place': {
		type: 'clip.place',
		source: { mediaByName: 'clip-a.mp4' },
		at: '00:00:00:00',
		tracks: { video: 'V1', audio: 'A1' },
		matchSequence: 'keep',
		ref: '$clip',
	},
	'clip.addText': {
		type: 'clip.addText',
		at: { seconds: 1 },
		duration: { seconds: 3 },
		track: 'V2',
		content: { text: 'Hello world', style: { sizePx: 96, fill: [1, 1, 1, 1] } },
		transform: { position: [960, 900] },
		textAnimation: { in: { preset: 'slide-up' }, out: { preset: 'fade' } },
		ref: '$title',
	},
	'clip.addMotionGraphic': {
		type: 'clip.addMotionGraphic',
		at: 0,
		duration: { seconds: 5 },
		track: 'V3',
		template: { id: 'lower-third', version: 1 },
		params: { name: 'Jane Doe', title: 'Director' },
	},
	// wp-m2-shapes (S11:ANA-006)
	'clip.addShape': {
		type: 'clip.addShape',
		at: 0,
		duration: { seconds: 4 },
		track: 'V3',
		shape: {
			type: 'rect',
			size: [640, 160],
			fill: [0.1, 0.1, 0.1, 0.8],
			stroke: { color: [1, 0.8, 0, 1], width: 6, position: 'inside' },
			cornerRadius: 24,
		},
		transform: { position: [960, 900] },
	},
	// wp masks
	'mask.add': {
		type: 'mask.add',
		clipId: { clipAt: { track: 'V1', at: '00:00:01:00' } },
		shape: 'ellipse',
		feather: 20,
		ref: '$mask',
	},
	'mask.editPath': {
		type: 'mask.editPath',
		maskId: '$mask',
		at: { sequenceFrame: 30 },
		ops: [
			{ op: 'transform', translate: [0.1, 0], scale: 1.2, rotation: 15 },
			{ op: 'insertVertex', segment: 0, t: 0.5 },
		],
	},
	'clip.move': { type: 'clip.move', clipIds: [{ clipAt: { track: 'V1', at: 0 } }], deltaFrames: 30 },
	'clip.trim': {
		type: 'clip.trim',
		clipId: { clipAt: { track: 'V1', at: 0 } },
		edge: 'out',
		deltaFrames: -30,
		mode: 'regular',
	},
	'clip.split': { type: 'clip.split', at: '00:00:02:00', scope: 'all-unlocked' },
	'clip.lift': { type: 'clip.lift', clipIds: [{ clipAt: { track: 'V1', at: 0 } }] },
	'clip.extract': {
		type: 'clip.extract',
		clipIds: [{ clipAt: { track: 'V1', at: 0 } }],
		syncConflict: 'cut',
	},
	// M2 (S11:ANA-006): a side with preset replaces it, one without merges into it, null removes it.
	'clip.update': {
		type: 'clip.update',
		clipId: '$title',
		patch: {
			name: 'Title',
			textAnimation: {
				in: { preset: 'pop', durationFrames: 12, params: { unit: 'char', stagger: 0.5 } },
				out: { durationFrames: 20 },
			},
		},
	},
	'param.set': {
		type: 'param.set',
		target: ['clip', '$clip', 'opacity'],
		value: 0.5,
	},
	// spatial-motion-path (S03:KF-021/030): a curved position key and its tangents (sequence px offsets).
	'keyframe.add': {
		type: 'keyframe.add',
		target: ['clip', '$clip', 'transform', 'position'],
		at: { sequenceFrame: 30 },
		value: [1400, 300],
		spatial: { mode: 'auto-bezier' },
		ref: '$key',
	},
	'keyframe.setSpatialInterpolation': {
		type: 'keyframe.setSpatialInterpolation',
		keyframeIds: ['$key'],
		mode: 'continuous-bezier',
	},
	'keyframe.setTangents': {
		type: 'keyframe.setTangents',
		keyframeId: '$key',
		outTangent: [200, -120],
	},
	// keyframes-blend: Rove Across Time on the middle keys of a path (the first and last keys stay fixed).
	'keyframe.setRoving': { type: 'keyframe.setRoving', keyframeIds: ['$key'], roving: true },
	'transition.add': {
		type: 'transition.add',
		clipId: { clipAt: { track: 'V1', at: 0 } },
		edge: 'in',
		effectId: 'jasper.dip-to-black',
		duration: 15,
	},
	'marker.add': { type: 'marker.add', frame: '00:00:01:00', name: 'Beat', comment: 'music hit' },
	'track.add': { type: 'track.add', kind: 'video', count: 1 },
	'sequence.setInOut': { type: 'sequence.setInOut', in: 0, out: { seconds: 2 } },
	// wp-clipboard (S01 §20): payloads come from copy_clips / copy_items; these are small hand-written ones.
	'clip.paste': {
		type: 'clip.paste',
		payload: SHAPE_PAYLOAD,
		at: '00:00:10:00',
		mode: 'insert',
		tracks: { video: 'V3' },
	},
	'clip.pasteAttributes': {
		type: 'clip.pasteAttributes',
		payload: SHAPE_PAYLOAD,
		clipIds: [{ clipAt: { track: 'V1', at: 0 } }],
		attributes: { motion: true, opacity: true },
		scaleTimes: true,
	},
	'clip.removeAttributes': {
		type: 'clip.removeAttributes',
		clipIds: [{ clipAt: { track: 'V1', at: 0 } }],
		attributes: { opacity: true },
	},
	'effect.paste': {
		type: 'effect.paste',
		payload: {
			...HEADER,
			kind: 'effects',
			effects: {
				effects: [
					{
						id: 'fx_src',
						effectId: 'jasper.gaussian-blur',
						effectVersion: 1,
						enabled: true,
						params: { radius: { value: 8, keyframes: [] } },
					},
				],
				source: { clipKind: 'video', timing: TIMING, frameRate: { num: 30, den: 1 } },
			},
		},
		clipIds: [{ clipAt: { track: 'V1', at: 0 } }],
	},
	'keyframe.paste': {
		type: 'keyframe.paste',
		payload: {
			...HEADER,
			kind: 'keyframes',
			keyframes: {
				paramType: 'number',
				keyframes: FADE_KEYS,
				originFlicks: 0,
				tracks: [{ address: { property: 'opacity' }, paramType: 'number', keyframes: FADE_KEYS }],
				speed: { rate: 1, reverse: false },
			},
		},
		clipId: { clipAt: { track: 'V1', at: 0 } },
		at: { frames: 0 },
	},
	// wp-m3-presets (S03:FX-030): a fade-in preset authored inline (list_effect_presets / get_effect_preset give real ones).
	'effect.applyPreset': {
		type: 'effect.applyPreset',
		preset: {
			format: 'jasper-effect-preset',
			version: 1,
			id: 'fxp_example',
			name: 'Fade In (1 s)',
			type: 'anchor-in',
			source: { duration: 150, frameRate: { num: 30, den: 1 } },
			intrinsic: {
				opacity: {
					value: 0,
					keyframes: [
						{ time: 0, value: 0 },
						{ time: 705_600_000, value: 100 },
					],
				},
			},
		},
		clipIds: [{ clipAt: { track: 'V1', at: 0 } }],
	},
	'project.pasteItems': {
		type: 'project.pasteItems',
		payload: {
			...HEADER,
			kind: 'project-items',
			items: {
				items: [{ id: 'bin_src', kind: 'bin', name: 'Pasted Selects', children: [], label: 'mango' }],
				sequences: [],
				rootItems: ['bin_src'],
			},
		},
		binId: null,
	},
	// sound-design (spec 12 §2.1): provenance of a Sound Library sound (import_sounds writes it; this sets it by hand).
	'media.setLibraryInfo': {
		type: 'media.setLibraryInfo',
		mediaId: { mediaByName: 'clip-a.mp4' },
		library: {
			soundId: 'snd_0123456789abcdef',
			title: 'Impact Metal 03',
			types: ['hit'],
			source: { type: 'starter' },
			license: 'CC0-1.0',
			licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
			author: 'Kenney',
			attribution: null,
			descriptors: {
				peakSec: 0.0123,
				onsetSec: 0.011,
				headQuietSec: 0.0105,
				durationSec: 0.9,
				octaveBandsDb: [-30, -25, -20, -18, -19, -24, -33],
				centroidHz: 1820,
				maxMomentaryLufs: -14.2,
			},
		},
	},
	// sound-design (spec 12 §2.2, §2.9): cues (what find_sound_cues / deriveCues output) and peak-aligned placement.
	'soundCue.add': {
		type: 'soundCue.add',
		cues: [
			{
				frame: 30,
				kind: 'cut',
				weight: 'support',
				types: ['hit', 'thump'],
				align: 'peak',
				reason: 'Cut on V1',
				source: 'agent',
				ref: '$cue',
			},
		],
	},
	'soundCue.update': { type: 'soundCue.update', cueId: 'cue_00000000000000EX', frame: 45, weight: 'hero' },
	'soundCue.remove': { type: 'soundCue.remove', cueIds: ['cue_00000000000000EX'], withClips: true },
	'soundCue.resync': { type: 'soundCue.resync' },
	'soundDesign.place': {
		type: 'soundDesign.place',
		frame: 30,
		layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'auto', gainDb: -3 }],
	},
	'soundDesign.swap': {
		type: 'soundDesign.swap',
		clipId: { clipAt: { track: 'A1', at: 30 } },
		mediaId: { mediaByName: 'clip-a.mp4' },
		align: 'start',
	},
	'soundDesign.setPalette': {
		type: 'soundDesign.setPalette',
		soundIds: ['snd_0123456789abcdef'],
		mode: 'add',
	},
	'soundDesign.setSettings': { type: 'soundDesign.setSettings', density: 'sparse', delivery: 'web', seed: 7 },
};

/** A multi-command transaction showing temp refs. */
export const TRANSACTION_EXAMPLE = {
	label: 'Rough cut with title',
	commands: [
		COMMAND_EXAMPLES['clip.place'],
		{ type: 'param.set', target: ['clip', '$clip', 'opacity'], value: 0.9 },
		COMMAND_EXAMPLES['clip.addText'],
		COMMAND_EXAMPLES['marker.add'],
	],
};
