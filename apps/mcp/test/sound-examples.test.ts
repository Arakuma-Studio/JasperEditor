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

const SOUND_COMMANDS = ['media.setLibraryInfo'];

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
		const resolved = resolveAgentAddresses(reg.document, [example]);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const r = applyTransaction(
			reg.document,
			{ label: 'example', origin: 'user', commands: resolved.commands },
			{ ...ctx, revision: 1 },
		);
		expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
	});
});
