// Worked examples for describe_commands. Every example is dry-run against a real project in
// test/integration.test.ts, so they stay valid when schemas change. Semantic addresses
// ({mediaByName}, {clipAt}, {markerByName}) keep them independent of generated ids.

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
	'clip.update': {
		type: 'clip.update',
		clipId: { clipAt: { track: 'V1', at: 0 } },
		patch: { name: 'Opening shot' },
	},
	'param.set': {
		type: 'param.set',
		target: ['clip', '$clip', 'opacity'],
		value: 0.5,
	},
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
