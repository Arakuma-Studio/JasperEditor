// M1 golden path (ARCHITECTURE §15 items 2–8 and 13), driven through the UI of the built app served by the
// built engine. Steps share one page and run in order; a failing step skips the rest.

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
	playheadFrame,
	pointerDrag,
	programPixels,
	ROOT,
	regionLuma,
	sequenceSummary,
	timelineArea,
	trackRow,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

test('Home → New Project opens the Editing workspace', async () => {
	await createProject(page, 'E2E Smoke');
	await expect(page.getByTestId('workspace-tab-editing')).toBeVisible();
	expect(await sequenceSummary(page)).toMatchObject({ settings: { width: 1920, height: 1080 } });
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
	// Header: autosave reaches "Saved"; the Jobs badge settles once the derivative jobs are done.
	await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
	await expect(page.getByTestId('jobs-badge')).toHaveAttribute('data-active', '0', { timeout: 60_000 });
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

const EXPORT_DIR = join(ROOT, 'test-results', 'e2e-exports');

/** Frames of the sequence = end of the last clip (the sequence starts at 0). */
async function sequenceFrames(): Promise<number> {
	return Math.max(...(await clips(page)).map((c) => c.end));
}

function assertOutput(file: string, frames: number): void {
	const probe = ffprobe(file);
	const v = probe.streams.find((s) => s.codec_type === 'video');
	expect(v, 'video stream').toBeTruthy();
	expect(v!.codec_name).toBe('h264');
	expect([v!.width, v!.height]).toEqual([1920, 1080]);
	expect(v!.r_frame_rate).toBe('30000/1001');
	expect(Number(v!.nb_read_frames)).toBe(frames);
	// Container duration within 0.1 s (AAC priming/padding makes the audio a few ms longer).
	expect(Math.abs(Number(probe.format.duration) - (frames * 1001) / 30000)).toBeLessThan(0.1);
	expect(probe.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac')).toBe(true);
}

test('export a media-only sequence with Auto → native ffmpeg path; ffprobe frame count matches', async ({
	request,
}) => {
	mkdirSync(EXPORT_DIR, { recursive: true });
	const frames = await sequenceFrames();
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'smoke-native.mp4',
		expectPath: /native/i,
		outDir: EXPORT_DIR,
	});
	expect(out.job.result?.renderPath).toBe('native');
	assertOutput(out.file, frames);
});

test('insert the lower-third@1 motion graphic from the Motion Templates panel (drag to V2)', async () => {
	await page.getByTestId('tab-motionTemplates').click();
	const card = page.locator('[data-template="lower-third@1"]');
	await expect(card).toBeVisible();
	const v2 = (await clips(page)).length;
	const area = timelineArea(page);
	const summary = await sequenceSummary(page);
	const v2Track = summary.tracks!.find((t) => t.label === 'V2')!;
	const row = (await trackRow(page, v2Track.id).boundingBox())!;
	const areaBox = (await area.boundingBox())!;
	await card.dragTo(area, { targetPosition: { x: 0, y: row.y - areaBox.y + row.height / 2 } });
	await expect
		.poll(async () => (await clips(page)).filter((c) => c.kind === 'motion-graphic').length)
		.toBe(1);
	expect((await clips(page)).length).toBe(v2 + 1);
	const mg = (await clips(page)).find((c) => c.kind === 'motion-graphic')!;
	expect(mg.track).toBe('V2');
});

test('motion graphic + footage exports with Auto → native (fframes master)', async ({ request }) => {
	// jasper-mg is an optional native tool (`pnpm mg:build`, needs cargo; `pnpm e2e` builds it when cargo is
	// installed). Without it the engine plans this export through Remotion (e2e:mg-fallback checks that path).
	const caps = (await (await request.get('/api/capabilities')).json()) as {
		render: { fframes: string; fframesReason?: string };
	};
	test.skip(
		caps.render.fframes !== 'ready',
		`the fframes renderer is unavailable: ${caps.render.fframesReason ?? 'jasper-mg is not built'} — run \`pnpm mg:build\` (needs cargo)`,
	);
	const frames = await sequenceFrames();
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'smoke-mg-native.mp4',
		expectPath: /native/i,
		outDir: EXPORT_DIR,
	});
	expect(out.job.result?.renderPath).toBe('native');
	assertOutput(out.file, frames);
	// The lower third (bottom-left) is composited over black before the footage starts.
	const mg = (await clips(page)).find((c) => c.kind === 'motion-graphic')!;
	const firstFootage = Math.min(...(await clips(page, ['V1'])).map((c) => c.start));
	const t = (Math.min(mg.end, firstFootage) * 1001) / 30000 / 2 + 0.5;
	const lowerThird = { x: 0.05, y: 0.72, w: 0.3, h: 0.18 };
	const topRight = { x: 0.6, y: 0.05, w: 0.35, h: 0.3 };
	expect(regionLuma(out.file, t, lowerThird)).toBeGreaterThan(20);
	expect(regionLuma(out.file, t, topRight)).toBeLessThan(5);
});

test('Type tool click in the Program monitor adds a text clip', async () => {
	await focusTimeline(page);
	await page.keyboard.press('KeyT');
	const vp = (await page.getByTestId('program-viewport').boundingBox())!;
	await page.mouse.click(vp.x + vp.width / 2, vp.y + vp.height * 0.3);
	await page.keyboard.press('Escape');
	await expect.poll(async () => (await clips(page)).filter((c) => c.kind === 'text').length).toBe(1);
	await focusTimeline(page);
	await page.keyboard.press('KeyV');
	expect((await appliedLabels(page)).at(-1)).toMatch(/Text/);
});

// M2 (S11:LBK-001, wp-m2-layer-bake): Auto bakes text (`hybrid`, e2e/layer-bake.spec.ts); the Remotion path is
// exercised by forcing it.
test('with the text clip, the forced Remotion export succeeds', async ({ request }) => {
	test.setTimeout(1_200_000);
	const frames = await sequenceFrames();
	const out = await exportViaUi(page, request, {
		engine: 'remotion',
		fileName: 'smoke-remotion.mp4',
		expectPath: /remotion/i,
		outDir: EXPORT_DIR,
		jobTimeoutMs: 900_000,
	});
	expect(out.job.result?.renderPath).toBe('remotion');
	assertOutput(out.file, frames);
});

test('Program monitor accepts effect drops (layer under the pointer) and motion-template drops', async () => {
	// Park the playhead inside the footage so the Program shows the V1 layer.
	const v1 = (await clips(page, ['V1'])).at(-1)!;
	await focusTimeline(page);
	const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
	const clipB = await clipBox(page, v1.id);
	await page.mouse.click(clipB.x + clipB.width / 2, ruler.y + ruler.height / 2);
	await page.getByTestId('tab-effects').click();
	await page.getByTestId('effects-search').fill('Gaussian');
	const blur = page.locator('[data-effect-id="jasper.gaussian-blur"]');
	await expect(blur).toBeVisible();
	const overlay = page.getByTestId('program-overlay');
	const ob = (await overlay.boundingBox())!;
	const before = await appliedLabels(page);
	await blur.dragTo(overlay, { targetPosition: { x: ob.width * 0.75, y: ob.height * 0.8 } });
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/Apply Gaussian Blur/);

	await page.getByTestId('tab-motionTemplates').click();
	const mgBefore = (await clips(page)).filter((c) => c.kind === 'motion-graphic').length;
	await page.locator('[data-template="lower-third@1"]').dragTo(overlay, {
		targetPosition: { x: ob.width / 2, y: ob.height / 2 },
	});
	await expect
		.poll(async () => (await clips(page)).filter((c) => c.kind === 'motion-graphic').length)
		.toBe(mgBefore + 1);
});
