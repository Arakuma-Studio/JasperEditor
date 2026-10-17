// MCP `auto_tag_audio` (spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): the fake engine applies real commands and answers
// `classifyAudio` with fixed results. Default clips (every untyped audio clip), apply in one transaction with the auto
// mark, the table and low-confidence report, propose mode, a user's type kept unless force, silent clips untyped,
// engine failures and strict arguments.
import type { EngineClient } from '@jasper/engine-client';
import {
	type AudioClip,
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	essentialAutoTag,
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
				{ index: 0, type: 'audio', codec: 'pcm_s16le', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key }],
		derivation: null,
		importedAt: '2026-10-17T00:00:00.000Z',
	};
}

type Item = { category: string | null; confidence: number; silent?: boolean };

function fakeEngine(answers: Record<string, Item>, fail = false) {
	const ids = createCounterIdSource(21);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Auto Tag', preset: 'hd-1080p-30' });
	let revision = 0;
	const calls: unknown[] = [];
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-10-17T00:00:00.000Z',
			revision,
			registries: defaultRegistries(),
		});
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const place = (m: string, track: string, ref: string) => ({
		type: 'clip.place',
		source: { mediaId: m },
		at: 0,
		sourceRange: { in: { flicks: 0 }, out: { flicks: 10 * S } },
		tracks: { audio: track },
		ref,
	});
	const setup = apply({
		label: 'setup',
		commands: [
			{ type: 'media.register', asset: audioMedia('mk_voice', 'voice.wav'), ref: '$v' },
			{ type: 'media.register', asset: audioMedia('mk_music', 'music.wav'), ref: '$m' },
			{ type: 'media.register', asset: audioMedia('mk_quiet', 'quiet.wav'), ref: '$q' },
			place('$v', 'A1', '$voice'),
			place('$m', 'A2', '$music'),
			place('$q', 'A3', '$quiet'),
		],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const clip = { voice: setup.refs.$voice!, music: setup.refs.$music!, quiet: setup.refs.$quiet! };
	const byClip: Record<string, Item> = {
		[clip.voice]: answers.voice!,
		[clip.music]: answers.music!,
		[clip.quiet]: answers.quiet!,
	};
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		classifyAudio: async (req: { clipIds: string[]; envelope?: unknown }, opts: { wait?: boolean }) => {
			calls.push({ req, opts });
			if (fail) return { id: 'job_c', kind: 'audio-classify', state: 'failed', error: { code: 'DECODE_FAILED', message: 'no' } };
			const seq = Object.values(doc.sequences)[0] as Sequence;
			return {
				id: 'job_c',
				kind: 'audio-classify',
				state: 'succeeded',
				progress: 1,
				result: {
					projectId: null,
					sequenceId: seq.id,
					lowConfidence: 0.6,
					counts: { dialogue: 0, music: 0, sfx: 0, ambience: 0, silent: 0, failed: 0, low: 0 },
					version: 1,
					ms: 1,
					items: req.clipIds.map((id) => {
						const a = byClip[id]!;
						const es = readEssentialSound((seq.clips[id] as AudioClip).essential);
						return {
							clipId: id,
							name: seq.clips[id]!.name,
							currentType: es?.type ?? null,
							autoTagged: !!es?.tagged,
							startSeconds: 0,
							durationSeconds: 10,
							cached: false,
							result: {
								category: a.category,
								confidence: a.confidence,
								scores: { dialogue: 0.1, music: 0.1, sfx: 0.1, ambience: 0.1, ...(a.category ? { [a.category]: a.confidence } : {}) },
								reasons: a.silent ? ['silent'] : [`because ${a.category}`],
								silent: !!a.silent,
								durationSec: 10,
								analysedSec: 10,
								features: {},
							},
						};
					}),
				},
			};
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, calls, clip, apply };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(answers: Record<string, Item>, fail = false) {
	const engine = fakeEngine(answers, fail);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'auto-tag-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'auto-tag-test', version: '1' });
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

const clipOf = (doc: ProjectDocument, id: string) => (Object.values(doc.sequences)[0] as Sequence).clips[id] as AudioClip;
const ANSWERS = {
	voice: { category: 'dialogue', confidence: 0.95 },
	music: { category: 'music', confidence: 0.45 },
	quiet: { category: null, confidence: 0, silent: true },
};

describe('auto_tag_audio', () => {
	it('tags every untyped clip in one transaction, marked auto; reports low confidence; silent stays untyped', async () => {
		const { engine, call } = await connect(ANSWERS);
		const r = await call('auto_tag_audio', { projectId: 'prj_t' });
		expect(r.r.isError, r.text).toBeFalsy();
		expect(engine.calls).toHaveLength(1);
		const req = (engine.calls[0] as { req: { clipIds: string[]; envelope: unknown }; opts: { wait: boolean } });
		expect(req.req.clipIds.sort()).toEqual(Object.values(engine.clip).sort());
		expect(req.req.envelope).toBeDefined();
		expect(req.opts.wait).toBe(true);
		expect(r.json.applied).toBe(true);
		expect(r.json.low).toEqual([engine.clip.music]);
		expect(String(r.json.table)).toContain('45 % (low)');
		expect(String(r.json.next)).toContain('low-confidence');
		const d = engine.doc();
		expect(readEssentialSound(clipOf(d, engine.clip.voice).essential)?.type).toBe('dialogue');
		expect(essentialAutoTag(clipOf(d, engine.clip.voice).essential)?.confidence).toBe(0.95);
		expect(readEssentialSound(clipOf(d, engine.clip.music).essential)?.type).toBe('music');
		expect(clipOf(d, engine.clip.quiet).essential).toBeUndefined();
		// nothing left untyped but the silent clip: it is asked again (still silent), nothing changes
		const again = await call('auto_tag_audio', { projectId: 'prj_t' });
		expect(again.json.applied).toBe(false);
	});

	it('propose only classifies; a user type is kept unless force; minConfidence', async () => {
		const { engine, call } = await connect(ANSWERS);
		engine.apply({
			label: 'user',
			commands: [{ type: 'essentialSound.setType', clipIds: [engine.clip.voice], audioType: 'sfx' }],
		});
		const p = await call('auto_tag_audio', { projectId: 'prj_t', clipIds: [engine.clip.voice], mode: 'propose' });
		expect(p.json.applied).toBe(false);
		expect((p.json.items as { before: string; category: string }[])[0]).toMatchObject({ before: 'sfx', category: 'dialogue' });
		expect(readEssentialSound(clipOf(engine.doc(), engine.clip.voice).essential)?.type).toBe('sfx');
		const keep = await call('auto_tag_audio', { projectId: 'prj_t', clipIds: [engine.clip.voice] });
		expect(keep.r.isError, keep.text).toBeFalsy();
		expect(readEssentialSound(clipOf(engine.doc(), engine.clip.voice).essential)?.type).toBe('sfx');
		expect(JSON.stringify(keep.json.results)).toContain('USER_TYPE');
		await call('auto_tag_audio', { projectId: 'prj_t', clipIds: [engine.clip.voice], force: true });
		expect(readEssentialSound(clipOf(engine.doc(), engine.clip.voice).essential)?.type).toBe('dialogue');
		await call('auto_tag_audio', { projectId: 'prj_t', clipIds: [engine.clip.music], minConfidence: 0.6 });
		expect(clipOf(engine.doc(), engine.clip.music).essential).toBeUndefined();
	});

	it('engine failures and bad arguments are tool errors', async () => {
		const { engine, call } = await connect(ANSWERS, true);
		const f = await call('auto_tag_audio', { projectId: 'prj_t' });
		expect(f.r.isError).toBe(true);
		expect(f.text).toContain('DECODE_FAILED');
		const unknown = await call('auto_tag_audio', { projectId: 'prj_t', clipId: engine.clip.voice });
		expect(unknown.r.isError).toBe(true);
		const notClip = await call('auto_tag_audio', { projectId: 'prj_t', clipIds: ['clp_nope'] });
		expect(notClip.r.isError).toBe(true);
		const badMode = await call('auto_tag_audio', { projectId: 'prj_t', mode: 'maybe' });
		expect(badMode.r.isError).toBe(true);
	});
});
