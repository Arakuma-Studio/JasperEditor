// Recovery policy is documented in docs/verification.md §8 #5: overloaded concurrent
// renders retry once on one page. Faults belong to the external renderer; the real service retries.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemotionService } from '../src/remotion/service.ts';

const renderer = vi.hoisted(() => ({
	renderMedia: vi.fn<(options: { concurrency: number }) => Promise<void>>(),
	selectComposition: vi.fn(async () => ({
		id: 'JasperSequence',
		width: 16,
		height: 16,
		fps: 30,
		durationInFrames: 30,
	})),
}));
vi.mock('@remotion/renderer', () => ({
	renderMedia: renderer.renderMedia,
	selectComposition: renderer.selectComposition,
	makeCancelSignal: () => ({ cancelSignal: undefined, cancel: () => undefined }),
}));

const bundle = mkdtempSync(join(tmpdir(), 'jasper-retry-'));
writeFileSync(join(bundle, 'index.html'), '<html></html>');
afterAll(() => rmSync(bundle, { recursive: true, force: true }));
beforeEach(() => {
	renderer.renderMedia.mockReset();
	renderer.selectComposition.mockReset();
});
const timeout = () => new Error('delayRender timed out at frame 12');

function render(signal = new AbortController().signal, concurrency = 4, intermediate444 = false) {
	const service = new RemotionService({
		bundleCacheDir: bundle,
		prebuiltBundleDir: bundle,
		usageLog: null,
		// These scenes need no GL. An unavailable configured browser prevents host-specific discovery;
		// rendering itself is supplied by the SDK fault fixture, without starting Chrome.
		env: { JASPER_REMOTION_GL: 'off', JASPER_BROWSER_EXECUTABLE: join(bundle, 'missing-browser') },
	});
	return service.renderMedia({
		inputProps: { doc: { videoTracks: [] } },
		output: join(bundle, 'output.mov'),
		signal,
		concurrency,
		intermediate: true,
		...(intermediate444 ? { intermediate444: true } : {}),
	});
}

describe('RemotionService timeout recovery', () => {
	it('reports a composition setup timeout as retryable RENDER_TIMEOUT', async () => {
		renderer.selectComposition.mockRejectedValueOnce(
			new Error('Timed out after 60000ms while setting up the headless browser.'),
		);
		renderer.renderMedia.mockResolvedValue(undefined);
		await expect(render()).rejects.toMatchObject({ code: 'RENDER_TIMEOUT', retryable: true });
	});

	it('reports cancellation during composition setup as JOB_CANCELLED', async () => {
		const controller = new AbortController();
		renderer.selectComposition.mockImplementationOnce(async () => {
			controller.abort();
			throw new Error('Timed out after 60000ms while setting up the headless browser.');
		});
		renderer.renderMedia.mockResolvedValue(undefined);
		await expect(render(controller.signal)).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
	});

	it('recovers a concurrent renderer timeout through the public render operation', async () => {
		renderer.renderMedia.mockImplementation(async ({ concurrency }) => {
			if (concurrency !== 1) throw timeout();
		});
		await expect(render()).resolves.toEqual({ frames: 30 });
	});

	it('reports RENDER_TIMEOUT after the recovery attempt also times out', async () => {
		renderer.renderMedia
			.mockRejectedValueOnce(timeout())
			.mockRejectedValueOnce(timeout())
			.mockResolvedValue(undefined);
		await expect(render()).rejects.toMatchObject({ code: 'RENDER_TIMEOUT', retryable: true });
	});

	it.each([
		{ name: 'unrelated render failure', concurrency: 4, cancelled: false, code: 'RENDER_FAILED' },
		{ name: 'one-page timeout', concurrency: 1, cancelled: false, code: 'RENDER_TIMEOUT' },
		{ name: 'cancellation during render failure', concurrency: 4, cancelled: true, code: 'JOB_CANCELLED' },
	])('does not retry $name', async ({ concurrency, cancelled, code }) => {
		const controller = new AbortController();
		renderer.renderMedia
			.mockImplementationOnce(async () => {
				if (cancelled) controller.abort();
				throw code === 'RENDER_FAILED' ? new Error('encoder failed') : timeout();
			})
			.mockResolvedValue(undefined);
		await expect(render(controller.signal, concurrency)).rejects.toMatchObject({ code });
	});
});

describe('the Remotion intermediate (AGENTS §4)', () => {
	it('keeps full chroma for a 4:4:4 output: ProRes 4444 at yuv444p10le, not 422 HQ', async () => {
		renderer.selectComposition.mockResolvedValue({
			id: 'JasperSequence',
			width: 16,
			height: 16,
			fps: 30,
			durationInFrames: 30,
		});
		renderer.renderMedia.mockResolvedValue(undefined);
		await render(new AbortController().signal, 1, true);
		expect(renderer.renderMedia.mock.calls.at(-1)![0]).toMatchObject({
			codec: 'prores',
			proResProfile: '4444',
			pixelFormat: 'yuv444p10le',
			imageFormat: 'png',
		});
		await render(new AbortController().signal, 1, false);
		expect(renderer.renderMedia.mock.calls.at(-1)![0]).toMatchObject({
			codec: 'prores',
			proResProfile: 'hq',
		});
		expect(renderer.renderMedia.mock.calls.at(-1)![0]).not.toHaveProperty('pixelFormat');
	});
});

describe('the sequence composition (wp-note export-performance §13)', () => {
	it('comes from the document, without loading the bundle in a page of its own', async () => {
		renderer.renderMedia.mockResolvedValue(undefined);
		const doc = {
			settings: { width: 1080, height: 1350, fps: { num: 30000, den: 1001 } },
			durationFrames: 0,
			videoTracks: [],
		};
		const options = { isPreview: false, useProxies: false, transparentBackground: true };
		const service = new RemotionService({
			bundleCacheDir: bundle,
			prebuiltBundleDir: bundle,
			usageLog: null,
			env: { JASPER_REMOTION_GL: 'off', JASPER_BROWSER_EXECUTABLE: join(bundle, 'missing-browser') },
		});
		await expect(
			service.renderMedia({
				inputProps: { doc, options },
				output: join(bundle, 'output.mov'),
				signal: new AbortController().signal,
				concurrency: 1,
				intermediate: true,
			}),
		).resolves.toEqual({ frames: 1 });
		expect(renderer.selectComposition).not.toHaveBeenCalled();
		expect(renderer.renderMedia.mock.calls.at(-1)![0]).toMatchObject({
			composition: {
				id: 'JasperSequence',
				width: 1080,
				height: 1350,
				fps: 30000 / 1001,
				durationInFrames: 1,
				props: { doc, options },
			},
		});
		await service.stop();
	});
});
