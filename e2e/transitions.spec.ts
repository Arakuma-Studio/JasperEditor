// S10 §8 test 5 (wp-m2-transitions): transitions through the real UI of the built app — drag Cross Dissolve from
// the Effects panel onto a cut (the Program shows the mix), Ctrl+Z, Ctrl+D at the playhead, drag the right edge
// (tooltip shows the duration), change the type to Dip to Black in Effect Controls, and export natively.
// The two clips are placed by the in-page agent API (setup only) so they have media handles around the cut.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	exportViaUi,
	ffprobe,
	focusTimeline,
	importFiles,
	query,
	ROOT,
	timelineArea,
	watchPage,
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
let watcher: { errors: string[] };
let seqId = '';
let cut = 0;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	watcher = watchPage(page);
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

async function transact(commands: unknown[]): Promise<{ ok: boolean; errors?: unknown[] }> {
	return page.evaluate(
		(cmds) =>
			(
				window as unknown as {
					jasper: { transact(tx: unknown): Promise<{ ok: boolean; errors?: unknown[] }> };
				}
			).jasper.transact({ protocol: 'jasper.tx/1', label: 'E2E setup', commands: cmds }),
		commands,
	);
}

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

test('setup: project, two clips with media handles meeting at a cut', async () => {
	await createProject(page, 'E2E Transitions');
	await importFiles(page, ['xfade-red.mp4', 'xfade-blue.mp4']);
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	const a = await transact([
		{
			type: 'clip.place',
			source: { mediaId: { mediaByName: 'xfade-red.mp4' } },
			at: 0,
			sourceRange: { in: { seconds: 1 }, out: { seconds: 5 } },
		},
	]);
	expect(a.ok, JSON.stringify(a.errors)).toBe(true);
	cut = (await clips(page, ['V1']))[0]!.end;
	const b = await transact([
		{
			type: 'clip.place',
			source: { mediaId: { mediaByName: 'xfade-blue.mp4' } },
			at: cut,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 5 } },
		},
	]);
	expect(b.ok, JSON.stringify(b.errors)).toBe(true);
	expect((await clips(page, ['V1'])).map((c) => c.start)).toEqual([0, cut]);
	await expect(page.getByTestId('jobs-badge')).toHaveAttribute('data-active', '0', { timeout: 90_000 });
});

test('drag Cross Dissolve from the Effects panel onto the cut → drawn, Program shows the mix; Ctrl+Z removes it', async () => {
	// Hard cut: the last frame before it is red.
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
	expect((await appliedLabels(page)).at(-1)).toBe('Add Transition');
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

test('Ctrl+D at the playhead near the cut adds the default transition (one entry)', async () => {
	await seek(cut - 4);
	await focusTimeline(page);
	const n = (await appliedLabels(page)).length;
	await page.keyboard.press('Control+KeyD');
	await expect.poll(async () => (await videoTransitionAtCut())?.effectId).toBe('jasper.cross-dissolve');
	const labels = await appliedLabels(page);
	expect(labels.length).toBe(n + 1);
	expect(labels.at(-1)).toBe('Apply Video Transition');
});

test('dragging its right edge lengthens it; the tooltip shows the new duration', async () => {
	const t = (await videoTransitionAtCut())!;
	const rect = page.locator(`[data-testid="timeline-track-area"] [data-transition-id="${t.id}"]`);
	const r = (await rect.boundingBox())!;
	const pxPerFrame = r.width / t.duration;
	const y = r.y + r.height / 2;
	await page.mouse.move(r.x + r.width - 1, y);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) {
		await page.mouse.move(r.x + r.width - 1 + (i * 5 * pxPerFrame) / 10, y);
		await page.waitForTimeout(16);
	}
	await expect(page.getByTestId('timeline-tooltip')).toContainText(/Duration 00[:;]00[:;]01[:;]1\d \(4\d\)/);
	await page.mouse.up();
	await expect.poll(async () => (await videoTransitionAtCut())?.duration).toBeGreaterThan(t.duration);
	expect((await appliedLabels(page)).at(-1)).toBe('Transition Duration');
	await page.screenshot({ path: join(ROOT, 'test-results', 'e2e-transitions-edge.png') });
});

test('Effect Controls Transition section changes the type to Dip to Black', async () => {
	const t = (await videoTransitionAtCut())!;
	const rect = page.locator(`[data-testid="timeline-track-area"] [data-transition-id="${t.id}"]`);
	await rect.click();
	await page
		.locator('.dv-tab')
		.filter({ hasText: /^Effect Controls$/ })
		.first()
		.click();
	const ec = page.getByTestId('effect-controls-panel');
	await expect(ec.getByTestId('transition-section')).toBeVisible();
	await expect(ec.getByTestId('transition-diagram')).toBeVisible();
	await ec.getByTestId('transition-type').selectOption('jasper.dip-to-black');
	await expect.poll(async () => (await videoTransitionAtCut())?.effectId).toBe('jasper.dip-to-black');
	expect((await appliedLabels(page)).at(-1)).toBe('Replace Transition');
	await page.screenshot({ path: join(ROOT, 'test-results', 'e2e-transitions-effect-controls.png') });
});

test('native export of the sequence with the transition succeeds', async ({ request }) => {
	const dir = join(ROOT, 'test-results', 'e2e-exports');
	mkdirSync(dir, { recursive: true });
	const frames = Math.max(...(await clips(page)).map((c) => c.end));
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'transitions-native.mp4',
		expectPath: /native/i,
		outDir: dir,
	});
	const probe = ffprobe(out.file);
	expect(Number(probe.streams.find((s) => s.codec_type === 'video')!.nb_read_frames)).toBe(frames);
});

test('no uncaught page errors', async () => {
	expect(watcher.errors.filter((e) => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});
