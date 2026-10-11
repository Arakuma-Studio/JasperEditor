// HTML-in-Canvas enables GPU compositing, as in Electron and Remotion.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, exportViaUi, transact } from './support.ts';

test.use({ launchOptions: { args: ['--enable-features=CanvasDrawElement'] } });
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Compositor');
});
test.afterAll(async () => {
	await page?.close();
});

/** Mean colour of the Program monitor's centre (its canvases drawn into a small canvas). */
async function programColor(x = 0.5, y = 0.5): Promise<[number, number, number]> {
	return page.getByTestId('program-player-wrapper').evaluate(
		(root, [fx, fy]) => {
			const w = 64;
			const h = 36;
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			const g = c.getContext('2d', { willReadFrequently: true })!;
			for (const s of [...root.querySelectorAll('canvas')] as HTMLCanvasElement[]) {
				try {
					g.drawImage(s, 0, 0, w, h);
				} catch {
					// not drawable
				}
			}
			const d = g.getImageData(Math.floor(w * fx!), Math.floor(h * fy!), 1, 1).data;
			return [d[0]!, d[1]!, d[2]!] as [number, number, number];
		},
		[x, y],
	);
}

const near = async (want: [number, number, number], tol = 4, x = 0.5, y = 0.5) =>
	expect
		.poll(
			async () => {
				const c = await programColor(x, y);
				return Math.max(...c.map((v, i) => Math.abs(v - want[i]!)));
			},
			{ timeout: 30_000 },
		)
		.toBeLessThanOrEqual(tol);

test('an adjustment layer with a GPU effect over a GL blend mode: the Program monitor draws it flat', async () => {
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0.8, 0.6, 0.4, 1] },
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V2', color: [0.5, 0.5, 0.9, 1], ref: '$b' },
		{ type: 'clip.update', clipId: '$b', patch: { blendMode: 'linear-burn' } },
		{ type: 'clip.addAdjustment', at: 0, duration: 90, track: 'V3', ref: '$adj' },
		{ type: 'effect.add', target: { clipId: '$adj' }, effectId: 'jasper.invert' },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	// Linear Burn: (0.3, 0.1, 0.3) → inverted (0.7, 0.9, 0.7) → (179, 230, 179).
	await near([179, 230, 179]);
	await expect(page.locator('[data-canvas-scope-nested], [data-canvas-scope-chip]')).toHaveCount(0);
	await expect(page.locator('[data-flat-compositor]')).toHaveCount(1);
	await page.screenshot({ path: 'test-results/compositor-adjust-over-blend.png' });
});

test('the export renders the same stack (Remotion path)', async ({ request }) => {
	const outDir = mkdtempSync(join(tmpdir(), 'jasper-e2e-compositor-'));
	const { file } = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'compositor.mp4',
		expectPath: /remotion/i,
		outDir,
		jobTimeoutMs: 600_000,
	});
	const raw = execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		...['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1'],
		...['-vf', 'crop=16:16:iw/2:ih/2,scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-'],
	]);
	expect(Math.abs(raw[0]! - 179)).toBeLessThanOrEqual(4);
	expect(Math.abs(raw[1]! - 230)).toBeLessThanOrEqual(4);
	expect(Math.abs(raw[2]! - 179)).toBeLessThanOrEqual(4);
});

test('a 3D layer joins the stack (a 3D run over the adjustment layer)', async () => {
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V4', color: [1, 0, 0, 1], ref: '$c' },
		{ type: 'param.set', target: ['clip', '$c', 'transform', 'scale'], value: 30 },
		{ type: 'clip.set3d', clipIds: ['$c'], enabled: true },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	// The red card in the centre, the inverted blend around it.
	await near([255, 0, 0], 6);
	await near([179, 230, 179], 4, 0.05, 0.08);
	await page.screenshot({ path: 'test-results/compositor-3d-in-stack.png' });
});

test('a Rec. 2100 PQ sequence keeps its display transform while the stack draws', async () => {
	const r = await transact(page, [
		{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq' } },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await expect(page.locator('[data-display-chip]')).toHaveCount(0);
	await expect(page.locator('[data-flat-compositor]')).toHaveCount(1);
	await page.screenshot({ path: 'test-results/compositor-pq-display.png' });
});
