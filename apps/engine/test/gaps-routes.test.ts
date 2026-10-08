// Workstream gaps: engine routes (Edit Original location / open).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openerFor } from '../src/routes/gaps.ts';
import { closeApps, ensureFixtures, fixture, H, JSON_H, makeApp, register } from './helpers.ts';

beforeAll(() => ensureFixtures());
afterAll(() => closeApps());

describe('Edit Original routes', () => {
	it('builds the host opener per platform', () => {
		expect(openerFor('reveal', '/m/a.mov', 'darwin')).toEqual({ cmd: 'open', args: ['-R', '/m/a.mov'] });
		expect(openerFor('open', '/m/a.mov', 'darwin')).toEqual({ cmd: 'open', args: ['/m/a.mov'] });
		expect(openerFor('reveal', 'C:\\m\\a.mov', 'win32')).toEqual({
			cmd: 'explorer.exe',
			args: ['/select,C:\\m\\a.mov'],
		});
		expect(openerFor('reveal', '/m/a.mov', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/m'] });
		expect(openerFor('open', '/m/a.mov', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/m/a.mov'] });
		expect(openerFor('open', '/m/a.mov', 'linux', 'true')).toEqual({
			cmd: 'true',
			args: ['open', '/m/a.mov'],
		});
	});

	it('locates a registered file and opens it with the host opener', async () => {
		const app = await makeApp();
		const reg = await register(app, fixture('clip-a.mp4'));
		const loc = await app.inject({ method: 'GET', url: `/api/media/${reg.mediaKey}/location`, headers: H });
		expect(loc.statusCode).toBe(200);
		expect(loc.json()).toMatchObject({ path: fixture('clip-a.mp4'), exists: true, canOpen: true });
		const prev = process.env.JASPER_OPEN_COMMAND;
		process.env.JASPER_OPEN_COMMAND = 'true';
		try {
			const open = await app.inject({
				method: 'POST',
				url: `/api/media/${reg.mediaKey}/open`,
				headers: JSON_H,
				payload: { action: 'reveal' },
			});
			expect(open.statusCode).toBe(200);
			expect(open.json()).toMatchObject({ ok: true, action: 'reveal' });
			process.env.JASPER_OPEN_COMMAND = '/nonexistent/opener-binary';
			const missing = await app.inject({
				method: 'POST',
				url: `/api/media/${reg.mediaKey}/open`,
				headers: JSON_H,
				payload: { action: 'open' },
			});
			expect(missing.statusCode).toBe(501);
			expect(missing.json().code).toBe('OPENER_MISSING');
		} finally {
			if (prev === undefined) delete process.env.JASPER_OPEN_COMMAND;
			else process.env.JASPER_OPEN_COMMAND = prev;
		}
		const unknown = await app.inject({ method: 'GET', url: '/api/media/zz/location', headers: H });
		expect(unknown.statusCode).toBe(404);
		const bad = await app.inject({
			method: 'POST',
			url: `/api/media/${reg.mediaKey}/open`,
			headers: JSON_H,
			payload: { action: 'run' },
		});
		expect(bad.statusCode).toBe(400);
	});
});
