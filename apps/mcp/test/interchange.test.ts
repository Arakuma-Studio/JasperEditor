import type { EngineJob, InterchangeExportRequest, RegisteredMedia, RelinkScanResult } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type MediaAsset,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const placeholder = (name: string, seconds: number, path = `/old/${name}`): Omit<MediaAsset, 'id'> =>
	({
		kind: 'video',
		fingerprint: `pending:interchange:${name}`,
		originalName: name,
		sizeBytes: 0,
		container: 'mov',
		probe: {
			durationFlicks: seconds * FLICKS_PER_SECOND,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: '',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 25, den: 1 },
					pixelFormat: '',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: null,
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'path', path, relativeToProject: null }],
		derivation: null,
		importedAt: '2026-10-07T00:00:00.000Z',
	}) as Omit<MediaAsset, 'id'>;

const job = (id: string, state: EngineJob['state'], result?: unknown): EngineJob =>
	({
		id,
		kind: 'interchange-export',
		title: 'Export',
		state,
		progress: state === 'succeeded' ? 1 : 0.2,
		priority: 'user',
		cpuSlots: 0,
		origin: { type: 'agent' },
		createdAt: '2026-10-07T00:00:00.000Z',
		...(result ? { result } : {}),
	}) as EngineJob;

function fakeEngine() {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'IX', preset: 'hd-1080p-25' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const calls: { name: string; body: unknown }[] = [];
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, ...tx, origin: 'user' } as never,
			{ ids, now: () => '2026-10-07T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const setup = apply({
		label: 'setup',
		commands: [
			{ type: 'media.register', asset: placeholder('A001.mov', 10), ref: '$a' },
			{ type: 'media.register', asset: placeholder('B002.mov', 10), ref: '$b' },
			{
				type: 'media.register',
				asset: placeholder('C003.mov', 10, 'D:\\Shoot\\Day 1\\C003.mov'),
				ref: '$c',
			},
		],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const reg = (name: string, seconds: number): RegisteredMedia => ({
		mediaKey: `mk_${name}`,
		fingerprint: `q1:${name}`,
		originalName: name,
		sizeBytes: 1234,
		container: 'mov',
		kind: 'video',
		probe: { ...placeholder(name, seconds).probe },
		locators: [{ type: 'path', path: `/new/${name}`, relativeToProject: null }],
		browserPlayable: 'yes',
	});
	const scan: RelinkScanResult = {
		found: [
			{
				assetId: setup.refs.$a!,
				path: '/new/A001.mov',
				media: reg('A001.mov', 10),
				matched: ['name', 'duration'],
				match: 'placeholder',
				diff: [],
			},
			{
				assetId: setup.refs.$b!,
				path: '/new/B002.mov',
				media: reg('B002.mov', 4),
				matched: ['name'],
				match: 'placeholder',
				diff: [{ field: 'duration', was: '10.00 s', now: '4.00 s' }],
			},
		],
		ambiguous: [],
		notFound: [],
		scannedFiles: 9,
		truncated: false,
		timedOut: false,
		mappings: [],
	};
	let scanned = new Set<string>();
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		importTimeline: async (body: unknown) => {
			calls.push({ name: 'importTimeline', body });
			return {
				format: 'edl',
				fragment: (() => {
					const src = createEmptyProject({
						ids: createCounterIdSource(77),
						name: 'Cut 1',
						preset: 'hd-1080p-25',
					});
					const item = Object.values(src.items).find((i) => i.kind === 'sequence')!;
					const seq = Object.values(src.sequences)[0]!;
					return {
						name: 'Cut 1',
						items: [{ ...item, name: 'Cut 1' }],
						rootItems: [item.id],
						media: [],
						synthetics: [],
						sequences: [seq],
						fonts: [],
						transcripts: [],
						topSequences: [seq.id],
						captions: [],
						missing: [],
					};
				})(),
				missing: [
					{
						mediaId: 'med_x',
						name: 'C003.mov',
						path: '/gone/C003.mov',
						kind: 'video',
						durationFlicks: null,
						reason: 'not-found',
					},
				],
				warnings: [
					{
						level: 'warning',
						message: 'a wipe was imported as a cross dissolve',
						count: 2,
						instead: 'Cross Dissolve',
					},
					{ level: 'info', message: 'reel names were read', count: 1 },
				],
				extracted: [],
			};
		},
		exportTimeline: async (body: InterchangeExportRequest) => {
			calls.push({ name: 'exportTimeline', body });
			return job('job_x', 'running');
		},
		relinkScan: async (_pid: string, body: { assets: { id: string }[] }) => {
			calls.push({ name: 'relinkScan', body });
			scanned = new Set(body.assets.map((x) => x.id));
			return job('job_scan', 'running');
		},
		relinkScanResult: async (pid: string, jobId: string) => {
			calls.push({ name: 'relinkScanResult', body: { pid, jobId } });
			return {
				...scan,
				found: scan.found.filter((f) => scanned.has(f.assetId)),
				notFound: [...scanned].filter((id) => !scan.found.some((f) => f.assetId === id)),
			};
		},
		relinkAsset: async (assetId: string, body: { path: string; match?: string[] }) => {
			calls.push({ name: 'relinkAsset', body: { assetId, ...body } });
			const name = body.path.split('/').pop()!;
			return { media: reg(name, 10), match: 'placeholder', diff: [], failed: [], needsConfirm: false };
		},
		mediaStatusBatch: async (keys: string[]) => ({
			statuses: keys.map((k) => ({ mediaKey: k, status: 'online', derivatives: {} })),
			unknown: [],
		}),
		getJob: async (id: string) =>
			id === 'job_scan'
				? job(id, 'succeeded', { found: scanned.size, needsConfirm: 0, ambiguous: 0, notFound: 0 })
				: job(id, 'succeeded', {
						format: 'aaf',
						files: [
							{
								name: 'Seq.aaf',
								downloadUrl: '/renders/job_x/interchange/Seq.aaf',
								byteSize: 9,
								role: 'document',
							},
						],
						prerendered: [{ clipId: 'clp_1', clipName: 'Title', reason: 'text clip' }],
						warnings: [
							{ level: 'warning', message: 'the markers are not carried', count: 1, instead: 'nothing' },
						],
					}),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, seqId, refs: setup.refs, calls };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'ix-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'ix-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({
			name,
			arguments: { projectId: 'prj_test', ...args },
		})) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
		return { isError: !!r.isError, body: JSON.parse(text) };
	};
	return { engine, call };
}

describe('interchange MCP tools', () => {
	it('import_timeline applies the fragment and reports offline media and what was not carried', async () => {
		const { engine, call } = await connect();
		const r = await call('import_timeline', { path: '/edits/Cut 1.edl', rate: { num: 25, den: 1 } });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(engine.calls[0]).toEqual({
			name: 'importTimeline',
			body: { projectId: 'prj_test', path: '/edits/Cut 1.edl', rate: { num: 25, den: 1 } },
		});
		expect(r.body.format).toBe('edl');
		expect(r.body.offline).toEqual([{ name: 'C003.mov', path: '/gone/C003.mov', reason: 'not-found' }]);
		expect(r.body.report.notCarried).toEqual([
			{ message: 'a wipe was imported as a cross dissolve', count: 2, instead: 'Cross Dissolve' },
		]);
		expect(r.body.report.notes).toBe(1);
		expect(Object.values(engine.doc().items).some((i) => i.kind === 'bin' && i.name === 'Cut 1')).toBe(true);
		expect((await call('import_timeline', { path: '/x.edl', content: 'x' })).isError).toBe(true);
		expect((await call('import_timeline', { path: 'x.edl' })).isError).toBe(true);
	});

	it('export_timeline maps the options, waits for the job and lists files and losses', async () => {
		const { engine, call } = await connect();
		const r = await call('export_timeline', {
			format: 'aaf',
			outputPath: '/out/Seq.aaf',
			audio: { mode: 'embed', handlesFrames: 12, breakoutToMono: true },
			prerender: 'all',
		});
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const req = engine.calls.find((c) => c.name === 'exportTimeline')!.body as InterchangeExportRequest;
		expect(req.format).toBe('aaf');
		expect(req.sequenceId).toBe(engine.seqId);
		expect(req.options).toEqual({
			prerender: 'all',
			audio: { mode: 'embed', handlesFrames: 12, breakoutToMono: true },
		});
		expect(req.destination).toEqual({ type: 'path', path: '/out/Seq.aaf' });
		expect(r.body.files).toEqual([
			{
				name: 'Seq.aaf',
				role: 'document',
				bytes: 9,
				url: 'http://engine.test/renders/job_x/interchange/Seq.aaf',
			},
		]);
		expect(r.body.prerendered).toEqual([{ clipId: 'clp_1', clipName: 'Title', reason: 'text clip' }]);
		expect(r.body.report.notCarried[0].message).toBe('the markers are not carried');
		expect(
			(await call('export_timeline', { format: 'aaf', audio: { mode: 'embed', nope: 1 } })).isError,
		).toBe(true);
	});

	it('list_offline_media and link_media (folder search; differences need force)', async () => {
		const { engine, call } = await connect();
		const list = await call('list_offline_media', {});
		expect(list.body.offline.map((m: { name: string }) => m.name).sort()).toEqual([
			'A001.mov',
			'B002.mov',
			'C003.mov',
		]);
		expect(list.body.total).toBe(3);
		const win = list.body.offline.find((m: { name: string }) => m.name === 'C003.mov');
		expect(win).toMatchObject({ path: 'D:\\Shoot\\Day 1\\C003.mov', pathStyle: 'windows' });
		const page = await call('list_offline_media', { offset: 1, limit: 1 });
		expect(page.body).toMatchObject({ total: 3, offset: 1, nextOffset: 2 });
		expect(page.body.offline.length).toBe(1);
		const dry = await call('link_media', { folder: '/new', dryRun: true });
		expect(dry.body.wouldLink.map((m: { name: string }) => m.name)).toEqual(['A001.mov']);
		expect(dry.body.needsForce[0].differences).toEqual(['duration: 10.00 s → 4.00 s']);
		const r = await call('link_media', { folder: '/new', match: ['name', 'duration'] });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(r.body.linked).toBe(1);
		const a = engine.doc().media[engine.refs.$a!]!;
		expect(a.fingerprint).toBe('q1:A001.mov');
		expect(a.locators[0]).toEqual({ type: 'engine-store', engineId: 'local', key: 'mk_A001.mov' });
		expect(engine.doc().media[engine.refs.$b!]!.fingerprint).toBe('pending:interchange:B002.mov');
		const forced = await call('link_media', { folder: '/new', force: true });
		expect(forced.body.linked).toBe(1);
		expect(engine.doc().media[engine.refs.$b!]!.fingerprint).toBe('q1:B002.mov');
	});

	it('link_media with a located file relinks the others automatically in one transaction', async () => {
		const { engine, call } = await connect();
		const r = await call('link_media', {
			mediaId: engine.refs.$c,
			path: '/Volumes/Mac/Shoot/Day 1/C003.mov',
			alignTimecode: false,
		});
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const scanCall = engine.calls.find((c) => c.name === 'relinkScan')!.body as {
			anchors: unknown[];
			assets: { id: string }[];
			match: string[];
		};
		expect(scanCall.anchors).toEqual([
			{ from: 'D:\\Shoot\\Day 1\\C003.mov', to: '/Volumes/Mac/Shoot/Day 1/C003.mov', relativePath: null },
		]);
		expect(scanCall.match).toEqual(['name', 'extension', 'duration', 'streams']);
		// the located file and the verified A001 in one transaction; B002 needs force (shorter than its clips)
		expect(r.body.linked).toBe(2);
		expect(r.body.needsForceCount).toBe(1);
		expect(engine.doc().media[engine.refs.$c!]!.fingerprint).toBe('q1:C003.mov');
		expect(engine.doc().media[engine.refs.$a!]!.fingerprint).toBe('q1:A001.mov');
		// a relative path is refused before reaching the engine
		const bad = await call('link_media', { mediaId: engine.refs.$b, path: 'B002.mov' });
		expect(bad.isError).toBe(true);
		expect(bad.body.error.code).toBe('E_INVALID_PARAM');
	});
});
