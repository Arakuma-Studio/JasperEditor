// The two clips are placed by the in-page agent API (setup only) so they have media handles around the cut.

import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	importFiles,
	mediaIdForFile,
	query,
	ROOT,
	timelineArea,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

type Tr = {
	id: string;
	effectId: string;
	duration: number;
	alignment: string;
	outgoingClipId: string | null;
	incomingClipId: string | null;
};

let page: Page;
let seqId = '';
let cut = 0;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

async function transitions(): Promise<Tr[]> {
	const t = await query<Record<string, Tr>>(page, 'doc.get', { path: ['sequences', seqId, 'transitions'] });
	return Object.values(t ?? {});
}

async function videoTransitionAtCut(): Promise<Tr | undefined> {
	const [b] = (await clips(page, ['V1'])).filter((c) => c.start === cut);
	return (await transitions()).find((t) => t.incomingClipId === b?.id);
}

/**
 * Mean RGB of the centre of the Program monitor as composited on screen (an element screenshot decoded in
 * the page: the preview's layer opacities are CSS, so reading the layer canvases would miss the mix).
 */
async function programRgb(): Promise<[number, number, number]> {
	const shot = await page.getByTestId('program-player-wrapper').screenshot();
	return page.evaluate(async (b64) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		const g = c.getContext('2d', { willReadFrequently: true })!;
		g.drawImage(img, 0, 0);
		const w = Math.max(1, Math.floor(img.width / 4));
		const h = Math.max(1, Math.floor(img.height / 4));
		const d = g.getImageData(
			Math.floor(img.width / 2 - w / 2),
			Math.floor(img.height / 2 - h / 2),
			w,
			h,
		).data;
		const sum = [0, 0, 0];
		for (let i = 0; i < d.length; i += 4) {
			sum[0] += d[i]!;
			sum[1] += d[i + 1]!;
			sum[2] += d[i + 2]!;
		}
		const n = d.length / 4;
		return [sum[0]! / n, sum[1]! / n, sum[2]! / n] as [number, number, number];
	}, shot.toString('base64'));
}

async function seek(frame: number) {
	await query(page, 'playhead.set', { frame });
}

test('drag Cross Dissolve from the Effects panel onto the cut → drawn, Program shows the mix; Ctrl+Z removes it', async () => {
	await createProject(page, 'E2E Transitions');
	await importFiles(page, ['xfade-red.mp4', 'xfade-blue.mp4']);
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	const a = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: await mediaIdForFile(page, 'xfade-red.mp4') },
			at: 0,
			sourceRange: { in: { seconds: 1 }, out: { seconds: 5 } },
		},
	]);
	expect(a.ok, JSON.stringify(a)).toBe(true);
	cut = (await clips(page, ['V1']))[0]!.end;
	const b = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: await mediaIdForFile(page, 'xfade-blue.mp4') },
			at: cut,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 5 } },
		},
	]);
	expect(b.ok, JSON.stringify(b)).toBe(true);
	expect((await clips(page, ['V1'])).map((c) => c.start)).toEqual([0, cut]);
	await expect(page.getByTestId('jobs-badge')).toHaveAttribute('data-active', '0', { timeout: 90_000 });
	await seek(cut - 1);
	await expect.poll(async () => (await programRgb())[0], { timeout: 30_000 }).toBeGreaterThan(180);
	expect((await programRgb())[2]).toBeLessThan(60);
	await page
		.locator('.dv-tab')
		.filter({ hasText: /^Effects$/ })
		.first()
		.click();
	const item = page.locator('[data-transition-effect-id="jasper.cross-dissolve"]');
	await expect(item).toBeVisible();
	const [, bClip] = await clips(page, ['V1']);
	const box = await clipBox(page, bClip!.id);
	const area = (await timelineArea(page).boundingBox())!;
	await item.dragTo(timelineArea(page), {
		targetPosition: { x: box.x - area.x, y: box.y - area.y + box.height / 2 },
	});
	await expect.poll(async () => (await videoTransitionAtCut())?.effectId).toBe('jasper.cross-dissolve');
	const t = (await videoTransitionAtCut())!;
	expect(t).toMatchObject({ alignment: 'center', duration: 30 });
	await expect(
		page.locator(`[data-testid="timeline-track-area"] [data-transition-id="${t.id}"]`),
	).toBeVisible();
	// The Program shows the mix at the cut: red and blue together (purple), not the hard cut.
	await seek(cut + 1);
	await seek(cut - 1);
	await expect
		.poll(
			async () => {
				const [r, , b] = await programRgb();
				return r > 60 && b > 60;
			},
			{ timeout: 30_000, intervals: [250] },
		)
		.toBe(true);
	await page.screenshot({ path: join(ROOT, 'test-results', 'e2e-transitions-dissolve.png') });
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await transitions()).length).toBe(0);
});
