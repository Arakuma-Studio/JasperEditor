// The plan job's Phase 4 style options (spec 12 §2.4, P4-R3 / P4-R4; wp-note "Phase 4 → WP4.2a"): room glue and a
// delivery preset as setup items every placement requires, a stop-before and a build item per hero with music, each
// requiring its placement; the editor's accept applies all of it in one transaction. The same
// fixture as the plan-levels test (the Phase 2 fixture + music on A1 + dialogue 4–8 s on A2, an indexed kit).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineJob, type SoundDesignPlanResult, SoundDesignPlanResultSchema } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	isSetupItem,
	makeEnvelope,
	mixFingerprint,
	type ProjectDocument,
	type Proposal,
	type SoundDesign,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeasureCache } from '../src/sound-design/bed.ts';
import { mixAnalysis } from '../src/sound-design/delivery.ts';
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
const TOKEN = 'tok_pmix_0123456789abcdef0123';
const KEY = 'key_pmix_0123456789abcdef0123';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'plan-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
const F = 705_600_000 / 30;

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
	process.env.JASPER_SOUND_STARTER_DIR = makeKit(tempAppdir('jasper-pmix-kit-'));
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
	const files = writeBedFixture(mkdtempSync(join(tmpdir(), 'jasper-pmix-bed-')));
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
	projectId = 'prj_0000000000000PMX';
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

/** Real-engine plans render the whole sequence several times: the timeout follows the host's load (a shared host). */
const LONG = 600_000 * Math.max(1, Math.ceil(loadavg()[0]! / Math.max(1, cpus().length) / 2));

describe('sound-design plan: room glue, delivery, stop-before, build (real engine)', {
	timeout: LONG,
}, () => {
	const STYLE = { seed: 11, roomGlue: true, stopBefore: true, build: true, delivery: 'web' } as const;
	const get = async (id: string) =>
		(
			(
				await app.inject({
					method: 'GET',
					url: `/api/projects/${projectId}/proposals/${id}`,
					headers: AGENT_H,
				})
			).json() as { proposal: Proposal }
		).proposal;
	it('the editor accepts every placement: one transaction with the room, the delivery, the dips and the builds', async () => {
		const { result } = await plan({ projectId, sequenceId: seqId, style: STYLE });
		expect(result.report.mix).toMatchObject({ delivery: 'web' });
		expect(result.report.mix!.stopBefore).toBeGreaterThan(0);
		expect(result.report.mix!.build).toBeGreaterThan(0);
		const p = await get(result.proposalId!);
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
		const sd = seq.soundDesign as SoundDesign;
		expect(sd.settings!.delivery).toBe('web');
		expect(seq.master.loudness).toMatchObject({ enabled: true, targetLufs: -14 });
		const room = sd.mix!.room!;
		expect(seq.submixTracks!.find((t) => t.id === room.busId)!.name).toBe('SFX Room');
		expect(room.sends.length).toBeGreaterThan(0);
		const recs = Object.values(sd.mix!.cues ?? {});
		expect(recs.filter((r) => r.stopBefore && r.stopBefore.writes.length > 0).length).toBe(
			result.report.mix!.stopBefore,
		);
		expect(recs.filter((r) => r.build && r.build.writes.length > 0).length).toBe(result.report.mix!.build);
		// the delivery's stored analysis is the accepted mix's (the planned sounds at their gains, the room, the dips),
		// so the preview normalises by the right gain at once: re-measured from scratch on the accepted document
		const core = coreServices(app);
		const deps = { ff: core.ffmpeg, registry: core.registry, cache: new MeasureCache() };
		const stored = seq.master.loudness!.analysis!;
		// and current: the fingerprint has no entity ids, so the preview's (seeded ids) is the accepted mix's (fresh ids)
		expect(stored.mixHash).toBe(mixFingerprint(after.doc, seqId));
		const real = (await mixAnalysis(after.doc, seqId, deps))!;
		expect(
			Math.abs((stored.integratedLufs ?? Number.NaN) - (real.integratedLufs as number)),
		).toBeLessThanOrEqual(0.1);
		expect(
			Math.abs((stored.truePeakDbtp ?? 0) - ((real.truePeakDbtp as number | null) ?? 0)),
		).toBeLessThanOrEqual(0.1);
		// (measured before the plan's sounds, as it was, it read the edit without them)
		const without = (await mixAnalysis(before.doc, seqId, deps))!;
		writeFileSync(
			join(tmpdir(), 'jasper-plan-mix-analysis.json'),
			JSON.stringify({
				stored: stored.integratedLufs,
				real: real.integratedLufs,
				before: without.integratedLufs,
			}),
		);
	});
});
