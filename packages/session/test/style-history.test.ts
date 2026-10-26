// spec 15 EA-012: accepting an Apply Style proposal (voice cleanup, subtitles, kits, punch-ins, Ken Burns — planned on
// the cleaned-up timeline) is ONE History entry; Undo restores the exact previous document and Redo the exact result.
import { setImmediate } from 'node:timers/promises';
import {
	builtinStyleRecipe,
	type CommandInput,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	planStyle,
	styleDraft,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, proposalsFor } from '../src/index.ts';
import { FakeEngine } from './fake-proposals-engine.ts';

const REG = defaultRegistries();
const NOW = '2026-10-26T10:00:00.000Z';

const camera = {
	kind: 'video' as const,
	fingerprint: `q1:${'c'.padStart(64, '0')}`,
	originalName: 'cam.mp4',
	sizeBytes: 1000,
	container: 'mov,mp4',
	probe: {
		durationFlicks: 3600 * FLICKS_PER_SECOND,
		startTimecode: null,
		streams: [
			{
				index: 0,
				type: 'video' as const,
				codec: 'h264',
				width: 1920,
				height: 1080,
				pixelAspect: { num: 1, den: 1 },
				frameRate: { num: 30, den: 1 },
				pixelFormat: 'yuv420p',
				bitDepth: 8,
				color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
				browserDecodable: true,
			},
			{ index: 1, type: 'audio' as const, codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
		],
		rotationDegrees: 0 as const,
		hasAlpha: false,
		variableFrameRate: false,
	},
	locators: [{ type: 'engine-store' as const, engineId: 'local', key: 'mk_cam' }],
	derivation: null,
	importedAt: NOW,
};

describe('Apply Style in the session', () => {
	it('Apply of the whole proposal is ONE History entry; Undo / Redo give the exact documents', async () => {
		const ids = createCounterIdSource(1);
		const doc = createEmptyProject({ ids, name: 'Style', preset: 'hd-1080p-30' });
		let session!: EditorSession;
		const engine = new FakeEngine(() => session);
		session = new EditorSession({ projectId: doc.projectId, document: doc, ctx: { ids, now: () => NOW, registries: REG } });
		const seqId = Object.keys(doc.sequences)[0]!;
		const F = FLICKS_PER_SECOND / 30;
		const lengths = [150, 120, 180, 90, 210, 150];
		const words: { text: string; start: number; end: number }[] = [];
		const places: CommandInput[] = [];
		let at = 0;
		let src = 0;
		for (const len of lengths) {
			for (let f = 0; f + 9 <= len; f += 12) words.push({ text: `w${words.length}`, start: (src + f) * F, end: (src + f + 9) * F });
			places.push({
				type: 'clip.place',
				source: { mediaId: '$cam' },
				at,
				tracks: { video: 'V1', audio: 'A1' },
				sourceRange: { in: { flicks: src * F }, out: { flicks: (src + len) * F } },
			} as CommandInput);
			at += len;
			src += len + 30;
		}
		const setup = session.apply({
			label: 'Setup',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'media.register', asset: camera, ref: '$cam' },
				{ type: 'transcript.create', mediaId: '$cam', language: 'es', origin: 'manual', words },
				...places,
			] as CommandInput[],
		});
		if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
		const audio = Object.values(session.getCommitted().sequences[seqId]!.clips)
			.filter((c) => c.kind === 'audio')
			.map((c) => c.id);
		const plan = await planStyle(
			session.getCommitted(),
			{ recipe: builtinStyleRecipe('builtin:fast-long-form')!, seed: 2, passes: { slides: false, music: false } },
			{
				cleanup: async () => ({
					ranges: [
						{ start: 60, end: 75 },
						{ start: 400, end: 420 },
					],
					clipIds: audio,
					fadeMs: 4,
					jlFrames: 0,
				}),
			},
			{ registries: REG, now: () => NOW },
		);
		const draft = styleDraft(plan)!;
		expect(draft).toBeTruthy();
		const c = proposalsFor(session, { engine });
		c.connect(engine.subscribe);
		const p = engine.create(draft as never, 'user');
		await c.setActive(p.id);
		await c.setItemDecision(p.items.map((it) => it.id), 'accept');
		const before = session.getCommitted();
		const entries = session.getState().history.entries.length;
		const r = await c.apply({ trusted: true });
		expect(r.ok, JSON.stringify(r)).toBe(true);
		const h = session.getState().history.entries;
		expect(h).toHaveLength(entries + 1);
		expect(h.at(-1)!.label).toMatch(/^Accept Apply Style: Fast Long-form/);
		const after = session.getCommitted();
		expect(Object.keys((after.sequences[seqId] as { captionGroups?: object }).captionGroups ?? {})).toHaveLength(1);
		expect(after.styleRecipes?.active).toBe('builtin:fast-long-form');
		expect(session.undo().ok).toBe(true);
		await setImmediate();
		expect(session.getCommitted()).toEqual(before);
		expect(session.redo().ok).toBe(true);
		await setImmediate();
		expect(session.getCommitted()).toEqual(after);
	});
});
