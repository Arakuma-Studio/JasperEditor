import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, ensureFixtures, fixture, JSON_H, makeApp, register } from './helpers.ts';

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
