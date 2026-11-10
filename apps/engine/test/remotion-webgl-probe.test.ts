// The render browser's WebGL probe prefers a GPU back end. Headless Chrome on Linux gives a SwiftShader WebGL2 context
// with its default `gl`; the probe used to stop there, so a machine with an NVIDIA GPU baked graphics on the CPU for
// hours. The browser is replaced by a renderer whose WebGL depends on the `gl` it was opened with.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemotionService } from '../src/remotion/service.ts';

const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)';
const NVIDIA = 'ANGLE (NVIDIA GeForce RTX 3080 Ti, OpenGL ES 3.2)';

// A Linux host without a GPU device node skips the GPU back ends; this one has an NVIDIA card.
vi.mock('node:fs', async (importOriginal) => {
	const fs = await importOriginal<typeof import('node:fs')>();
	return { ...fs, existsSync: (p: string) => p === '/dev/nvidia0' || fs.existsSync(p) };
});
const browsers = vi.hoisted(() => ({ renderers: new Map<string, string>() }));
vi.mock('@remotion/renderer', () => ({
	openBrowser: async (_name: string, opts: { chromiumOptions: { gl: string | null } }) => {
		const renderer = browsers.renderers.get(opts.chromiumOptions.gl ?? 'default');
		return {
			newPage: async () => ({
				evaluate: async () =>
					renderer ? { renderer, floatTargets: true, maxRenderbufferSize: 16384 } : null,
			}),
			close: async () => undefined,
		};
	},
}));

const dir = mkdtempSync(join(tmpdir(), 'jasper-webgl-probe-'));
writeFileSync(join(dir, 'index.html'), '<html></html>');
writeFileSync(join(dir, 'chrome'), '');
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => browsers.renderers.clear());

const probe = () =>
	new RemotionService({
		bundleCacheDir: dir,
		prebuiltBundleDir: dir,
		usageLog: null,
		env: { JASPER_BROWSER_EXECUTABLE: join(dir, 'chrome') },
	}).probeWebgl();

describe('the render browser WebGL probe', () => {
	it('uses the GPU back end when Chrome’s default gives SwiftShader', async () => {
		browsers.renderers.set('default', SWIFTSHADER);
		browsers.renderers.set('angle-egl', NVIDIA);
		await expect(probe()).resolves.toMatchObject({
			state: 'ok',
			gl: 'angle-egl',
			renderer: NVIDIA,
			hardware: true,
		});
	});

	it('reports software rendering, and how to get the GPU, when no back end reaches one', async () => {
		browsers.renderers.set('default', SWIFTSHADER);
		browsers.renderers.set('swangle', SWIFTSHADER);
		const s = await probe();
		expect(s).toMatchObject({ state: 'ok', gl: null, renderer: SWIFTSHADER, hardware: false });
		expect(s.message).toContain('JASPER_REMOTION_GL=angle-egl');
	});
});
