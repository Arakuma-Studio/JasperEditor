// wp-note export-performance §15: renders must not make Remotion read and parse the bundle's source map on the
// engine's main thread, and a failed render still names its original source line (from the side-car map).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RemotionService } from '../src/remotion/service.ts';

const renderer = vi.hoisted(() => ({
	renderStill: vi.fn<() => Promise<void>>(),
}));
vi.mock('@remotion/renderer', () => ({
	renderStill: renderer.renderStill,
	selectComposition: async () => ({
		id: 'JasperSequence',
		width: 16,
		height: 16,
		fps: 30,
		durationInFrames: 30,
	}),
	makeCancelSignal: () => ({ cancelSignal: undefined, cancel: () => undefined }),
}));

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

const root = mkdtempSync(join(tmpdir(), 'jasper-source-map-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A bundle laid out like Remotion's: a module that kept its library's `sourceMappingURL` comment (immer's, in the
 * real bundle; that map is not in the bundle directory), webpack's own reference on the last line, and the map,
 * whose third generated line comes from line 12 of `src/titles/TitleCard.tsx`.
 */
function writeBundle(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'index.html'), '<html></html>');
	writeFileSync(
		join(dir, 'bundle.js'),
		[
			'var immer = 1;',
			'//# sourceMappingURL=immer.mjs.map',
			'function TitleCard() { return undefined.x; }',
			'TitleCard();',
			'//# sourceMappingURL=bundle.js.map',
			'',
		].join('\n'),
	);
	writeFileSync(
		join(dir, 'bundle.js.map'),
		JSON.stringify({
			version: 3,
			file: 'bundle.js',
			sources: ['src/titles/TitleCard.tsx'],
			sourcesContent: ['…'],
			names: [],
			mappings: ';;AAWA',
			sourceRoot: '',
		}),
	);
}

function service(opts: { prebuiltBundleDir: string | null; bundleCacheDir: string }) {
	return new RemotionService({
		...opts,
		usageLog: null,
		env: { JASPER_REMOTION_GL: 'off', JASPER_BROWSER_EXECUTABLE: join(root, 'missing-browser') },
	});
}

describe('Remotion bundle source map', () => {
	it('serves renders a bundle whose source map Remotion does not load', async () => {
		const cache = join(root, 'cache');
		const s = service({ prebuiltBundleDir: null, bundleCacheDir: cache });
		// a dev bundle cached by an engine before this change
		writeBundle(join(cache, s.sourceHash(s.entryPoint()!)));
		const serveUrl = await s.serveUrl();
		await expect(remotionLocalMap(join(serveUrl, 'bundle.js'))).resolves.toBeNull();
	});

	it('names the original source line of a failed render', async () => {
		const bundle = join(root, 'prebuilt');
		writeBundle(bundle);
		const err = new Error("Cannot read properties of undefined (reading 'x')");
		err.stack = [
			"TypeError: Cannot read properties of undefined (reading 'x')",
			'    at TitleCard (http://localhost:3000/bundle.js:3:31)',
			'    at http://localhost:3000/bundle.js:4:1',
		].join('\n');
		renderer.renderStill.mockRejectedValueOnce(err);
		const render = service({ prebuiltBundleDir: bundle, bundleCacheDir: join(root, 'unused') }).renderStill({
			inputProps: { doc: { videoTracks: [] } },
			output: join(root, 'still.png'),
			frame: 0,
			signal: new AbortController().signal,
		});
		await expect(render).rejects.toMatchObject({
			code: 'RENDER_FAILED',
			message: expect.stringContaining('at TitleCard (src/titles/TitleCard.tsx:12)'),
		});
	});

	it('serves renders the bundle over HTTP without its map, and names the source line of a frame served there', async () => {
		const bundle = join(root, 'prebuilt-http');
		writeBundle(bundle);
		const s = service({ prebuiltBundleDir: bundle, bundleCacheDir: join(root, 'unused-http') });
		const url = await s.renderServeUrl();
		const base = url.slice(0, url.lastIndexOf('/') + 1);
		expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
		// Given an HTTP serve URL, Remotion downloads and parses `<serveUrl>/bundle.js.map` for every render.
		expect((await fetch(`${base}bundle.js.map`)).status).toBe(404);
		expect((await fetch(`${base}bundle.js`)).status).toBe(200);
		const err = new Error("Cannot read properties of undefined (reading 'x')");
		err.stack = [
			"TypeError: Cannot read properties of undefined (reading 'x')",
			`    at TitleCard (${base}bundle.js:3:31)`,
		].join('\n');
		renderer.renderStill.mockRejectedValueOnce(err);
		const render = s.renderStill({
			inputProps: { doc: { videoTracks: [] } },
			output: join(root, 'still-http.png'),
			frame: 0,
			signal: new AbortController().signal,
		});
		await expect(render).rejects.toMatchObject({
			message: expect.stringContaining('at TitleCard (src/titles/TitleCard.tsx:12)'),
		});
		await s.stop();
	});
});
