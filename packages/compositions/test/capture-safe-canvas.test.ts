// @vitest-environment node
// HTML-in-Canvas must capture late video draws, including contexts asking for low latency.
import { type Browser, chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installCaptureSafeCanvases } from '../src/fx/capture-safe-canvas.ts';
import { CHROME } from './gl-browser.ts';

const run = !!CHROME && process.env.FX_GL !== '0';

const PAGE = `<!doctype html><html><body style="margin:0">
<canvas id="host" width="100" height="100" layoutsubtree style="width:100px;height:100px;display:block">
  <div id="root" style="position:relative;width:100px;height:100px">
    <canvas id="video" width="100" height="100"></canvas>
  </div>
</canvas></body></html>`;

/** Paint once before the video's context exists, then capture the late draw. */
const probe = async ({ color, desynchronized }: { color: string; desynchronized?: true }) => {
	const host = document.getElementById('host') as HTMLCanvasElement & {
		requestPaint(): void;
		captureElementImage?(e: Element): ElementImage;
	};
	const ctx = host.getContext('2d') as CanvasRenderingContext2D & {
		drawElementImage(e: unknown, x: number, y: number): void;
	};
	const root = document.getElementById('root')!;
	let last: number[] = [];
	host.addEventListener('paint', () => {
		const image = host.captureElementImage?.(root);
		try {
			ctx.reset();
			ctx.drawElementImage(image ?? root, 0, 0);
			last = Array.from(ctx.getImageData(50, 50, 1, 1).data);
		} finally {
			image?.close();
		}
	});
	const paint = () =>
		new Promise<void>((resolve) => {
			host.addEventListener('paint', () => resolve(), { once: true });
			host.requestPaint();
		});
	await paint();
	const video = (document.getElementById('video') as HTMLCanvasElement).getContext(
		'2d',
		desynchronized ? { alpha: true, desynchronized } : undefined,
	)!;
	video.fillStyle = color;
	video.fillRect(0, 0, 100, 100);
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	await paint();
	return last;
};

const htmlInCanvas = () => {
	const c = document.createElement('canvas') as HTMLCanvasElement & { requestPaint?: unknown };
	const d = c.getContext('2d') as unknown as { drawElementImage?: unknown } | null;
	return typeof c.requestPaint === 'function' && typeof d?.drawElementImage === 'function';
};

describe.runIf(run)('HTML-in-Canvas capture of video canvases', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await chromium.launch({
			executablePath: CHROME!,
			headless: true,
			args: ['--enable-features=CanvasDrawElement'],
		});
	}, 60_000);

	afterAll(async () => {
		await browser?.close();
	});

	it('captures late draws from low-latency and ordinary canvases', async (ctx) => {
		// Use independent origin-aligned hosts so context capture does not depend on sibling placement.
		for (const { color, desynchronized, expected } of [
			{ color: 'rgb(0,255,0)', desynchronized: true as const, expected: [0, 255, 0, 255] },
			{ color: 'rgb(255,0,255)', expected: [255, 0, 255, 255] },
		]) {
			const page = await browser.newPage();
			try {
				await page.setContent(PAGE);
				ctx.skip(
					!(await page.evaluate(htmlInCanvas)),
					`Chrome ${browser.version()} has no HTML-in-Canvas (148+)`,
				);
				await page.evaluate(`(${installCaptureSafeCanvases.toString()})()`);
				expect(await page.evaluate(probe, { color, desynchronized })).toEqual(expected);
			} finally {
				await page.close();
			}
		}
	}, 60_000);
});
