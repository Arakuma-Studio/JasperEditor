// apply_default_transitions (S10:TUI-034) through the MCP protocol against an in-memory engine: the types and
// alignment come from the call, else from the open editor's preferences (`preferences.get`), else the built-ins.
// The real-engine workflow (headless, built-ins, set_transition_defaults lengths) is in integration.test.ts.
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

let fp = 0;
/** A probed 10 s 1080p30 video with stereo audio. */
function videoAsset(): Omit<MediaAsset, 'id'> {
	fp++;
	return {
		kind: 'video',
		fingerprint: `q1:${fp.toString(16).padStart(64, '0')}`,
		originalName: `clip-${fp}.mp4`,
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
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${fp}` }],
		derivation: null,
		importedAt: '2026-09-30T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

/**
 * An engine whose project (two linked video+audio clips cut at frame 100, with media handles on both sides)
 * lives in memory; `editor` is what an open editor answers to `preferences.get` (null: no editor open).
 */
function fakeEngine(editor: Record<string, unknown> | null) {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Transitions', preset: 'hd-1080p-30' });
	let revision = 0;
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-09-30T00:00:00.000Z',
			revision,
			registries: defaultRegistries(),
		});
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const setup = (commands: unknown[]) => {
		const r = apply({ label: 'setup', commands });
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r.results;
	};
	const media = setup([
		{ type: 'media.register', asset: videoAsset() },
		{ type: 'media.register', asset: videoAsset() },
	]) as { mediaId: string }[];
	const placed = setup([
		{
			type: 'clip.place',
			source: { mediaId: media[0]!.mediaId },
			at: 0,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: media[1]!.mediaId },
			at: 100,
			sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
		},
	]) as { clipIds: string[] }[];
	const client = {
		agentQuery: async (req: { query: string }) => {
			if (req.query === 'preferences.get') {
				if (!editor) throw new Error('preferences.get needs an open editor');
				return { result: { preferences: { transitions: editor } }, revision, via: 'session' };
			}
			return { result: doc, revision, via: editor ? 'session' : 'headless' };
		},
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
	return { link, outgoing: placed[0]!.clipIds[0]! };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

type Applied = {
	defaults: { video?: string; audio?: string; alignment: string; source: string };
	transitions: { effectId: string; track: string; cut: number; alignment: string }[];
};

/** Calls apply_default_transitions on the outgoing clip's tail (the cut at 100), video and audio. */
async function applyDefaults(editor: Record<string, unknown> | null, args: Record<string, unknown> = {}) {
	const engine = fakeEngine(editor);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'transitions-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'transitions-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const r = (await client.callTool({
		name: 'apply_default_transitions',
		arguments: {
			projectId: 'prj_test',
			clipIds: [engine.outgoing],
			edges: 'out',
			media: ['video', 'audio'],
			durationFrames: 10,
			...args,
		},
	})) as CallToolResult;
	const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
	expect(r.isError, text).toBeFalsy();
	const body = JSON.parse(text) as Applied;
	const atCut = body.transitions
		.filter((t) => t.cut === 100)
		.map((t) => [t.track, t.effectId, t.alignment])
		.sort();
	return { defaults: body.defaults, atCut };
}

describe('apply_default_transitions defaults (S10:TUI-034)', () => {
	it('uses the open editor’s default types and alignment', async () => {
		const editor = { video: 'jasper.dip-to-black', audio: 'jasper.constant-gain', alignment: 'end-at-cut' };
		const r = await applyDefaults(editor);
		expect(r.defaults).toMatchObject({ ...editor, source: 'editor preferences' });
		expect(r.atCut).toEqual([
			['A1', 'jasper.constant-gain', 'end-at-cut'],
			['V1', 'jasper.dip-to-black', 'end-at-cut'],
		]);
	});

	it('lets call arguments override the editor value by value', async () => {
		const editor = { video: 'jasper.dip-to-black', audio: 'jasper.constant-gain', alignment: 'end-at-cut' };
		const r = await applyDefaults(editor, { videoType: 'cross-dissolve', alignment: 'start-at-cut' });
		expect(r.atCut).toEqual([
			['A1', 'jasper.constant-gain', 'start-at-cut'],
			['V1', 'jasper.cross-dissolve', 'start-at-cut'],
		]);
		const all = await applyDefaults(editor, {
			videoType: 'dip-to-black',
			audioType: 'constant-power',
			alignment: 'center',
		});
		expect(all.defaults.source).toBe('call');
		expect(all.atCut).toEqual([
			['A1', 'jasper.constant-power', 'center'],
			['V1', 'jasper.dip-to-black', 'center'],
		]);
	});

	it('falls back to the built-ins for invalid editor values', async () => {
		const builtIn = [
			['A1', 'jasper.constant-power', 'center'],
			['V1', 'jasper.cross-dissolve', 'center'],
		];
		// Wrong medium, unknown id, unknown alignment: ignored.
		const invalid = await applyDefaults({ video: 'jasper.constant-power', audio: 'x', alignment: 'middle' });
		expect(invalid.defaults.source).toBe('built-in');
		expect(invalid.atCut).toEqual(builtIn);
	});
});

describe('GPU transitions through MCP (transition framework)', () => {
	async function connect() {
		const engine = fakeEngine(null);
		const { server } = createJasperMcpServer({ link: engine.link, agentName: 'transitions-test' });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const client = new Client({ name: 'transitions-test', version: '1' });
		await client.connect(b);
		open.push(client);
		const call = async <T>(name: string, args: Record<string, unknown>) => {
			const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
			const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
			expect(r.isError, text).toBeFalsy();
			return JSON.parse(text) as T;
		};
		return { call };
	}

	it('lists the catalogue with bins and params', async () => {
		const { call } = await connect();
		const all = await call<{ types: { effectId: string; bin: string; gpu: boolean }[] }>(
			'list_transition_types',
			{},
		);
		expect(all.types.map((t) => t.effectId)).toEqual(
			expect.arrayContaining([
				'jasper.cross-dissolve',
				'jasper.push',
				'jasper.iris-round',
				'jasper.s.dissolve-luma',
			]),
		);
		expect(all.types.find((t) => t.effectId === 'jasper.s.dissolve-luma')).toMatchObject({
			bin: 'Sapphire Transitions/Dissolves',
			gpu: true,
		});
		const iris = await call<{ types: { effectId: string; params: { name: string }[] }[] }>(
			'list_transition_types',
			{ bin: 'Iris' },
		);
		expect(iris.types.map((t) => t.effectId)).toContain('jasper.iris-round');
		expect(iris.types.find((t) => t.effectId === 'jasper.iris-round')!.params.map((p) => p.name)).toContain(
			'center',
		);
	});

	it('adds a GPU transition by label with params and updates its params', async () => {
		const { call } = await connect();
		await call('add_transition', {
			projectId: 'prj_test',
			type: 'Push',
			durationFrames: 10,
			track: 'V1',
			at: 100,
			params: { direction: 'eastToWest' },
		});
		type Listed = { id: string; effectId: string; gpu?: boolean; params?: Record<string, unknown> };
		const list = await call<{ transitions: Listed[] }>('list_transitions', { projectId: 'prj_test' });
		const push = list.transitions.find((t) => t.effectId === 'jasper.push')!;
		expect(push).toMatchObject({ gpu: true, params: { direction: 'eastToWest' } });
		const up = await call<{ transition: Listed }>('update_transition', {
			projectId: 'prj_test',
			transitionId: push.id,
			params: { borderWidth: 3 },
		});
		expect(up.transition.params).toEqual({ direction: 'eastToWest', borderWidth: 3 });
	});
});
