// Critical M1 workflows share the project so the native exports contain the user's accumulated edits.
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
	query,
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

test('create, import, edit linked footage, play, undo and export a native movie', async ({
	request,
}, testInfo) => {
	test.setTimeout(600_000);
	await createProject(page, 'E2E Smoke');
	await expect(page.getByTestId('workspace-tab-editing')).toBeVisible();
	expect(await sequenceSummary(page)).toMatchObject({ settings: { width: 1920, height: 1080 } });

	await importFiles(page, ['clip-a.mp4']);
	const row = page.getByTestId('project-row').filter({ hasText: 'clip-a.mp4' });
	const box = (await timelineArea(page).boundingBox())!;
	await row.dragTo(timelineArea(page), { targetPosition: { x: 0, y: box.height - 150 } });
	await expect.poll(async () => (await clips(page)).length).toBe(2);
	let [a1, v1] = await clips(page);
	expect(v1).toMatchObject({ track: 'V1', kind: 'video', start: 0 });
	expect(a1).toMatchObject({ track: 'A1', kind: 'audio', start: 0 });
	expect(v1!.linked).toContain(a1!.id);
	// 10 s at 29.97 fps = 300 frames (rounded from 299.7).
	expect(Math.abs(v1!.duration - 300)).toBeLessThanOrEqual(1);
	await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
	await expect(page.getByTestId('jobs-badge')).toHaveAttribute('data-active', '0', { timeout: 60_000 });

	await focusTimeline(page);
	const before = await playheadFrame(page);
	const lastContentFrame = (await sequenceFrames()) - 1;
	let advancedFrame = before;
	await page.keyboard.press('Space');
	await expect
		.poll(async () => {
			const state = await query<{ frame: number; playing: boolean }>(page, 'playhead.get');
			if (!state.playing || state.frame <= before) return false;
			advancedFrame = state.frame;
			return true;
		})
		.toBe(true);
	await page.keyboard.press('Space');
	await expect
		.poll(async () => {
			const state = await query<{ frame: number; playing: boolean }>(page, 'playhead.get');
			return !state.playing && state.frame >= advancedFrame && state.frame < lastContentFrame;
		})
		.toBe(true);
	const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
	await page.mouse.click(ruler.x + ruler.width * 0.3, ruler.y + ruler.height / 2);
	await expect.poll(async () => (await programPixels(page)).std, { timeout: 20_000 }).toBeGreaterThan(20);

	[a1, v1] = await clips(page);
	const labelsBefore = (await appliedLabels(page)).length;
	const b = await clipBox(page, v1!.id);
	const pxPerFrame = b.width / v1!.duration;
	await pointerDrag(
		page,
		{ x: b.x + b.width / 2, y: b.y + b.height / 2 },
		{ x: b.x + b.width / 2 + 30 * pxPerFrame, y: b.y + b.height / 2 },
	);
	await expect.poll(async () => (await clips(page, ['V1']))[0]!.start).toBeGreaterThan(20);
	[a1, v1] = await clips(page);
	expect(a1!.start).toBe(v1!.start);
	expect((await appliedLabels(page)).length).toBe(labelsBefore + 1);
	const moved = v1!.start;
	const movedEnd = v1!.end;

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
	expect(v1!.end).toBe(movedEnd);
	const trimmedDuration = v1!.duration;
	const trimmedStart = v1!.start;

	await focusTimeline(page);
	await page.keyboard.press('KeyC');
	const b3 = await clipBox(page, v1!.id);
	await page.mouse.click(b3.x + b3.width / 2, b3.y + b3.height / 2);
	await page.keyboard.press('KeyV');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(2);
	expect((await clips(page, ['A1'])).length).toBe(2);
	expect((await appliedLabels(page)).length).toBe(labelsBefore + 3);

	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(1);
	expect((await clips(page, ['V1']))[0]).toMatchObject({ start: trimmedStart, duration: trimmedDuration });
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(2);
	expect((await appliedLabels(page)).length).toBe(labelsBefore + 3);

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
	await testInfo.attach('exported-movie', { path: out.file, contentType: 'video/mp4' });
	await testInfo.attach('stream-probe', {
		body: JSON.stringify(ffprobe(out.file), null, 2),
		contentType: 'application/json',
	});
	await testInfo.attach('edited-timeline', { body: await page.screenshot(), contentType: 'image/png' });
});

test('insert a motion graphic and export it over footage with the native renderer', async ({
	request,
}, testInfo) => {
	test.setTimeout(600_000);
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
	await testInfo.attach('exported-movie', { path: out.file, contentType: 'video/mp4' });
	await testInfo.attach('stream-probe', {
		body: JSON.stringify(ffprobe(out.file), null, 2),
		contentType: 'application/json',
	});
	// The lower third (bottom-left) is composited over black before the footage starts.
	const firstFootage = Math.min(...(await clips(page, ['V1'])).map((c) => c.start));
	const t = (Math.min(mg.end, firstFootage) * 1001) / 30000 / 2 + 0.5;
	const lowerThird = { x: 0.05, y: 0.72, w: 0.3, h: 0.18 };
	const topRight = { x: 0.6, y: 0.05, w: 0.35, h: 0.3 };
	expect(regionLuma(out.file, t, lowerThird)).toBeGreaterThan(20);
	expect(regionLuma(out.file, t, topRight)).toBeLessThan(5);
});
