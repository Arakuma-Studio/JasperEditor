// sound_check's humanVerdicts and custom target (wp-note "Phase 5 → WP5.2"): the user's listen-here verdicts — the
// `comment` markers the editor's Sound Check panel writes ("Sound Check: sounds right" / "Sound Check: flagged" + the
// note) — come back to the agent with their timecode, the listen slot they sit on, and the note; an agent's own
// marker with that name is not a human verdict; `target` reaches the engine request. The engine is faked (the real
// check runs in `sound-check.test.ts`).
import type { SoundCheckRequest } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	SOUND_CHECK_VERDICT_MARKER,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { resultFixture } from './sound-check-report-fixture.ts';
import { readToolResponse } from './tool-response.ts';

function fakeEngine() {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Check', preset: 'hd-1080p-30' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const apply = (tx: Record<string, unknown>, origin: unknown) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, label: 'x', ...tx, origin } as never,
			{ ids, now: () => '2026-10-17T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (r.result.ok) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	// 10 s of audio on A1 (bound verdicts need a moment inside the sequence)
	const media = apply(
		{
			commands: [
				{
					type: 'media.register',
					ref: '$a',
					asset: {
						kind: 'audio',
						fingerprint: 'q1:verdicts',
						originalName: 'voice.wav',
						sizeBytes: 1,
						container: 'wav',
						probe: {
							durationFlicks: 7_056_000_000,
							startTimecode: null,
							streams: [
								{
									index: 0,
									type: 'audio',
									codec: 'pcm_s16le',
									sampleRate: 48_000,
									channels: 2,
									channelLayout: 'stereo',
								},
							],
							rotationDegrees: 0,
							hasAlpha: false,
							variableFrameRate: false,
						},
						locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_verdicts' }],
					},
				},
				{ type: 'clip.place', source: { mediaId: '$a' }, at: 0, tracks: { audio: 'A1' } },
			],
		},
		'user',
	);
	if (!media.ok) throw new Error(JSON.stringify(media.errors));
	const audioClip = () => Object.values(doc.sequences[seqId]!.clips).find((c) => c.kind === 'audio')!.id;
	// the user listened: the hero sounds right, the worst moment is flagged with a note; an agent wrote a marker with
	// the same name (not a human verdict) and the user an ordinary comment marker
	const user = apply(
		{
			commands: [
				{ type: 'marker.add', frame: 91, name: SOUND_CHECK_VERDICT_MARKER.ok, markerType: 'comment' },
				{
					type: 'marker.add',
					frame: 90,
					name: SOUND_CHECK_VERDICT_MARKER.flag,
					markerType: 'comment',
					comment: 'The impact is late',
				},
				{ type: 'marker.add', frame: 12, name: 'Check the logo', markerType: 'comment' },
			],
		},
		'user',
	);
	if (!user.ok) throw new Error(JSON.stringify(user.errors));
	const agent = apply(
		{
			commands: [
				{ type: 'marker.add', frame: 150, name: SOUND_CHECK_VERDICT_MARKER.ok, markerType: 'comment' },
			],
		},
		{ agent: 'other-agent' },
	);
	if (!agent.ok) throw new Error(JSON.stringify(agent.errors));
	const requests: SoundCheckRequest[] = [];
	const lastRequests: unknown[] = [];
	const job = (state: string) => ({
		id: 'job_check',
		kind: 'sound-check',
		title: 'Sound Check',
		origin: { type: 'agent', agentRunId: 'x' },
		state,
		progress: state === 'succeeded' ? 1 : 0,
		createdAt: '2026-10-17T10:00:00.000Z',
		priority: 'user',
		cpuSlots: 2,
		...(state === 'succeeded' ? { result: resultFixture({ projectId: 'prj_test', sequenceId: seqId }) } : {}),
	});
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		soundCheck: async (req: SoundCheckRequest) => {
			requests.push(req);
			return job('queued');
		},
		getJob: async () => job('succeeded'),
		lastSoundCheck: async (req: { projectId: string; sequenceId?: string }) => {
			lastRequests.push(req);
			return {
				projectId: req.projectId,
				sequenceId: seqId,
				jobId: 'job_check',
				savedAt: '2026-10-17T10:00:00.000Z',
				state: 'stale',
				reasons: ['mix'],
				result: resultFixture({ projectId: 'prj_test', sequenceId: seqId }),
			};
		},
		call: async (name: string) => {
			throw new Error(`unexpected call ${name}`);
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, requests, lastRequests, seqId, apply, audioClip };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'check-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'check-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (args: Record<string, unknown>, name = 'sound_check') =>
		readToolResponse(
			(await client.callTool({
				name,
				arguments: { projectId: 'prj_test', ...(name === 'sound_check' ? { images: false } : {}), ...args },
			})) as CallToolResult,
		);
	return { engine, call };
}

describe('sound_check humanVerdicts / target', () => {
	it('returns the user’s listen-here verdicts with timecode, slot and note; not an agent’s marker', async () => {
		const { call, engine } = await connect();
		const r = await call({});
		expect(r.isError).toBe(false);
		expect(r.body.humanVerdicts).toEqual([
			expect.objectContaining({
				frame: 90,
				timecode: '00:00:03:00',
				verdict: 'flagged',
				note: 'The impact is late',
				slot: 'worst',
			}),
			expect.objectContaining({
				frame: 91,
				timecode: '00:00:03:01',
				verdict: 'sounds right',
				note: null,
				slot: 'hero',
			}),
		]);
		expect(engine.requests[0]).not.toHaveProperty('target');
	});

	it('a verdict bound to its moment (soundDesign.setVerdict) says whether it is still current; older ones cannot tell', async () => {
		const { call, engine } = await connect();
		const clipId = engine.audioClip();
		const set = engine.apply(
			{
				commands: [
					{
						type: 'soundDesign.setVerdict',
						frame: 120,
						verdict: 'flag',
						note: 'Too quiet',
						slot: 'loudest',
						clipId,
					},
				],
			},
			'user',
		);
		expect(set.ok).toBe(true);
		let r = await call({});
		const bound = (r.body.humanVerdicts as Record<string, unknown>[]).find((v) => v.frame === 120);
		expect(bound).toMatchObject({
			verdict: 'flagged',
			note: 'Too quiet',
			slot: 'loudest',
			clipId,
			stale: false,
		});
		// the legacy (name-only) markers: staleness unknown
		expect((r.body.humanVerdicts as Record<string, unknown>[]).find((v) => v.frame === 90)).toMatchObject({
			stale: null,
		});
		// the user's sound changed since they listened: stale, with the reason
		expect(
			engine.apply(
				{ commands: [{ type: 'audio.setGain', clipIds: [clipId], mode: 'adjust', db: 6 }] },
				'user',
			).ok,
		).toBe(true);
		r = await call({});
		expect((r.body.humanVerdicts as Record<string, unknown>[]).find((v) => v.frame === 120)).toMatchObject({
			stale: true,
			staleReasons: ['moment'],
			mixChangedSince: true,
		});
	});

	it('get_sound_check returns the kept report with its staleness and the verdicts; no job is run', async () => {
		const { call, engine } = await connect();
		const r = await call({}, 'get_sound_check');
		expect(r.isError).toBe(false);
		expect(r.body).toMatchObject({ jobId: 'job_check', state: 'stale', reasons: ['mix'], verdict: 'fail' });
		expect(String(r.body.next)).toContain('run sound_check again before applying any fix');
		expect((r.body.findings as string[]).some((f) => f.includes('OUT_OF_SYNC'))).toBe(true);
		expect(r.body.humanVerdicts).toHaveLength(2);
		expect(engine.lastRequests).toEqual([{ projectId: 'prj_test', sequenceId: engine.seqId }]);
		expect(engine.requests).toEqual([]);
	});

	it('safeFixes: the safe fixes once each in the order they were judged (commands, swaps, jobs); why lines', async () => {
		const { call } = await connect();
		const r = await call({});
		const fixes = r.body.safeFixes as { issueIds: string[]; tool: string }[];
		// report order: OUT_OF_SYNC (commands), TRUNCATED (swap), SILENCE (not safe), LOUDNESS (commands), MUSIC_OVER_VOICE (job)
		expect(fixes.map((f) => f.issueIds[0]!.split(':')[0])).toEqual([
			'OUT_OF_SYNC',
			'LOUDNESS',
			'TRUNCATED',
			'MUSIC_OVER_VOICE',
		]);
		expect(fixes.map((f) => f.tool)).toEqual(['align_peak', 'apply_commands', 'swap_sound', 'apply_delivery']);
		expect(r.body.next).toMatch(/in the order of safeFixes/);
		// a fix that is not safe says why
		const silence = (r.body.findings as string[]).find((l) => l.includes('SILENCE'))!;
		expect(silence).toContain('needs the user');
		expect(silence).toContain('— Only if the silence is intended');
	});

	it('passes a custom target to the engine; refuses one out of range', async () => {
		const { call, engine } = await connect();
		const r = await call({ target: { integratedLufs: -20, truePeakDb: -2 } });
		expect(r.isError).toBe(false);
		expect(engine.requests[0]).toMatchObject({ target: { integratedLufs: -20, truePeakDb: -2 } });
		const bad = await call({ target: { integratedLufs: -80, truePeakDb: -2 } });
		expect(bad.isError).toBe(true);
	});
});
