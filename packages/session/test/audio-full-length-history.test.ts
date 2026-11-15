// Extending a sound clip into the last partial frame of its media (a 1.128 s sound: 67.68 frames at 60 fps) is one
// History step: undo gives back the 67-frame clip, redo the 68-frame one.
import {
	type CommandInput,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
} from '@jasper/project';
import { expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

const sound = {
	kind: 'audio' as const,
	fingerprint: `q1:${'7'.padStart(64, '0')}`,
	originalName: 'keke.mp3',
	sizeBytes: 1000,
	container: 'mp3',
	probe: {
		durationFlicks: Math.round(1.128 * FLICKS_PER_SECOND),
		startTimecode: null,
		streams: [
			{
				index: 0,
				type: 'audio' as const,
				codec: 'mp3',
				sampleRate: 48000,
				channels: 2,
				channelLayout: 'stereo',
			},
		],
		rotationDegrees: 0 as const,
		hasAlpha: false,
		variableFrameRate: false,
	},
	locators: [{ type: 'engine-store' as const, engineId: 'local', key: 'mk_keke' }],
	derivation: null,
	importedAt: '2026-11-15T00:00:00.000Z',
};

it('undoes and redoes extending a sound clip to its rounded-up end', async () => {
	const ids = createCounterIdSource(1);
	const now = () => '2026-11-15T10:00:00.000Z';
	const store = new MemoryProjectStore({ ids, now });
	const doc = createEmptyProject({ ids, name: 'Sound', preset: 'hd-1080p-60' });
	store.put(doc);
	const s = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now, registries: defaultRegistries() },
		sessionId: 's1',
	});
	const apply = (commands: CommandInput[]) => s.apply({ label: 'Edit', origin: 'user', commands });
	const reg = apply([{ type: 'media.register', asset: sound, ref: '$m' } as CommandInput]);
	if (!reg.ok) throw new Error(JSON.stringify(reg.errors));
	const placed = apply([
		{
			type: 'clip.place',
			source: { mediaId: reg.refs.$m! },
			sourceRange: { in: { flicks: 0 }, out: { flicks: (67 * FLICKS_PER_SECOND) / 60 } },
			at: 0,
			tracks: { audio: 'A1' },
			ref: '$c',
		} as CommandInput,
	]);
	if (!placed.ok) throw new Error(JSON.stringify(placed.errors));
	const id = placed.refs.$c!;
	const duration = () => Object.values(s.getCommitted().sequences)[0]!.clips[id]!.duration;
	expect(apply([{ type: 'clip.trim', clipId: id, edge: 'out', deltaFrames: 1 } as CommandInput]).ok).toBe(
		true,
	);
	expect(duration()).toBe(68);
	expect(s.undo().ok).toBe(true);
	expect(duration()).toBe(67);
	expect(s.redo().ok).toBe(true);
	expect(duration()).toBe(68);
});
