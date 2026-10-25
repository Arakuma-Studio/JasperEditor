import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CacheLocationCheck, EngineJob } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repairCacheLocation } from '../src/cache/location.ts';
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

/** A folder on another disk than os.tmpdir() when the host has one (here /var vs /tmp), else null. */
function otherDiskDir(): string | null {
	for (const base of ['/tmp', '/dev/shm', '/var/tmp', '/var/lib/orquester/tmp']) {
		try {
			mkdirSync(base, { recursive: true });
			if (lstatSync(base).dev !== lstatSync(tmpdir()).dev)
				return mkdtempSync(join(base, 'jasper-cache-loc-'));
		} catch {
			// not usable
		}
	}
	return null;
}

function seedCache(appdir: string): string[] {
	const files = [
		join(appdir, 'cache', 'luts', `${'a'.repeat(64)}.cube`),
		join(appdir, 'cache', 'warp', `${'b'.repeat(40)}.mov`),
		join(appdir, 'mg', 'c'.repeat(40), 'master.mov'),
		join(appdir, 'renders', 'job_0000000000000001', 'output.mp4'),
	];
	for (const f of files) {
		mkdirSync(join(f, '..'), { recursive: true });
		writeFileSync(f, Buffer.alloc(4096, 7));
	}
	return files.map((f) => f.slice(appdir.length + 1));
}

async function move(app: TestApp, body: Record<string, unknown>): Promise<EngineJob> {
	const r = await app.inject({ method: 'POST', url: '/api/cache/location', headers: JSON_H, payload: body });
	expect(r.statusCode, r.body).toBe(202);
	return coreServices(app).queue.wait((r.json() as EngineJob).id);
}

async function check(app: TestApp, path: string | null): Promise<CacheLocationCheck> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/cache/location/check',
		headers: JSON_H,
		payload: { path },
	});
	expect(r.statusCode, r.body).toBe(200);
	return r.json();
}

// A clean checkout generates (or waits for) every fixture here: minutes, not the default 10 s hook timeout.
beforeAll(() => ensureFixtures(), 900_000);
afterAll(closeApps);

describe('cache location (S04:CA-021)', () => {
	it('validates folders: absolute, writable, outside the data and cache folders, empty, free space', async () => {
		const app = await makeApp();
		const dest = mkdtempSync(join(tmpdir(), 'jasper-cache-dest-'));
		expect((await check(app, 'relative/dir')).ok).toBe(false);
		expect(await check(app, null)).toMatchObject({ ok: false, sameAsCurrent: true, isDefault: true });
		expect((await check(app, join(app.appdir, 'cache', 'x'))).ok).toBe(false);
		const good = await check(app, dest);
		expect(good).toMatchObject({ ok: true, writable: true, sameDevice: true, requiredBytes: 0 });
		expect(good.path).toBe(join(dest, 'JasperEditor Media Cache'));
		mkdirSync(join(dest, 'JasperEditor Media Cache', 'cache'), { recursive: true });
		writeFileSync(join(dest, 'JasperEditor Media Cache', 'cache', 'x'), 'x');
		expect((await check(app, dest)).ok).toBe(false);
		const bad = await app.inject({
			method: 'POST',
			url: '/api/cache/location',
			headers: JSON_H,
			payload: { path: dest, mode: 'move' },
		});
		expect(bad.statusCode).toBe(422);
		expect(bad.json().code).toBe('CACHE_LOCATION_INVALID');
	});

	it('moves on the same disk (rename), keeps working through the links, survives a restart, moves back', async () => {
		const appdir = tempAppdir('jasper-cache-move-');
		const files = seedCache(appdir);
		let app = await makeApp({ appdir });
		const dest = mkdtempSync(join(tmpdir(), 'jasper-cache-dest-'));
		const job = await move(app, { path: dest, mode: 'move' });
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const root = join(dest, 'JasperEditor Media Cache');
		expect(job.result).toMatchObject({ location: root, isDefault: false, mode: 'move' });
		for (const d of ['cache', 'mg', 'renders', 'tmp'])
			expect(readlinkSync(join(appdir, d))).toBe(join(root, d));
		for (const f of files) {
			expect(existsSync(join(root, f))).toBe(true);
			expect(existsSync(join(appdir, f))).toBe(true);
		}
		const settings = JSON.parse(readFileSync(join(appdir, 'engine', 'cache.json'), 'utf8'));
		expect(settings.location).toBe(dest);
		const u = (await app.inject({ method: 'GET', url: '/api/cache', headers: H })).json();
		expect(u).toMatchObject({ location: root, locationIsDefault: false });
		expect(u.kinds.find((k: { kind: string }) => k.kind === 'luts').entries).toBe(1);
		await app.inject({
			method: 'PUT',
			url: '/api/cache/settings',
			headers: JSON_H,
			payload: { autoClean: false, maxTotalBytes: null, maxAgeDays: 30, kinds: {}, location: null },
		});
		expect(
			(await app.inject({ method: 'GET', url: '/api/cache/settings', headers: H })).json().location,
		).toBe(dest);

		const m = await register(app, fixture('clip-b.mp4'));
		const d = new DocBuilder('hd-720p-30', 81);
		const mid = d.addMedia(m);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: mid },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 1 } },
			},
		]);
		const ex = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'entire' },
					container: 'mp4',
					video: {
						codec: 'h264',
						width: 64,
						height: 36,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 23 },
						encoderSpeed: 'fast',
					},
					audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
					engine: 'native',
				},
			},
		});
		expect(ex.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(ex.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		expect(existsSync(join(root, 'renders', done.id, 'output.mp4'))).toBe(true);

		await app.close();
		app = await makeApp({ appdir });
		expect(readlinkSync(join(appdir, 'cache'))).toBe(join(root, 'cache'));
		expect(existsSync(join(appdir, files[0]!))).toBe(true);

		const back = await move(app, { path: null, mode: 'move' });
		expect(back.state, JSON.stringify(back.error)).toBe('succeeded');
		for (const dir of ['cache', 'mg', 'renders', 'tmp']) {
			expect(lstatSync(join(appdir, dir)).isDirectory()).toBe(true);
		}
		for (const f of files) expect(existsSync(join(appdir, f))).toBe(true);
		expect(existsSync(join(root, 'cache'))).toBe(false);
		expect(JSON.parse(readFileSync(join(appdir, 'engine', 'cache.json'), 'utf8')).location).toBeNull();
	}, 300_000);

	it('moves to another disk by copying; the old files go', async (context) => {
		const dest = otherDiskDir();
		if (!dest) return context.skip(); // Cross-device copying requires a second filesystem.
		const appdir = tempAppdir('jasper-cache-xdev-');
		const files = seedCache(appdir);
		const app = await makeApp({ appdir });
		expect((await check(app, dest)).sameDevice).toBe(false);
		expect((await check(app, dest)).requiredBytes).toBeGreaterThanOrEqual(4 * 4096);
		const job = await move(app, { path: dest, mode: 'move' });
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const root = join(dest, 'JasperEditor Media Cache');
		for (const f of files) {
			expect(readFileSync(join(root, f))).toEqual(Buffer.alloc(4096, 7));
			expect(existsSync(join(appdir, f))).toBe(true);
		}
		expect(readdirSync(appdir).filter((n) => n.startsWith('.cache-old'))).toEqual([]);
		expect(readdirSync(root).filter((n) => n.includes('.partial-'))).toEqual([]);
		expect(job.result).toMatchObject({ movedBytes: 4 * 4096 });
	}, 300_000);

	it('a fresh start keeps the old files on request (and removes them otherwise)', async () => {
		const appdir = tempAppdir('jasper-cache-fresh-');
		const files = seedCache(appdir);
		const app = await makeApp({ appdir });
		const dest = mkdtempSync(join(tmpdir(), 'jasper-cache-dest-'));
		const job = await move(app, { path: dest, mode: 'fresh', keepOld: true });
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		expect(existsSync(join(appdir, files[0]!))).toBe(false);
		const kept = readdirSync(appdir).find((n) => n.startsWith('Old Media Cache'))!;
		expect(kept).toBeTruthy();
		expect(existsSync(join(appdir, kept, files[0]!))).toBe(true);
		writeFileSync(join(appdir, 'cache', 'x.cube'), 'x');
		const back = await move(app, { path: null, mode: 'fresh' });
		expect(back.state).toBe('succeeded');
		expect(existsSync(join(dest, 'JasperEditor Media Cache', 'cache'))).toBe(false);
	}, 120_000);

	it('the start-up repair completes an interrupted switch and falls back when the location is gone', () => {
		const appdir = tempAppdir('jasper-cache-repair-');
		const files = seedCache(appdir);
		const dest = mkdtempSync(join(tmpdir(), 'jasper-cache-dest-'));
		// Crash right after the setting was written (journal "switching"), before any link existed.
		mkdirSync(join(appdir, 'engine'), { recursive: true });
		writeFileSync(join(appdir, 'engine', 'cache.json'), JSON.stringify({ location: dest }));
		writeFileSync(
			join(appdir, 'engine', 'cache-move.json'),
			JSON.stringify({ id: 'abcd', state: 'switching', from: null, to: dest, mode: 'move', keepOld: false }),
		);
		const r = repairCacheLocation(appdir);
		expect(r).toEqual({ location: dest, warning: null });
		const root = join(dest, 'JasperEditor Media Cache');
		for (const d of ['cache', 'mg', 'renders', 'tmp'])
			expect(lstatSync(join(appdir, d)).isSymbolicLink()).toBe(true);
		for (const f of files) expect(existsSync(join(root, f))).toBe(true);
		// The location disappears (drive unplugged): a fresh cache in the data folder, with a warning.
		// (a folder below a plain file cannot be created, like a folder on an unplugged drive)
		const plain = join(dest, 'plain-file');
		writeFileSync(plain, 'x');
		writeFileSync(join(appdir, 'engine', 'cache.json'), JSON.stringify({ location: join(plain, 'drive') }));
		const gone = repairCacheLocation(appdir);
		expect(gone.warning).toBeTruthy();
		for (const d of ['cache', 'mg', 'renders', 'tmp'])
			expect(lstatSync(join(appdir, d)).isDirectory()).toBe(true);
	});
});
