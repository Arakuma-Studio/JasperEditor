// syncAudio returns scripted offsets; real analysis is covered in apps/engine/test/sync-audio.test.ts.
import type { SyncAudioRequest, SyncAudioResponse } from '@jasper/api';
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

let n = 0;
function asset(kind: 'video' | 'audio', seconds: number): Omit<MediaAsset, 'id'> {
	n++;
	const streams: MediaAsset['probe']['streams'] = [];
	if (kind === 'video')
		streams.push({
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
		});
	streams.push({
		index: streams.length,
		type: 'audio',
		codec: 'aac',
		sampleRate: 48000,
		channels: 2,
		channelLayout: 'stereo',
	});
	return {
		kind,
		fingerprint: `q1:${String(n).padStart(64, '0')}`,
		originalName: `${kind}-${n}.mp4`,
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: seconds * FLICKS_PER_SECOND,
			startTimecode: null,
			streams,
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${n}` }],
		derivation: null,
		importedAt: '2026-09-30T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

function fakeEngine(offsetsByKey: Record<string, number>, reliable = true) {
	n = 0;
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'MC', preset: 'hd-1080p-30' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const requests: SyncAudioRequest[] = [];
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, ...tx, origin: 'user' } as never,
			{ ids, now: () => '2026-09-30T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const reg = apply({
		label: 'setup',
		commands: [
			{ type: 'media.register', asset: asset('video', 10), itemRef: '$a', name: 'A' },
			{ type: 'media.register', asset: asset('video', 10), itemRef: '$b', name: 'B' },
			{ type: 'media.register', asset: asset('audio', 12), itemRef: '$r', name: 'Rec' },
		],
	});
	if (!reg.ok) throw new Error(JSON.stringify(reg.errors));
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		call: async (name: string, opts: { body: SyncAudioRequest }) => {
			if (name !== 'syncAudio') throw new Error(`unexpected ${name}`);
			requests.push(opts.body);
			const ref = opts.body.reference ?? opts.body.clips[0]!.key;
			const base = offsetsByKey[opts.body.clips.find((c) => c.key === ref)!.mediaKey] ?? 0;
			const res: SyncAudioResponse = {
				reference: ref,
				sampleRate: 48000,
				elapsedMs: 1,
				results: opts.body.clips.map((c) => ({
					key: c.key,
					offsetFlicks: (offsetsByKey[c.mediaKey] ?? 0) - base,
					lagSamples: 0,
					lagFine: 0,
					confidence: c.key === ref ? null : reliable ? 40 : 3,
					distinct: c.key === ref ? null : reliable ? 4 : 1.1,
					reliable: c.key === ref || reliable,
					inverted: false,
				})),
			};
			return res;
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, seqId, items: reg.refs, requests };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(offsets: Record<string, number>, reliable = true) {
	const engine = fakeEngine(offsets, reliable);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'mc-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'mc-test', version: '1' });
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

const S = FLICKS_PER_SECOND;

describe('multi-camera MCP tools', () => {
	it('creates a multicam by audio, places it, switches, records, lists and flattens', async () => {
		// B started 2 s after A; the recorder 1 s before A
		const { engine, call } = await connect({ mk_1: 0, mk_2: -2 * S, mk_3: 1 * S });
		const { $a, $b, $r } = engine.items as Record<string, string>;
		const m = await call('measure_audio_sync', { itemIds: [$a, $b, $r] });
		expect(m.isError).toBe(false);
		expect(m.body.results.map((r: { offsetSeconds: number }) => r.offsetSeconds)).toEqual([0, -2, 1]);
		const c = await call('create_multicam_sequence', {
			itemIds: [$a, $b, $r],
			method: 'audio',
			audio: 'switch',
		});
		expect(c.isError).toBe(false);
		const mcSeq = c.body.results[0].sequenceId as string;
		const src = engine.doc().sequences[mcSeq]!;
		const startOf = (track: string) => Object.values(src.clips).find((x) => x.trackId === track)!.start;
		const angles = src.multicam!.angles;
		// B's media t = A's t − 2 s → B starts 2 s (60 frames) after A; the recorder 1 s (30 frames) before A
		expect(startOf(angles[1]!.videoTrackId!) - startOf(angles[0]!.videoTrackId!)).toBe(60);
		expect(startOf(angles[0]!.videoTrackId!) - startOf(angles[2]!.audioTrackIds[0]!)).toBe(30);
		const p = await call('place_sequence', { sourceSequenceId: mcSeq, at: 0, sequenceId: engine.seqId });
		expect(p.isError).toBe(false);
		const sw = await call('switch_multicam_angle', {
			angle: 2,
			range: { from: 30, to: 60 },
			sequenceId: engine.seqId,
		});
		expect(sw.isError).toBe(false);
		const rec = await call('record_multicam_cuts', {
			cuts: [
				{ at: 90, angle: 1 },
				{ at: 120, angle: 'Camera 2' },
			],
			to: 150,
			sequenceId: engine.seqId,
		});
		expect(rec.isError).toBe(false);
		const g = await call('get_multicam', { sequenceId: engine.seqId, at: 45 });
		expect(g.body.sources[0].cameras.map((x: { name: string }) => x.name)).toEqual([
			'Camera 1',
			'Camera 2',
			'Audio 1',
		]);
		expect(g.body.at[0].camera).toBe(2);
		const cams = g.body.clips
			.filter((x: { kind: string }) => x.kind === 'nest-video')
			.map((x: { camera: number }) => x.camera);
		expect(cams).toEqual([1, 2, 1, 2, 1]);
		const ed = await call('edit_multicam_cameras', {
			sequenceId: mcSeq,
			cameras: [{ angle: 1, name: 'Wide' }],
		});
		expect(ed.isError).toBe(false);
		const ids = g.body.clips.map((x: { clipId: string }) => x.clipId);
		const fl = await call('flatten_multicam', { clipIds: ids });
		expect(fl.isError).toBe(false);
		const after = await call('get_multicam', { sequenceId: engine.seqId });
		expect(after.body.clips).toEqual([]);
	});

	it('refuses unreliable audio unless asked, and merges clips', async () => {
		const { engine, call } = await connect({ mk_1: 0, mk_3: 0.5 * S }, false);
		const { $a, $r } = engine.items as Record<string, string>;
		const bad = await call('merge_clips', { itemIds: [$a, $r], method: 'audio' });
		expect(bad.isError).toBe(true);
		expect(bad.body.error.code).toBe('E_SYNC_UNRELIABLE');
		const ok = await call('merge_clips', {
			itemIds: [$a, $r],
			method: 'audio',
			onUnreliable: 'apply',
			removeVideoAudio: true,
		});
		expect(ok.isError).toBe(false);
		expect(ok.body.audio).toHaveLength(2);
		const merged = Object.values(engine.doc().sequences).find((s) => s.merged)!;
		expect(
			Object.values(merged.clips)
				.map((c) => c.kind)
				.sort(),
		).toEqual(['audio', 'video']);
	});

	it('synchronizes timeline clips by audio against the reference the command uses', async () => {
		const { engine, call } = await connect({ mk_1: 0, mk_2: -2 * S });
		const { $a, $b } = engine.items as Record<string, string>;
		const doc = engine.doc();
		const mediaOf = (item: string) => (doc.items[item] as { mediaId: string }).mediaId;
		await call('apply_commands', {
			label: 'place',
			commands: [
				{
					type: 'clip.place',
					source: { mediaId: mediaOf($a!) },
					at: 0,
					tracks: { video: 'V1', audio: 'A1' },
				},
				{
					type: 'clip.place',
					source: { mediaId: mediaOf($b!) },
					at: 200,
					tracks: { video: 'V2', audio: 'A2' },
				},
			],
		});
		const seq = engine.doc().sequences[engine.seqId]!;
		const ids = Object.values(seq.clips)
			.filter((c) => c.kind === 'video')
			.map((c) => c.id);
		const r = await call('synchronize_clips', { clipIds: ids, method: 'audio' });
		expect(r.isError).toBe(false);
		const req = engine.requests.at(-1)!;
		// the reference is the unit on the lowest video track; its representative is its audio clip
		const a1 = Object.values(seq.clips).find((c) => c.kind === 'audio' && c.start === 0)!;
		expect(req.reference).toBe(a1.id);
		const after = engine.doc().sequences[engine.seqId]!;
		const v2 = Object.values(after.clips).find((c) => c.kind === 'video' && c.id !== ids[0])!;
		expect(v2.start).toBe(60);
		const strict = await call('synchronize_clips', { clipIds: ids, method: 'in', bogus: 1 });
		expect(strict.isError).toBe(true);
	});
});
