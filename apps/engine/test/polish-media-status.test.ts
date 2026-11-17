import { appendFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, ensureFixtures, fixture, JSON_H, makeApp, register } from './helpers.ts';
import { tempAppdir } from './temp.ts';

beforeAll(() => ensureFixtures(), 180_000);
afterAll(() => closeApps());

describe('POST /api/media/status', () => {
	it('returns registered status, lists unknown keys and removes duplicates', async () => {
		const app = await makeApp();
		const a = await register(app, fixture('clip-a.mp4'));
		const b = await register(app, fixture('tone.wav'));
		const r = await app.inject({
			method: 'POST',
			url: '/api/media/status',
			headers: JSON_H,
			payload: { mediaKeys: [a.mediaKey, 'mk_UNKNOWN000000000000', b.mediaKey, a.mediaKey, '../etc/passwd'] },
		});
		expect(r.statusCode).toBe(200);
		const body = r.json() as { statuses: { mediaKey: string; status: string }[]; unknown: string[] };
		expect(body.statuses.map((s) => s.mediaKey).sort()).toEqual([a.mediaKey, b.mediaKey].sort());
		expect(body.unknown.sort()).toEqual(['../etc/passwd', 'mk_UNKNOWN000000000000']);
		const mine = body.statuses.find((s) => s.mediaKey === a.mediaKey)!;
		expect(['online', 'processing']).toContain(mine.status);
	});

	it('validates the body', async () => {
		const app = await makeApp();
		for (const payload of [{}, { mediaKeys: [] }, { mediaKeys: 'x' }, { mediaKeys: Array(1001).fill('k') }]) {
			const r = await app.inject({ method: 'POST', url: '/api/media/status', headers: JSON_H, payload });
			expect(r.statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
			expect(r.json().code).toBe('VALIDATION_FAILED');
		}
	});
});

describe('offline reason (Link Media)', () => {
	it('a file re-rendered at its path is "changed"; a deleted one is "missing"', async () => {
		const app = await makeApp();
		const src = join(tempAppdir('jasper-rerender-'), 'MGB_S62_cpu_huesos_alpha.mp4');
		copyFileSync(fixture('clip-b.mp4'), src);
		appendFileSync(src, 'v0'); // its own content (the registry keys files by content)
		const { mediaKey } = await register(app, src);
		const status = async () =>
			(
				(
					await app.inject({
						method: 'POST',
						url: '/api/media/status',
						headers: JSON_H,
						payload: { mediaKeys: [mediaKey] },
					})
				).json() as {
					statuses: { status: string; offline?: string }[];
				}
			).statuses[0]!;
		expect((await status()).offline).toBeUndefined();
		appendFileSync(src, Buffer.alloc(4096));
		expect(await status()).toMatchObject({ status: 'missing', offline: 'changed' });
		const one = await app.inject({ method: 'GET', url: `/api/media/${mediaKey}`, headers: JSON_H });
		expect(one.json()).toMatchObject({ status: 'missing', offline: 'changed' });
		rmSync(src);
		expect(await status()).toMatchObject({ status: 'missing', offline: 'missing' });
	});
});
