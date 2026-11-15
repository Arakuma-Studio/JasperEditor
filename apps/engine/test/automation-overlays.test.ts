// Overlay passes of editing automation at the engine (spec 15 EA-023…EA-026, EA-033, EA-041): reactions and music beds
// from a folder of the user's files (probed into the engine's media store, imported by the proposal's setup items;
// the dry run stores nothing in the project), folder refusals (relative, missing), overlay slides, stingers measured
// from the dialogue's real momentary loudness with the generated TV static sound from the indexed Jasper Synth, an
// agent's accept as ONE transaction each, Refresh of a reaction after an edit, and the export planner's route for each
// (reactions, slides, stingers: hybrid — native with the layers / spans baked; music: native).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type AutomationPassResult,
	AutomationPassResultSchema,
	type EngineJob,
	type EnvelopeJson,
	mediaRegisterCommand,
	ProposalRefreshResponseSchema,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import {
	type AudioClip,
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type EffectInstance,
	flicksPerFrame,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
} from '@jasper/project';
import { encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planExport } from '../src/export/planner.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, editorCookie, makeApp, TEST_HOST, tempAppdir } from './helpers.ts';
import { asset } from './sound-design-fixture.ts';
import { SR, writeWav } from './sound-fixtures.ts';

const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const HOST = { host: TEST_HOST };
const TOKEN = 'tok_ovl_0123456789abcdef012345';
const KEY = 'key_ovl_0123456789abcdef012345';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'overlay-agent' };
const EDITOR_H = { ...HOST, cookie: editorCookie(TOKEN, KEY) };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

type App = Awaited<ReturnType<typeof makeApp>>;
let app: App;
let projects = 0;

/** A saved project: V1 an A-roll of fake clips of `lengths` frames (two sources), plus extra commands. */
function seed(lengths: number[], extra: (F: number) => unknown[] = () => [], preset = 'hd-1080p-30') {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Overlays', preset });
	doc = { ...doc, projectId: `prj_R${(++projects).toString().padStart(15, '0')}` };
	const seqId = Object.keys(doc.sequences)[0]!;
	const F = flicksPerFrame(doc.sequences[seqId]!.settings.frameRate);
	let at = 0;
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'media.register', asset: asset('video', 3600), ref: '$a' },
				{ type: 'media.register', asset: asset('video', 3600), ref: '$b' },
				...lengths.map((len, i) => {
					const c = {
						type: 'clip.place',
						source: { mediaId: i % 2 ? '$b' : '$a' },
						at,
						tracks: { video: 'V1' },
						video: true,
						audio: false,
						sourceRange: { in: { flicks: at * F }, out: { flicks: (at + len) * F } },
					};
					at += len;
					return c;
				}),
				...extra(F),
			],
		},
		{ ids, now: () => '2026-10-26T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = r.document;
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-26T00:00:00.000Z', platform: 'test' })),
	);
	const clips = Object.values(doc.sequences[seqId]!.clips).sort((x, y) => x.start - y.start);
	return { projectId: doc.projectId, seqId, clips, file };
}

function userEdit(file: string, seqId: string, commands: unknown[]) {
	const env = JSON.parse(readFileSync(file, 'utf8')) as EnvelopeJson;
	const { document: doc } = loadProject(env);
	const r = applyTransaction(
		doc,
		{ label: 'user edit', origin: 'user', sequenceId: seqId, commands },
		{
			ids: createCounterIdSource(900),
			now: () => '2026-10-26T01:00:00.000Z',
			revision: env.revision,
			registries: defaultRegistries(),
		},
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(r.document, {
				revision: env.revision + 1,
				savedAt: '2026-10-26T01:00:00.000Z',
				platform: 'test',
			}),
		),
	);
}

const url = (projectId: string, pass: string) => `/api/projects/${projectId}/automation/${pass}`;
const post = (u: string, body: unknown, headers: Record<string, string> = AGENT_H) =>
	app.inject({ method: 'POST', url: u, headers: json(headers), payload: JSON.stringify(body) });
async function savedDoc(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
	const r = await post('/api/agent/query', { projectId, query: 'doc.get', args: {} }, EDITOR_H);
	const b = r.json() as { result: ProjectDocument; revision: number };
	return { doc: b.result, revision: b.revision };
}
async function dryRun(projectId: string, pass: string, body: Record<string, unknown>) {
	const r = await post(url(projectId, pass), { ...body, mode: 'dryRun' });
	expect(r.statusCode, r.body).toBe(200);
	return AutomationPassResultSchema.parse(r.json()) as AutomationPassResult;
}
async function propose(projectId: string, pass: string, body: unknown) {
	const r = await post(url(projectId, pass), body);
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return { job, result: AutomationPassResultSchema.parse(job.result) as AutomationPassResult };
}
async function getProposal(projectId: string, id: string): Promise<Proposal> {
	const r = await app.inject({
		method: 'GET',
		url: `/api/projects/${projectId}/proposals/${id}`,
		headers: AGENT_H,
	});
	expect(r.statusCode, r.body).toBe(200);
	return (r.json() as { proposal: Proposal }).proposal;
}
async function acceptAll(projectId: string, id: string) {
	const r = await post(`/api/projects/${projectId}/proposals/${id}/accept`, { itemIds: 'all' });
	expect(r.statusCode, r.body).toBe(200);
}

const CAPS = { native: true, remotionLocal: 'ready' as const, fframes: 'ready' as const, mgMasters: true };
async function exportPath(doc: ProjectDocument, seqId: string) {
	const core = coreServices(app);
	const plan = await planExport(
		{
			envelope: makeEnvelope(doc, {
				revision: 1,
				savedAt: '2026-10-26T00:00:00.000Z',
				platform: 'test',
			}) as never,
			sequenceId: seqId,
			settings: {
				sequenceId: seqId,
				range: { type: 'entire' },
				container: 'mp4',
				video: {
					codec: 'h264',
					width: 1920,
					height: 1080,
					frameRate: { num: 30, den: 1 },
					scaling: 'fit',
					quality: { mode: 'crf', value: 23 },
					encoderSpeed: 'fast',
				},
				audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
				engine: 'auto',
			} as never,
		},
		{
			registry: core.registry,
			fonts: core.fonts,
			capabilities: CAPS,
			extensions: core.exports.nativeExtensions.all(),
		},
	);
	return plan.plan;
}

/** A folder of solid-colour PNG reaction pictures (generated: never anyone's files). */
function pictureFolder(names: string[]): string {
	const dir = tempAppdir('jasper-ovl-pics-');
	names.forEach((n, i) => {
		const w = 120 + i * 10;
		const h = 100;
		const data = new Uint8Array(w * h * 4);
		for (let k = 0; k < w * h; k++) data.set([40 * i, 200, 255 - 40 * i, 255], k * 4);
		writeFileSync(join(dir, `${n}.png`), encodePng({ width: w, height: h, data }));
	});
	writeFileSync(join(dir, 'notes.txt'), 'not a picture');
	return dir;
}

describe('editing automation overlay passes (real engine)', { timeout: 600_000 }, () => {
	beforeAll(async () => {
		const kit = tempAppdir('jasper-ovl-kit-');
		writeWav(join(kit, 'whoosh_a.wav'), 'whoosh', 0.5, 1);
		writeFileSync(join(kit, 'manifest.json'), JSON.stringify({ version: 1, packs: [], sounds: [] }));
		process.env.JASPER_SOUND_STARTER_DIR = kit;
		process.env.JASPER_SOUND_SYNTH_VARIANTS = '1';
		process.env.JASPER_SOUND_AUTO_INDEX = '0';
		// These cases plan hybrid effects; dev mode allows the installed renderer without an optional LGPL bundle.
		// Explicit token/editor-key authentication still applies; strict binary refusal is owned by lgpl-binaries.
		app = await makeApp({ dev: true, token: TOKEN, editorKey: KEY });
		const r = await post('/api/sounds/index', {}, EDITOR_H);
		expect(r.statusCode, r.body).toBe(202);
		const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	}, 600_000);
	afterAll(async () => {
		await closeApps();
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	it('reactions from a folder: dry run (nothing stored), proposal, ONE accept, hybrid export; Refresh after an edit', async () => {
		const dir = pictureFolder(['Happy', 'Surprised', 'Thinking']);
		const { projectId, seqId, clips, file } = seed([90, 90, 900], () => [
			{ type: 'marker.add', frame: 95, name: 'reaction' },
			{ type: 'marker.add', frame: 600, name: 'Surprised' },
		]);
		const before = await savedDoc(projectId);
		const params = { assets: { folder: dir }, maxPerMinute: 12, seed: 3 };
		const dry = await dryRun(projectId, 'reactions', { sequenceId: seqId, params });
		expect(dry.summary).toMatchObject({ pass: 'reactions', count: 2, considered: 2 });
		expect(dry.summary.assets).toEqual({ count: 3, names: ['Happy', 'Surprised', 'Thinking'] });
		expect(dry.summary.cost).toMatchObject({ class: 'hybrid', effects: ['jasper.s.shake'] });
		expect(dry.summary.track).toBe('new track Reactions');
		expect((await savedDoc(projectId)).revision).toBe(before.revision);
		const { result } = await propose(projectId, 'reactions', { sequenceId: seqId, params });
		const p = await getProposal(projectId, result.proposalId!);
		expect(p.title).toBe('Reactions');
		const reactions = p.items.filter((it) => (it.meta as { kind?: string }).kind === 'reaction');
		expect(reactions.map((it) => (it.meta as { frame: number }).frame)).toEqual([90, 600]);
		expect(reactions[1]!.meta).toMatchObject({ asset: { name: 'Surprised' } });
		await acceptAll(projectId, p.id);
		const after = await savedDoc(projectId);
		expect(after.revision).toBe(before.revision + 1);
		const seq = after.doc.sequences[seqId]!;
		const stills = Object.values(seq.clips).filter((c) => c.kind === 'still');
		expect(stills.map((c) => [c.start, c.duration])).toEqual([
			[90, 78],
			[600, 78],
		]);
		for (const c of stills)
			expect(((c as { effects: EffectInstance[] }).effects ?? []).map((e) => e.effectId)).toContain(
				'jasper.s.shake',
			);
		const images = Object.values(after.doc.media).filter((m) => m.kind === 'image');
		expect(images.length).toBeGreaterThanOrEqual(2);
		expect(Object.values(after.doc.items).some((it) => it.kind === 'bin' && it.name === 'Reactions')).toBe(
			true,
		);
		const plan = await exportPath(after.doc, seqId);
		expect(plan.path).toBe('hybrid');
		// a second proposal, then the user ripples the first clip: Refresh re-times the reaction on its moved cut
		const again = await propose(projectId, 'reactions', {
			sequenceId: seqId,
			params: { ...params, reactionTrack: 'V3', seed: 4 },
		});
		const p2 = again.result.proposalId!;
		userEdit(file, seqId, [
			{ type: 'clip.trim', clipId: clips[0]!.id, edge: 'out', deltaFrames: -6, mode: 'ripple' },
		]);
		const rr = await post(
			`/api/projects/${projectId}/proposals/${p2}/refresh`,
			{ itemIds: 'stale' },
			EDITOR_H,
		);
		expect(rr.statusCode, rr.body).toBe(200);
		const out = ProposalRefreshResponseSchema.parse(rr.json());
		const first = out.proposal.items.find((it) => (it.meta as { kind?: string }).kind === 'reaction')!;
		expect((first.meta as { frame: number }).frame).toBe(84);
	});

	it('folder refusals: a relative path (400) and a missing folder (404) at once', async () => {
		const { projectId, seqId } = seed([300]);
		const rel = await post(url(projectId, 'reactions'), {
			sequenceId: seqId,
			params: { assets: { folder: 'pics' } },
		});
		expect([rel.statusCode, rel.json().detail?.code]).toEqual([400, 'E_INVALID_PARAM']);
		const missing = await post(url(projectId, 'music'), {
			sequenceId: seqId,
			mode: 'dryRun',
			params: { assets: { folder: '/nonexistent/folder/xyz' } },
		});
		expect([missing.statusCode, missing.json().detail?.code]).toEqual([404, 'E_NOT_FOUND']);
		const bin = await post(url(projectId, 'music'), {
			sequenceId: seqId,
			params: { assets: { bin: 'Nope' } },
		});
		expect(bin.statusCode).toBe(404);
	});

	it('music beds from a folder of songs: −33 dB on a Music track, switching on cuts; native export', async () => {
		const dir = tempAppdir('jasper-ovl-music-');
		writeWav(join(dir, '01 first.wav'), 'tone', 70, 1, 220);
		writeWav(join(dir, '02 second.wav'), 'tone', 70, 2, 330);
		const lengths = Array.from({ length: 30 }, () => 150); // a cut every 5 s, 150 s
		const { projectId, seqId } = seed(lengths);
		const { result } = await propose(projectId, 'music', {
			sequenceId: seqId,
			params: { assets: { folder: dir } },
		});
		expect(result.summary).toMatchObject({ pass: 'music', considered: 2 });
		expect(result.summary.cost.class).toBe('native');
		await acceptAll(projectId, result.proposalId!);
		const { doc } = await savedDoc(projectId);
		const seq = doc.sequences[seqId]!;
		const music = seq.audioTracks.find((t) => t.name === 'Music')!;
		const beds = Object.values(seq.clips)
			.filter((c): c is AudioClip => c.trackId === music.id)
			.sort((a, b) => a.start - b.start);
		// 52 s = 1 560 frames: the first cut at or after it is 1 650; the second song runs from there
		expect(beds.map((c) => [c.start, c.gainDb])).toEqual([
			[0, -33],
			[1650, -33],
			[3300, -33],
		]);
		expect(beds[0]!.duration).toBe(1650);
		expect((await exportPath(doc, seqId)).path).toBe('native');
	});

	it('overlay slides: one-sided Smooth Slides at the overlay’s free edges; hybrid export', async () => {
		const { projectId, seqId } = seed([900], () => [
			{ type: 'media.register', asset: asset('image'), ref: '$img' },
			{
				type: 'clip.place',
				source: { mediaId: '$img' },
				at: 100,
				tracks: { video: 'V2' },
				video: true,
				audio: false,
				sourceRange: { in: { flicks: 0 }, out: { flicks: 300 * (705_600_000 / 30) } },
			},
		]);
		const { result } = await propose(projectId, 'slides', {
			sequenceId: seqId,
			params: { heads: 1, tails: 1 },
		});
		expect(result.summary).toMatchObject({ pass: 'slides', count: 2, considered: 2 });
		await acceptAll(projectId, result.proposalId!);
		const { doc } = await savedDoc(projectId);
		const trs = Object.values(doc.sequences[seqId]!.transitions);
		expect(trs.map((t) => [t.effectId, t.duration, !!t.incomingClipId, !!t.outgoingClipId]).sort()).toEqual([
			['jasper.smooth-slide', 30, false, true],
			['jasper.smooth-slide', 30, true, false],
		]);
		expect((await exportPath(doc, seqId)).path).toBe('hybrid');
	});

	it('stingers: a measured shout + "!" → generated TV static (picture and synth noise at −18 dB); hybrid export', async () => {
		// dialogue: 12 s of quiet tone with a loud burst at 4.0–4.6 s, transcribed with "¡no!" there
		const dir = tempAppdir('jasper-ovl-voice-');
		const n = 12 * SR;
		const ch = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const t = i / SR;
			const loud = t >= 4 && t < 4.6;
			ch[i] = (loud ? 0.7 : 0.05) * Math.sin(2 * Math.PI * 300 * t);
		}
		const wav = join(dir, 'voice.wav');
		writeFileSync(wav, encodeWav([ch, ch], SR, 's16'));
		const reg = await coreServices(app).media.registerPath(wav, {});
		const F = 705_600_000 / 30;
		const { projectId, seqId } = seed([150, 150, 60], () => [
			{ ...mediaRegisterCommand(reg, '$v', '$vi', 'voice') },
			{
				type: 'clip.place',
				source: { mediaId: '$v' },
				at: 0,
				tracks: { audio: 'A1' },
				video: false,
				audio: true,
				sourceRange: { in: { flicks: 0 }, out: { flicks: 360 * F } },
			},
			{
				type: 'transcript.create',
				mediaId: '$v',
				language: 'es',
				origin: 'manual',
				words: [
					{ text: 'hola', start: 30 * F, end: 45 * F },
					{ text: '¡no!', start: 120 * F, end: 137 * F },
				],
			},
		]);
		const dry = await dryRun(projectId, 'stingers', { sequenceId: seqId, params: {} });
		expect(dry.warnings.map((w) => w.code)).toContain('W_NO_LOUDNESS');
		const { result } = await propose(projectId, 'stingers', { sequenceId: seqId, params: {} });
		expect(result.summary).toMatchObject({ pass: 'stingers', count: 1 });
		expect(result.sfx).toMatchObject({ type: 'glitch', placed: 1 });
		const p = await getProposal(projectId, result.proposalId!);
		const item = p.items.find((it) => (it.meta as { kind?: string }).kind === 'stinger')!;
		const frame = (item.meta as { frame: number }).frame;
		// the burst ends at 4.6 s = frame 138; the cut at 150 is within 0.5 s after it
		expect(frame).toBe(150);
		await acceptAll(projectId, p.id);
		const { doc } = await savedDoc(projectId);
		const seq = doc.sequences[seqId]!;
		const top = seq.videoTracks.at(-1)!;
		expect(top.name).toBe('Stingers');
		const solid = Object.values(seq.clips).find((c) => c.trackId === top.id)!;
		expect([solid.kind, solid.start, solid.duration]).toEqual(['solid', 150, 29]);
		const noise = Object.values(seq.clips).find(
			(c): c is AudioClip => c.kind === 'audio' && c.start >= 150 && c.trackId !== seq.audioTracks[0]!.id,
		)!;
		expect(noise.gainDb).toBe(-18);
		expect(noise.start).toBe(150);
		expect(noise.duration).toBe(29);
		const media = doc.media[noise.mediaId]!;
		expect((media as { library?: { source?: { recipe?: string } } }).library?.source?.recipe).toBe(
			'synth.static',
		);
		expect((await exportPath(doc, seqId)).path).toBe('hybrid');
	});
});
