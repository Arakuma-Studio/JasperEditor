// JSON console templates (ARCHITECTURE §11 Agent panel M1): transactions and queries an agent would send.

export type ConsoleTemplate = { id: string; label: string; body: unknown };

export const CONSOLE_TEMPLATES: readonly ConsoleTemplate[] = [
	{
		id: 'marker',
		label: 'Add a marker',
		body: {
			label: 'Add marker',
			origin: { agent: 'console' },
			commands: [
				{ type: 'marker.add', frame: '00:00:01:00', name: 'From the console', markerType: 'agent-note' },
			],
		},
	},
	{
		id: 'title-fade',
		label: 'Title with fade-in (S01 Appendix B)',
		body: {
			label: 'Add title and fade in',
			origin: { agent: 'console' },
			commands: [
				{
					type: 'clip.addText',
					ref: '$title',
					at: '00:00:01:00',
					duration: { seconds: 4 },
					track: 'V2',
					content: { text: 'Launch Day' },
					box: { width: 1400, height: 160, autoSize: 'height' },
				},
				{
					type: 'param.setAnimated',
					target: ['clip', '$title', 'opacity'],
					animated: true,
					at: { frames: 0 },
				},
				{ type: 'param.set', target: ['clip', '$title', 'opacity'], value: 0, at: { frames: 0 } },
				{ type: 'param.set', target: ['clip', '$title', 'opacity'], value: 100, at: { frames: 15 } },
				{
					type: 'marker.add',
					frame: 30,
					name: 'Title added',
					markerType: 'agent-note',
					comment: 'Fades in over 0.5 s.',
				},
			],
		},
	},
	{
		id: 'remove-track',
		label: 'Remove track V3 (destructive)',
		body: {
			label: 'Remove V3',
			origin: { agent: 'console' },
			commands: [{ type: 'track.remove', trackIds: ['V3'] }],
		},
	},
	{
		id: 'undo',
		label: 'Undo my last step',
		body: { label: 'Undo', origin: { agent: 'console' }, commands: [{ type: 'history.undo' }] },
	},
	{ id: 'q-summary', label: 'Query: sequence summary', body: { query: 'sequence.summary', args: {} } },
	{
		id: 'q-range',
		label: 'Query: clips in the first 10 s',
		body: { query: 'sequence.clipsInRange', args: { from: 0, to: { seconds: 10 } } },
	},
	{
		id: 'q-at',
		label: 'Query: stack at 00:00:01:00',
		body: { query: 'sequence.at', args: { frame: '00:00:01:00' } },
	},
	{ id: 'q-history', label: 'Query: history', body: { query: 'history.list', args: {} } },
	{ id: 'q-validate', label: 'Query: validate document', body: { query: 'validate', args: {} } },
];

export const DEFAULT_TEMPLATE = CONSOLE_TEMPLATES[0]!;

export const pretty = (v: unknown) => JSON.stringify(v, null, 2);
