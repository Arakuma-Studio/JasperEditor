// audio-fx: the audio effect, Essential Sound and Remix MCP tools through the protocol against an in-memory engine
// (documents applied with the real command system; loudness analysis and the remix plan answered by the fake).
import type { EngineClient } from '@jasper/engine-client';
import {
	type AudioClip,
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	readEssentialSound,
	type Sequence,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const S = 705_600_000;

function audioMedia(key: string, name: string) {
	return {
		kind: 'audio',
		fingerprint: `q1:${key.padStart(64, '0')}`,
		originalName: name,
		sizeBytes: 1000,
		container: 'wav',
		probe: {
			durationFlicks: 60 * S,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'audio',
					codec: 'pcm_s16le',
					sampleRate: 48000,
					channels: 2,
					channelLayout: 'stereo',
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key }],
		derivation: null,
		importedAt: '2026-10-07T00:00:00.000Z',
	};
}

function fakeEngine() {
	const ids = createCounterIdSource(11);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Audio FX', preset: 'hd-1080p-30' });
	let revision = 0;
	const calls: { name: string; body?: unknown }[] = [];
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-10-07T00:00:00.000Z',
			revision,
			registries: defaultRegistries(),
		});
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const setup = apply({
		label: 'setup',
		commands: [
			{ type: 'media.register', asset: audioMedia('mk_voice', 'voice.wav'), ref: '$v' },
			{ type: 'media.register', asset: audioMedia('mk_music', 'music.wav'), ref: '$m' },
			{
				type: 'clip.place',
				source: { mediaId: '$v' },
				at: 0,
				sourceRange: { in: { flicks: 0 }, out: { flicks: 10 * S } },
				tracks: { audio: 'A1' },
				ref: '$voice',
			},
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { flicks: 0 }, out: { flicks: 40 * S } },
				tracks: { audio: 'A2' },
				ref: '$music',
			},
		],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const voice = setup.refs.$voice!;
	const music = setup.refs.$music!;
	const job = (result: unknown) => ({
		id: 'job_a',
		kind: 'audio-analyze',
		state: 'succeeded',
		progress: 1,
		result,
	});
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		analyzeAudio: async (req: { scope: { clipIds?: string[] }; activity?: unknown; levels?: string }) => {
			calls.push({ name: 'analyzeAudio', body: req });
			if (req.activity) return job({ activity: { thresholdDb: -44, regions: [[30, 150]] } });
			const clips: Record<string, { integratedLufs: number | null }> = {};
			for (const id of req.scope.clipIds ?? []) clips[id] = { integratedLufs: id === voice ? -31 : -15 };
			return job({ clips });
		},
		remixPlan: async (req: Record<string, unknown>) => {
			calls.push({ name: 'remixPlan', body: req });
			return {
				bpm: 120,
				lengthSeconds: 20,
				pieces: [
					{ srcSeconds: 0, lenSeconds: 12 },
					{ srcSeconds: 32, lenSeconds: 8 },
				],
			};
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, calls, voice, music };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'audio-fx-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'audio-fx-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		let json: Record<string, unknown> = {};
		try {
			json = JSON.parse(text);
		} catch {}
		return { r, text, json };
	};
	return { engine, call };
}

const seqOf = (doc: ProjectDocument) => Object.values(doc.sequences)[0] as Sequence;
const clipOf = (doc: ProjectDocument, id: string) => seqOf(doc).clips[id] as AudioClip;

describe('audio effect MCP tools', () => {
	it('lists the catalogue, adds with keyframes, edits, reorders, bypasses and removes', async () => {
		const { engine, call } = await connect();
		const list = await call('list_audio_effects', { folder: 'Amplitude and Compression' });
		expect(list.r.isError, list.text).toBeFalsy();
		const ids = (list.json.effects as { effectId: string }[]).map((e) => e.effectId);
		expect(ids).toContain('jasper.audio.hard-limiter');
		expect(ids).toContain('jasper.audio.amplify');

		const add = await call('add_audio_effect', {
			projectId: 'prj_t',
			clipId: engine.voice,
			effectId: 'jasper.audio.amplify',
			params: {
				leftGain: {
					keyframes: [
						{ at: 0, value: -6 },
						{ at: { seconds: 2 }, value: 3 },
					],
				},
				link: false,
			},
		});
		expect(add.r.isError, add.text).toBeFalsy();
		let fx = clipOf(engine.doc(), engine.voice).effects.at(-1)!;
		expect(fx.effectId).toBe('jasper.audio.amplify');
		expect(fx.params.leftGain!.keyframes.map((k) => k.value)).toEqual([-6, 3]);
		expect(fx.params.link!.value).toBe(false);

		const get = await call('get_audio_effects', { projectId: 'prj_t', clipId: engine.voice, at: 60 });
		const stack = get.json.effects as { id: string; values: Record<string, unknown> }[];
		expect(stack.at(-1)!.values.leftGain).toBeCloseTo(3);
		expect(stack.at(-1)!.values['leftGain.keyframes']).toBe(2);

		await call('add_audio_effect', {
			projectId: 'prj_t',
			clipId: engine.voice,
			effectId: 'jasper.audio.hard-limiter',
		});
		const set = await call('set_audio_effect', {
			projectId: 'prj_t',
			effectInstanceId: fx.id,
			params: { leftGain: -3 },
			enabled: false,
			index: 0,
		});
		expect(set.r.isError, set.text).toBeFalsy();
		const effects = clipOf(engine.doc(), engine.voice).effects;
		fx = effects.find((e) => e.id === fx.id)!;
		expect(effects.filter((e) => e.effectId.startsWith('jasper.audio.'))[0]!.id).toBe(fx.id);
		expect(fx.enabled).toBe(false);
		expect(fx.params.leftGain).toMatchObject({ value: -3, keyframes: [] });

		const bad = await call('set_audio_effect', {
			projectId: 'prj_t',
			effectInstanceId: fx.id,
			params: { gain: 1 },
		});
		expect(bad.r.isError).toBe(true);
		expect(bad.text).toContain('leftGain');
		const unknown = await call('add_audio_effect', {
			projectId: 'prj_t',
			clipId: engine.voice,
			effectId: 'nope',
		});
		expect(unknown.r.isError).toBe(true);

		const track = await call('add_audio_effect', {
			projectId: 'prj_t',
			track: 'A2',
			effectId: 'jasper.audio.studio-reverb',
		});
		expect(track.r.isError, track.text).toBeFalsy();
		const trackFx = await call('get_audio_effects', { projectId: 'prj_t', track: 'A2' });
		expect((trackFx.json.effects as { effectId: string }[]).map((e) => e.effectId)).toEqual([
			'jasper.audio.studio-reverb',
		]);

		const rm = await call('remove_audio_effect', { projectId: 'prj_t', effectInstanceIds: [fx.id] });
		expect(rm.r.isError, rm.text).toBeFalsy();
		expect(clipOf(engine.doc(), engine.voice).effects.some((e) => e.id === fx.id)).toBe(false);
	});
});

describe('Essential Sound and Remix MCP tools', () => {
	it('type, preset, options, Auto-Match, ducking, clear', async () => {
		const { engine, call } = await connect();
		const info = await call('get_essential_sound', { projectId: 'prj_t', audioType: 'dialogue' });
		expect(info.json.optionKeys as string[]).toContain('repair.noise.amount');
		const presets = info.json.presets as string[];
		expect(presets[0]).toBe('(Default)');

		const set = await call('set_essential_sound', {
			projectId: 'prj_t',
			clipIds: [engine.voice],
			audioType: 'dialogue',
			preset: presets[1],
			values: { 'repair.noise.on': true, 'repair.noise.amount': 6 },
		});
		expect(set.r.isError, set.text).toBeFalsy();
		let voice = clipOf(engine.doc(), engine.voice);
		expect(readEssentialSound(voice.essential)?.repair.noise).toEqual({ on: true, amount: 6 });
		expect(voice.effects.some((e) => e.essential === 'noise' && e.effectId === 'jasper.audio.denoise')).toBe(
			true,
		);

		const match = await call('auto_match_loudness', {
			projectId: 'prj_t',
			clipIds: [engine.voice, engine.music],
		});
		expect(match.r.isError, match.text).toBeFalsy();
		const req = engine.calls.find((c) => c.name === 'analyzeAudio')!.body as { levels: string };
		expect(req.levels).toBe('source');
		voice = clipOf(engine.doc(), engine.voice);
		expect(voice.gainDb).toBeCloseTo(8); // −31 → −23 LUFS
		const music = clipOf(engine.doc(), engine.music);
		expect(readEssentialSound(music.essential)?.type).toBe('dialogue'); // untyped clips become Dialogue
		expect(music.gainDb).toBeCloseTo(-8);

		await call('set_essential_sound', { projectId: 'prj_t', clipIds: [engine.music], audioType: 'music' });
		const duck = await call('generate_essential_ducking', { projectId: 'prj_t', clipIds: [engine.music] });
		expect(duck.r.isError, duck.text).toBeFalsy();
		expect(duck.json.triggerClips).toBe(1);
		expect(clipOf(engine.doc(), engine.music).volumeDb.keyframes.length).toBeGreaterThan(0);
		const notMusic = await call('generate_essential_ducking', {
			projectId: 'prj_t',
			clipIds: [engine.voice],
		});
		expect(notMusic.r.isError).toBe(true);

		const clear = await call('clear_essential_sound', { projectId: 'prj_t', clipIds: [engine.voice] });
		expect(clear.r.isError, clear.text).toBeFalsy();
		voice = clipOf(engine.doc(), engine.voice);
		expect(voice.essential).toBeUndefined();
		expect(voice.effects.some((e) => e.essential)).toBe(false);
		expect(voice.gainDb).toBeCloseTo(0);
	});

	it('remix to a duration and revert', async () => {
		const { engine, call } = await connect();
		const r = await call('remix_audio', {
			projectId: 'prj_t',
			clipId: engine.music,
			targetDuration: { seconds: 20 },
		});
		expect(r.r.isError, r.text).toBeFalsy();
		const plan = engine.calls.find((c) => c.name === 'remixPlan')!.body as Record<string, number | string>;
		expect(plan).toMatchObject({
			mediaKey: 'mk_music',
			startSeconds: 0,
			durationSeconds: 40,
			targetSeconds: 20,
		});
		const pieces = Object.values(seqOf(engine.doc()).clips).filter((c) => (c as AudioClip).remix);
		expect(pieces.length).toBe(2);
		const end = Math.max(...pieces.map((c) => c.start + c.duration));
		expect(end).toBe(600);
		const back = await call('revert_remix', { projectId: 'prj_t', clipId: pieces[1]!.id });
		expect(back.r.isError, back.text).toBeFalsy();
		const clips = Object.values(seqOf(engine.doc()).clips).filter((c) => c.kind === 'audio');
		expect(clips.length).toBe(2);
		expect(clips.some((c) => c.duration === 1200)).toBe(true);
	});
});
