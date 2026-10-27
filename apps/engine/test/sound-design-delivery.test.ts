// Delivery presets (spec 12 §2.4 "Delivery presets", P4-R4; wp-note "Phase 4 → WP4.2a") on a real engine with generated
// media: a music bed (A1), dialogue without a transcript from 4 s to 8 s (A2), a hero hit at 1 s and a click under the
// speech. `POST /api/sound-design/delivery` apply = ONE transaction "Apply Delivery Preset": the Mix normalises to the
// preset, dialogue / music are Auto-Matched (music 8 LU under), the music ducks under the speech, the sound effects are
// solved again; the EXPORT (native, 24-bit PCM, measured by ffmpeg's ebur128) meets the integrated target ±1 LU and the
// true-peak ceiling, and the music sits ≥ 8 LU under the voice during speech (measured on the export mixer's stems).
// Propose stores a proposal (agents may not accept it); typed refusals before a job starts.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineJob, type SoundDeliveryResult, SoundDeliveryResultSchema } from '@jasper/api';
import { LoudnessMeter } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import {
	type AudioClip,
	type ClipSfx,
	makeEnvelope,
	mixFingerprint,
	type ProjectDocument,
	type Proposal,
	readEssentialSound,
	type SoundDesign,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../src/agent/service.ts';
import { MeasureCache, renderSequencePcm } from '../src/sound-design/bed.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';
import { provenance, SR, writeBedFixture } from './sound-bed-fixture.ts';

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_deliv_0123456789abcdef012';
const KEY = 'key_deliv_0123456789abcdef012';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'mix-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

type SfxClip = AudioClip & { sfx?: ClipSfx };
let app: TestApp;
let base: { doc: ProjectDocument; ids: Record<string, string>; seqId: string };

async function buildDoc(a: TestApp) {
	const files = writeBedFixture(mkdtempSync(join(tmpdir(), 'jasper-deliv-')));
	const b = new DocBuilder('hd-1080p-30', 600);
	const auth = { authorization: `Bearer ${TOKEN}` };
	const music = b.addMedia(await register(a, files.music, auth));
	const speech = b.addMedia(await register(a, files.speech, auth));
	const hit = b.addMedia(await register(a, files.hit, auth));
	const click = b.addMedia(await register(a, files.click, auth));
	const r = b.tx([
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'dialogue' },
		{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
		{ type: 'media.setLibraryInfo', mediaId: click, library: provenance('click') },
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: hit, role: 'hero', align: 'peak', ref: '$h' }],
		},
		{
			type: 'soundDesign.place',
			frame: 150,
			layers: [{ mediaId: click, role: 'support', align: 'peak', ref: '$k' }],
		},
	]);
	return {
		doc: b.doc,
		seqId: b.seqId,
		ids: { music: r.refs.$m!, speech: r.refs.$s!, hit: r.refs.$h!, click: r.refs.$k! },
	};
}

let projects = 0;
function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(9000 + ++projects).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...doc, projectId },
				{ revision: 3, savedAt: '2026-10-16T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}
async function saved(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/agent/query',
		headers: json(EDITOR_H),
		payload: JSON.stringify({ projectId, query: 'doc.get', args: {} }),
	});
	const b = r.json() as { result: ProjectDocument; revision: number };
	return { doc: b.result, revision: b.revision };
}
async function deliver(body: unknown, headers: Record<string, string> = AGENT_H) {
	return app.inject({
		method: 'POST',
		url: '/api/sound-design/delivery',
		headers: json(headers),
		payload: JSON.stringify(body),
	});
}
async function run(body: unknown, headers: Record<string, string> = AGENT_H) {
	const r = await deliver(body, headers);
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return { job, result: SoundDeliveryResultSchema.parse(job.result) as SoundDeliveryResult };
}

/** ffmpeg's EBU R128 summary of a file: integrated loudness and true peak. */
function ebur128(file: string): { integrated: number; truePeak: number } {
	const r = spawnSync(
		TEST_FFMPEG,
		[
			'-nostats',
			'-hide_banner',
			'-i',
			file,
			'-vn',
			'-filter_complex',
			'ebur128=peak=true',
			'-f',
			'null',
			'-',
		],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
	);
	const text = r.stderr;
	const summary = text.slice(text.lastIndexOf('Summary:'));
	const i = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
	const p = /True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
	if (!i || !p) throw new Error(`ebur128 output not understood: ${summary.slice(0, 500)}`);
	return { integrated: Number(i[1]), truePeak: Number(p[1]) };
}

/** BS.1770 integrated loudness of `clipIds` alone over [a, b) s, rendered by the export mixer. */
async function stemLufs(doc: ProjectDocument, seqId: string, clipIds: string[], a: number, b: number) {
	const core = coreServices(app);
	const out = await renderSequencePcm(
		doc,
		seqId,
		{ start: Math.round(a * 30), end: Math.round(b * 30) },
		new Set(clipIds),
		{ ff: core.ffmpeg, registry: core.registry, cache: new MeasureCache() },
	);
	const m = new LoudnessMeter(out.sampleRate, out.channels.length);
	m.process(out.channels, 0, out.channels[0]!.length);
	m.flush();
	return m.integrated();
}

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	base = await buildDoc(app);
}, 120_000);
afterAll(closeApps);

describe('POST /api/sound-design/delivery (real engine)', { timeout: 600_000 }, () => {
	it('apply (web): one transaction; the export meets −14 LUFS ±1 and −1 dBTP; music ≥ 8 LU under the voice', async () => {
		const projectId = seed(base.doc);
		const { ids, seqId } = base;
		const before = await saved(projectId);
		const { job, result } = await run({ projectId, delivery: 'web', mode: 'apply' }, EDITOR_H);
		expect(job.origin).toEqual({ type: 'user' });
		expect(result.applied).toBe(true);
		const after = await saved(projectId);
		expect(after.revision).toBe(before.revision + 1);
		const rep = result.report;
		const seq = after.doc.sequences[seqId]!;
		expect((seq.soundDesign as SoundDesign).settings!.delivery).toBe('web');
		// loudness normalisation on, with the measured analysis of this very mix (keyframe ids aside)
		const loud = seq.master.loudness!;
		expect(loud).toMatchObject({ enabled: true, targetLufs: -14, truePeakDb: -1 });
		expect(loud.analysis?.mixHash).toBe(mixFingerprint(after.doc, seqId));
		expect(loud.analysis?.integratedLufs).toBeCloseTo(rep.measure!.mixLufs!, 1);
		// Auto-Match: dialogue at −14, music at −22 (8 LU under)
		const byId = new Map(rep.clips.map((c) => [c.clipId, c]));
		expect(byId.get(ids.speech!)).toMatchObject({ type: 'dialogue', targetLufs: -14 });
		expect(byId.get(ids.music!)).toMatchObject({ type: 'music', targetLufs: -22 });
		const ms = readEssentialSound((seq.clips[ids.music!] as AudioClip).essential)!;
		expect(ms.loudness).toMatchObject({ enabled: true, targetLufs: -22 });
		// ducking under the speech (the dialogue is the trigger)
		expect(rep.ducking).toEqual([
			{ clipIds: [ids.music], triggers: [ids.speech], regions: expect.any(Number) },
		]);
		expect(rep.ducking[0]!.regions).toBeGreaterThan(0);
		expect((seq.clips[ids.music!] as AudioClip).volumeDb.keyframes.length).toBeGreaterThan(1);
		// the sound effects solved again against the new bed
		expect(rep.sfx).toMatchObject({ solved: 2 });
		for (const id of [ids.hit!, ids.click!])
			expect((seq.clips[id] as SfxClip).sfx!.level).toMatchObject({ by: 'solver' });
		// the solver's own findings reach the report: the click under the speech is too bright for it (its dominant
		// band is in 1–4 kHz), and every conflict names one of the solved clips
		expect(rep.warnings).toContainEqual(
			expect.objectContaining({ code: 'W_DIALOGUE_BAND', clipId: ids.click }),
		);
		for (const c of rep.conflicts ?? []) expect([ids.hit, ids.click]).toContain(c.clipId);
		// the report's own measurement
		const m = rep.measure!;
		expect(m.expectedLufs).toBe(-14);
		expect(m.expectedTruePeakDb!).toBeLessThanOrEqual(-1);
		expect(m.speechSeconds).toBeGreaterThan(3);
		expect(m.musicUnderVoiceLu!).toBeGreaterThanOrEqual(8);
		// independent check on the export mixer's stems: music vs voice during the speech (4–8 s)
		const voice = await stemLufs(after.doc, seqId, [ids.speech!], 4.2, 7.8);
		const musicL = await stemLufs(after.doc, seqId, [ids.music!], 4.2, 7.8);
		expect(voice - musicL, `voice ${voice.toFixed(1)} music ${musicL.toFixed(1)}`).toBeGreaterThanOrEqual(8);
		// the export: native, 24-bit PCM, normalised by the export's two passes
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: json(EDITOR_H),
			payload: JSON.stringify({
				envelope: makeEnvelope(
					{ ...after.doc },
					{ revision: after.revision, savedAt: '2026-10-16T00:00:00.000Z', platform: 'test' },
				),
				sequenceId: seqId,
				settings: {
					sequenceId: seqId,
					destination: { type: 'download' },
					range: { type: 'entire' },
					container: 'mov',
					video: {
						codec: 'h264',
						width: 320,
						height: 180,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 35 },
						encoderSpeed: 'fast',
					},
					audio: { codec: 'pcm', sampleRate: SR, channels: 2 },
					engine: 'native',
				},
			}),
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		const e = ebur128(file);
		expect(Math.abs(e.integrated - -14), `export ${e.integrated} LUFS`).toBeLessThanOrEqual(1);
		expect(e.truePeak, `export true peak ${e.truePeak} dBTP`).toBeLessThanOrEqual(-1 + 0.1);
		writeFileSync(
			join(tmpdir(), 'jasper-delivery-web.json'),
			JSON.stringify({ export: e, voice, music: musicL, report: rep.measure }),
		);
		// again: the same edit measures the same (a second transaction, nothing new to match)
		const again = await run({ projectId, delivery: 'web', mode: 'apply' }, EDITOR_H);
		expect(again.result.report.measure!.mixLufs).toBeCloseTo(m.mixLufs!, 0);
	});

	it('propose (broadcast-r128): a proposal the agent may not accept; the editor applies it', async () => {
		const projectId = seed(base.doc);
		const before = await saved(projectId);
		const { result } = await run({ projectId, delivery: 'broadcast-r128' });
		expect(result.mode).toBe('propose');
		expect(result.applied).toBe(false);
		expect((await saved(projectId)).revision).toBe(before.revision);
		const p = (
			(
				await app.inject({
					method: 'GET',
					url: `/api/projects/${projectId}/proposals/${result.proposalId}`,
					headers: AGENT_H,
				})
			).json() as { proposal: Proposal }
		).proposal;
		expect(p.items[0]!.id).toBe('delivery');
		expect(p.items.slice(1).every((i) => i.id.startsWith('gain:') && i.requires.includes('delivery'))).toBe(
			true,
		);
		// each gain item says what limited it (as rebalance_sfx's do)
		for (const it of p.items.slice(1)) {
			const meta = it.meta as { limitedBy?: unknown; targetLiftDb?: unknown; why?: unknown };
			expect(Array.isArray(meta.limitedBy)).toBe(true);
			expect(typeof meta.targetLiftDb).toBe('number');
			expect(String(meta.why)).toMatch(/ dB/);
		}
		for (const c of result.report.conflicts ?? [])
			if (p.items.some((i) => (i.meta as { clipId?: string }).clipId === c.clipId))
				expect(c.itemId).toMatch(/^gain:/);
		const denied = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/proposals/${p.id}/accept`,
			headers: json(AGENT_H),
			payload: JSON.stringify({ itemIds: 'all' }),
		});
		expect(denied.statusCode).toBe(403);
		const ok = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/proposals/${p.id}/accept`,
			headers: json(EDITOR_H),
			payload: JSON.stringify({ itemIds: p.items.map((i) => i.id) }),
		});
		expect(ok.statusCode, ok.body).toBe(200);
		const after = await saved(projectId);
		expect(after.revision).toBe(before.revision + 1);
		const seq = after.doc.sequences[base.seqId]!;
		expect(seq.master.loudness).toMatchObject({ enabled: true, targetLufs: -23, truePeakDb: -1 });
		expect((seq.soundDesign as SoundDesign).settings!.delivery).toBe('broadcast-r128');
	});

	it('apply: a hit added after measurement causes retryable CONFLICT; only the user edit survives', async () => {
		// WP6.5b: a sound added to the mix after the job re-read the edit and before its transaction. The transaction
		// touches the Mix, the music, the dialogue and the sound effects it levels, not the new clip, so the fast-forward
		// rule (S01:AGT-010) let it through and the loudness solved for the old mix was applied; `soundDesign.expectMix`
		// in the transaction now refuses it
		const projectId = seed(base.doc);
		const before = await saved(projectId);
		const agent = app.jasper.services.agent as AgentService;
		const transact = agent.transact.bind(agent);
		const race = vi.spyOn(agent, 'transact').mockImplementationOnce(async (...args) => {
			race.mockRestore();
			const r = await app.inject({
				method: 'POST',
				url: '/api/agent/tx',
				headers: json(EDITOR_H),
				payload: JSON.stringify({
					projectId,
					transaction: {
						label: 'Add a hit',
						origin: 'user',
						commands: [
							{
								type: 'clip.place',
								source: {
									mediaId: (before.doc.sequences[base.seqId]!.clips[base.ids.hit] as AudioClip).mediaId,
								},
								at: 450,
								tracks: { audio: 'A3' },
							},
						],
					},
				}),
			});
			expect((r.json() as { result: { ok: boolean } }).result.ok, r.body).toBe(true);
			return transact(...args);
		});
		try {
			const r = await deliver({ projectId, delivery: 'web', mode: 'apply' }, EDITOR_H);
			expect(r.statusCode, r.body).toBe(202);
			const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
			expect(job.state, JSON.stringify(job.result)).toBe('failed');
			expect(job.error).toMatchObject({ code: 'CONFLICT', retryable: true });
		} finally {
			race.mockRestore();
		}
		const after = await saved(projectId);
		expect(after.revision).toBe(before.revision + 1); // the user's edit only
		const seq = after.doc.sequences[base.seqId]!;
		const prior = before.doc.sequences[base.seqId]!;
		expect(seq.master).toEqual(prior.master);
		for (const [id, clip] of Object.entries(prior.clips)) expect(seq.clips[id]).toEqual(clip);
		expect(Object.values(seq.clips).filter((clip) => !prior.clips[clip.id])).toEqual([
			expect.objectContaining({ kind: 'audio', start: 450 }),
		]);
		expect((seq.soundDesign as SoundDesign | undefined)?.settings?.delivery).toBe(
			(before.doc.sequences[base.seqId]!.soundDesign as SoundDesign | undefined)?.settings?.delivery,
		);
	});

	it('typed refusals before a job starts', async () => {
		const projectId = seed(base.doc);
		const cases: [unknown, number, string][] = [
			[{ projectId, delivery: 'cinema' }, 400, 'VALIDATION_FAILED'],
			[{ projectId, delivery: 'web', bogus: 1 }, 400, 'VALIDATION_FAILED'],
			[{ projectId: 'prj_nope00000000000', delivery: 'web' }, 404, 'PROJECT_NOT_FOUND'],
			[{ projectId: '../etc', delivery: 'web' }, 400, 'VALIDATION_FAILED'],
			[{ projectId, sequenceId: 'seq_nope', delivery: 'web' }, 404, 'SEQUENCE_NOT_FOUND'],
		];
		for (const [body, status, code] of cases) {
			const r = await deliver(body);
			expect(r.statusCode, JSON.stringify(body)).toBe(status);
			expect((r.json() as { code: string }).code).toBe(code);
		}
	});
});
