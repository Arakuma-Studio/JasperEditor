// replace_footage with the engine stubbed; document changes run through the real command system.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** A PNG as the engine probes it: one video stream at the 25 fps ffprobe reports for images, no duration. */
function pngProbe(size: number): MediaAsset['probe'] {
	return {
		durationFlicks: null,
		startTimecode: null,
		streams: [
			{
				index: 0,
				type: 'video',
				codec: 'png',
				width: size,
				height: size,
				pixelAspect: { num: 1, den: 1 },
				frameRate: { num: 25, den: 1 },
				pixelFormat: 'rgba',
				bitDepth: 8,
				color: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', range: 'pc' },
				browserDecodable: true,
			},
		],
		rotationDegrees: 0,
		hasAlpha: true,
		variableFrameRate: false,
	};
}

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Replace', preset: 'hd-1080p-30' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, ...tx, origin: 'user' } as never,
			{ ids, now: () => '2026-11-14T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const asset = {
		kind: 'image',
		fingerprint: `q1:${'a'.padStart(64, '0')}`,
		originalName: 'logo.png',
		sizeBytes: 1000,
		container: 'png_pipe',
		probe: pngProbe(3000),
		locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_1' }],
		derivation: null,
		importedAt: '2026-11-14T00:00:00.000Z',
	};
	const r = apply({
		label: 'setup',
		commands: [
			{ type: 'media.register', asset, ref: '$m' },
			{ type: 'clip.place', source: { mediaId: '$m' }, at: 0 },
		],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const client = {
		registerMedia: async (req: { paths: string[] }) => ({
			items: req.paths.map((p) => ({
				mediaKey: 'mk_2',
				kind: 'image',
				fingerprint: `q1:${'b'.padStart(64, '0')}`,
				originalName: 'logo-small.png',
				sizeBytes: 500,
				container: 'png_pipe',
				probe: pngProbe(1500),
				locators: [{ type: 'path', path: p, relativeToProject: null }],
				browserPlayable: 'yes',
			})),
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
	return { link, doc: () => doc, mediaId: r.refs.$m! };
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const f of cleanup.splice(0)) await f();
});

describe('replace_footage', () => {
	it('replaces a still without keepSourceTiming (a still has no source timing to keep)', async () => {
		const engine = fakeEngine();
		const { server } = createJasperMcpServer({ link: engine.link, agentName: 'replace-test' });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const client = new Client({ name: 'replace-test', version: '1' });
		await client.connect(b);
		const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-replace-'));
		cleanup.push(
			() => client.close(),
			() => rmSync(dir, { recursive: true, force: true }),
		);
		const path = join(dir, 'logo-small.png');
		writeFileSync(path, 'png');
		const r = (await client.callTool({
			name: 'replace_footage',
			arguments: { projectId: 'prj_test', mediaId: engine.mediaId, path },
		})) as CallToolResult;
		expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
		expect(engine.doc().media[engine.mediaId]!.originalName).toBe('logo-small.png');
	});
});
