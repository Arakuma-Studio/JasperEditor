// M1 golden path (ARCHITECTURE §15 items 2–8 and 13), driven through the UI of the built app served by the
// built engine. Steps share one page and run in order; a failing step skips the rest.
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	importFiles,
	playheadFrame,
	pointerDrag,
	programPixels,
	timelineArea,
	watchPage,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let watcher: { errors: string[] };

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	watcher = watchPage(page);
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

test('Home → New Project opens the Editing workspace', async () => {
	await createProject(page, 'E2E Smoke');
	await expect(page.getByTestId('header-bar')).toBeVisible();
	await expect(page.getByTestId('engine-chip')).toBeVisible();
	await expect(page.getByTestId('workspace-tab-editing')).toBeVisible();
	for (const id of [
		'project-panel',
		'program-monitor',
		'tools-panel',
		'timeline-panel',
		'properties-panel',
	]) {
		await expect(page.getByTestId(id), id).toBeVisible();
	}
	const summary = await page.evaluate(() =>
		(window as unknown as { jasper: { query(n: string): Promise<unknown> } }).jasper.query(
			'sequence.summary',
		),
	);
	expect(summary).toMatchObject({ settings: { width: 1920, height: 1080 } });
});

test('import clip-a.mp4 through the file chooser → Project panel row with a poster', async () => {
	await importFiles(page, ['clip-a.mp4']);
	expect(await appliedLabels(page)).toContain('Import 1 file');
	// Icon view shows the engine poster once the derivative job finished.
	await page.getByTestId('project-icon-view').click();
	const tile = page.getByTestId('project-tile').filter({ hasText: 'clip-a.mp4' });
	await expect(tile).toBeVisible();
	await expect
		.poll(
			async () =>
				tile.locator('img').evaluateAll((imgs) => imgs.some((i) => (i as HTMLImageElement).naturalWidth > 0)),
			{
				timeout: 60_000,
			},
		)
		.toBe(true);
	await page.getByTestId('project-list-view').click();
});

test('drag the item to the timeline → linked V1/A1 clips', async () => {
	const row = page.getByTestId('project-row').filter({ hasText: 'clip-a.mp4' });
	const box = (await timelineArea(page).boundingBox())!;
	await row.dragTo(timelineArea(page), { targetPosition: { x: 0, y: box.height - 150 } });
	await expect.poll(async () => (await clips(page)).length).toBe(2);
	const [a1, v1] = await clips(page);
	expect(v1).toMatchObject({ track: 'V1', kind: 'video', start: 0 });
	expect(a1).toMatchObject({ track: 'A1', kind: 'audio', start: 0 });
	expect(v1!.linked).toContain(a1!.id);
	// 10 s at 29.97 fps = 300 frames (rounded from 299.7).
	expect(Math.abs(v1!.duration - 300)).toBeLessThanOrEqual(1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/Place|Overwrite|Insert/);
});

test('Space plays the Program monitor, Space stops it; the monitor shows the frame', async () => {
	await focusTimeline(page);
	const before = await playheadFrame(page);
	await page.keyboard.press('Space');
	await page.waitForTimeout(1200);
	await page.keyboard.press('Space');
	await page.waitForTimeout(300);
	const after = await playheadFrame(page);
	expect(after - before).toBeGreaterThan(10);
	// Seek to 3 s by clicking the ruler, then the Program output must contain the test pattern.
	const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
	await page.mouse.click(ruler.x + ruler.width * 0.3, ruler.y + ruler.height / 2);
	await expect.poll(async () => (await programPixels(page)).std, { timeout: 20_000 }).toBeGreaterThan(20);
});

test('move, trim, razor: one History entry each; Ctrl+Z / Ctrl+Shift+Z', async () => {
	let [a1, v1] = await clips(page);
	const labelsBefore = (await appliedLabels(page)).length;
	// Move (overwrite) the video clip right by ~1 s.
	const b = await clipBox(page, v1!.id);
	const pxPerFrame = b.width / v1!.duration;
	await pointerDrag(
		page,
		{ x: b.x + b.width / 2, y: b.y + b.height / 2 },
		{ x: b.x + b.width / 2 + 30 * pxPerFrame, y: b.y + b.height / 2 },
	);
	await expect.poll(async () => (await clips(page, ['V1']))[0]!.start).toBeGreaterThan(20);
	[a1, v1] = await clips(page);
	expect(a1!.start).toBe(v1!.start); // linked partner moved too
	expect((await appliedLabels(page)).length).toBe(labelsBefore + 1);
	const moved = v1!.start;
	const movedEnd = v1!.end;

	// Trim the head by dragging the left edge right by ~2 s (regular trim).
	const b2 = await clipBox(page, v1!.id);
	await pointerDrag(
		page,
		{ x: b2.x + 2, y: b2.y + b2.height / 2 },
		{ x: b2.x + 2 + 60 * pxPerFrame, y: b2.y + b2.height / 2 },
	);
	await expect.poll(async () => (await clips(page, ['V1']))[0]!.duration).toBeLessThan(260);
	expect((await appliedLabels(page)).length).toBe(labelsBefore + 2);
	[a1, v1] = await clips(page);
	expect(v1!.start).toBeGreaterThan(moved + 40);
	expect(v1!.end).toBe(movedEnd); // head trim keeps the out point
	const trimmedDuration = v1!.duration;
	const trimmedStart = v1!.start;

	// Razor tool (C) click at mid-clip → two clips on V1 (and A1, linked).
	await focusTimeline(page);
	await page.keyboard.press('KeyC');
	const b3 = await clipBox(page, v1!.id);
	await page.mouse.click(b3.x + b3.width / 2, b3.y + b3.height / 2);
	await page.keyboard.press('KeyV');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(2);
	expect((await clips(page, ['A1'])).length).toBe(2);
	expect((await appliedLabels(page)).length).toBe(labelsBefore + 3);

	// Undo the razor, then redo it.
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(1);
	expect((await clips(page, ['V1']))[0]).toMatchObject({ start: trimmedStart, duration: trimmedDuration });
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(2);
	expect((await appliedLabels(page)).length).toBe(labelsBefore + 3);
});

test('no uncaught page errors so far', async () => {
	expect(watcher.errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
});
