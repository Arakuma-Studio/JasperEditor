// spec 13 AS-001 / AS-012 / AS-020: every subtitle command is ONE History entry whatever the number of subtitles;
// undo restores the exact previous document and redo the exact result.
import {
	type CommandInput,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

const WORDS = 600;

function asset(key: string) {
	return {
		kind: 'video' as const,
		fingerprint: `q1:${key.padStart(64, '0')}`,
		originalName: `${key}.mp4`,
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 400 * FLICKS_PER_SECOND,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video' as const,
					codec: 'h264',
					width: 1080,
					height: 1920,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 60000, den: 1001 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
				{
					index: 1,
					type: 'audio' as const,
					codec: 'aac',
					sampleRate: 48000,
					channels: 2,
					channelLayout: 'stereo',
				},
			],
			rotationDegrees: 0 as const,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store' as const, engineId: 'local', key: `mk_${key}` }],
		derivation: null,
		importedAt: '2026-10-25T00:00:00.000Z',
	};
}

async function open() {
	const ids = createCounterIdSource(1);
	const now = () => '2026-10-25T10:00:00.000Z';
	const store = new MemoryProjectStore({ ids, now });
	const doc = createEmptyProject({ ids, name: 'Subtitles', preset: 'vertical-1080x1920-60' });
	store.put(doc);
	const s = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now, registries: defaultRegistries() },
		sessionId: 's1',
	});
	const ok = (commands: CommandInput[]) => {
		const r = s.apply({ label: 'Setup', origin: 'user', commands });
		if (!r.ok) throw new Error(JSON.stringify(r));
		return r;
	};
	const a = (
		ok([{ type: 'media.register', asset: asset('a') } as CommandInput]).results[0] as { mediaId: string }
	).mediaId;
	const b = (
		ok([{ type: 'media.register', asset: asset('b') } as CommandInput]).results[0] as { mediaId: string }
	).mediaId;
	ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			tracks: { video: 'V1', audio: ['A1'] },
			mode: 'overwrite',
		},
	]);
	// B-roll cuts every 4 s for 1 s
	ok(
		Array.from({ length: 60 }, (_, i) => ({
			type: 'clip.place' as const,
			source: { mediaId: b },
			sourceRange: { in: { seconds: i }, out: { seconds: i + 1 } },
			at: { seconds: 4 * i + 2 },
			tracks: { video: 'V2' },
			audio: false,
			mode: 'overwrite' as const,
		})),
	);
	const w = (i: number) => ({
		text: i % 7 === 6 ? `palabra${i}.` : `w${i}`,
		start: Math.round(i * 0.4 * FLICKS_PER_SECOND),
		end: Math.round((i * 0.4 + 0.35) * FLICKS_PER_SECOND),
	});
	ok([
		{
			type: 'transcript.create',
			mediaId: a,
			language: 'es',
			origin: 'manual',
			words: Array.from({ length: WORDS }, (_, i) => w(i)),
		} as CommandInput,
	]);
	return { s };
}

const groupOf = (d: ProjectDocument) =>
	Object.keys(
		(Object.values(d.sequences)[0] as { captionGroups?: Record<string, unknown> }).captionGroups ?? {},
	)[0]!;

describe('subtitle commands in the session history', () => {
	it('generate, align, regenerate, template, convert both ways and edits are one undo step each, exact', async () => {
		const { s } = await open();
		const step = (commands: CommandInput[] | ((d: ProjectDocument) => CommandInput[])) => {
			const before = s.getCommitted();
			const snapshot = structuredClone(before);
			const depth = s.getState().history.index;
			const r = s.apply({
				label: 'Step',
				origin: 'user',
				commands: typeof commands === 'function' ? commands(before) : commands,
			});
			expect(r.ok, JSON.stringify(r)).toBe(true);
			if (!r.ok) throw new Error('failed');
			expect(s.getState().history.index).toBe(depth + 1);
			const afterSnapshot = structuredClone(s.getCommitted());
			expect(s.undo().ok).toBe(true);
			expect(s.getCommitted()).toEqual(snapshot);
			expect(s.redo().ok).toBe(true);
			expect(s.getCommitted()).toEqual(afterSnapshot);
			return r;
		};
		const t0 = performance.now();
		const gen = step([
			{ type: 'captions.generate', template: 'builtin:pixel-pop', cutAware: false } as CommandInput,
		]);
		const ms = performance.now() - t0;
		const res = gen.results[0] as { clipIds: string[]; stats: { crossing: number } };
		expect(res.clipIds.length).toBeGreaterThan(150);
		// one generation of hundreds of animated subtitles stays interactive (reported; bound generous for shared CI)
		expect(ms).toBeLessThan(20_000);
		const al = step((d) => [{ type: 'captions.alignToCuts', groupId: groupOf(d) } as CommandInput]);
		expect((al.results[0] as { crossing: number; splitAtCuts: number }).crossing).toBe(0);
		step((d) => [
			{
				type: 'captions.regenerate',
				groupId: groupOf(d),
				rules: { maxWords: 2 },
				cutAware: true,
			} as CommandInput,
		]);
		step((d) => [
			{ type: 'subtitleTemplate.apply', template: 'builtin:bold-pop', groupId: groupOf(d) } as CommandInput,
		]);
		step((d) => {
			const seq = Object.values(d.sequences)[0]!;
			const c = Object.values(seq.clips).find((x) => (x as { caption?: unknown }).caption)!;
			return [
				{ type: 'clip.update', clipId: c.id, patch: { content: { text: 'otra cosa' } } } as CommandInput,
			];
		});
		step((d) => {
			const seq = Object.values(d.sequences)[0]!;
			const c = Object.values(seq.clips).find((x) => (x as { caption?: unknown }).caption && x.duration > 4)!;
			return [{ type: 'clip.split', at: c.start + 2, clipIds: [c.id] } as CommandInput];
		});
		const conv = step((d) => [
			{ type: 'captions.convert', groupId: groupOf(d), to: 'caption-track' } as CommandInput,
		]);
		const trackId = (conv.results[0] as { trackId: string }).trackId;
		step([{ type: 'captions.convert', captionTrackId: trackId, to: 'text-clips' } as CommandInput]);
	});
});
