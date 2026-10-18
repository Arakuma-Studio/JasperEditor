// Describe-it search and Find Moment end to end (spec 12 P6-E14, WP-E9) on a tiny stand-in model (tiny-clap.ts: the
// real model's file names, inputs and outputs; bright sounds match "high", dark ones "low"): without the model the
// description's words are searched; installing it (catalogue file URLs, sha256-checked) and embedding the library
// (`sound-embed`, incremental), describe search ranks badly named sounds by what they sound like; a changed file gets a
// new embedding and the old one leaves the cache; Find Moment finds the bright burst of a long recording and reuses its
// cached windows; hostile requests are refused with typed errors; a worker that dies fails its request and the next
// one works; removing the model asks an agent's user and leaves keyword search as before. No network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AGENT_NAME_HEADER,
	type EngineJob,
	SoundEmbedResultSchema,
	SoundMatchResponseSchema,
	SoundMomentResultSchema,
	SoundSearchResponseSchema,
	SoundSemanticModelsResponseSchema,
	SoundSemanticStatusSchema,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import { createCounterIdSource, createEmptyProject, makeEnvelope } from '@jasper/project';
import { writeTinyClapCatalog } from '@jasper/testkit/tiny-clap';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { ClapError } from '../src/sounds/semantic/runtime.ts';
import type { SoundService } from '../src/sounds/service.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, JSON_H, makeApp, tempAppdir, until } from './helpers.ts';
import { PACK, SR } from './sound-fixtures.ts';

const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
	'JASPER_MODEL_CATALOG',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function tone(seconds: number, freq: number, amp = 0.4): Float32Array {
	const x = new Float32Array(Math.round(seconds * SR));
	for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
	return x;
}
const wav = (path: string, x: Float32Array) => {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, encodeWav([x, x], SR, 's16'));
};

/** A field recording: 40 s of low hum with a bright 1 s burst at 23 s. */
function fieldRecording(): Float32Array {
	const x = tone(40, 110, 0.2);
	const burst = tone(1, 7000, 0.5);
	x.set(burst, 23 * SR);
	return x;
}

let starter = '';
function makeKit(dir: string): string {
	wav(join(dir, 'sfx', 'SFX_0001.wav'), tone(1, 7000));
	wav(join(dir, 'sfx', 'SFX_0002.wav'), tone(1, 120));
	wav(join(dir, 'sfx', 'SFX_0003.wav'), tone(0.6, 1500));
	wav(join(dir, 'field', 'field_recording.wav'), fieldRecording());
	const sound = (file: string, title: string) => ({
		file,
		title,
		types: [],
		tags: ['test'],
		author: 'Test Author',
		license: 'CC0-1.0',
		sourceUrl: 'https://example.invalid/sounds',
		packId: PACK.id,
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [PACK],
			sounds: [
				sound('sfx/SFX_0001.wav', 'SFX_0001'),
				sound('sfx/SFX_0002.wav', 'SFX_0002'),
				sound('sfx/SFX_0003.wav', 'SFX_0003 glass'),
				sound('field/field_recording.wav', 'Field recording'),
			],
		}),
	);
	return dir;
}

beforeAll(() => {
	const dir = tempAppdir('jasper-clap-cat-');
	process.env.JASPER_MODEL_CATALOG = writeTinyClapCatalog(dir, { pending: true });
	starter = makeKit(tempAppdir('jasper-clap-kit-'));
	process.env.JASPER_SOUND_STARTER_DIR = starter;
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '0';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
});
afterAll(async () => {
	await closeApps();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const wait = (app: FastifyInstance, id: string): Promise<EngineJob> => coreServices(app).queue.wait(id);
const sounds = (app: FastifyInstance) => app.jasper.services.sounds as SoundService;

async function json(
	app: FastifyInstance,
	method: 'GET' | 'POST' | 'DELETE',
	url: string,
	payload?: unknown,
	headers: Record<string, string> = JSON_H,
) {
	const { 'content-type': _ct, ...plain } = headers;
	const r = await app.inject({
		method,
		url,
		headers: payload === undefined ? plain : headers,
		...(payload === undefined ? {} : { payload: payload as never }),
	});
	return { status: r.statusCode, body: r.json() as Record<string, unknown> };
}

async function indexed(app: FastifyInstance, headers: Record<string, string> = JSON_H) {
	const r = await json(app, 'POST', '/api/sounds/index', {}, headers);
	expect(r.status).toBe(202);
	const j = await wait(app, r.body.id as string);
	expect(j.state, JSON.stringify(j.error)).toBe('succeeded');
}

async function search(app: FastifyInstance, qs: string) {
	const r = await json(app, 'GET', `/api/sounds?${qs}`);
	expect(r.status, JSON.stringify(r.body)).toBe(200);
	return SoundSearchResponseSchema.parse(r.body);
}

async function installTiny(app: FastifyInstance, headers: Record<string, string> = JSON_H) {
	const r = await json(app, 'POST', '/api/sounds/semantic/models/clap-test/install', undefined, headers);
	expect(r.status, JSON.stringify(r.body)).toBe(202);
	const j = await wait(app, r.body.id as string);
	expect(j.state, JSON.stringify(j.error)).toBe('succeeded');
}

async function embed(app: FastifyInstance, body: Record<string, unknown> = {}) {
	// the install starts one by itself once its job has ended: let it finish, then run ours
	await until(async () => {
		const j = sounds(app).semantic.embedJob();
		if (j) await wait(app, j.id);
		return !sounds(app).semantic.embedJob();
	}, 120_000);
	const r = await json(app, 'POST', '/api/sounds/semantic/embed', body);
	expect(r.status, JSON.stringify(r.body)).toBe(202);
	const j = await wait(app, r.body.id as string);
	expect(j.state, JSON.stringify(j.error)).toBe('succeeded');
	return SoundEmbedResultSchema.parse(j.result);
}

const titles = (s: { results: { sound: { title: string } }[] }) => s.results.map((r) => r.sound.title);

describe('Describe-it search without the model', { timeout: 300_000 }, () => {
	it('lists the model (licence, sizes, pending location) and searches the description’s words', async () => {
		const app = await makeApp();
		await indexed(app);
		const st = SoundSemanticStatusSchema.parse((await json(app, 'GET', '/api/sounds/semantic')).body);
		expect(st).toMatchObject({ status: 'not-installed', embedded: 0, job: null });
		expect(st.total).toBe(4);
		const models = SoundSemanticModelsResponseSchema.parse(
			(await json(app, 'GET', '/api/sounds/semantic/models')).body,
		).models;
		expect(models.map((m) => m.id)).toEqual(['clap-test', 'clap-pending']);
		expect(models[0]).toMatchObject({
			installed: false,
			available: true,
			unavailableReason: null,
			license: 'Apache-2.0',
		});
		expect(models[0]!.missingBytes).toBe(models[0]!.sizeBytes);
		expect(models[1]).toMatchObject({
			available: false,
			unavailableReason: 'Not available yet: the model download location is pending',
		});
		// keyword fallback: the same rows as searching the words
		const d = await search(app, 'describe=glass&license=any');
		expect(d.describe).toMatchObject({ mode: 'keywords', embedded: 0 });
		expect(d.describe!.reason).toMatch(/not installed/);
		expect(titles(d)).toEqual(titles(await search(app, 'q=glass&license=any')));
		expect(titles(d)).toEqual(['SFX_0003 glass']);
		// refusals: pending download, no model for embedding or moments
		const pending = await json(app, 'POST', '/api/sounds/semantic/models/clap-pending/install', undefined);
		expect(pending).toMatchObject({ status: 409, body: { code: 'MODEL_DOWNLOAD_PENDING' } });
		expect((await json(app, 'POST', '/api/sounds/semantic/models/nope/install', undefined)).status).toBe(404);
		expect((await json(app, 'POST', '/api/sounds/semantic/embed', {})).body).toMatchObject({
			code: 'MODEL_NOT_INSTALLED',
		});
		const id = d.results[0]!.sound.id;
		const m = await json(app, 'POST', `/api/sounds/${id}/moments`, { description: 'a high tone' });
		expect(m).toMatchObject({ status: 409, body: { code: 'MODEL_NOT_INSTALLED' } });
		const mt = await json(app, 'POST', `/api/sounds/${id}/match`, { description: 'a high tone' });
		expect(mt).toMatchObject({ status: 409, body: { code: 'MODEL_NOT_INSTALLED' } });
		const caps = (await json(app, 'GET', '/api/capabilities')).body as {
			features: { sound: { describe: { status: string } } };
		};
		expect(caps.features.sound.describe.status).toBe('not-installed');
	});
});

describe('Describe-it search with the model', { timeout: 300_000 }, () => {
	let app: FastifyInstance & { appdir: string };
	beforeAll(async () => {
		app = await makeApp();
		await indexed(app);
		await installTiny(app);
	});

	it('embeds the library once, incrementally, and ranks badly named sounds by what they sound like', async () => {
		const first = await embed(app);
		expect(first.total).toBe(4);
		expect(first.failed).toBe(0);
		expect(first.embedded + first.reused).toBe(4);
		const second = await embed(app);
		expect(second).toMatchObject({ embedded: 0, reused: 4, failed: 0 });
		const st = SoundSemanticStatusSchema.parse((await json(app, 'GET', '/api/sounds/semantic')).body);
		expect(st).toMatchObject({ status: 'ready', embedded: 4, total: 4 });

		const high = await search(app, 'describe=high&license=any');
		expect(high.describe).toMatchObject({ mode: 'semantic', model: 'clap-test', embedded: 4, pending: 0 });
		expect(titles(high)[0]).toBe('SFX_0001');
		expect(high.results[0]!.match).toBeDefined();
		expect(high.results[0]!.parts.semantic).toBeGreaterThan(0);
		const low = await search(app, 'describe=low&license=any');
		expect(titles(low)[0]).toBe('SFX_0002');
		expect(titles(low)).not.toContain('SFX_0001');
		// deterministic: the same request ranks the same
		expect(await search(app, 'describe=high&license=any')).toEqual(high);
		// keyword search is untouched by the model
		const kw = await search(app, 'q=glass&license=any');
		expect(titles(kw)).toEqual(['SFX_0003 glass']);
		expect(kw.describe).toBeUndefined();
		// q still filters in describe mode
		expect(
			titles(await search(app, 'q=glass&describe=high&license=any')).every((t) => t === 'SFX_0003 glass'),
		).toBe(true);
		const caps = (await json(app, 'GET', '/api/capabilities')).body as {
			features: { sound: { describe: { status: string } } };
		};
		expect(caps.features.sound.describe.status).toBe('ready');
	});

	it('matches one sound against a description and its alternatives', async () => {
		const s = await search(app, 'q=SFX_0001&license=any');
		const id = s.results[0]!.sound.id;
		const r = await json(app, 'POST', `/api/sounds/${id}/match`, {
			description: 'high',
			alternatives: ['low'],
		});
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const m = SoundMatchResponseSchema.parse(r.body);
		expect(m.matches.map((x) => x.text)).toEqual(['high', 'low']);
		expect(m.matches[0]!.share).toBeGreaterThan(m.matches[1]!.share);
		expect(m.matches[0]!.share + m.matches[1]!.share).toBeCloseTo(1, 3);
		expect(m.matches[0]!.z).toBeGreaterThan(m.matches[1]!.z);
		const bad = (body: unknown, sid = id) => json(app, 'POST', `/api/sounds/${sid}/match`, body);
		expect((await bad({ description: '' })).status).toBe(400);
		expect((await bad({ description: 'x', alternatives: Array.from({ length: 9 }, () => 'y') })).status).toBe(
			400,
		);
		expect((await bad({ description: 'x', extra: true })).status).toBe(400);
		expect((await bad({ description: 'x' }, 'snd_0123456789abcdef')).status).toBe(404);
	});

	it('refuses hostile describe and moment requests with typed errors', async () => {
		expect((await json(app, 'GET', `/api/sounds?describe=${'a'.repeat(301)}`)).status).toBe(400);
		const s = await search(app, 'q=field&license=any');
		const id = s.results[0]!.sound.id;
		const post = (body: unknown, sid = id) => json(app, 'POST', `/api/sounds/${sid}/moments`, body);
		expect((await post({ description: '' })).status).toBe(400);
		expect((await post({ description: 'x', lengthSec: 0.1 })).status).toBe(400);
		expect((await post({ description: 'x', count: 11 })).status).toBe(400);
		expect((await post({ description: 'x', extra: 1 })).status).toBe(400);
		expect((await post({ description: 'x', startSec: 5, endSec: 2 })).body).toMatchObject({
			code: 'INVALID_RANGE',
		});
		expect((await post({ description: 'x', startSec: 100 })).body).toMatchObject({ code: 'INVALID_RANGE' });
		expect((await post({ description: 'x' }, 'snd_0123456789abcdef')).status).toBe(404);
		expect((await post({ description: 'x' }, '../etc')).status).toBe(404);
		expect((await json(app, 'POST', '/api/sounds/semantic/embed', { full: 'yes' })).status).toBe(400);
	});

	it('finds the bright moment of a long recording, trimmed, and reuses its windows', async () => {
		const s = await search(app, 'q=field&license=any');
		const id = s.results[0]!.sound.id;
		const r = await json(app, 'POST', `/api/sounds/${id}/moments?wait=1`, {
			description: 'high',
			lengthSec: 1,
			count: 2,
		});
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const res = SoundMomentResultSchema.parse((r.body as unknown as EngineJob).result);
		expect(res).toMatchObject({
			soundId: id,
			description: 'high',
			model: 'clap-test',
			startSec: 0,
			endSec: 40,
			lengthSec: 1,
		});
		const best = res.moments[0]!;
		expect(best.startSec).toBeGreaterThanOrEqual(22.5);
		expect(best.endSec).toBeLessThanOrEqual(24.6);
		expect(best.endSec - best.startSec).toBeGreaterThan(0.2);
		expect(res.moments.length).toBeLessThanOrEqual(2);
		expect(res.computed).toBeGreaterThan(0);
		// the same recording again: every window comes from the cache
		const again = await json(app, 'POST', `/api/sounds/${id}/moments?wait=1`, {
			description: 'high',
			lengthSec: 1,
			count: 2,
		});
		const res2 = SoundMomentResultSchema.parse((again.body as unknown as EngineJob).result);
		expect(res2.computed).toBe(0);
		expect(res2.cached).toBe(res.computed + res.cached);
		expect(res2.moments).toEqual(res.moments);
		// a range: only that part is searched
		const part = await json(app, 'POST', `/api/sounds/${id}/moments?wait=1`, {
			description: 'high',
			startSec: 0,
			endSec: 15,
		});
		const res3 = SoundMomentResultSchema.parse((part.body as unknown as EngineJob).result);
		expect(res3.endSec).toBe(15);
		for (const m of res3.moments) expect(m.endSec).toBeLessThanOrEqual(15);
	});

	it('gives a changed file a new embedding and drops the old one', async () => {
		const svc = sounds(app).semantic;
		wav(join(starter, 'sfx', 'SFX_0001.wav'), tone(1, 100)); // now dark
		await indexed(app);
		const st = SoundSemanticStatusSchema.parse((await json(app, 'GET', '/api/sounds/semantic')).body);
		expect(st.embedded).toBe(3);
		const r = await embed(app);
		expect(r).toMatchObject({ embedded: 1, reused: 3 });
		const high = await search(app, 'describe=high&license=any');
		expect(titles(high)[0]).not.toBe('SFX_0001');
		// the cache holds the four current sounds only (the old content's embedding left it)
		const stores = (svc as unknown as { storesOf(e: unknown): { sounds: { size: number } } }).storesOf(
			svc.models!.entry('clap-test'),
		);
		expect(stores.sounds.size).toBe(4);
	});

	it('fails a request whose worker dies and works again on the next one', async () => {
		const svc = sounds(app).semantic;
		const dir = join(appdirPaths(app.appdir).root, 'models', 'sound', 'clap-test');
		await svc.runtime.embedTexts(dir, ['warm up']);
		const pending = svc.runtime.embedTexts(
			dir,
			Array.from({ length: 400 }, (_, i) => `text ${i}`),
		);
		(svc.runtime as unknown as { child: { kill(s: string): void } }).child.kill('SIGKILL');
		await expect(pending).rejects.toMatchObject({ code: 'CLAP_CRASHED' });
		expect((await svc.runtime.embedTexts(dir, ['again'])).length).toBe(1);
		// a broken model directory is a typed error, not a crash
		const bad = tempAppdir('jasper-clap-bad-');
		await expect(svc.runtime.embedTexts(bad, ['x'])).rejects.toBeInstanceOf(ClapError);
		// requests remove their abort listener when they settle (a job's signal carries hundreds of them)
		const shared = new AbortController();
		let listeners = 0;
		const add = shared.signal.addEventListener.bind(shared.signal);
		const remove = shared.signal.removeEventListener.bind(shared.signal);
		shared.signal.addEventListener = ((...a: Parameters<typeof add>) => {
			listeners++;
			add(...a);
		}) as typeof add;
		shared.signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
			listeners--;
			remove(...a);
		}) as typeof remove;
		for (let i = 0; i < 12; i++) await svc.runtime.embedTexts(dir, [`t${i}`], shared.signal);
		expect(listeners).toBe(0);
		// a cancelled request is dropped
		const ac = new AbortController();
		ac.abort();
		await expect(svc.runtime.embedTexts(dir, ['x'], ac.signal)).rejects.toMatchObject({
			code: 'JOB_CANCELLED',
		});
	});
});

describe('removing the model', { timeout: 300_000 }, () => {
	const TOKEN = 'tok_clap_0123456789abcdef';
	const KEY = 'key_clap_0123456789abcdef';
	const AGENT = {
		...H,
		authorization: `Bearer ${TOKEN}`,
		[AGENT_NAME_HEADER]: 'clap-agent',
		'content-type': 'application/json',
	};
	const EDITOR = {
		...H,
		cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}`,
		'content-type': 'application/json',
	};

	async function editorWindow(app: FastifyInstance & { appdir: string }) {
		const doc = createEmptyProject({ ids: createCounterIdSource(5), name: 'Clap', preset: 'hd-1080p-30' });
		const file = appdirPaths(app.appdir).projectFile(doc.projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(
				makeEnvelope(doc, { revision: 1, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' }),
			),
		);
		const ws: WebSocket = await app.injectWS('/agent', { headers: EDITOR });
		const cards: { approvalId: string; answerKey: string; summary: string; label: string }[] = [];
		let wake: (() => void) | null = null;
		ws.on('message', (d) => {
			const m = JSON.parse(String(d)) as { type: string; event?: string; payload?: unknown };
			if (m.type === 'event' && m.event === 'agent.approval.requested') {
				cards.push(m.payload as (typeof cards)[number]);
				wake?.();
			}
		});
		ws.send(
			JSON.stringify({ type: 'hello', projectId: doc.projectId, sessionId: 'ses_1', leaseId: 'lease_1' }),
		);
		await new Promise((r) => setTimeout(r, 100));
		const card = async (n: number) => {
			while (cards.length < n) await new Promise<void>((r) => (wake = r));
			return cards[n - 1]!;
		};
		const answer = (c: (typeof cards)[number], decision: 'approved' | 'denied') =>
			ws.send(
				JSON.stringify({
					type: 'event',
					event: 'agent.approval.resolve',
					payload: { approvalId: c.approvalId, decision, answerKey: c.answerKey },
				}),
			);
		return { card, answer, cards };
	}

	it('agents may install; removal asks the user; afterwards search is keyword search again', async () => {
		const app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		await indexed(app, AGENT);
		await installTiny(app, AGENT);
		// the install embeds the library by itself (it starts once the install job has ended)
		await until(async () => {
			const s = SoundSemanticStatusSchema.parse(
				(await json(app, 'GET', '/api/sounds/semantic', undefined, AGENT)).body,
			);
			return s.job === null && s.embedded === s.total;
		}, 120_000);
		const del = () => json(app, 'DELETE', '/api/sounds/semantic/models/clap-test', undefined, AGENT);
		const refused = await del();
		expect(refused.status).toBe(403);
		expect(refused.body).toMatchObject({ code: 'APPROVAL_DENIED' });
		const editor = await editorWindow(app);
		const pending = del();
		const c = await editor.card(1);
		expect(c.label).toBe('Remove a downloaded model');
		expect(c.summary).toContain('Describe-it search model');
		editor.answer(c, 'approved');
		const ok = await pending;
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(ok.body).toMatchObject({ modelId: 'clap-test' });
		expect(ok.body.freedBytes as number).toBeGreaterThan(0);
		const st = SoundSemanticStatusSchema.parse(
			(await json(app, 'GET', '/api/sounds/semantic', undefined, AGENT)).body,
		);
		expect(st.status).toBe('not-installed');
		const r = await json(app, 'GET', '/api/sounds?describe=glass&license=any', undefined, AGENT);
		expect(SoundSearchResponseSchema.parse(r.body).describe).toMatchObject({ mode: 'keywords' });
		// nothing installed any more: removing again asks nothing
		expect((await del()).status).toBe(200);
		expect(editor.cards).toHaveLength(1);
		expect((await json(app, 'DELETE', '/api/sounds/semantic/models/nope', undefined, AGENT)).status).toBe(
			404,
		);
	});
});
