// Decorate Cuts' inputs at the engine (spec 15 EA-020; wp-note "Decorate Cuts inputs"): whooshes cut from a project
// media — the hits found in it (`auto`) or the given slices, each slice's peak measured on the decoded file — placed
// through sound design with the peak on the cut and trimmed to the kit; an explicit cut list and a kit selection; a
// frame that is not a cut refused at once (E_NOT_A_CUT).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AutomationPassResult, AutomationPassResultSchema, type EngineJob } from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import {
	type AudioClip,
	type ClipSfx,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';

const HAVE_FFMPEG = spawnSync(TEST_FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;
const SR = 48_000;

let app: TestApp;
let dir = '';

/** Tone swells (a rising, then falling 600 Hz burst) peaking at the given seconds, `width` seconds long each. */
function swells(seconds: number, at: [number, number][]): Float32Array {
	const x = new Float32Array(Math.round(seconds * SR));
	for (const [peak, width] of at) {
		const a = Math.round((peak - width / 2) * SR);
		const p = Math.round(peak * SR);
		const b = Math.round((peak + width / 2) * SR);
		for (let i = a; i < b; i++) {
			const env = i <= p ? (i - a) / (p - a) : (b - i) / (b - p);
			x[i] = 0.8 * env * env * Math.sin((2 * Math.PI * 600 * i) / SR);
		}
	}
	return x;
}

function seed(doc: ProjectDocument, n: number): string {
	const projectId = `prj_${(9300 + n).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...doc, projectId },
				{ revision: 1, savedAt: '2026-11-16T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}

const post = (url: string, body: unknown) =>
	app.inject({ method: 'POST', url, headers: JSON_H, payload: JSON.stringify(body) });
const pass = (projectId: string, body: unknown) =>
	post(`/api/projects/${projectId}/automation/decorate-cuts`, body);

/** Three solids end to end on V1 (two picture cuts: 120 and 240) and the whoosh recording. */
async function project(n: number) {
	const file = join(dir, `whooshes-${n}.wav`);
	const x = swells(6, [
		[1, 0.6],
		[3, 0.9],
		[5, 0.5],
	]);
	writeFileSync(file, encodeWav([x, x.slice()], SR, 's16'));
	const b = new DocBuilder('hd-1080p-30', 40 + n);
	const media = b.addMedia(await register(app, file));
	b.tx([
		{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [1, 0, 0, 1] },
		{ type: 'clip.addSolid', at: 120, duration: 120, track: 'V1', color: [0, 1, 0, 1] },
		{ type: 'clip.addSolid', at: 240, duration: 120, track: 'V1', color: [0, 0, 1, 1] },
	]);
	return { projectId: seed(b.doc, n), seqId: b.seqId, media };
}

describe.skipIf(!HAVE_FFMPEG)('Decorate Cuts with whooshes cut from a project media', () => {
	beforeAll(async () => {
		app = await makeApp();
		dir = mkdtempSync(join(tmpdir(), 'jasper-whoosh-'));
	}, 120_000);
	afterAll(closeApps);

	it('auto finds the hits of the media (dry run); given slices are placed peak on the cut, trimmed to the kit', {
		timeout: 300_000,
	}, async () => {
		const { projectId, seqId, media } = await project(1);
		const dry = await pass(projectId, {
			sequenceId: seqId,
			mode: 'dryRun',
			params: { sfx: { media: { mediaId: media } } },
		});
		expect(dry.statusCode, dry.body).toBe(200);
		const d = AutomationPassResultSchema.parse(dry.json());
		expect(d.sfx).toMatchObject({ enabled: true, available: 3, placed: 2, unsounded: 0 });

		const r = await pass(projectId, {
			sequenceId: seqId,
			params: {
				cuts: [240],
				kits: ['spin'],
				sfx: { media: { mediaId: media, slices: [{ from: 2.3, to: 3.7 }] } },
			},
		});
		expect(r.statusCode, r.body).toBe(202);
		const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const result = AutomationPassResultSchema.parse(job.result) as AutomationPassResult;
		expect(result.summary.count).toBe(1);
		expect(result.sfx).toMatchObject({ available: 1, placed: 1 });
		const got = await app.inject({
			method: 'GET',
			url: `/api/projects/${projectId}/proposals/${result.proposalId}`,
			headers: JSON_H,
		});
		const p = (got.json() as { proposal: Proposal }).proposal;
		const kit = p.items.find((it) => it.id === 'kit:240')!;
		expect((kit.meta as { family: string }).family).toBe('spin');
		const place = (kit.commands as { type: string; layers?: { slice?: { peakSec: number } }[] }[]).find(
			(c) => c.type === 'soundDesign.place',
		)!;
		// the slice's peak measured on the file: the swell's top at 3 s
		expect(Math.abs(place.layers![0]!.slice!.peakSec - 3)).toBeLessThan(0.005);

		const acc = await post(`/api/projects/${projectId}/proposals/${p.id}/accept`, { itemIds: 'all' });
		expect(acc.statusCode, acc.body).toBe(200);
		const q = await post('/api/agent/query', { projectId, query: 'doc.get', args: {} });
		const doc = (q.json() as { result: ProjectDocument }).result;
		const seq = doc.sequences[seqId]!;
		const F = flicksPerFrame(seq.settings.frameRate);
		const whoosh = Object.values(seq.clips).find(
			(c): c is AudioClip & { sfx: ClipSfx } => c.kind === 'audio' && c.mediaId === media,
		)!;
		const m = kit.meta as { frame: number; range: { start: number; end: number } };
		expect([whoosh.start, whoosh.start + whoosh.duration]).toEqual([m.range.start, m.range.end]);
		expect(whoosh.sourceIn).toBeGreaterThanOrEqual(2.3 * FLICKS_PER_SECOND);
		const peak = whoosh.start * F + (whoosh.sfx.placement.peakFlicks - whoosh.sourceIn);
		expect(Math.abs(peak - m.frame * F)).toBeLessThanOrEqual(F);
	});

	it('refuses a frame that is not a cut, and an unknown media, at once', { timeout: 120_000 }, async () => {
		const { projectId, seqId } = await project(2);
		const bad = await pass(projectId, { sequenceId: seqId, params: { cuts: [120, 200] } });
		expect(bad.statusCode).toBe(400);
		expect(bad.json()).toMatchObject({ detail: { code: 'E_NOT_A_CUT' } });
		expect(bad.json().message).toContain('200 (nearest cut 240');
		const media = await pass(projectId, {
			sequenceId: seqId,
			params: { sfx: { media: { mediaId: 'med_nope' } } },
		});
		expect(media.statusCode).toBe(404);
	});
});
