// color-mgmt MCP tools through the protocol against an in-memory engine: colour spaces, working space, Interpret
// Footage ▸ Colour, clip overrides, import_ocio_config (engine registration stubbed).
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

function videoAsset(): Omit<MediaAsset, 'id'> {
	return {
		kind: 'video',
		fingerprint: `q1:${'a'.padStart(64, '0')}`,
		originalName: 'clip.mp4',
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 10 * 705_600_000,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
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
				{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_1' }],
		derivation: null,
		importedAt: '2026-09-30T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Colour', preset: 'hd-1080p-30' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, ...tx, origin: 'user' } as never,
			{
				ids,
				now: () => '2026-09-30T00:00:00.000Z',
				revision,
				registries: defaultRegistries(),
			},
		);
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const r = apply({ label: 'setup', commands: [{ type: 'media.register', asset: videoAsset(), ref: '$m' }] });
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const mediaId = r.refs.$m!;
	const placed = apply({
		label: 'setup',
		commands: [
			{
				type: 'clip.place',
				source: { mediaId },
				at: 10,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
			},
		],
	});
	if (!placed.ok) throw new Error(JSON.stringify(placed.errors));
	const sceneRequests: unknown[] = [];
	const client = {
		detectScenes: async (req: unknown) => {
			sceneRequests.push(req);
			return {
				id: 'job_scene1',
				state: 'succeeded',
				result: { cuts: [1, 2.5], frames: 120, scores: [], times: [], threshold: 0.25 },
			};
		},
		getJob: async () => ({ id: 'job_scene1', state: 'succeeded' }),
		registerMedia: async () => ({
			items: [
				{
					mediaKey: 'mk_ocio',
					fingerprint: `q1:${'b'.padStart(64, '0')}`,
					originalName: 'studio.jocio',
					sizeBytes: 10,
					container: 'ocio',
					kind: 'color-config',
					probe: {
						durationFlicks: null,
						startTimecode: null,
						streams: [],
						rotationDegrees: 0,
						hasAlpha: false,
						variableFrameRate: false,
					},
					locators: [],
					browserPlayable: 'no',
					colorConfig: {
						format: 'ocio',
						name: 'studio',
						version: 2,
						spaces: [{ name: 'ACEScct', family: '', reference: 'scene' }],
						roles: [['aces_interchange', 'ACES2065-1']],
						displays: [],
						unsupported: [],
						missing: [],
					},
				},
			],
			errors: [],
		}),
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return {
		link,
		doc: () => doc,
		seqId,
		sceneRequests,
		clipIds: (placed.results[0] as { clipIds: string[] }).clipIds,
	};
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'color-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'color-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({
			name,
			arguments: { projectId: 'prj_test', ...args },
		})) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
		return {
			isError: !!r.isError,
			body: (() => {
				try {
					return JSON.parse(text);
				} catch {
					return text;
				}
			})(),
		};
	};
	return { engine, call, client };
}

describe('colour management MCP tools', () => {
	it('lists spaces, sets the working space, interprets footage and overrides a clip', async () => {
		const { engine, call } = await connect();
		const spaces = await call('list_color_spaces', {});
		expect(spaces.isError).toBe(false);
		expect(spaces.body.spaces.some((s: { id: string }) => s.id === 'slog3-sgamut3cine')).toBe(true);
		expect(spaces.body.workingSpaces).toContain('rec2100-pq');

		let r = await call('set_working_color_space', { workingColorSpace: 'rec2100-hlg', sdrWhiteNits: 203 });
		expect(r.isError).toBe(false);
		expect(engine.doc().sequences[engine.seqId]!.settings.workingColorSpace).toBe('rec2100-hlg');

		const mediaId = Object.keys(engine.doc().media)[0]!;
		r = await call('interpret_footage_color', {
			mediaIds: [mediaId],
			color: { space: 'logc4-awg4', range: 'pc' },
		});
		expect(r.isError).toBe(false);
		expect(engine.doc().media[mediaId]!.interpretation?.color).toEqual({ space: 'logc4-awg4', range: 'pc' });

		const settings = await call('get_color_settings', {});
		expect(settings.body.workingColorSpace).toBe('rec2100-hlg');
		expect(settings.body.media[0].resolved.space).toBe('logc4-awg4');

		const v = engine.clipIds.find((id) => engine.doc().sequences[engine.seqId]!.clips[id]!.kind === 'video')!;
		r = await call('set_clip_color_space', { clipIds: [v], color: { space: 'rec709' } });
		expect(r.isError).toBe(false);
		r = await call('interpret_footage_color', { mediaIds: [mediaId], color: { space: 'nope' } });
		expect(r.isError).toBe(true);
		r = await call('interpret_footage_color', { mediaIds: [mediaId], color: null });
		expect(engine.doc().media[mediaId]!.interpretation).toBeUndefined();
	});

	it('imports an OCIO config and refuses relative paths', async () => {
		const { engine, call } = await connect();
		const { mkdtempSync, writeFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const { tmpdir } = await import('node:os');
		const dir = mkdtempSync(join(tmpdir(), 'cm-mcp-'));
		const file = join(dir, 'studio.ocio');
		writeFileSync(file, 'ocio_profile_version: 2\ncolorspaces:\n  - !<ColorSpace>\n    name: ACEScct\n');
		const r = await call('import_ocio_config', { path: file });
		expect(r.isError).toBe(false);
		expect(r.body.spaces[0].name).toBe('ACEScct');
		expect(engine.doc().media[r.body.mediaId]!.kind).toBe('color-config');
		expect((await call('import_ocio_config', { path: 'studio.ocio' })).isError).toBe(true);
	});
});
