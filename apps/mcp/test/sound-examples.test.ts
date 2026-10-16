// The describe_commands examples of the sound-design commands run against a real project (spec 12 §2.9).
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	resolveAgentAddresses,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { COMMAND_EXAMPLES } from '../src/examples.ts';

const SOUND_COMMANDS = [
	'media.setLibraryInfo',
	'soundCue.add',
	'soundCue.update',
	'soundCue.remove',
	'soundCue.resync',
	'soundDesign.place',
	'soundDesign.swap',
	'soundDesign.setRole',
	'soundDesign.setPalette',
	'soundDesign.setSettings',
	'soundDesign.setPeak',
	'soundDesign.applyGains',
];

/** Examples whose prelude runs in the same transaction (they use a `$ref` the prelude binds). */
const SAME_TX = new Set(['soundDesign.applyGains']);

/** What an example needs in the project first (a cue to edit, a placed sound to swap). */
const PRELUDE: Record<string, unknown[]> = {
	'soundCue.update': [
		{
			type: 'soundCue.add',
			cues: [{ id: 'cue_00000000000000EX', frame: 30, kind: 'cut', weight: 'support', source: 'user' }],
		},
	],
	'soundCue.remove': [
		{
			type: 'soundCue.add',
			cues: [{ id: 'cue_00000000000000EX', frame: 30, kind: 'cut', weight: 'support', source: 'user' }],
		},
	],
	'soundDesign.swap': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1' }],
		},
	],
	'soundDesign.setRole': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1' }],
		},
	],
	'soundDesign.setPeak': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1' }],
		},
	],
	'soundDesign.applyGains': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1', ref: '$sfx' }],
		},
	],
};

describe('sound-design describe_commands examples', () => {
	it.each(SOUND_COMMANDS)('%s applies to a project with clip-a.mp4', (type) => {
		const ids = createCounterIdSource(3);
		const ctx = { ids, now: () => '2026-10-15T00:00:00.000Z', revision: 0, registries: defaultRegistries() };
		const empty = createEmptyProject({ ids, name: 'Examples', preset: 'hd-1080p-30' });
		const reg = applyTransaction(
			empty,
			{
				label: 'import',
				origin: 'user',
				commands: [
					{
						type: 'media.register',
						asset: {
							kind: 'video',
							fingerprint: 'q1:example',
							originalName: 'clip-a.mp4',
							sizeBytes: 1,
							container: 'mov,mp4',
							probe: {
								durationFlicks: 705_600_000,
								startTimecode: null,
								streams: [
									{
										index: 0,
										type: 'audio',
										codec: 'aac',
										sampleRate: 48_000,
										channels: 2,
										channelLayout: 'stereo',
									},
								],
								rotationDegrees: 0,
								hasAlpha: false,
								variableFrameRate: false,
							},
							locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_example' }],
						},
					},
				],
			},
			ctx,
		);
		expect(reg.result.ok).toBe(true);
		const example = COMMAND_EXAMPLES[type];
		expect(example).toBeDefined();
		let doc = reg.document;
		const prelude = SAME_TX.has(type) ? undefined : PRELUDE[type];
		if (prelude) {
			const p = resolveAgentAddresses(doc, prelude);
			expect(p.ok).toBe(true);
			if (!p.ok) return;
			const pr = applyTransaction(
				doc,
				{ label: 'prelude', origin: 'user', commands: p.commands },
				{ ...ctx, revision: 1 },
			);
			expect(pr.result.ok, JSON.stringify(pr.result)).toBe(true);
			doc = pr.document;
		}
		const resolved = resolveAgentAddresses(doc, [...(SAME_TX.has(type) ? PRELUDE[type]! : []), example]);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const r = applyTransaction(
			doc,
			{ label: 'example', origin: 'user', commands: resolved.commands },
			{ ...ctx, revision: 2 },
		);
		expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
	});
});
