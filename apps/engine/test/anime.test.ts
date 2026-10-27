import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineCapabilitiesSchema, LicensesResponseSchema } from '@jasper/api';
import { afterEach, describe, expect, it } from 'vitest';
import { animeLicense } from '../src/anime/index.ts';
import { createServer, engineConfig } from '../src/index.ts';
import { RemotionService } from '../src/remotion/service.ts';

const H = { host: '127.0.0.1:47900' };

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
	for (const a of apps.splice(0)) await a.close();
});

async function make() {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-anime-'));
	const config = engineConfig({ appdir, port: 47900, dev: true, token: null, webDir: null, env: {} });
	const app = await createServer(config, { env: { PATH: process.env.PATH } });
	apps.push(app);
	return app;
}

describe('anime.js on the engine (routes/anime.ts)', () => {
	it('lists anime.js (MIT, with its text) in /api/licenses and fills features.anime', async () => {
		const app = await make();
		const lic = LicensesResponseSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/licenses', headers: H })).json(),
		);
		const anime = lic.components.filter((c) => c.id === 'animejs');
		expect(anime).toHaveLength(1);
		expect(anime[0]).toMatchObject({ license: 'MIT', version: '4.5.0', bundled: true });
		expect(anime[0]!.texts[0]!.text).toMatch(/MIT License[\s\S]*Julian Garnier/);
		const caps = EngineCapabilitiesSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json(),
		);
		expect(caps.features?.anime).toEqual({
			animejs: '4.5.0',
			textPresets: expect.any(Number),
			templates: expect.any(Number),
		});
	});
	it('packaged-like: without the installed package, the committed licence text and the pinned version', () => {
		const lic = animeLicense(null);
		expect(lic).toMatchObject({
			id: 'animejs',
			version: '4.5.0',
			license: 'MIT',
			bundled: true,
		});
		expect(lic.texts[0]!.text).toMatch(/MIT License[\s\S]*Julian Garnier/);
		expect(lic.texts[0]!.text).toContain('Permission is hereby granted, free of charge');
	});
});

describe('Remotion bundle source hash (S11:FIX-009)', () => {
	const remotion = new RemotionService({
		bundleCacheDir: tmpdir(),
		usageLog: null,
		env: {},
		binaries: { dir: null, source: 'bundled', lgpl: false, allowed: true },
	});
	/** A miniature workspace: compositions depending on project, mg-templates and motion; a lockfile at the root. */
	function workspace() {
		const root = mkdtempSync(join(tmpdir(), 'jasper-srchash-'));
		writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
		const pkg = (dir: string, name: string) => {
			mkdirSync(join(dir, 'src'), { recursive: true });
			writeFileSync(
				join(dir, 'package.json'),
				JSON.stringify({ name, type: 'module', exports: { '.': './src/index.ts' } }),
			);
			writeFileSync(join(dir, 'src', 'index.ts'), `export const name = '${name}';\n`);
		};
		const comp = join(root, 'packages', 'compositions');
		pkg(comp, '@jasper/compositions');
		writeFileSync(join(comp, 'src', 'remotion-entry.ts'), 'export {};\n');
		mkdirSync(join(comp, 'node_modules', '@jasper'), { recursive: true });
		for (const dep of ['@jasper/project', '@jasper/mg-templates', '@jasper/motion']) {
			const short = dep.split('/')[1]!;
			pkg(join(root, 'packages', short), dep);
			symlinkSync(join(root, 'packages', short), join(comp, 'node_modules', '@jasper', short), 'dir');
		}
		return { root, entry: join(comp, 'src', 'remotion-entry.ts') };
	}
	it('changes with the lockfile and with the sources of every bundled workspace package', () => {
		const w = workspace();
		const h0 = remotion.sourceHash(w.entry);
		expect(remotion.sourceHash(w.entry)).toBe(h0);
		writeFileSync(join(w.root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# animejs 4.5.1\n");
		const h1 = remotion.sourceHash(w.entry);
		expect(h1).not.toBe(h0);
		let prev = h1;
		for (const short of ['motion', 'project', 'mg-templates', 'compositions']) {
			writeFileSync(join(w.root, 'packages', short, 'src', 'extra.ts'), 'export const x = 1;\n');
			const next = remotion.sourceHash(w.entry);
			expect(next, short).not.toBe(prev);
			prev = next;
		}
	});
});
