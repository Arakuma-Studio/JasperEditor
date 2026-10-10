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
		// The path is quoted for explorer.exe's own parser and written verbatim (test/windows-opener.test.ts).
		expect(openerFor('reveal', 'C:\\m\\a.mov', 'win32')).toEqual({
			cmd: 'explorer.exe',
			args: ['/select,"C:\\m\\a.mov"'],
			verbatim: true,
		});
		// Security review ENG-5: Windows "open" passes the path in the environment, never on a cmd.exe command line.
		expect(openerFor('open', 'C:\\m\\a.mov', 'win32')).toMatchObject({
			cmd: 'powershell.exe',
			env: { JASPER_OPEN_PATH: 'C:\\m\\a.mov' },
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

describe('Preferences ▸ Auto Save / Memory (engine side)', () => {
	it('reads, validates, persists and applies the version policy and render optimisation', async () => {
		const { renderParallelism } = await import('../src/gaps/render-budget.ts');
		const app = await makeApp();
		const get = await app.inject({ method: 'GET', url: '/api/settings/gaps', headers: H });
		expect(get.statusCode).toBe(200);
		expect(get.json()).toMatchObject({
			versionIntervalMinutes: 5,
			keepVersions: 20,
			optimizeFor: 'performance',
		});
		expect(get.json().memory.totalBytes).toBeGreaterThan(0);
		const put = await app.inject({
			method: 'PUT',
			url: '/api/settings/gaps',
			headers: JSON_H,
			payload: { versionIntervalMinutes: 15, keepVersions: 3, optimizeFor: 'memory' },
		});
		expect(put.statusCode, put.body).toBe(200);
		const { coreServices } = await import('../src/tools/services.ts');
		expect(coreServices(app).projects.versionPolicy()).toEqual({
			versionIntervalMs: 15 * 60_000,
			keepVersions: 3,
		});
		expect(renderParallelism(16)).toBe(4);
		const bad = await app.inject({
			method: 'PUT',
			url: '/api/settings/gaps',
			headers: JSON_H,
			payload: { keepVersions: 0 },
		});
		expect(bad.statusCode).toBe(400);
		// A new engine on the same appdir reads the saved settings.
		const again = await makeApp({ appdir: app.appdir });
		const g2 = await again.inject({ method: 'GET', url: '/api/settings/gaps', headers: H });
		expect(g2.json()).toMatchObject({ versionIntervalMinutes: 15, keepVersions: 3, optimizeFor: 'memory' });
		const reset = await again.inject({
			method: 'PUT',
			url: '/api/settings/gaps',
			headers: JSON_H,
			payload: { optimizeFor: 'performance' },
		});
		expect(reset.statusCode).toBe(200);
		expect(renderParallelism(16)).toBe(8);
	});
});
