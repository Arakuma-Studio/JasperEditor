// Workstream gaps (PRJ-8): Create Proxies and ingest copies / transcodes as engine jobs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaJobResult, RegisteredMedia } from '@jasper/api';
import { attachedProxyFrom, proxyMismatch } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

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
		// The engine now reads the media from the ingested copy.
		const loc = await app.inject({
			method: 'GET',
			url: `/api/media/${b.mediaKey}/location`,
			headers: JSON_H,
		});
		expect(loc.json().path).toBe(copy.outputs[0]!.path);
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

describe('exports and proxies', () => {
	const settings = (seqId: string, draft: boolean) => ({
		sequenceId: seqId,
		range: { type: 'custom', startFrame: 0, endFrame: 10 },
		container: 'mp4',
		video: {
			codec: 'h264',
			width: 640,
			height: 360,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 18 },
			encoderSpeed: 'fast',
			colorTags: 'rec709',
		},
		audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
		engine: 'native',
		...(draft ? { draftUseProxies: true } : {}),
	});

	async function exportOf(d: DocBuilder, draft: boolean) {
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, draft) },
		});
		expect(r.statusCode, r.body).toBe(200);
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, draft) },
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		return { plan: r.json(), file: (await coreServices(app).exports.outputFile(start.json().id))! };
	}

	const mean = (file: string) => {
		const raw = spawnSync(
			'ffmpeg',
			[
				'-v',
				'error',
				'-i',
				file,
				'-vf',
				'select=eq(n\\,5),scale=64:36',
				'-frames:v',
				'1',
				'-f',
				'rawvideo',
				'-pix_fmt',
				'gray',
				'-',
			],
			{
				maxBuffer: 1 << 24,
			},
		).stdout;
		return [...raw];
	};

	it('exports never use proxies unless asked; Use Proxies renders the proxy at the original size', async () => {
		const a = await register(app, fixture('clip-a.mp4'));
		const d = new DocBuilder();
		const m = d.addMedia(a);
		d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const res = await run({
			op: 'proxy',
			preset: 'proxy-540',
			destination: { mode: 'folder', folder: join(out, 'draft') },
			items: [{ mediaKey: a.mediaKey, mediaId: m }],
		});
		const reg = res.outputs[0]!.registered as RegisteredMedia;
		d.tx([{ type: 'media.attachProxy', mediaId: m, proxy: attachedProxyFrom(reg, 'created', 'proxy-540') }]);
		const full = await exportOf(d, false);
		expect(full.plan.warnings.some((w: { code: string }) => w.code === 'DRAFT_PROXIES')).toBe(false);
		const draft = await exportOf(d, true);
		expect(draft.plan.warnings.some((w: { code: string }) => w.code === 'DRAFT_PROXIES')).toBe(true);
		// Same framing (the proxy is scaled to the original's box): the pictures agree within proxy softness.
		if (process.env.GAPS_DUMP) console.log('[draft]', full.file, draft.file);
		const fa = mean(full.file);
		const fb = mean(draft.file);
		expect(fa.length).toBe(64 * 36);
		const diff = fa.reduce((s, v, i) => s + Math.abs(v - fb[i]!), 0) / fa.length;
		expect(diff).toBeLessThan(6);
	}, 300_000);
});
