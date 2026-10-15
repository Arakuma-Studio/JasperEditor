// @vitest-environment node
// HTML-in-Canvas misses draws from desynchronized 2D canvases after the host's first paint.
import { type Browser, chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installCaptureSafeCanvases } from '../src/fx/capture-safe-canvas.ts';
import { CHROME } from './gl-browser.ts';

const run = !!CHROME && process.env.FX_GL !== '0';

const PAGE = `<!doctype html><html><body style="margin:0">
<canvas id="host" width="200" height="100" layoutsubtree style="width:200px;height:100px;display:block">
  <div id="root" style="position:relative;width:200px;height:100px">
    <canvas id="low" width="100" height="100" style="position:absolute;left:0;top:0"></canvas>
    <canvas id="plain" width="100" height="100" style="position:absolute;left:100px;top:0"></canvas>
  </div>
</canvas></body></html>`;

/** Captures the host after drawing both canvases (one asked for a low-latency context) once the host has painted. */
const probe = async () => {
	const host = document.getElementById('host') as HTMLCanvasElement & { requestPaint(): void };
	const ctx = host.getContext('2d') as CanvasRenderingContext2D & {
		drawElementImage(e: Element, x: number, y: number): void;
	};
	let last: number[][] = [];
	host.addEventListener('paint', () => {
		ctx.clearRect(0, 0, 200, 100);
		ctx.drawElementImage(document.getElementById('root')!, 0, 0);
		last = [50, 150].map((x) => Array.from(ctx.getImageData(x, 50, 1, 1).data));
	});
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	host.requestPaint();
	await sleep(200);
	const low = (document.getElementById('low') as HTMLCanvasElement).getContext('2d', {
		alpha: true,
		desynchronized: true,
	} as CanvasRenderingContext2DSettings)!;
	low.fillStyle = 'rgb(0,255,0)';
	low.fillRect(0, 0, 100, 100);
	const plain = (document.getElementById('plain') as HTMLCanvasElement).getContext('2d')!;
	plain.fillStyle = 'rgb(255,0,255)';
	plain.fillRect(0, 0, 100, 100);
	await sleep(300);
	host.requestPaint();
	await sleep(300);
	return last;
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

	it('captures late draws from low-latency and ordinary canvases', async () => {
		const fixed = await browser.newPage();
		await fixed.setContent(PAGE);
		await fixed.evaluate(`(${installCaptureSafeCanvases.toString()})()`);
		const after = await fixed.evaluate(probe);
		expect(after[0]).toEqual([0, 255, 0, 255]);
		expect(after[1]).toEqual([255, 0, 255, 255]);
	}, 60_000);
});
