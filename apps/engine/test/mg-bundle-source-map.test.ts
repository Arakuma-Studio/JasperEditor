// wp-note export-performance §15: imported motion-graphics bundles are served to Remotion without a source-map
// reference (Remotion would read and parse the map on the main thread for every render), under the key of the bundle
// as imported, without touching the user's folder; a failed pre-render names its original source line.
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { EMPTY_PROBE, MG_REMOTION_VERSION } from '@jasper/project';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hashBundleDir } from '../src/mg-bundles/hash.ts';
import { mgBundleService } from '../src/routes/mg-bundles.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, JSON_H, makeApp, tempAppdir } from './helpers.ts';

/**
 * Remotion 4.0.499's local source-map lookup, the one its `prepareServer` runs for every render on
 * `<serveUrl>/bundle.js` (the module is not in the package's exports, hence the file path).
 */
const remotionLocalMap = createRequire(import.meta.url)(
	join(
		dirname(createRequire(import.meta.url).resolve('@remotion/renderer/package.json')),
		'dist',
		'symbolicate-stacktrace.js',
	),
).getSourceMapFromLocalFile as (bundleJs: string) => Promise<unknown>;

/** What Remotion's lookup found in each directory a (mocked) Remotion call was given. */
const lookups = vi.hoisted(() => [] as unknown[]);
const renderer = vi.hoisted(() => ({ selectComposition: vi.fn() }));
vi.mock('@remotion/renderer', () => ({
	getCompositions: async (serveUrl: string) => {
		lookups.push(await remotionLocalMap(join(serveUrl, 'bundle.js')));
		return [{ id: 'Title', width: 64, height: 36, fps: 30, durationInFrames: 30, defaultProps: {} }];
	},
	selectComposition: renderer.selectComposition,
	makeCancelSignal: () => ({ cancelSignal: undefined, cancel: () => undefined }),
}));

afterAll(async () => {
	await closeApps();
});

/**
 * A built bundle laid out like `remotion bundle`'s: a module that kept its library's `sourceMappingURL` comment (that
 * map is not in the bundle), webpack's reference on the last line, and the map, whose third generated line comes
 * from line 12 of `src/Title.tsx`.
 */
function builtBundle(dir: string): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'index.html'),
		`<!DOCTYPE html><html><body><script>window.siteVersion = '11'; window.remotion_version = '${MG_REMOTION_VERSION}';</script><script src="./bundle.js"></script></body></html>`,
	);
	writeFileSync(
		join(dir, 'bundle.js'),
		[
			'var lib = 1;',
			'//# sourceMappingURL=index.mjs.map',
			'function Title() { return undefined.x; }',
			'//# sourceMappingURL=bundle.js.map',
			'',
		].join('\n'),
	);
	writeFileSync(
		join(dir, 'bundle.js.map'),
		JSON.stringify({ version: 3, sources: ['src/Title.tsx'], names: [], mappings: ';;AAWA' }),
	);
	return dir;
}

describe('mg bundle source maps', () => {
	it("imports a bundle folder under its own key, served without a map reference, the user's folder untouched", async () => {
		const app = await makeApp();
		const folder = builtBundle(join(tempAppdir('jasper-mg-user-'), 'daycard'));
		const before = readFileSync(join(folder, 'bundle.js'));
		const { hash } = await hashBundleDir(folder);
		lookups.length = 0;
		const r = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/import',
			headers: JSON_H,
			payload: { path: folder },
		});
		expect(r.statusCode, r.body).toBe(200);
		expect(r.json().mediaKey).toBe(`mk_${hash.slice(0, 24)}`);
		expect(lookups).toEqual([null]);
		expect(readFileSync(join(folder, 'bundle.js'))).toEqual(before);
	});

	it('serves a bundle stored before without a map reference; a failed pre-render names its source line', async () => {
		const app = await makeApp();
		const svc = mgBundleService(app)!;
		// stored by an engine before this change: references still in place
		const src = builtBundle(join(tempAppdir('jasper-mg-old-'), 'bundle'));
		const { hash } = await hashBundleDir(src);
		const stored = join(svc.bundlesDir, hash);
		cpSync(src, stored, { recursive: true });
		const index = join(stored, 'index.html');
		const st = statSync(index);
		const key = `mk_${hash.slice(0, 24)}`;
		await coreServices(app).registry.put({
			mediaKey: key,
			fingerprint: `q1:${hash}`,
			originalName: 'old',
			sizeBytes: st.size,
			mtimeMs: st.mtimeMs,
			container: 'remotion-bundle',
			kind: 'mg-bundle',
			probe: EMPTY_PROBE,
			browserPlayable: 'no',
			storage: { type: 'managed', path: index },
			durationSec: null,
			display: null,
			hasAudio: false,
			registeredAt: '2026-10-01T00:00:00.000Z',
			mgBundle: {
				remotionVersion: MG_REMOTION_VERSION,
				bundleHash: hash,
				builtAt: '2026-10-01T00:00:00.000Z',
				source: { type: 'bundle-upload', path: null, name: 'old' },
				compositions: [
					{
						id: 'Title',
						width: 64,
						height: 36,
						fps: 30,
						durationInFrames: 30,
						defaultProps: {},
						propsSchema: { type: 'object', properties: {} },
						schemaSource: 'inferred',
					},
				],
			},
		});
		lookups.length = 0;
		renderer.selectComposition.mockImplementationOnce(async ({ serveUrl }: { serveUrl: string }) => {
			lookups.push(await remotionLocalMap(join(serveUrl, 'bundle.js')));
			const err = new Error("Cannot read properties of undefined (reading 'x')");
			err.stack = [
				"TypeError: Cannot read properties of undefined (reading 'x')",
				'    at Title (http://localhost:3000/bundle.js:3:28)',
			].join('\n');
			throw err;
		});
		const r = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/prerender',
			headers: JSON_H,
			payload: {
				mediaKey: key,
				compositionId: 'Title',
				props: {},
				width: 64,
				height: 36,
				fps: { num: 30, den: 1 },
				startFrame: 0,
				durationFrames: 1,
				quality: 'master',
			},
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done: EngineJob = await coreServices(app).queue.wait(r.json().id);
		expect(lookups).toEqual([null]);
		expect(done.error).toMatchObject({
			code: 'MG_RENDER_FAILED',
			message: expect.stringContaining('at Title (src/Title.tsx:12)'),
		});
	});
});
