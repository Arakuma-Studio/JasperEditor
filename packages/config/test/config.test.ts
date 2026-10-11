import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { appdirPaths, desktopAppdir, parseEngineRuntime, resolveAppdir, resolvePort } from '../src/index.ts';

describe('@jasper/config', () => {
	it('resolves appdir with argv > env > default', () => {
		expect(resolveAppdir({ argv: ['--appdir=/a'], env: { JASPER_APPDIR: '/b' }, defaultDir: '/c' })).toBe(
			'/a',
		);
		expect(resolveAppdir({ argv: [], env: { JASPER_APPDIR: '/b' }, defaultDir: '/c' })).toBe('/b');
		expect(resolveAppdir({ argv: [], env: {}, defaultDir: '/c' })).toBe('/c');
		expect(resolveAppdir({ argv: [], env: { JASPER_APPDIR: './.stage' }, cwd: '/repo' })).toBe(
			resolve('/repo/.stage'),
		);
		expect(resolveAppdir({ argv: [], env: { XDG_DATA_HOME: '/data' } })).toMatch(/jasper$/);
	});

	it('resolves port', () => {
		expect(resolvePort({ argv: [], env: {} })).toBe(47900);
		expect(resolvePort({ argv: ['--port', '0'], env: {} })).toBe(0);
		expect(resolvePort({ argv: [], env: { JASPER_PORT: '1234' } })).toBe(1234);
		expect(() => resolvePort({ argv: ['--port', 'abc'], env: {} })).toThrow();
	});

	it('lays out the appdir per ARCHITECTURE §4.3', () => {
		const p = appdirPaths('/app');
		expect(p.engineConfig).toBe(join('/app', 'engine', 'engine.json'));
		expect(p.mediaIndex).toBe(join('/app', 'engine', 'media-index.json'));
		expect(p.jobsJournal).toBe(join('/app', 'engine', 'jobs.jsonl'));
		expect(p.projectFile('prj_1')).toBe(join('/app', 'projects', 'prj_1', 'project.jasper'));
		expect(p.projectViewFile('prj_1')).toBe(join('/app', 'projects', 'prj_1', 'project.jasper-view'));
		expect(p.mediaFile('mk_1', 'a.mp4')).toBe(join('/app', 'media', 'mk_1', 'a.mp4'));
		expect(p.derivativeFile('abc', 'poster', 'h', 'jpg')).toBe(join('/app', 'cache', 'abc', 'poster-h.jpg'));
		expect(p.mgRenderDir('rk')).toBe(join('/app', 'mg', 'rk'));
		expect(p.renderDir('job1')).toBe(join('/app', 'renders', 'job1'));
		expect(p.remotionBundleDir).toBe(join('/app', 'remotion', 'bundle'));
		expect(p.tmpDir).toBe(join('/app', 'tmp'));
		expect(p.logFile(new Date('2026-09-30T10:00:00Z'))).toBe(
			join('/app', 'engine', 'logs', '2026-09-30.log'),
		);
	});

	it('locates the desktop appdir and parses runtime files', () => {
		expect(desktopAppdir({ XDG_CONFIG_HOME: '/cfg' }, 'linux')).toBe(join('/cfg', 'JasperEditor', 'jasper'));
		expect(desktopAppdir({ APPDATA: 'C:/Users/u/AppData/Roaming' }, 'win32')).toMatch(
			/JasperEditor[\\/]jasper$/,
		);
		expect(appdirPaths('/a').runtimeFile).toBe(join('/a', 'engine', 'runtime.json'));
		expect(parseEngineRuntime({ url: 'http://127.0.0.1:1', port: 1, pid: 2, token: 't' })).toMatchObject({
			token: 't',
			host: '127.0.0.1',
		});
		expect(parseEngineRuntime({ url: 'x', port: 1 })).toBeNull();
		expect(parseEngineRuntime({ url: 'x', port: 1, pid: 1, token: 5 })).toBeNull();
	});
});

describe('engine runtime validation', () => {
	const runtime = { url: 'http://127.0.0.1:47900', port: 47900, pid: 12, token: 'token' };

	it('refuses malformed runtime ports, process ids and URLs', () => {
		for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '47900'])
			expect(parseEngineRuntime({ ...runtime, port })).toBeNull();
		for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
			expect(parseEngineRuntime({ ...runtime, pid })).toBeNull();
		for (const url of ['not a URL', 'file:///tmp/engine', 'javascript:alert(1)'])
			expect(parseEngineRuntime({ ...runtime, url })).toBeNull();
		expect(parseEngineRuntime({ ...runtime, host: 42 })).toBeNull();
	});

	it('accepts arbitrary JSON only when it satisfies the discovery contract', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				const result = parseEngineRuntime(value);
				if (result) {
					expect(Number.isInteger(result.port)).toBe(true);
					expect(result.port).toBeGreaterThan(0);
					expect(result.port).toBeLessThanOrEqual(65535);
					expect(Number.isInteger(result.pid)).toBe(true);
					expect(result.pid).toBeGreaterThan(0);
					expect(new URL(result.url).protocol).toMatch(/^https?:$/);
				}
			}),
		);
	});
});
