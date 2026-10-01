// M2 animation contracts on the engine (ARCHITECTURE §20.5, S11): routes/anime.ts (licence + features.anime),
// routes/layer-bake.ts (501 stub, registration order), LayerOverride additions, and the Remotion bundle source
// hash covering @jasper/motion and pnpm-lock.yaml (S11:FIX-009).
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineCapabilitiesSchema, LicensesResponseSchema } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import { TEXT_ANIMATION_SPECS } from '@jasper/project';
import { afterEach, describe, expect, it } from 'vitest';
import { ANIMEJS_PINNED_VERSION, animejsPackageDir, animeLicense } from '../src/anime/index.ts';
import type { LayerOverride } from '../src/export/native-ext.ts';
import { createServer, engineConfig } from '../src/index.ts';
import { BUNDLED_WORKSPACE_PACKAGES, remotionSourceHash } from '../src/remotion/service.ts';
import animeRoutes from '../src/routes/anime.ts';
import { ROUTE_PLUGINS } from '../src/routes/index.ts';
import layerBakeRoutes from '../src/routes/layer-bake.ts';
import mgBundleRoutes from '../src/routes/mg-bundles.ts';
import trackingRoutes from '../src/routes/tracking.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
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
	it('the pinned version matches packages/motion and the installed package', () => {
		const pkg = JSON.parse(readFileSync(join(repo, 'packages', 'motion', 'package.json'), 'utf8'));
		expect(pkg.dependencies.animejs).toBe(ANIMEJS_PINNED_VERSION);
		const dir = animejsPackageDir();
		expect(dir).not.toBeNull();
		expect(JSON.parse(readFileSync(join(dir!, 'package.json'), 'utf8')).version).toBe(ANIMEJS_PINNED_VERSION);
		// The committed fallback is the package's own licence text.
		expect(readFileSync(join(repo, 'apps/engine/src/anime/third-party/LICENSE-animejs.txt'), 'utf8')).toBe(
			readFileSync(join(dir!, 'LICENSE.md'), 'utf8'),
		);
	});
	it('lists anime.js (MIT, with its text) in /api/licenses and fills features.anime', async () => {
		expect(animeLicense()).toMatchObject({ id: 'animejs', license: 'MIT', version: '4.5.0', bundled: true });
		const app = await make();
		const lic = LicensesResponseSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/licenses', headers: H })).json(),
		);
		const anime = lic.components.filter((c) => c.id === 'animejs');
		expect(anime).toHaveLength(1);
		expect(anime[0]!.texts[0]!.text).toMatch(/MIT License[\s\S]*Julian Garnier/);
		const caps = EngineCapabilitiesSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json(),
		);
		expect(caps.features?.anime).toEqual({
			animejs: '4.5.0',
			textPresets: TEXT_ANIMATION_SPECS.length,
			templates: mgRegistry.list().filter((t) => t.renderer === 'anime').length,
		});
	});
	it('packaged-like: without the installed package, the committed licence text and the pinned version', () => {
		const lic = animeLicense(null);
		expect(lic).toMatchObject({
			id: 'animejs',
			version: ANIMEJS_PINNED_VERSION,
			license: 'MIT',
			bundled: true,
		});
		expect(lic.texts[0]!.text).toBe(
			readFileSync(join(repo, 'apps/engine/src/anime/third-party/LICENSE-animejs.txt'), 'utf8'),
		);
	});
});

describe('layer bake contracts (routes/layer-bake.ts)', () => {
	it('is registered after mg-bundles and before tracking; anime is appended', () => {
		const order = ROUTE_PLUGINS as readonly unknown[];
		const lb = order.indexOf(layerBakeRoutes);
		expect(lb).toBeGreaterThan(order.indexOf(mgBundleRoutes));
		expect(lb).toBeLessThan(order.indexOf(trackingRoutes));
		expect(order.indexOf(animeRoutes)).toBe(order.length - 1);
	});
	// wp-m2-layer-bake: the 501 stub is replaced by the real route (covered in layer-bake.test.ts).
	it('POST /api/layer-bake/preview is implemented (validates its body)', async () => {
		const app = await make();
		const r = await app.inject({
			method: 'POST',
			url: '/api/layer-bake/preview',
			headers: { ...H, 'content-type': 'application/json' },
			payload: '{"clipId":"clp_1"}',
		});
		expect(r.statusCode).toBe(400);
		expect(r.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
	});
	it('LayerOverride carries still / rect / colorRuns (types only)', () => {
		const o: LayerOverride = {
			path: '/cache/layers/k/still.png',
			space: 'sequence',
			startFrame: 0,
			includesFades: true,
			still: true,
			rect: { x: 10, y: 20, w: 300, h: 100 },
			colorRuns: true,
		};
		expect(o.rect?.w).toBe(300);
	});
});

describe('Remotion bundle source hash (S11:FIX-009)', () => {
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
		for (const dep of BUNDLED_WORKSPACE_PACKAGES) {
			const short = dep.split('/')[1]!;
			pkg(join(root, 'packages', short), dep);
			symlinkSync(join(root, 'packages', short), join(comp, 'node_modules', '@jasper', short), 'dir');
		}
		return { root, entry: join(comp, 'src', 'remotion-entry.ts') };
	}
	it('changes with the lockfile and with the sources of every bundled workspace package', () => {
		const w = workspace();
		const h0 = remotionSourceHash(w.entry);
		expect(h0).toMatch(/^[0-9a-f]{16}$/);
		expect(remotionSourceHash(w.entry)).toBe(h0);
		writeFileSync(join(w.root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# animejs 4.5.1\n");
		const h1 = remotionSourceHash(w.entry);
		expect(h1).not.toBe(h0);
		let prev = h1;
		for (const short of ['motion', 'project', 'mg-templates', 'compositions']) {
			writeFileSync(join(w.root, 'packages', short, 'src', 'extra.ts'), 'export const x = 1;\n');
			const next = remotionSourceHash(w.entry);
			expect(next, short).not.toBe(prev);
			prev = next;
		}
	});
	it('hashes the real workspace (motion included)', () => {
		const entry = join(repo, 'packages', 'compositions', 'src', 'remotion-entry.ts');
		expect(remotionSourceHash(entry)).toMatch(/^[0-9a-f]{16}$/);
	});
});
