// Workstream gaps (PRJ-8): Create Proxies and ingest copies / transcodes as engine jobs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaJobResult, RegisteredMedia } from '@jasper/api';
import { proxyMismatch } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, ensureFixtures, fixture, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

let app: TestApp;
const out = mkdtempSync(join(tmpdir(), 'jasper-media-jobs-'));

beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

async function run(payload: Record<string, unknown>): Promise<MediaJobResult> {
	const r = await app.inject({ method: 'POST', url: '/api/media-jobs', headers: JSON_H, payload });
	expect(r.statusCode, r.body).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return done.result as MediaJobResult;
}

const video = (reg: RegisteredMedia) => {
	const v = reg.probe.streams.find((s) => s.type === 'video');
	return v?.type === 'video' ? v : null;
};

describe('media jobs', () => {
	it('creates proxies at a preset size that pass the attach check (rotation kept)', async () => {
		const a = await register(app, fixture('clip-a.mp4'));
		const rot = await register(app, fixture('phone-rot90.mp4'));
		const tone = await register(app, fixture('tone.wav'));
		const res = await run({
			op: 'proxy',
			preset: 'proxy-540',
			destination: { mode: 'folder', folder: out },
			items: [
				{ mediaKey: a.mediaKey, mediaId: 'med_a' },
				{ mediaKey: rot.mediaKey, mediaId: 'med_r' },
				{ mediaKey: tone.mediaKey, mediaId: 'med_t' },
			],
		});
		expect(res.skipped).toEqual([{ mediaId: 'med_t', reason: expect.stringMatching(/no video/) }]);
		expect(res.outputs.map((o) => o.mediaId)).toEqual(['med_a', 'med_r']);
		const pa = res.outputs[0]!.registered as RegisteredMedia;
		expect(res.outputs[0]!.path).toBe(join(out, 'clip-a_Proxy.mp4'));
		expect(video(pa)!.height).toBeLessThanOrEqual(540);
		const pr = res.outputs[1]!.registered as RegisteredMedia;
		expect(pr.probe.rotationDegrees).toBe(rot.probe.rotationDegrees);
		for (const [orig, p] of [
			[a, pa],
			[rot, pr],
		] as const)
			expect(
				proxyMismatch({ kind: 'video', probe: orig.probe, originalName: orig.originalName }, p.probe),
			).toBeNull();
		// A second run numbers the files instead of overwriting.
		const again = await run({
			op: 'proxy',
			preset: 'proxy-540',
			destination: { mode: 'folder', folder: out },
			items: [{ mediaKey: a.mediaKey, mediaId: 'med_a' }],
		});
		expect(again.outputs[0]!.path).toBe(join(out, 'clip-a_Proxy 2.mp4'));
	}, 300_000);

	it('ingest copies verify the fingerprint; transcodes write ProRes', async () => {
		const b = await register(app, fixture('clip-b.mp4'));
		const copy = await run({
			op: 'copy',
			destination: { mode: 'folder', folder: join(out, 'ingest') },
			items: [{ mediaKey: b.mediaKey, mediaId: 'med_b' }],
		});
		expect((copy.outputs[0]!.registered as RegisteredMedia).fingerprint).toBe(b.fingerprint);
		const tc = await run({
			op: 'transcode',
			preset: 'transcode-prores-422',
			destination: { mode: 'folder', folder: join(out, 'ingest') },
			items: [{ mediaKey: b.mediaKey, mediaId: 'med_b' }],
		});
		const reg = tc.outputs[0]!.registered as RegisteredMedia;
		expect(video(reg)!.codec).toBe('prores');
		expect(proxyMismatch({ kind: 'video', probe: b.probe, originalName: 'b' }, reg.probe)).toBeNull();
	}, 300_000);

	it('refuses unknown presets, relative folders and unknown media', async () => {
		const a = await register(app, fixture('clip-a.mp4'));
		const post = (payload: unknown) =>
			app.inject({ method: 'POST', url: '/api/media-jobs', headers: JSON_H, payload: payload as never });
		expect(
			(
				await post({
					op: 'proxy',
					preset: 'nope',
					destination: { mode: 'next-to-media' },
					items: [{ mediaKey: a.mediaKey, mediaId: 'm' }],
				})
			).statusCode,
		).toBe(400);
		expect(
			(
				await post({
					op: 'proxy',
					destination: { mode: 'folder', folder: 'rel' },
					items: [{ mediaKey: a.mediaKey, mediaId: 'm' }],
				})
			).statusCode,
		).toBe(400);
		expect(
			(
				await post({
					op: 'proxy',
					destination: { mode: 'next-to-media' },
					items: [{ mediaKey: 'mk_nope', mediaId: 'm' }],
				})
			).statusCode,
		).toBe(404);
		expect(
			(
				await post({
					op: 'proxy',
					destination: { mode: 'project' },
					items: [{ mediaKey: a.mediaKey, mediaId: 'm' }],
				})
			).statusCode,
		).toBe(400);
	});
});
