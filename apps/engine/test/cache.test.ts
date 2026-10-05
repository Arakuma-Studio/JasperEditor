// Media cache registry and GC (M3, S04 §7.5 CA-010…CA-019, wp-m3-cachegc): layout and scan, usage per kind,
// reference-aware cleaning (saved / open projects, pins of running jobs, the grace window), age limits and LRU
// budgets, orphan sweep and crash-safe removal, refs that survive a restart, the HTTP routes.

import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { CacheGcReport, CacheUsage } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { mgRegistry } from '@jasper/mg-templates';
import {
	applyTransaction,
	buildRenderSnapshot,
	CORNER_PIN_EFFECT_ID,
	defaultRegistries,
	EMPTY_PROBE,
	LUMETRI_EFFECT_ID,
	makeEnvelope,
} from '@jasper/project';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { logsUsage, maintainLogs, USAGE_LOG } from '../src/cache/logs.ts';
import type { CacheService } from '../src/cache/service.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import type { MgService } from '../src/mg/index.ts';
import { prerenderKey } from '../src/mg-bundles/service.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
	tempAppdir,
} from './helpers.ts';

const DAY = 24 * 3600 * 1000;
const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);

/** Writes a file (and its parents) and sets its times `ageMs` in the past. */
function put(path: string, bytes = 1000, ageMs = 30 * DAY): string {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, Buffer.alloc(bytes, 1));
	age(path, ageMs);
	// Directory entries (bakes, renders…) were last written when their newest file was.
	age(join(path, '..'), ageMs);
	return path;
}

function age(path: string, ageMs: number): void {
	const t = (Date.now() - ageMs) / 1000;
	utimesSync(path, t, t);
}

/** A synthetic cache: one entry of every kind (old), plus temporary files. */
function seed(appdir: string) {
	const p = (...s: string[]) => join(appdir, ...s);
	return {
		poster: put(p('cache', FP, 'poster-1234abcd.jpg')),
		spriteJson: put(p('cache', FP, 'sprite-1234abcd.json')),
		spriteSheet: put(p('cache', FP, 'sprite-1234abcd', '0.jpg')),
		proxy: put(p('cache', FP, 'proxy-720-1234abcd.mp4'), 5000),
		otherPoster: put(p('cache', FP2, 'poster-1234abcd.jpg')),
		lut: put(p('cache', 'luts', `${'c'.repeat(64)}.cube`), 2000),
		warp: put(p('cache', 'warp', `${'d'.repeat(40)}.mov`), 3000),
		layer: put(p('cache', 'layers', 'e'.repeat(40), 'still.png')),
		mg: put(p('mg', 'f'.repeat(40), 'master.mov'), 4000),
		poster2: put(p('mg', 'posters', '1'.repeat(64), 'Intro@0.png')),
		exportOut: put(p('renders', 'job_0000000000000001', 'output.mp4'), 6000),
		stillOut: put(p('renders', 'job_0000000000000002', 'output.png')),
		bundleOld: put(p('remotion', 'bundle', 'oldhash', 'index.html')),
		partial: put(p('cache', FP, 'proxy-720-1234abcd.mp4.lq3.partial.mp4'), 100, 2 * 60 * 60 * 1000),
		freshPartial: put(p('cache', 'luts', `${'9'.repeat(64)}.cube.1.x.partial`), 100, 1000),
		trash: put(p('cache', 'warp', `.trash-0011-${'8'.repeat(40)}.mov`), 100, 1000),
	};
}

/** Saves a document as a project of the engine's store (what the editor's autosave does). */
function saveProject(appdir: string, d: DocBuilder): string {
	const pid = d.doc.projectId;
	mkdirSync(join(appdir, 'projects', pid), { recursive: true });
	writeFileSync(
		join(appdir, 'projects', pid, 'project.jasper'),
		JSON.stringify(
			makeEnvelope(d.doc, { revision: d.revision, savedAt: new Date().toISOString(), platform: 'test' }),
		),
	);
	return pid;
}

/** A document whose media asset has fingerprint `q1:<FP>` (its derivatives are under `cache/<FP>/`). */
function docWithMedia(seed = 21): DocBuilder {
	const d = new DocBuilder('hd-1080p-30', seed);
	d.tx([
		{
			type: 'media.register',
			asset: {
				fingerprint: `q1:${FP}`,
				originalName: 'a.mp4',
				sizeBytes: 10,
				container: 'mp4',
				kind: 'video',
				probe: EMPTY_PROBE,
				locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_000000000000000000000001' }],
				derivation: null,
			},
		},
	]);
	return d;
}

describe('cache registry and cleaning (CA-011…CA-018)', () => {
	let app: TestApp;
	let cache: CacheService;
	beforeAll(async () => {
		app = await makeApp();
		cache = coreServices(app).cache;
		await cache.start();
	});
	afterAll(closeApps);

	const fresh = () => {
		const s = seed(app.appdir);
		return s;
	};
	const clean = async (mode: string, kinds?: string[]) => {
		const r = await app.inject({
			method: 'POST',
			url: '/api/cache/clean',
			headers: JSON_H,
			payload: { mode, ...(kinds ? { kinds } : {}) },
		});
		expect(r.statusCode).toBe(200);
		return r.json() as CacheGcReport;
	};
	const usage = async () => {
		const r = await app.inject({ method: 'GET', url: '/api/cache', headers: H });
		expect(r.statusCode).toBe(200);
		return r.json() as CacheUsage;
	};

	it('reports usage per kind: in use, referenced by saved projects, unused (CA-013)', async () => {
		const s = fresh();
		const d = docWithMedia();
		const pid = saveProject(app.appdir, d);
		const u = await usage();
		const kind = (k: string) => u.kinds.find((x) => x.kind === k)!;
		// The project's media → its derivatives (fingerprint FP) are referenced; FP2's are not.
		expect(kind('media-cache')).toMatchObject({
			entries: 3,
			bytes: 4000,
			referencedBytes: 3000,
			unusedBytes: 1000,
		});
		expect(kind('proxies')).toMatchObject({ referencedBytes: 5000, unusedBytes: 0 });
		expect(kind('exports')).toMatchObject({ entries: 1, bytes: 6000, maxAgeDays: 7, defaultMaxAgeDays: 7 });
		expect(kind('stills').maxAgeDays).toBe(1);
		expect(kind('layers').maxAgeDays).toBe(14);
		expect(kind('luts').maxAgeDays).toBe(30);
		expect(u.automaticBudget).toBe(true);
		expect(u.maxTotalBytes).toBeGreaterThan(0);
		expect(u.location).toBe(app.appdir);
		expect(u.other.map((o) => o.id)).toContain('media');
		// The newest Remotion bundle is the current one: in use.
		expect(kind('bundles').inUseBytes).toBe(1000);
		await clean('all');
		rmProject(app.appdir, pid);
		void s;
	});

	it('"Clean Unused" keeps referenced, pinned and recent entries and sweeps stale temporary files (CA-014, CA-017)', async () => {
		const s = fresh();
		const pid = saveProject(app.appdir, docWithMedia());
		// A running export holds the warp layer; the LUT was used a minute ago.
		cache.pin('job:job_running0000000001', s.warp);
		cache.touch(s.lut);
		const r = await clean('unused');
		expect(existsSync(s.poster) && existsSync(s.spriteSheet) && existsSync(s.proxy)).toBe(true); // referenced
		expect(existsSync(s.otherPoster)).toBe(false);
		expect(existsSync(s.warp)).toBe(true); // pinned
		expect(existsSync(s.lut)).toBe(true); // recent
		for (const f of [s.layer, s.mg, s.poster2, s.exportOut, s.stillOut]) expect(existsSync(f)).toBe(false);
		expect(existsSync(s.bundleOld)).toBe(true); // the only (= current) bundle
		expect(existsSync(s.partial)).toBe(false);
		expect(existsSync(s.trash)).toBe(false);
		expect(existsSync(s.freshPartial)).toBe(true); // a write may still be running
		expect(r).toMatchObject({ mode: 'unused', removedOrphans: 2, failed: 0 });
		expect(r.keptReferenced).toBe(3);
		expect(r.removedEntries).toBe(6);
		expect(r.byKind['mg-renders']).toEqual({ entries: 1, bytes: 4000 });
		// Nothing left over from the removals (trash is deleted at once).
		expect(readdirSync(join(app.appdir, 'cache', 'warp')).filter((n) => n.startsWith('.trash'))).toEqual([]);
		cache.release('job:job_running0000000001');
		rmProject(app.appdir, pid);
		await clean('all');
	});

	it('"Clean All (not in use)" removes what saved projects reference but keeps open projects and running jobs (CA-014)', async () => {
		const s = fresh();
		const saved = saveProject(app.appdir, docWithMedia(31));
		await clean('all');
		expect(existsSync(s.poster)).toBe(false);
		expect(existsSync(s.proxy)).toBe(false);
		// An open project (live lease) keeps what it needs.
		const s2 = fresh();
		const lease = coreServices(app).leases.acquire(saved, 'sess-open');
		const r = await clean('all');
		expect(existsSync(s2.poster) && existsSync(s2.proxy) && existsSync(s2.spriteJson)).toBe(true);
		expect(existsSync(s2.otherPoster)).toBe(false);
		expect(r.keptInUse).toBeGreaterThanOrEqual(3);
		coreServices(app).leases.release(saved, lease.leaseId);
		// A read-only editor window (no lease; its agent relay connection says the project is open) keeps them too.
		const off = cache.addOpenProbe((pid) => pid === saved);
		await clean('all');
		expect(existsSync(s2.poster)).toBe(true);
		off();
		await clean('all');
		expect(existsSync(s2.poster)).toBe(false);
		rmProject(app.appdir, saved);
	});

	it('an open project keeps what its editor shows before the autosave (live document; integration regression)', async () => {
		// The editor imported clip X (artifacts already old: the same file was imported long ago in another project)
		// and has not autosaved yet: the saved document has no media, the live one has.
		const d = new DocBuilder('hd-1080p-30', 61);
		const pid = saveProject(app.appdir, d);
		const live = docWithMedia(61); // same seed → same projectId, plus the media
		expect(live.doc.projectId).toBe(pid);
		const s = fresh();
		const offOpen = cache.addOpenProbe((p) => p === pid);
		const offLive = cache.addLiveDocumentSource(async (p) => (p === pid ? live.doc : null));
		await clean('all');
		expect(existsSync(s.poster) && existsSync(s.proxy) && existsSync(s.spriteSheet)).toBe(true);
		expect(existsSync(s.otherPoster)).toBe(false);
		// Without the live document only the saved one counts: the files go.
		offLive();
		const s2 = fresh();
		await clean('all');
		expect(existsSync(s2.poster)).toBe(false);
		offOpen();
		rmProject(app.appdir, pid);
	});

	it('automatic passes: per-kind age limits, then LRU eviction under kind and total budgets; referenced entries stay (CA-003, CA-015)', async () => {
		const p = (...x: string[]) => join(app.appdir, ...x);
		// Ages: exports 7 d, stills 1 d, LUTs 30 d (global default).
		const exp8 = put(p('renders', 'job_00000000000000a1', 'output.mp4'), 100, 8 * DAY);
		const exp6 = put(p('renders', 'job_00000000000000a2', 'output.mp4'), 100, 6 * DAY);
		const still2 = put(p('renders', 'job_00000000000000a3', 'output.png'), 100, 2 * DAY);
		const lut20 = put(p('cache', 'luts', `${'2'.repeat(64)}.cube`), 100, 20 * DAY);
		let r = await clean('auto');
		expect([existsSync(exp8), existsSync(exp6), existsSync(still2), existsSync(lut20)]).toEqual([
			false,
			true,
			false,
			true,
		]);
		expect(r.removedEntries).toBe(2);
		// Settings change the limits at once (S04:ENG-012).
		const put1 = await app.inject({
			method: 'PUT',
			url: '/api/cache/settings',
			headers: JSON_H,
			payload: {
				autoClean: false,
				maxTotalBytes: null,
				maxAgeDays: 10,
				kinds: { exports: { maxAgeDays: null } },
			},
		});
		expect(put1.statusCode).toBe(200);
		r = await clean('auto');
		expect(existsSync(lut20)).toBe(false);
		expect(existsSync(exp6)).toBe(true);
		// Budgets: warp ≤ 2500 bytes (LRU), then the total.
		const w = (n: string, ageDays: number) =>
			put(p('cache', 'warp', `${n.repeat(40)}.mov`), 1000, ageDays * DAY);
		const w1 = w('3', 3);
		const w2 = w('4', 2);
		const w3 = w('5', 1);
		await app.inject({
			method: 'PUT',
			url: '/api/cache/settings',
			headers: JSON_H,
			payload: {
				autoClean: false,
				maxTotalBytes: null,
				maxAgeDays: null,
				kinds: { warp: { maxBytes: 2500 } },
			},
		});
		r = await clean('auto');
		expect([existsSync(w1), existsSync(w2), existsSync(w3)]).toEqual([false, true, true]);
		// A total budget below what saved projects reference: unused entries go first (oldest first), the
		// referenced ones stay even though the cache is still over budget.
		const d = docWithMedia(41);
		const pid = saveProject(app.appdir, d);
		const ref1 = put(p('cache', FP, 'proxy-720-77777777.mp4'), 4000, 9 * DAY);
		const pidRefs = await usage();
		expect(pidRefs.referencedBytes).toBe(4000);
		await app.inject({
			method: 'PUT',
			url: '/api/cache/settings',
			headers: JSON_H,
			payload: { autoClean: false, maxTotalBytes: 1000, maxAgeDays: null, kinds: {} },
		});
		r = await clean('auto');
		expect(existsSync(ref1)).toBe(true);
		expect(existsSync(w2) || existsSync(w3) || existsSync(exp6)).toBe(false);
		const u = await usage();
		expect(u.maxTotalBytes).toBe(1000);
		expect(u.automaticBudget).toBe(false);
		expect(u.totalBytes).toBeGreaterThan(1000); // referenced bytes are kept over budget
		rmProject(app.appdir, pid);
		await app.inject({
			method: 'PUT',
			url: '/api/cache/settings',
			headers: JSON_H,
			payload: { autoClean: false, maxTotalBytes: null, maxAgeDays: 30, kinds: {} },
		});
		await clean('all');
	});

	it('validates and persists the settings (engine/cache.json)', async () => {
		const bad = await app.inject({
			method: 'PUT',
			url: '/api/cache/settings',
			headers: JSON_H,
			payload: { autoClean: true, maxTotalBytes: -5, maxAgeDays: 30, kinds: {} },
		});
		expect(bad.statusCode).toBe(400);
		const unknownKind = await app.inject({
			method: 'PUT',
			url: '/api/cache/settings',
			headers: JSON_H,
			payload: { autoClean: false, maxTotalBytes: 50 * 1024 ** 3, maxAgeDays: 60, kinds: { nope: {} } },
		});
		expect(unknownKind.statusCode).toBe(400);
		const ok = await app.inject({
			method: 'PUT',
			url: '/api/cache/settings',
			headers: JSON_H,
			payload: {
				autoClean: false,
				maxTotalBytes: 50 * 1024 ** 3,
				maxAgeDays: 60,
				kinds: { proxies: { maxBytes: 10 * 1024 ** 3, maxAgeDays: null } },
			},
		});
		expect(ok.statusCode).toBe(200);
		const saved = JSON.parse(readFileSync(join(app.appdir, 'engine', 'cache.json'), 'utf8'));
		expect(saved).toMatchObject({ maxTotalBytes: 50 * 1024 ** 3, kinds: { proxies: { maxAgeDays: null } } });
		const got = (await app.inject({ method: 'GET', url: '/api/cache/settings', headers: H })).json();
		expect(got).toEqual(saved);
		const u = await usage();
		expect(u.kinds.find((k) => k.kind === 'proxies')).toMatchObject({
			maxBytes: 10 * 1024 ** 3,
			maxAgeDays: null,
		});
		expect(u.kinds.find((k) => k.kind === 'luts')).toMatchObject({ maxAgeDays: 60 });
		await app.inject({
			method: 'PUT',
			url: '/api/cache/settings',
			headers: JSON_H,
			payload: { autoClean: false, maxTotalBytes: null, maxAgeDays: 30, kinds: {} },
		});
	});

	it('a lookup racing a removal either keeps the entry or misses; never a path that disappears (CA-016)', async () => {
		for (let i = 0; i < 20; i++) {
			const f = put(join(app.appdir, 'cache', 'luts', `${(i % 10).toString().repeat(64)}.cube`), 500);
			const holder = `job:job_race${String(i).padStart(12, '0')}`;
			const late = new Promise((res) => setTimeout(res, (i % 5) * 3)).then(() => cache.acquire(holder, f));
			const [r, present] = await Promise.all([clean('all', ['luts']), late]);
			if (present) {
				expect(existsSync(f)).toBe(true);
				// Pinned: a second pass keeps it.
				await clean('all', ['luts']);
				expect(existsSync(f)).toBe(true);
			} else expect(existsSync(f)).toBe(false);
			expect(r.failed).toBe(0);
			cache.release(holder);
		}
		await clean('all');
	});

	it('crash safety: a removal that cannot rename leaves the entry whole; leftovers of a crash are swept', async () => {
		const dir = join(app.appdir, 'cache', 'layers', '6'.repeat(40));
		put(join(dir, 'still.png'));
		put(join(dir, 'meta.json'));
		age(dir, 30 * DAY);
		chmodSync(join(app.appdir, 'cache', 'layers'), 0o555); // rename out of the parent fails
		try {
			const r = await clean('all', ['layers']);
			expect(r.failed).toBe(1);
			expect(readdirSync(dir).sort()).toEqual(['meta.json', 'still.png']);
		} finally {
			chmodSync(join(app.appdir, 'cache', 'layers'), 0o755);
		}
		// A crash between rename and delete leaves `.trash-*`; an interrupted write leaves `*.partial`.
		const trash = join(app.appdir, 'mg', `.trash-00ff-${'7'.repeat(40)}`);
		put(join(trash, 'master.mov'));
		const tmp = put(
			join(app.appdir, 'mg', '6'.repeat(40), '.tmp-job_0000000000000009', 'master.mov'),
			10,
			2 * 60 * 60 * 1000,
		);
		age(join(tmp, '..'), 2 * 60 * 60 * 1000);
		const scratch = join(app.appdir, 'tmp', 'layer-preview-abc123');
		put(join(scratch, 'x'), 10, 2 * 60 * 60 * 1000);
		age(scratch, 2 * 60 * 60 * 1000);
		const r = await clean('auto');
		expect(existsSync(trash)).toBe(false);
		expect(existsSync(join(tmp, '..'))).toBe(false);
		expect(existsSync(scratch)).toBe(false);
		expect(r.removedOrphans).toBe(3);
		await clean('all');
	});
});

/** What `DELETE /api/projects/:pid` does. */
function rmProject(appdir: string, pid: string): void {
	rmSync(join(appdir, 'projects', pid), { recursive: true, force: true });
}

describe('project refs survive a restart (CA-012)', () => {
	afterAll(closeApps);

	it('recorded ref sets are persisted; they go when the project is deleted', async () => {
		const appdir = tempAppdir('jasper-cache-restart-');
		const d = new DocBuilder('hd-1080p-30', 51);
		const pid = saveProject(appdir, d);
		const lut = put(join(appdir, 'cache', 'luts', `${'4'.repeat(64)}.cube`), 100);
		const unused = put(join(appdir, 'cache', 'luts', `${'5'.repeat(64)}.cube`), 100);
		let app = await makeApp({ appdir });
		await coreServices(app).cache.start();
		coreServices(app).cache.setRefs(`export:${pid}:${d.seqId}`, pid, [lut]);
		await app.close();
		app = await makeApp({ appdir });
		const cache = coreServices(app).cache;
		await cache.start();
		let r = await cache.clean('unused');
		expect(existsSync(lut)).toBe(true);
		expect(existsSync(unused)).toBe(false);
		expect(r.keptReferenced).toBe(1);
		// The project is deleted: its ref set goes with it, and so does the LUT.
		rmProject(appdir, pid);
		r = await cache.clean('unused');
		expect(existsSync(lut)).toBe(false);
	});
});

const exportSettings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 1280,
		height: 720,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 16 },
		encoderSpeed: 'fast',
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'native',
});

/** Decoded RGB of one frame (system or vendor ffmpeg on PATH). */
function frameRgb(file: string, n: number): Buffer {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			`select=eq(n\\,${n})`,
			'-frames:v',
			'1',
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgb24',
			'-',
		],
		{ maxBuffer: 1 << 26 },
	);
	return r.stdout;
}

describe('exports hold and record their cache entries (CA-016, S06:CG-056)', () => {
	let app: TestApp;
	beforeAll(async () => {
		ensureFixtures();
		app = await makeApp();
		await coreServices(app).cache.start();
	}, 120_000);
	afterAll(closeApps);

	it('keyframed grade + keyframed Motion: "Clean All" running in a loop during the export removes nothing it reads; identical grade states share one LUT; the LUTs, warp layer are the project\'s refs', async () => {
		const core = coreServices(app);
		const cache = core.cache;
		const m = await register(app, fixture('clip-a.mp4'));
		const d = new DocBuilder('hd-720p-30', 61);
		const media = d.addMedia(m);
		const clip = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: media },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
				ref: '$c',
			},
		]).refs.$c!;
		const fx = d.tx([
			{
				type: 'effect.add',
				target: { clipId: clip },
				effectId: LUMETRI_EFFECT_ID,
				params: { exposure: 0, temperature: -20, saturation: 130 },
				ref: '$g',
			},
			// A (slight) corner pin: the warp stage renders this layer (keyframed Motion alone is animated by the
			// builder itself since wave1 native-animated-export, without a cache entry).
			{
				type: 'effect.add',
				target: { clipId: clip },
				effectId: CORNER_PIN_EFFECT_ID,
				params: { topLeft: [0.02, 0], topRight: [1, 0.02], bottomRight: [0.98, 1], bottomLeft: [0, 0.98] },
			},
		]).refs.$g!;
		// 30 grade states (the look intensity changes every frame) that all bake to the same table: no look is set.
		const at = (f: number) => ({ sequenceFrame: f });
		d.tx([
			{ type: 'param.setAnimated', target: ['effect', fx, 'lookIntensity'], animated: true, at: at(0) },
			{ type: 'param.set', target: ['effect', fx, 'lookIntensity'], value: 40, at: at(0) },
			{ type: 'param.set', target: ['effect', fx, 'lookIntensity'], value: 100, at: at(29) },
			{ type: 'keyframe.add', target: ['clip', clip, 'transform', 'position'], at: at(0), value: [600, 360] },
			{
				type: 'keyframe.add',
				target: ['clip', clip, 'transform', 'position'],
				at: at(29),
				value: [680, 380],
			},
		]);
		saveProject(app.appdir, d);
		const lutDir = join(app.appdir, 'cache', 'luts');
		const warpDir = join(app.appdir, 'cache', 'warp');

		const runExport = async (gcLoop: boolean) => {
			const start = await app.inject({
				method: 'POST',
				url: '/api/exports',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: exportSettings(d.seqId) },
			});
			expect(start.statusCode).toBe(202);
			const id = start.json().id as string;
			let passes = 0;
			let stop = false;
			const loop = (async () => {
				while (gcLoop && !stop) {
					await cache.clean('all');
					passes++;
					await new Promise((r) => setTimeout(r, 5));
				}
			})();
			const done = await core.queue.wait(id);
			stop = true;
			await loop;
			return { done, id, passes };
		};

		const first = await runExport(true);
		expect(first.done.error).toBeUndefined();
		expect(first.done.state).toBe('succeeded');
		expect((first.done.result as { frames: number }).frames).toBe(30);
		expect(first.passes).toBeGreaterThan(2);
		const second = await runExport(false);
		expect(second.done.state).toBe('succeeded');
		const f1 = (await core.exports.outputFile(first.id))!;
		const f2 = (await core.exports.outputFile(second.id))!;
		// The same pictures. (Not bit-exact: x264's output depends on its thread count, i.e. on the CPU slots the
		// queue granted each export; two exports with the same slots are bit-identical.)
		for (const n of [0, 15, 29]) {
			const a = frameRgb(f1, n);
			const b = frameRgb(f2, n);
			expect(b.length).toBe(1280 * 720 * 3);
			let sum = 0;
			for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
			expect(sum / a.length).toBeLessThan(1);
		}

		// Saved project → kept by "Clean Unused"; not open → removed by "Clean All", regenerated by the next export.
		await new Promise((r) => setTimeout(r, 20)); // the job's pins are released after it ends
		await cache.clean('unused');
		expect(readdirSync(lutDir).filter((f) => f.endsWith('.cube'))).toHaveLength(1);
		expect(readdirSync(warpDir).filter((f) => f.endsWith('.mov'))).toHaveLength(1);
		// Ten minutes later (past the grace window that protects files just written or read):
		const later = 10 * 60 * 1000;
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + later);
		await cache.clean('unused');
		expect(readdirSync(lutDir).filter((f) => f.endsWith('.cube'))).toHaveLength(1);
		await cache.clean('all');
		expect(readdirSync(lutDir).filter((f) => f.endsWith('.cube'))).toHaveLength(0);
		expect(readdirSync(warpDir).filter((f) => f.endsWith('.mov'))).toHaveLength(0);
	}, 600_000);
});

describe('removed artifacts come back on demand (S04:CA-004)', () => {
	afterAll(closeApps);

	it('GET /api/media/:key queues the automatic derivatives the cache GC removed', async () => {
		ensureFixtures();
		const app = await makeApp();
		const cache = coreServices(app).cache;
		await cache.start();
		const m = await register(app, fixture('clip-b.mp4'));
		const status = async () =>
			(await app.inject({ method: 'GET', url: `/api/media/${m.mediaKey}`, headers: H })).json() as {
				derivatives: Record<string, { state: string }>;
			};
		const ready = async () => {
			const s = await status();
			return ['poster', 'keyframes', 'sprite', 'peaks'].every((k) => s.derivatives[k]?.state === 'ready');
		};
		const until = async (f: () => Promise<boolean>) => {
			for (let i = 0; i < 600 && !(await f()); i++) await new Promise((r) => setTimeout(r, 200));
			expect(await f()).toBe(true);
		};
		await until(ready);
		// Past the grace window, nothing references it: Clean All removes the derivatives.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 10 * 60 * 1000);
		const r = await cache.clean('all', ['media-cache']);
		expect(r.removedEntries).toBeGreaterThanOrEqual(4);
		// The next status request (what an editor does when it opens the project) queues them again.
		const s = await status();
		expect(['queued', 'running', 'ready']).toContain(s.derivatives.poster!.state);
		await until(ready);
	}, 240_000);
});

describe('discarding a media removes its cache through the registry (wp-m3-inpoint PRC-018 × CA-016/017)', () => {
	afterAll(closeApps);

	it('DELETE /api/media/:key waits for a derivative a job still pins; one pinned for good is left to the GC', async () => {
		ensureFixtures();
		const app = await makeApp();
		const cache = coreServices(app).cache;
		await cache.start();
		const managed = async (tag: string) => {
			const src = join(app.appdir, `${tag}.mp4`);
			writeFileSync(src, Buffer.concat([readFileSync(fixture('clip-b.mp4')), Buffer.from(tag)]));
			const r = await app.inject({
				method: 'POST',
				url: '/api/media/register',
				headers: JSON_H,
				payload: { projectId: 'prj_0000000000000001', paths: [src], copyIntoProject: true },
			});
			const reg = (r.json() as { items: { mediaKey: string; fingerprint: string }[] }).items[0]!;
			const dir = join(app.appdir, 'cache', reg.fingerprint.replace(/^q1:/, ''));
			// Derivatives made (poster, keyframes, peaks, sprite).
			for (let i = 0; i < 600; i++) {
				const s = (
					await app.inject({ method: 'GET', url: `/api/media/${reg.mediaKey}`, headers: H })
				).json() as {
					derivatives: Record<string, { state: string }>;
				};
				if (['poster', 'keyframes', 'sprite', 'peaks'].every((k) => s.derivatives[k]?.state === 'ready'))
					break;
				await new Promise((r) => setTimeout(r, 200));
			}
			const poster = readdirSync(dir).find((f) => f.startsWith('poster-'))!;
			return { reg, dir, poster: join(dir, poster) };
		};
		const del = (key: string) => app.inject({ method: 'DELETE', url: `/api/media/${key}`, headers: H });

		// 1. A job reads the poster; it finishes after ~1 s: the discard waits for it, then everything goes.
		const a = await managed('discard-wait');
		cache.pin('job:job_reader0000000001', a.poster);
		setTimeout(() => cache.release('job:job_reader0000000001'), 1000);
		const t0 = Date.now();
		const r1 = await del(a.reg.mediaKey);
		expect(r1.json()).toEqual({ deleted: true, reason: 'deleted' });
		expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
		expect(existsSync(a.dir)).toBe(false); // entries and the fingerprint folder; no trash left
		expect(readdirSync(join(app.appdir, 'cache')).filter((n) => n.startsWith('.trash'))).toEqual([]);

		// 2. Pinned for good (a long export): the media goes, the pinned derivative stays (reported) and is not
		//    removed under the reader; once released, the next pass removes it (no project references it).
		const b = await managed('discard-busy');
		cache.pin('job:job_reader0000000002', b.poster);
		const r2 = await del(b.reg.mediaKey);
		expect(r2.json()).toEqual({ deleted: true, reason: 'deleted', cacheKept: 1 });
		expect(existsSync(b.poster)).toBe(true);
		expect(readdirSync(b.dir)).toEqual([basename(b.poster)]);
		cache.release('job:job_reader0000000002');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 10 * 60 * 1000);
		await cache.clean('unused');
		expect(existsSync(b.dir)).toBe(false);
	}, 300_000);
});

describe('saved composition cache references (CA-012)', () => {
	afterAll(closeApps);

	it('keeps trimmed preview/master renders and bundle posters; releases obsolete renders after a props edit', async () => {
		const app = await makeApp();
		const cache = coreServices(app).cache;
		await cache.start();
		const hash = '3'.repeat(64);
		const d = new DocBuilder('hd-1080p-30', 71);
		const registered = d.tx([
			{
				type: 'media.register',
				asset: {
					kind: 'mg-bundle',
					fingerprint: `q1:${hash}`,
					originalName: 'Title',
					sizeBytes: 1,
					container: 'remotion-bundle',
					probe: EMPTY_PROBE,
					locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${hash.slice(0, 24)}` }],
					derivation: null,
					mgBundle: {
						remotionVersion: '4.0.499',
						bundleHash: hash,
						builtAt: '2026-10-01T00:00:00.000Z',
						source: { type: 'bundle-upload', path: null, name: 'Title' },
						compositions: [
							{
								id: 'Title',
								width: 1920,
								height: 1080,
								fps: 25,
								durationInFrames: 75,
								defaultProps: { title: 'Hi' },
								propsSchema: { type: 'object', properties: { title: { type: 'string' } } },
								schemaSource: 'inferred',
							},
						],
					},
				},
			},
		]);
		const mediaId = (registered.results[0] as { mediaId: string }).mediaId;
		const added = d.tx([
			{ type: 'clip.addComposition', composition: { mediaId, id: 'Title' }, at: 10, track: 'V2' },
		]);
		const clipId = (added.results[0] as { clipId: string }).clipId;
		d.tx([{ type: 'clip.trim', clipId, edge: 'in', deltaFrames: 12, mode: 'regular' }]);
		const pid = saveProject(app.appdir, d);
		// 75 frames at 25 fps occupy 90 sequence frames; trimming 12 leaves master frames 12–89.
		// The key helper only addresses fixtures: expected ranges and props are specified independently.
		const renders = (title: string) =>
			[
				{ startFrame: 0, durationFrames: 90, file: 'preview.webm' },
				{ startFrame: 12, durationFrames: 78, file: 'master.mov' },
			].map(({ file, ...range }) => {
				const key = prerenderKey(
					{
						compositionId: 'Title',
						props: { title },
						width: 1920,
						height: 1080,
						fps: { num: 30, den: 1 },
						...range,
					},
					hash,
				);
				return put(join(app.appdir, 'mg', key, file));
			});
		const old = renders('Hi');
		const poster = put(join(app.appdir, 'mg', 'posters', hash, 'Title@0.png'));
		const unrelated = put(join(app.appdir, 'mg', '9'.repeat(40), 'master.mov'));
		await cache.clean('unused');
		for (const file of [...old, poster]) expect(existsSync(file)).toBe(true);
		expect(existsSync(unrelated)).toBe(false);

		d.tx([{ type: 'clip.update', clipId, patch: { props: { title: 'Changed' } } }]);
		saveProject(app.appdir, d);
		const current = renders('Changed');
		await cache.clean('unused');
		for (const file of old) expect(existsSync(file)).toBe(false);
		for (const file of [...current, poster]) expect(existsSync(file)).toBe(true);

		rmProject(app.appdir, pid);
		await cache.clean('unused');
		for (const file of [...current, poster]) expect(existsSync(file)).toBe(false);
	});
});

describe('fframes motion-graphic renders are referenced by saved projects (CA-012)', () => {
	afterAll(closeApps);

	it('the render key of a motion-graphic clip comes from the document; edited params release the old render', async () => {
		const app = await makeApp();
		const cache = coreServices(app).cache;
		await cache.start();
		const mg = app.jasper.services.mg as MgService;
		const d = new DocBuilder('hd-1080p-30', 91);
		// Motion-graphic templates need the mg registry (DocBuilder uses the default registries).
		const mgTx = (commands: unknown[]) => {
			const { document, result } = applyTransaction(
				d.doc,
				{ label: 'mg', origin: 'user', sequenceId: d.seqId, commands: commands as never },
				{
					ids: d.ids,
					now: () => '2026-10-01T00:00:00.000Z',
					revision: d.revision,
					registries: defaultRegistries(mgRegistry),
				},
			);
			if (!result.ok) throw new Error(JSON.stringify(result.errors));
			d.doc = document;
			d.revision = result.revision;
			return result;
		};
		const clipId = (
			mgTx([
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 90,
					track: 'V2',
					template: { id: 'lower-third', version: 1 },
				},
			]).results[0] as { clipId: string }
		).clipId;
		const snap = buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId)!;
		const key = mg.clipRenderKey(clip, snap.settings.fps)!;
		// A render of it (old) and an unrelated one: Clean Unused keeps the project's.
		const dir = join(app.appdir, 'mg', key);
		put(join(dir, 'master.mov'));
		put(join(dir, 'meta.json'));
		const other = join(app.appdir, 'mg', '9'.repeat(40));
		put(join(other, 'master.mov'));
		const pid = saveProject(app.appdir, d);
		await cache.clean('unused');
		expect(existsSync(join(dir, 'master.mov'))).toBe(true);
		expect(existsSync(other)).toBe(false);
		// Other params → another key: the saved project no longer references the old render.
		mgTx([{ type: 'clip.update', clipId, patch: { params: { name: 'Someone else' } } }]);
		saveProject(app.appdir, d);
		await cache.clean('unused');
		expect(existsSync(dir)).toBe(false);
		rmProject(app.appdir, pid);
	});
});

describe('engine logs and the job journal do not grow forever (CA-020)', () => {
	it('log retention by age and size; the Remotion usage log keeps 13 months; usage reports them', async () => {
		const appdir = tempAppdir('jasper-logs-');
		const paths = appdirPaths(appdir);
		const logs = paths.logsDir;
		const old = put(join(logs, '2026-01-01.log'), 1000, 60 * DAY);
		const job = put(join(logs, 'jobs', 'job_0000000000000001.log'), 1000, 45 * DAY);
		const recent = put(join(logs, 'mg-bundles', 'job_0000000000000002.log'), 3000, 2 * DAY);
		const recent2 = put(join(logs, 'jobs', 'job_0000000000000003.log'), 3000, 1 * DAY);
		const now = Date.now();
		const lines: string[] = [];
		for (let i = 0; i < 9000; i++)
			lines.push(
				JSON.stringify({
					at: new Date(now - (i % 2 ? 500 : 30) * DAY).toISOString(),
					kind: 'media',
					purpose: `export${'x'.repeat(100)}`,
				}),
			);
		writeFileSync(join(logs, USAGE_LOG), `${lines.join('\n')}\n`);
		const r = await maintainLogs(paths, { maxAgeDays: 30, maxBytes: 4000 }, now);
		expect(existsSync(old) || existsSync(job)).toBe(false);
		expect(existsSync(recent)).toBe(false); // oldest beyond the 4000-byte limit
		expect(existsSync(recent2)).toBe(true);
		expect(r.removedFiles).toBe(3);
		const kept = readFileSync(join(logs, USAGE_LOG), 'utf8').trim().split('\n');
		expect(kept).toHaveLength(4500); // the 500-day-old half went
		const u = await logsUsage(paths);
		expect(u.files).toBe(2);
	});

	it('the job journal is compacted: finished jobs older than 7 days beyond the newest 500 go', async () => {
		const appdir = tempAppdir('jasper-journal-');
		const journalPath = join(appdir, 'jobs.jsonl');
		let t = Date.parse('2026-09-01T00:00:00Z');
		const q = new JobQueue({ journalPath, tmpDir: join(appdir, 'tmp'), now: () => new Date(t) });
		q.registerRunner('probe', async () => ({ ok: true }));
		q.start();
		const ids: string[] = [];
		for (let i = 0; i < 520; i++)
			ids.push(q.submit({ kind: 'probe', title: `p${i}`, priority: 'background', cpuSlots: 0 }).id);
		for (const id of ids) await q.wait(id);
		const linesBefore = readFileSync(journalPath, 'utf8').trim().split('\n').length;
		expect(linesBefore).toBeGreaterThan(520);
		t += 8 * DAY;
		expect(q.prune()).toBe(20);
		expect(readFileSync(journalPath, 'utf8').trim().split('\n')).toHaveLength(500);
		expect(q.get(ids[0]!)).toBeNull();
		expect(q.get(ids[519]!)).not.toBeNull();
		await q.shutdown();
	});
});

beforeAll(() => ensureFixtures());

afterEach(() => vi.useRealTimers());
