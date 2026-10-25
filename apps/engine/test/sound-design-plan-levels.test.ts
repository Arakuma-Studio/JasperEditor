// The plan job with solved gains (spec 12 §2.4, P4-R2; wp-note "Phase 4 → WP4.1b"): the Phase 2 fixture plus a real
// bed (music on A1, dialogue without a transcript on A2 from 4 s to 8 s) planned on a real engine with an indexed kit.
// Every placed event reaches its target lift or reports what limited it (P4 done-when); each place item and each
// alternative applies its solved gains (`soundDesign.applyGains` on the placement's refs); the why-lines say it;
// deterministic by seed; the editor's accept places every sound at its solved gain in one transaction; timed.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineJob, type SoundDesignPlanResult, SoundDesignPlanResultSchema } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	type AudioClip,
	type ClipSfx,
	isSetupItem,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
	soundCuesOf,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, makeApp, register, tempAppdir } from './helpers.ts';
import { writeBedFixture } from './sound-bed-fixture.ts';
import { fixture } from './sound-design-fixture.ts';
import { PACK, writeWav } from './sound-fixtures.ts';

const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_plvl_0123456789abcdef0123';
const KEY = 'key_plvl_0123456789abcdef0123';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'plan-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
const F = 705_600_000 / 30;

type SfxClip = AudioClip & { sfx?: ClipSfx & { level?: Record<string, unknown> } };
type App = Awaited<ReturnType<typeof makeApp>>;
let app: App;
let projectId: string;
let seqId: string;

function makeKit(dir: string): string {
	const files: [string, 'hit' | 'whoosh' | 'click', number, string, string[]][] = [
		['hit_a.wav', 'hit', 0.5, 'Punch hit', ['hit']],
		['hit_b.wav', 'hit', 0.4, 'Crunch hit', ['hit']],
		['thump_a.wav', 'hit', 0.45, 'Soft thump', ['thump']],
		['boom_a.wav', 'hit', 0.9, 'Low boom', ['boom']],
		['whoosh_a.wav', 'whoosh', 0.7, 'Air whoosh', ['whoosh']],
		['whoosh_b.wav', 'whoosh', 0.9, 'Fast whoosh', ['whoosh']],
		['key_a.wav', 'click', 0.08, 'Key a', ['key']],
		['key_b.wav', 'click', 0.09, 'Key b', ['key']],
	];
	files.forEach(([file, shape, sec], i) => {
		writeWav(join(dir, file), shape, sec, i + 1);
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [PACK],
			sounds: files.map(([file, , , title, types]) => ({
				file,
				title,
				types,
				tags: ['test'],
				author: 'Test Author',
				license: 'CC0-1.0',
				sourceUrl: 'https://example.invalid/sounds',
				packId: PACK.id,
			})),
		}),
	);
	return dir;
}

async function saved(): Promise<{ doc: ProjectDocument; revision: number }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/agent/query',
		headers: json(EDITOR_H),
		payload: JSON.stringify({ projectId, query: 'doc.get', args: {} }),
	});
	const b = r.json() as { result: ProjectDocument; revision: number };
	return { doc: b.result, revision: b.revision };
}

async function plan(body: unknown): Promise<{ job: EngineJob; result: SoundDesignPlanResult; ms: number }> {
	const t0 = Date.now();
	const r = await app.inject({
		method: 'POST',
		url: '/api/sound-design/plan',
		headers: json(AGENT_H),
		payload: JSON.stringify(body),
	});
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return { job, result: SoundDesignPlanResultSchema.parse(job.result), ms: Date.now() - t0 };
}

beforeAll(async () => {
	process.env.JASPER_SOUND_STARTER_DIR = makeKit(tempAppdir('jasper-plvl-kit-'));
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '1';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	const idx = await app.inject({
		method: 'POST',
		url: '/api/sounds/index',
		headers: json(EDITOR_H),
		payload: '{}',
	});
	expect(idx.statusCode, idx.body).toBe(202);
	expect((await coreServices(app).queue.wait((idx.json() as EngineJob).id)).state).toBe('succeeded');
	// The Phase 2 fixture with a bed: music under everything (A1), dialogue from 4 s to 8 s (A2).
	const f = fixture();
	const files = writeBedFixture(mkdtempSync(join(tmpdir(), 'jasper-plvl-bed-')));
	const auth = { authorization: `Bearer ${TOKEN}` };
	const asset = (m: Awaited<ReturnType<typeof register>>) => {
		const { mediaKey: _k, browserPlayable: _b, ...rest } = m;
		return { ...rest, derivation: null };
	};
	const music = await register(app, files.music, auth);
	const speech = await register(app, files.speech, auth);
	f.tx([
		{ type: 'media.register', asset: asset(music), ref: '$mm' },
		{ type: 'media.register', asset: asset(speech), ref: '$sm' },
		{ type: 'clip.place', source: { mediaId: '$mm' }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{
			type: 'clip.place',
			source: { mediaId: '$sm' },
			sourceRange: { in: { flicks: 4 * 30 * F }, out: { flicks: 8 * 30 * F } },
			at: 120,
			tracks: { audio: 'A2' },
			ref: '$s',
		},
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'dialogue' },
	]);
	projectId = 'prj_00000000000000P4';
	seqId = f.seqId;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...f.get(), projectId },
				{ revision: 3, savedAt: '2026-10-16T00:00:00.000Z', platform: 'test' },
			),
		),
	);
}, 600_000);
afterAll(async () => {
	await closeApps();
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe('sound-design plan with solved gains (real engine)', { timeout: 600_000 }, () => {
	it('every event reaches its target lift or reports a limit; items apply their gains; deterministic; timed', async () => {
		const first = await plan({ projectId, sequenceId: seqId, style: { seed: 11 } });
		const rep = first.result.report;
		expect(rep.levels, JSON.stringify(rep.warnings)).toBeDefined();
		expect(rep.events.length).toBeGreaterThan(6);
		for (const e of rep.events) {
			const l = e.level!;
			expect(l, `${e.itemId} has a level`).toBeDefined();
			// P4 done-when
			if (l.achievedLiftDb !== null && l.achievedLiftDb < l.targetLiftDb - 0.05)
				expect(l.limitedBy.length, `${e.itemId}: ${l.reason}`).toBeGreaterThan(0);
			expect(e.why).toContain(l.reason);
			expect(e.alternativeLevels?.length ?? 0).toBe(e.alternatives.length);
		}
		// events under the speech (4–8 s) overlap it and name the dialogue track when it limits them
		const underWords = rep.events.filter((e) => e.level!.speech);
		expect(underWords.length).toBeGreaterThan(0);
		for (const e of underWords)
			if (e.level!.limitedBy.includes('dialogue')) expect(e.level!.reason).toMatch(/dialogue A2/);
		// the stored proposal: each place item (and each alternative) ends with applyGains on its own refs
		const p = (
			(
				await app.inject({
					method: 'GET',
					url: `/api/projects/${projectId}/proposals/${first.result.proposalId}`,
					headers: AGENT_H,
				})
			).json() as { proposal: Proposal }
		).proposal;
		expect(p.items.every((i) => i.state === 'pending')).toBe(true);
		const places = p.items.filter((i) => !isSetupItem(i));
		// the report never names preview clips (they do not exist in the project): items, layer refs, alternatives
		const docNow = await saved();
		const clipIds = new Set(Object.keys(docNow.doc.sequences[seqId]!.clips));
		const named = JSON.stringify([rep.warnings, rep.conflicts ?? []]);
		for (const id of named.match(/clp_[0-9A-Z]{16}/g) ?? []) expect(clipIds.has(id), id).toBe(true);
		for (const c of rep.conflicts ?? []) {
			expect(c.clipId).toMatch(/^\$sfx_\d+_\d+$/);
			expect(c.itemId).toMatch(/^sfx:/);
		}
		// extra layers carry their own levels in the item's meta
		for (const it of places) {
			const layers = (
				it.commands.find((c) => (c as { type: string }).type === 'soundDesign.place') as {
					layers: unknown[];
				}
			).layers.length;
			const meta = it.meta as { layerLevels?: unknown[] };
			if (layers > 1) expect(meta.layerLevels?.length).toBe(layers - 1);
			else expect(meta.layerLevels).toBeUndefined();
		}
		// deterministic: the same seed gives the same gains, warnings and conflicts — and, the measurements being keyed
		// by content (not by the previews' ids), nothing is rendered again
		const again = await plan({ projectId, sequenceId: seqId, style: { seed: 11 } });
		expect(
			again.result.report.events.map((e) => [e.sound.soundId, e.level!.gainDb, e.alternativeLevels]),
		).toEqual(rep.events.map((e) => [e.sound.soundId, e.level!.gainDb, e.alternativeLevels]));
		expect(again.result.report.warnings).toEqual(rep.warnings);
		expect(again.result.report.conflicts ?? []).toEqual(rep.conflicts ?? []);
		expect(again.result.report.levels!.renders).toMatchObject({ bed: 0, sound: 0, voice: 0 });
		// performance (spec: < 15 s at moderate load; generous when the shared host is overloaded)
		const load = loadavg()[0]! / Math.max(1, cpus().length);
		expect(first.ms).toBeLessThan(load > 1 ? 45_000 : 15_000);
		writeFileSync(
			join(tmpdir(), 'jasper-plan-levels-timing.json'),
			JSON.stringify({ firstMs: first.ms, againMs: again.ms, load: loadavg(), levels: rep.levels }),
		);
	});

	it('the editor accepts every place item: one transaction, every sound at its solved gain (sfx.level by solver)', async () => {
		const { result } = await plan({ projectId, sequenceId: seqId, style: { seed: 11 } });
		const p = (
			(
				await app.inject({
					method: 'GET',
					url: `/api/projects/${projectId}/proposals/${result.proposalId}`,
					headers: AGENT_H,
				})
			).json() as { proposal: Proposal }
		).proposal;
		// pick the second alternative on one item: its own solved gain applies
		const withAlt = p.items.find((i) => !isSetupItem(i) && (i.alternatives?.length ?? 0) >= 2)!;
		const sel = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/proposals/${p.id}/select`,
			headers: json(EDITOR_H),
			payload: JSON.stringify({ itemId: withAlt.id, alternative: 2 }),
		});
		expect(sel.statusCode, sel.body).toBe(200);
		const before = await saved();
		const ok = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/proposals/${p.id}/accept`,
			headers: json(EDITOR_H),
			payload: JSON.stringify({ itemIds: p.items.filter((i) => !isSetupItem(i)).map((i) => i.id) }),
		});
		expect(ok.statusCode, ok.body).toBe(200);
		const after = await saved();
		expect(after.revision).toBe(before.revision + 1);
		const seq = after.doc.sequences[seqId]!;
		const cues = soundCuesOf(seq);
		for (const e of result.report.events) {
			const cue = cues.find((c) => c.frame === e.frame && c.kind === e.kind)!;
			const clip = seq.clips[cue.placedClipIds![0]!] as SfxClip;
			const want = e.itemId === withAlt.id ? e.alternativeLevels![1]! : e.level!;
			expect(clip.gainDb, e.itemId).toBe(want.gainDb);
			expect(clip.sfx!.level).toMatchObject({ by: 'solver', gainDb: want.gainDb, limitedBy: want.limitedBy });
			if (e.itemId === withAlt.id) expect(clip.sfx!.soundId).toBe(e.alternatives[1]!.soundId);
		}
		// a rebalance right after the accept measures the accepted sounds from the plan's caches (fresh ids, same
		// content): only the alternative picked may need a render (its preview slot had the other items' alternatives
		// selected too, which can put it on another track); the bed is rendered again only where its clusters differ
		const rb = await app.inject({
			method: 'POST',
			url: '/api/sound-design/rebalance',
			headers: json(EDITOR_H),
			payload: JSON.stringify({ projectId, sequenceId: seqId }),
		});
		expect(rb.statusCode, rb.body).toBe(202);
		const rbJob = await coreServices(app).queue.wait((rb.json() as EngineJob).id);
		expect(rbJob.state, JSON.stringify(rbJob.error)).toBe('succeeded');
		const renders = (rbJob.result as { report: { levels: { renders: Record<string, number> } } }).report
			.levels.renders;
		expect(renders.sound, JSON.stringify(renders)).toBeLessThanOrEqual(1);
		expect(renders.cached, JSON.stringify(renders)).toBeGreaterThanOrEqual(result.report.events.length - 1);
	});
});
