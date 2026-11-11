// HTML compositions (docs/wp-notes/html-compositions.md): a page with window.__duration / __ready / __seek(t) imported
// as an mg-bundle, served to the live host, and rendered by seeking it (masters, stills, exports, watch).
// The end-to-end part needs Chrome and FFmpeg: MG_E2E=1.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, RegisteredMedia } from '@jasper/api';
import { EMPTY_PROBE, type MgBundleInfo, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MgBundleService } from '../src/mg-bundles/service.ts';
import { mgBundleService } from '../src/routes/mg-bundles.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, H, JSON_H, makeApp, ROOT } from './helpers.ts';

const FIXTURE = join(ROOT, 'fixtures', 'html-composition');
const E2E = process.env.MG_E2E === '1';

afterAll(closeApps);

describe('HTML composition pages: import requests and the live host page', () => {
	it('refuses relative paths and folders before loading anything', async () => {
		const app = await makeApp();
		const post = (path: string) =>
			app.inject({
				method: 'POST',
				url: '/api/mg-bundles/import-html',
				headers: JSON_H,
				payload: { path, width: 640, height: 360, fps: 30 },
			});
		expect((await post('page.html')).json()).toMatchObject({ code: 'BAD_REQUEST' });
		const folder = await post(FIXTURE);
		expect(folder.statusCode).toBe(400);
		expect(folder.json()).toMatchObject({ code: 'HTML_NOT_A_PAGE', detail: { hint: /page file/ } });
	});

	it('serves the page with its query, the HTML host agent and the CDN-script policy of the renders', async () => {
		const app = await makeApp();
		const dir = mkdtempSync(join(tmpdir(), 'jasper-html-serve-'));
		cpSync(FIXTURE, dir, { recursive: true });
		const info: MgBundleInfo = {
			remotionVersion: '4.0.499',
			bundleHash: 'c'.repeat(64),
			builtAt: '2026-11-11T00:00:00.000Z',
			source: { type: 'html-page', path: join(FIXTURE, 'page.html'), name: 'page.html?color=red' },
			compositions: [],
			html: { entry: 'page.html', query: 'color=red' },
		};
		const key = `mk_${'c'.repeat(24)}`;
		await coreServices(app).registry.put({
			mediaKey: key,
			fingerprint: `q1:${info.bundleHash}`,
			originalName: info.source.name,
			sizeBytes: 1,
			mtimeMs: 0,
			container: 'html-page',
			kind: 'mg-bundle',
			probe: EMPTY_PROBE,
			browserPlayable: 'no',
			storage: { type: 'managed', path: join(dir, 'page.html') },
			durationSec: null,
			display: null,
			hasAudio: false,
			registeredAt: '2026-11-11T00:00:00.000Z',
			mgBundle: info,
		});
		const redirect = await app.inject({
			method: 'GET',
			url: `/mg/bundles/${key}/page.html?color=red&jasper-host=1`,
			headers: H,
		});
		expect(redirect.statusCode).toBe(302);
		const location = String(redirect.headers.location);
		expect(location).toMatch(new RegExp(`^/mg/sandbox/[^/]+/${key}/page\\.html\\?color=red&jasper-host=1$`));
		const page = await app.inject({ method: 'GET', url: location, headers: H });
		expect(page.statusCode).toBe(200);
		expect(page.body).toContain('__jasperHtmlHost');
		expect(page.body).not.toContain('remotion_puppeteerTimeout');
		const csp = String(page.headers['content-security-policy']);
		expect(csp).toMatch(/^sandbox allow-scripts/);
		expect(csp).toMatch(/script-src [^;]* https:/);
		rmSync(dir, { recursive: true, force: true });
	});
});

/** Raw frame `frame` of a video (or a PNG) as RGBA. */
function rgba(file: string, frame = 0): Buffer {
	const ff = process.env.JASPER_FFMPEG || 'ffmpeg';
	const r = spawnSync(
		ff,
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			`select=eq(n\\,${frame})`,
			'-frames:v',
			'1',
			'-pix_fmt',
			'rgba',
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(`ffmpeg decode failed: ${r.stderr}`);
	return r.stdout;
}

/**
 * The fixture's box (80×80, left edge at round(t / 2 × (W − 80)), vertically centred) over `bg` at time t: share of
 * pixels within 3/255 of it.
 */
function boxShare(
	img: Buffer,
	o: { width: number; height: number; t: number; box: number[]; bg: number[] | null },
): number {
	const x0 = Math.round(Math.min(1, o.t / 2) * (o.width - 80));
	const y0 = Math.round(o.height / 2 - 40);
	let ok = 0;
	for (let y = 0; y < o.height; y++)
		for (let x = 0; x < o.width; x++) {
			const inBox = x >= x0 && x < x0 + 80 && y >= y0 && y < y0 + 80;
			const want = inBox ? [...o.box, 255] : o.bg ? [...o.bg, 255] : [0, 0, 0, 0];
			const i = (y * o.width + x) * 4;
			// Transparent pixels only need alpha 0.
			const channels = !inBox && !o.bg ? [3] : [0, 1, 2, 3];
			if (channels.every((c) => Math.abs(img[i + c]! - want[c]!) <= 3)) ok++;
		}
	return ok / (o.width * o.height);
}

/** The box's left edge over the grey background: first column of the middle row whose red is below the midpoint. */
function boxLeft(img: Buffer, width: number, height: number): number {
	const y = Math.round(height / 2);
	for (let x = 0; x < width; x++) if (img[(y * width + x) * 4]! < (128 + 0x22) / 2) return x;
	return -1;
}

describe.runIf(E2E)('HTML compositions end to end (MG_E2E=1)', () => {
	let app: Awaited<ReturnType<typeof makeApp>>;
	let svc: MgBundleService;
	let page: RegisteredMedia;
	let work: string;
	const job = (id: string): Promise<EngineJob> => coreServices(app).queue.wait(id);
	const importHtml = (payload: Record<string, unknown>) =>
		app.inject({ method: 'POST', url: '/api/mg-bundles/import-html', headers: JSON_H, payload });

	beforeAll(async () => {
		app = await makeApp({ totalSlots: 8 });
		svc = mgBundleService(app)!;
		work = mkdtempSync(join(tmpdir(), 'jasper-html-'));
		cpSync(FIXTURE, work, { recursive: true });
		// Files the page does not load stay out of the bundle.
		writeFileSync(join(work, 'notes.txt'), 'not loaded');
		const r = await importHtml({
			path: join(work, 'page.html'),
			width: 1920,
			height: 1080,
			fps: 30,
			query: 'color=%2322aa66',
		});
		expect(r.statusCode, r.body).toBe(200);
		page = r.json();
	}, 300_000);

	afterAll(() => rmSync(work, { recursive: true, force: true }));

	it('imports the page as one composition of __duration × fps frames with the files it loaded', () => {
		expect(page.kind).toBe('mg-bundle');
		expect(page.mgBundle).toMatchObject({
			source: { type: 'html-page', path: join(work, 'page.html'), name: 'page.html?color=%2322aa66' },
			html: { entry: 'page.html', query: 'color=%2322aa66' },
			compositions: [
				{ id: 'page', width: 1920, height: 1080, fps: 30, durationInFrames: 60, defaultProps: {} },
			],
		});
		const dir = svc.bundleDir(page.mediaKey)!;
		const files = spawnSync('find', ['.', '-type', 'f'], { cwd: dir, encoding: 'utf8' })
			.stdout.split('\n')
			.sort();
		expect(files.filter(Boolean)).toEqual(['./lib/motion.js', './page.css', './page.html']);
	});

	it('names what a page lacks: HTML_CONTRACT_MISSING with the missing globals, the page error and a fix', async () => {
		const bad = join(work, 'bad');
		mkdirSync(bad);
		writeFileSync(
			join(bad, 'noseek.html'),
			'<!doctype html><html><body><script>window.__duration = 3;\nwindow.__ready = Promise.resolve();\nstartTimeline();</script></body></html>',
		);
		const r = await importHtml({ path: join(bad, 'noseek.html'), width: 320, height: 240, fps: 30 });
		expect(r.statusCode).toBe(422);
		expect(r.json()).toMatchObject({
			code: 'HTML_CONTRACT_MISSING',
			message: /window\.__seek is missing.*startTimeline is not defined \(noseek\.html:3\)/,
			detail: { missing: ['__seek'], hint: /window\.__seek = \(t\)/ },
		});
	}, 120_000);

	it('renders frame-exact masters with straight alpha; stills and native exports show the same frames', async () => {
		const d = new DocBuilder('hd-1080p-30');
		const mediaId = d.addMedia(page);
		d.tx([
			{
				type: 'sequence.updateSettings',
				sequenceId: d.seqId,
				settings: { backgroundColor: [0.5, 0.5, 0.5, 1] },
			},
		]);
		d.tx([{ type: 'clip.addComposition', composition: { mediaId, id: 'page' }, at: 15, track: 'V1' }]);
		const green = [0x22, 0xaa, 0x66];
		const grey = [128, 128, 128];
		// render_frame's path: a still at sequence frame 45 = composition frame 30 = t 1 s.
		const still = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 45 },
		});
		expect(still.statusCode, still.body).toBe(202);
		const sdone = await job(still.json().id);
		expect(sdone.state, JSON.stringify(sdone.error)).toBe('succeeded');
		const png = await app.inject({ method: 'GET', url: `/renders/${still.json().id}/output`, headers: H });
		const stillFile = join(work, 'still.png');
		writeFileSync(stillFile, png.rawPayload);
		expect(
			boxShare(rgba(stillFile), { width: 1920, height: 1080, t: 1, box: green, bg: grey }),
		).toBeGreaterThan(0.999);

		const settings = {
			sequenceId: d.seqId,
			range: { type: 'custom', startFrame: 14, endFrame: 46 },
			container: 'mov',
			engine: 'native',
			video: {
				codec: 'prores',
				proresProfile: 'hq',
				width: 1920,
				height: 1080,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 10 },
				encoderSpeed: 'fast',
			},
		};
		const plan = (
			await app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
			})
		).json();
		expect(plan.path).toBe('native');
		const started = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		const done = await job(started.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const out = join(coreServices(app).config.paths.rendersDir, done.id, 'output.mov');
		// Export frame 0 = sequence frame 14: before the clip. Frame 31 = sequence 45 = t 1 s, like the still.
		expect(boxShare(rgba(out, 0), { width: 1920, height: 1080, t: -1, box: grey, bg: grey })).toBeGreaterThan(
			0.999,
		);
		expect(
			boxShare(rgba(out, 31), { width: 1920, height: 1080, t: 1, box: green, bg: grey }),
		).toBeGreaterThan(0.99);
		// Frame-exact: each frame's box edge is where its time puts it (one frame off would move it by 31 px; ±1 px
		// is the 4:2:2 chroma of the ProRes HQ export).
		for (const f of [16, 23, 30, 31]) {
			const t = (f + 14 - 15) / 30;
			expect(Math.abs(boxLeft(rgba(out, f), 1920, 1080) - Math.round((t / 2) * 1840))).toBeLessThanOrEqual(1);
		}
		// The master: straight alpha, transparent where the page paints nothing.
		const prerender = coreServices(app)
			.queue.list({})
			.find((j) => j.kind === 'mg-prerender' && j.parentId === done.id && j.state === 'succeeded');
		const master = svc.masterPath((prerender!.result as { renderKey: string }).renderKey)!;
		expect(
			boxShare(rgba(master, 30), { width: 1920, height: 1080, t: 1, box: green, bg: null }),
		).toBeGreaterThan(0.999);
	}, 600_000);

	it('watch: saving a file the page loads re-imports it and relinks a project no editor has open', async () => {
		const created = await app.inject({
			method: 'POST',
			url: '/api/projects',
			headers: H,
			payload: { name: 'HTML watch', preset: 'hd-1080p-30' },
		});
		const projectId = created.json().projectId as string;
		const watched = await importHtml({
			path: join(work, 'page.html'),
			width: 1920,
			height: 1080,
			fps: 30,
			query: 'color=red',
			watch: true,
			projectId,
		});
		expect(watched.statusCode, watched.body).toBe(200);
		const first = watched.json() as RegisteredMedia;
		const { mediaKey: _k, browserPlayable: _b, ...asset } = first;
		const reg = await app.inject({
			method: 'POST',
			url: '/api/agent/tx',
			headers: H,
			payload: {
				projectId,
				transaction: {
					label: 'Import',
					origin: { agent: 'test' },
					commands: [{ type: 'media.register', asset: { ...asset, derivation: null } }],
				},
			},
		});
		expect(reg.json().result.ok, reg.body).toBe(true);
		const rebuilt = new Promise<{ oldKey: string; newKey: string; mgBundle: MgBundleInfo }>((resolve) => {
			const off = coreServices(app).broadcaster.subscribe((event) => {
				if (event.type !== 'mgBundle.rebuilt') return;
				off();
				resolve(event.payload as never);
			}, {});
		});
		const motion = join(work, 'lib', 'motion.js');
		writeFileSync(
			motion,
			readFileSync(motion, 'utf8').replace('window.__duration = 2;', 'window.__duration = 3;'),
		);
		const ev = await rebuilt;
		expect(ev.oldKey).toBe(first.mediaKey);
		expect(ev.newKey).not.toBe(first.mediaKey);
		expect(ev.mgBundle.compositions[0]!.durationInFrames).toBe(90);
		// The relink is part of the reload job, after the event.
		const reload = coreServices(app)
			.queue.list({})
			.find((j) => j.kind === 'mg-bundle' && j.title.startsWith('Reload HTML composition'))!;
		expect((await job(reload.id)).state).toBe('succeeded');
		const q = await app.inject({
			method: 'POST',
			url: '/api/agent/query',
			headers: H,
			payload: { projectId, query: 'doc.get' },
		});
		const doc = q.json().result as ProjectDocument;
		const keys = Object.values(doc.media).flatMap((m) =>
			m.locators.flatMap((l) => (l.type === 'engine-store' ? [l.key] : [])),
		);
		expect(keys).toContain(ev.newKey);
	}, 600_000);
});
