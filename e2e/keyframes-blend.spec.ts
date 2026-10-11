// HTML-in-Canvas enables GPU compositing, as in Electron and Remotion.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	clipBox,
	createProject,
	enableAgentBridge,
	expectTransaction,
	exportViaUi,
	query,
	timelineArea,
	transact,
} from './support.ts';

test.use({ launchOptions: { args: ['--enable-features=CanvasDrawElement'] } });
test.describe.configure({ mode: 'serial' });

let page: Page;
let seqId = '';
let top = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Keyframes blend');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
});
test.afterAll(async () => {
	await page?.close();
});

/** Mean colour of the Program monitor output (its canvases / videos / images drawn into a small canvas). */
async function programColor(): Promise<[number, number, number]> {
	return page.getByTestId('program-player-wrapper').evaluate((root) => {
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
		const d = g.getImageData(w / 2, h / 2, 1, 1).data;
		return [d[0]!, d[1]!, d[2]!] as [number, number, number];
	});
}

test('Blend Mode menu: grouped, Linear Burn previewed by the GL compositor', async () => {
	const base = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0.8, 0.6, 0.4, 1] },
	]);
	expectTransaction(base);
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V2', color: [0.5, 0.5, 0.9, 1] },
	]);
	expectTransaction(r);
	top = r.created.find((id) => id.startsWith('clp_'))!;
	const b = await clipBox(page, top);
	const area = (await timelineArea(page).boundingBox())!;
	await page.mouse.click(
		(Math.max(b.x, area.x + 4) + Math.min(b.x + b.width, area.x + area.width - 4)) / 2,
		b.y + b.height / 2,
	);
	const select = page.getByTestId('prop-blendMode').first();
	await expect(select).toBeVisible();
	const groups = await select.evaluate((el) =>
		[...el.querySelectorAll('optgroup')].map((g) => (g as HTMLOptGroupElement).label),
	);
	expect(groups).toEqual(['Normal', 'Subtractive', 'Additive', 'Complex', 'Difference', 'HSL', 'Utility']);
	await select.selectOption('linear-burn');
	const clip = await query<{ blendMode: string }>(page, 'doc.get', {
		path: ['sequences', seqId, 'clips', top],
		fields: ['blendMode'],
	});
	expect(clip.blendMode).toBe('linear-burn');
	// max(cb + cs − 1, 0) = (0.3, 0.1, 0.3) → (77, 26, 77).
	await expect
		.poll(
			async () => {
				const c = await programColor();
				return Math.max(Math.abs(c[0] - 77), Math.abs(c[1] - 26), Math.abs(c[2] - 77));
			},
			{ timeout: 20_000 },
		)
		.toBeLessThanOrEqual(3);
	await page.screenshot({ path: 'test-results/keyframes-blend-linear-burn.png' });
});

test('the native export draws the same blend', async ({ request }) => {
	const outDir = mkdtempSync(join(tmpdir(), 'jasper-e2e-blend-'));
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'blend.mp4',
		expectPath: /native/i,
		outDir,
	});
	const raw = execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		...['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1'],
		...['-vf', 'crop=16:16:iw/2:ih/2,scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-'],
	]);
	// H.264 4:2:0 round trip: within a few code values.
	expect(Math.abs(raw[0]! - 77)).toBeLessThanOrEqual(4);
	expect(Math.abs(raw[1]! - 26)).toBeLessThanOrEqual(4);
	expect(Math.abs(raw[2]! - 77)).toBeLessThanOrEqual(4);
});

test('right-click a key ▸ Rove Across Time re-times it', async () => {
	expect(
		(
			await transact(page, [
				{ type: 'keyframe.add', target: ['clip', top, 'opacity'], at: { frames: 0 }, value: 0 },
				{ type: 'keyframe.add', target: ['clip', top, 'opacity'], at: { frames: 10 }, value: 80 },
				{ type: 'keyframe.add', target: ['clip', top, 'opacity'], at: { frames: 40 }, value: 100 },
			])
		).ok,
	).toBe(true);
	const keys = async () =>
		(
			await query<{ opacity: { keyframes: { id: string; time: number; roving?: boolean }[] } }>(
				page,
				'doc.get',
				{
					path: ['sequences', seqId, 'clips', top],
					fields: ['opacity'],
				},
			)
		).opacity.keyframes;
	const mid = (await keys())[1]!;
	await page.getByText('Effect Controls', { exact: true }).first().click();
	await page.locator(`button[data-kf-id="${mid.id}"]`).first().click({ button: 'right' });
	await page.getByTestId('ec-kf-rove').click();
	await expect.poll(async () => (await keys())[1]!.roving).toBe(true);
	// 80 of the 100 units of the run → 80 % of its span (frame 32 of 40).
	const k = await keys();
	expect((k[1]!.time - k[0]!.time) / (k[2]!.time - k[0]!.time)).toBeCloseTo(0.8, 4);
	await expect(page.locator(`button[data-kf-id="${mid.id}"]`).first()).toHaveAttribute(
		'data-kf-shape',
		'roving',
	);
});
