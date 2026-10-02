import { describe, expect, it } from 'vitest';
import { buildMediaAsset, mismatchPatch } from '../../src/import/assets.ts';
import { ClientJobStore } from '../../src/import/client-jobs.ts';
import type { ImportPrompts } from '../../src/import/prompts.ts';
import { EngineImportService, readDataTransfer } from '../../src/import/service.ts';
import { buildImportTransaction, type PreparedMedia } from '../../src/import/transaction.ts';
import { createUnloadGuard } from '../../src/import/unload-guard.ts';
import { PROJECT_ITEMS_MIME } from '../../src/state/services.ts';
import { memorySession, registered, ScriptedEngine } from './helpers.ts';

function fakePrompts(
	answers: { duplicates?: 'use-existing' | 'import-again'; mismatch?: 'change' | 'keep' } = {},
) {
	const log: string[] = [];
	const prompts: ImportPrompts = {
		duplicates: async ({ names }) => {
			log.push(`duplicates:${names.join(',')}`);
			return answers.duplicates ?? 'use-existing';
		},
		clipMismatch: async (info) => {
			log.push(`mismatch:${info.clipName}`);
			return answers.mismatch ?? 'keep';
		},
		failures: ({ failed, committed }) =>
			log.push(`failures:${committed}:${failed.map((f) => `${f.name}=${f.code}`).join(',')}`),
	};
	return { prompts, log };
}

async function setup(answers: Parameters<typeof fakePrompts>[0] = {}, opts: { desktop?: boolean } = {}) {
	const { session } = await memorySession();
	const engine = new ScriptedEngine();
	const jobs = new ClientJobStore();
	const win = new EventTarget();
	const guard = createUnloadGuard(win);
	const { prompts, log } = fakePrompts(answers);
	const picked: string[] = [];
	const service = new EngineImportService({
		engine: engine.client(),
		session,
		prompts,
		jobs,
		unloadGuard: guard,
		desktop: opts.desktop ? { runtime: 'desktop', pickMedia: async () => picked } : null,
	});
	return { session, engine, jobs, guard, win, service, log, picked };
}

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: 'video/mp4' });

describe('MediaAsset from RegisteredMedia (ARCHITECTURE D-09)', () => {
	it('uses a new med_ id, an engine-store locator keyed by mediaKey and a path locator on desktop', () => {
		const reg = registered('clip-a.mp4', { key: 'mk_ABCDEFGH1', path: '/media/clip-a.mp4' });
		const a = buildMediaAsset(reg, { id: 'med_0000000000000001', now: 't', path: '/media/clip-a.mp4' });
		expect(a.id).toBe('med_0000000000000001');
		expect(a.locators).toEqual([
			{ type: 'engine-store', engineId: 'local', key: 'mk_ABCDEFGH1' },
			{ type: 'path', path: '/media/clip-a.mp4', relativeToProject: null },
		]);
		expect(a.probe).toEqual(reg.probe);
		expect(a.probe).not.toBe(reg.probe);
		expect(a.fingerprint).toBe(reg.fingerprint);
		expect(a.derivation).toBeNull();
	});

	it('detects clip mismatch only for the first visual clip into an empty sequence', async () => {
		const { session } = await memorySession();
		const seq = Object.values(session.getCommitted().sequences)[0]!;
		const a = buildMediaAsset(registered('b.mp4', { width: 1280, height: 720, fps: { num: 25, den: 1 } }), {
			id: 'med_1',
			now: 't',
		});
		expect(mismatchPatch(seq, a)).toEqual({
			width: 1280,
			height: 720,
			frameRate: { num: 25, den: 1 },
			dropFrame: false,
		});
		const same = buildMediaAsset(registered('a.mp4'), { id: 'med_2', now: 't' });
		expect(mismatchPatch(seq, same)).toBeNull();
		const audio = buildMediaAsset(registered('t.wav', { kind: 'audio' }), { id: 'med_3', now: 't' });
		expect(mismatchPatch(seq, audio)).toBeNull();
	});
});

describe('import transaction (S01:LIFE-010 step 6)', () => {
	it('bin import: one "Import N files" transaction of media.register commands into the target bin', async () => {
		const { session } = await memorySession();
		const prepared: PreparedMedia[] = ['a.mp4', 'b.mp4'].map((n, i) => ({
			name: n,
			asset: buildMediaAsset(registered(n), { id: `med_000000000000000${i + 1}`, now: 't' }),
			existingMediaId: null,
		}));
		const built = buildImportTransaction({
			doc: session.getCommitted(),
			prepared,
			target: { kind: 'bin', binId: null },
		});
		expect(built.tx!.label).toBe('Import 2 files');
		expect(built.tx!.commands.map((c) => c.type)).toEqual(['media.register', 'media.register']);
		const r = session.apply(built.tx!);
		expect(r.ok).toBe(true);
		expect(session.getState().history.entries.map((e) => e.label)).toEqual(['Import 2 files']);
		expect(Object.keys(session.getCommitted().media)).toEqual([
			'med_0000000000000001',
			'med_0000000000000002',
		]);
	});

	it('timeline drop: media.register + clip.place in the same transaction, placed one after another', async () => {
		const { session } = await memorySession();
		const doc = session.getCommitted();
		const seq = Object.values(doc.sequences)[0]!;
		const prepared: PreparedMedia[] = [
			{
				name: 'a.mp4',
				asset: buildMediaAsset(registered('a.mp4', { seconds: 2 }), { id: 'med_000000000000000A', now: 't' }),
				existingMediaId: null,
			},
			{
				name: 'b.mp4',
				asset: buildMediaAsset(registered('b.mp4', { seconds: 3 }), { id: 'med_000000000000000B', now: 't' }),
				existingMediaId: null,
			},
		];
		const built = buildImportTransaction({
			doc,
			prepared,
			target: {
				kind: 'timeline',
				sequenceId: seq.id,
				at: 30,
				trackId: seq.videoTracks[0]!.id,
				mode: 'overwrite',
			},
		});
		expect(built.tx!.commands.map((c) => c.type)).toEqual([
			'media.register',
			'clip.place',
			'media.register',
			'clip.place',
		]);
		const places = built.tx!.commands.filter((c) => c.type === 'clip.place') as {
			at: number;
			source: unknown;
		}[];
		expect(places.map((p) => p.at)).toEqual([30, 90]);
		expect(places[0]!.source).toEqual({ mediaId: '$m0' });
		const r = session.apply(built.tx!);
		expect(r.ok).toBe(true);
		const clips = Object.values(session.getCommitted().sequences[seq.id]!.clips);
		expect(clips.filter((c) => c.kind === 'video').map((c) => [c.start, c.duration])).toEqual([
			[30, 60],
			[90, 90],
		]);
		expect(clips.filter((c) => c.kind === 'audio')).toHaveLength(2);
		expect(session.getState().history.entries).toHaveLength(1);
	});
});

describe('EngineImportService', () => {
	it('web: uploads files in client jobs and commits ONE transaction with engine-store locators', async () => {
		const { session, engine, jobs, service, log } = await setup();
		engine.media.set('clip-a.mp4', registered('clip-a.mp4', { key: 'mk_CLIPA0001' }));
		engine.media.set('clip-b.mp4', registered('clip-b.mp4', { key: 'mk_CLIPB0001' }));
		const progress: string[] = [];
		const result = await service.importFiles(
			{ files: [file('clip-a.mp4'), file('clip-b.mp4')] },
			{ kind: 'bin', binId: null },
			(p) => progress.push(`${p.fileName}:${p.phase}`),
		);
		expect(result.failed).toEqual([]);
		expect(result.mediaIds).toHaveLength(2);
		const doc = session.getCommitted();
		const assets = result.mediaIds.map((id) => doc.media[id]!);
		expect(assets.map((a) => a.locators[0])).toEqual([
			{ type: 'engine-store', engineId: 'local', key: 'mk_CLIPA0001' },
			{ type: 'engine-store', engineId: 'local', key: 'mk_CLIPB0001' },
		]);
		expect(assets.every((a) => a.id.startsWith('med_'))).toBe(true);
		expect(session.getState().history.entries.map((e) => e.label)).toEqual(['Import 2 files']);
		expect(jobs.getAll().map((j) => [j.kind, j.state, j.progress])).toEqual([
			['upload', 'succeeded', 1],
			['upload', 'succeeded', 1],
		]);
		expect(progress).toContain('clip-a.mp4:uploading');
		expect(progress).toContain('clip-b.mp4:done');
		expect(
			engine.requests.filter((r) => r.method === 'PUT' && r.path.startsWith('/api/uploads/')).length,
		).toBe(6);
		expect(log).toEqual([]);
		expect(session.getState().selection.project.items).toHaveLength(2);
	});

	it('web: a source-range sidecar picked with a render makes it a version of its source (M3, S07:PRC-019)', async () => {
		const { session, engine, service } = await setup();
		engine.media.set('crudo.mp4', registered('crudo.mp4', { key: 'mk_CRUDO0001', seconds: 60 }));
		engine.media.set('T02.mov', registered('T02.mov', { key: 'mk_T02000001', seconds: 130 / 30 }));
		const sidecar = new File(
			[JSON.stringify({ first_src_frame: 174, frames: 130, spec: { src: 'raw/crudo.mp4' } })],
			'T02.json',
			{
				type: 'application/json',
			},
		);
		// The render comes first in the batch: the range is resolved after every media.register.
		const result = await service.importFiles(
			{ files: [file('T02.mov'), sidecar, file('crudo.mp4')] },
			{ kind: 'bin', binId: null },
		);
		expect(result.failed).toEqual([]);
		expect(result.mediaIds).toHaveLength(2);
		const doc = session.getCommitted();
		const t02 = Object.values(doc.media).find((m) => m.originalName === 'T02.mov')!;
		const crudo = Object.values(doc.media).find((m) => m.originalName === 'crudo.mp4')!;
		expect(t02.sourceRange).toEqual({
			mediaId: crudo.id,
			sourceName: 'crudo.mp4',
			firstFrame: 174,
			frames: 130,
			frameRate: { num: 30, den: 1 },
			origin: 'sidecar',
		});
		expect(crudo.sourceRange).toBeUndefined();
		// The sidecar was read, not uploaded.
		expect(engine.requests.filter((r) => r.method === 'POST' && r.path === '/api/uploads')).toHaveLength(2);
		expect(session.getState().history.entries.map((e) => e.label)).toEqual(['Import 2 files']);
	});

	it('lists per-file failures and commits the rest (S04 §5.3 AC 2)', async () => {
		const { session, engine, service, log, jobs } = await setup();
		engine.media.set('good.mp4', registered('good.mp4'));
		const r = await service.importFiles(
			{ files: [file('good.mp4'), file('corrupt.bin')] },
			{ kind: 'bin', binId: null },
		);
		expect(r.mediaIds).toHaveLength(1);
		expect(r.failed).toEqual([
			{ name: 'corrupt.bin', code: 'UNSUPPORTED_MEDIA', message: 'corrupt.bin has no streams' },
		]);
		expect(log).toEqual(['failures:1:corrupt.bin=UNSUPPORTED_MEDIA']);
		expect(session.getState().history.entries.map((e) => e.label)).toEqual(['Import 1 file']);
		expect(
			jobs
				.getAll()
				.map((j) => j.state)
				.sort(),
		).toEqual(['failed', 'succeeded']);
	});

	it('dedupes by fingerprint with one prompt per batch (S04:IN-007)', async () => {
		const { session, engine, service, log } = await setup({ duplicates: 'use-existing' });
		engine.media.set('a.mp4', registered('a.mp4', { fingerprint: 'q1:same' }));
		const first = await service.importFiles({ files: [file('a.mp4')] }, { kind: 'bin', binId: null });
		engine.media.set('a-copy.mp4', registered('a-copy.mp4', { fingerprint: 'q1:same' }));
		engine.media.set('new.mp4', registered('new.mp4'));
		const second = await service.importFiles(
			{ files: [file('a-copy.mp4'), file('new.mp4')] },
			{ kind: 'bin', binId: null },
		);
		expect(log).toEqual(['duplicates:a-copy.mp4']);
		expect(second.mediaIds).toContain(first.mediaIds[0]);
		const doc = session.getCommitted();
		expect(Object.keys(doc.media)).toHaveLength(2);
		// "Use existing" does not add another project item for the duplicate.
		expect(Object.values(doc.items).filter((i) => i.kind === 'media')).toHaveLength(2);
	});

	it('"Import again" adds another project item referencing the same asset', async () => {
		const { session, engine, service } = await setup({ duplicates: 'import-again' });
		engine.media.set('a.mp4', registered('a.mp4', { fingerprint: 'q1:same' }));
		await service.importFiles({ files: [file('a.mp4')] }, { kind: 'bin', binId: null });
		await service.importFiles({ files: [file('a.mp4')] }, { kind: 'bin', binId: null });
		const doc = session.getCommitted();
		expect(Object.keys(doc.media)).toHaveLength(1);
		expect(Object.values(doc.items).filter((i) => i.kind === 'media')).toHaveLength(2);
	});

	it('timeline drop into an empty sequence asks about the clip mismatch and updates the settings', async () => {
		const { session, engine, service, log } = await setup({ mismatch: 'change' });
		engine.media.set('b.mp4', registered('b.mp4', { width: 1280, height: 720, fps: { num: 25, den: 1 } }));
		const seq = Object.values(session.getCommitted().sequences)[0]!;
		const r = await service.importFiles(
			{ files: [file('b.mp4')] },
			{ kind: 'timeline', sequenceId: seq.id, at: 0, trackId: seq.videoTracks[0]!.id, mode: 'overwrite' },
		);
		expect(log).toEqual(['mismatch:b.mp4']);
		expect(r.clipIds.length).toBe(2);
		const s2 = session.getCommitted().sequences[seq.id]!;
		expect(s2.settings).toMatchObject({ width: 1280, height: 720, frameRate: { num: 25, den: 1 } });
		const video = Object.values(s2.clips).find((c) => c.kind === 'video')!;
		expect(video.duration).toBe(250);
		expect(session.getState().history.entries.map((e) => e.label)).toEqual(['Import 1 file']);
		// The second drop does not ask again (the sequence is no longer empty).
		engine.media.set('c.mp4', registered('c.mp4', { width: 640, height: 480 }));
		await service.importFiles(
			{ files: [file('c.mp4')] },
			{ kind: 'timeline', sequenceId: seq.id, at: 300, trackId: seq.videoTracks[0]!.id, mode: 'overwrite' },
		);
		expect(log).toEqual(['mismatch:b.mp4']);
	});

	it('desktop: registers picked paths in place and adds a path locator', async () => {
		const { session, engine, service } = await setup({}, { desktop: true });
		engine.on((r) =>
			r.path === '/api/media/register'
				? {
						body: {
							items: [registered('clip-a.mp4', { key: 'mk_DESKTOP01', path: '/home/u/clip-a.mp4' })],
							errors: [{ path: '/home/u/broken.mov', code: 'UNSUPPORTED_MEDIA', message: 'no streams' }],
						},
					}
				: undefined,
		);
		const r = await service.importFiles(
			{ paths: ['/home/u/clip-a.mp4', '/home/u/broken.mov'] },
			{ kind: 'bin', binId: null },
		);
		expect(engine.requests.find((q) => q.path === '/api/media/register')!.body).toEqual({
			projectId: session.projectId,
			paths: ['/home/u/clip-a.mp4', '/home/u/broken.mov'],
		});
		expect(r.failed.map((f) => f.name)).toEqual(['broken.mov']);
		const asset = session.getCommitted().media[r.mediaIds[0]!]!;
		expect(asset.locators).toEqual([
			{ type: 'engine-store', engineId: 'local', key: 'mk_DESKTOP01' },
			{ type: 'path', path: '/home/u/clip-a.mp4', relativeToProject: null },
		]);
	});

	it('guards beforeunload while uploads run (S04:IN-013)', async () => {
		const { engine, service, win } = await setup();
		engine.media.set('a.mp4', registered('a.mp4'));
		const p = service.importFiles({ files: [file('a.mp4')] }, { kind: 'bin', binId: null });
		const during = new Event('beforeunload', { cancelable: true });
		win.dispatchEvent(during);
		expect(during.defaultPrevented).toBe(true);
		await p;
		const after = new Event('beforeunload', { cancelable: true });
		win.dispatchEvent(after);
		expect(after.defaultPrevented).toBe(false);
	});

	it('placeItems: Project items dragged to the timeline become one Overwrite transaction', async () => {
		const { session, engine, service } = await setup();
		engine.media.set('a.mp4', registered('a.mp4', { seconds: 1 }));
		await service.importFiles({ files: [file('a.mp4')] }, { kind: 'bin', binId: null });
		const itemId = Object.values(session.getCommitted().items).find((i) => i.kind === 'media')!.id;
		const seq = Object.values(session.getCommitted().sequences)[0]!;
		const r = await service.placeItems(
			{ type: 'jasper/project-items', itemIds: [itemId, itemId] },
			{ kind: 'timeline', sequenceId: seq.id, at: 10, trackId: seq.videoTracks[0]!.id, mode: 'overwrite' },
		);
		expect(r.clipIds).toHaveLength(4);
		const starts = Object.values(session.getCommitted().sequences[seq.id]!.clips)
			.filter((c) => c.kind === 'video')
			.map((c) => c.start)
			.sort((a, b) => a - b);
		expect(starts).toEqual([10, 40]);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Overwrite');
	});

	it('reads DataTransfer payloads: in-app items first, then OS files', () => {
		const make = (data: Record<string, string>, files: File[] = []) =>
			({
				types: [...Object.keys(data), ...(files.length ? ['Files'] : [])],
				getData: (t: string) => data[t] ?? '',
				files,
			}) as unknown as DataTransfer;
		expect(readDataTransfer(make({ [PROJECT_ITEMS_MIME]: JSON.stringify({ itemIds: ['itm_1'] }) }))).toEqual({
			type: 'jasper/project-items',
			itemIds: ['itm_1'],
		});
		const f = file('x.mp4');
		expect(readDataTransfer(make({}, [f]))).toEqual({ type: 'os-files', files: [f] });
		expect(readDataTransfer(make({ 'text/plain': 'hi' }))).toBeNull();
	});
});
