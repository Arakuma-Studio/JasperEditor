// Layer bake E2E (S11 §6, §11 test 4; wp-m2-layer-bake). Through the UI of the built app: footage + a static title
// + a keyframed title; a Lumetri grade on the static title shows "Grade pending" in the Program and then its graded
// preview (FIX-002); the Auto export plans `hybrid`, bakes one PNG for the static title and a master for the
// keyframed one (child jobs), and the output shows both titles with the keyframed opacity ramp, graded.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	clipBox,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	exportViaUi,
	ffprobe,
	focusTimeline,
	importFiles,
	query,
	ROOT,
	regionLuma,
	timelineArea,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const EXPORT_DIR = join(ROOT, 'test-results', 'e2e-exports');
let page: Page;
let staticTitle = '';
let movingTitle = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

async function seek(tc: string): Promise<void> {
	await page.getByTestId('timeline-timecode').click();
	await page.getByTestId('timeline-timecode-input').fill(tc);
	await page.getByTestId('timeline-timecode-input').press('Enter');
}

async function selectClip(id: string): Promise<void> {
	// Click the visible part of the clip (it may start left of the scrolled timeline viewport).
	const b = await clipBox(page, id);
	const area = (await timelineArea(page).boundingBox())!;
	const x0 = Math.max(b.x, area.x + 4);
	const x1 = Math.min(b.x + b.width, area.x + area.width - 4);
	await page.mouse.click((x0 + x1) / 2, b.y + b.height / 2);
}

test('footage, a static title after it and a keyframed title (Effect Controls stopwatch)', async () => {
	await createProject(page, 'E2E Layer bake');
	await importFiles(page, ['clip-a.mp4']);
	const row = page.getByTestId('project-row').filter({ hasText: 'clip-a.mp4' });
	const box = (await timelineArea(page).boundingBox())!;
	await row.dragTo(timelineArea(page), { targetPosition: { x: 0, y: box.height - 150 } });
	await expect.poll(async () => (await clips(page)).length).toBe(2);

	// Graphics ▸ Text at 10 s (after the footage) and at 15 s: 5 s titles centred in the frame.
	await seek('00;00;10;00');
	await focusTimeline(page);
	await page.keyboard.press('Alt+KeyT');
	await expect.poll(async () => (await clips(page)).filter((c) => c.kind === 'text').length).toBe(1);
	staticTitle = (await clips(page)).find((c) => c.kind === 'text')!.id;
	await seek('00;00;15;00');
	await focusTimeline(page);
	await page.keyboard.press('Alt+KeyT');
	await expect.poll(async () => (await clips(page)).filter((c) => c.kind === 'text').length).toBe(2);
	movingTitle = (await clips(page)).find((c) => c.kind === 'text' && c.id !== staticTitle)!.id;

	// Opacity keyframes on the second title: 100 % at 15 s, 20 % at 19 s.
	await selectClip(movingTitle);
	await page.getByTestId('tab-effectControls').click();
	const ec = page.getByTestId('ec-content');
	await ec.getByTestId('stopwatch-opacity').click();
	await seek('00;00;19;00');
	// The value is edited in Properties (wider than Effect Controls here); with the stopwatch on, a key is added.
	const props = page.getByTestId('clip-properties');
	await props.getByTestId('prop-opacity').click();
	await props.getByTestId('prop-opacity-input').fill('20');
	await props.getByTestId('prop-opacity-input').press('Enter');
	const seqId = (await page.evaluate(() =>
		(window as unknown as { jasper: { query(n: string): Promise<{ sequenceId: string }> } }).jasper.query(
			'sequence.summary',
		),
	)) as { sequenceId: string };
	const op = await page.evaluate(
		([s, c]) =>
			(window as unknown as { jasper: { query(n: string, a: unknown): Promise<unknown> } }).jasper.query(
				'doc.get',
				{ path: ['sequences', s, 'clips', c], fields: ['opacity'] },
			),
		[seqId.sequenceId, movingTitle] as const,
	);
	expect(
		(op as { opacity: { keyframes: { value: number }[] } }).opacity.keyframes.map((k) => k.value),
	).toEqual([100, 20]);
});

test('a Lumetri grade on the static title: "Grade pending", then the graded preview in the Program (FIX-002)', async () => {
	test.setTimeout(600_000);
	await page.getByTestId('workspace-tab-color').click();
	await expect(page.getByTestId('lumetri-panel')).toBeVisible();
	await seek('00;00;12;00');
	// The timeline is laid out anew in the Color workspace: click once it shows the clip, until it is selected.
	await expect(clipElement(page, staticTitle)).toBeVisible();
	await expect
		.poll(async () => {
			await selectClip(staticTitle);
			return clipElement(page, staticTitle).getAttribute('data-selected');
		})
		.toBe('true');
	await expect(page.getByTestId('lumetri-chip')).toBeVisible();
	// Exposure slider dragged to the left: a darker title.
	const slider = page.getByTestId('lumetri-exposure');
	const s = (await slider.boundingBox())!;
	await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(s.x + s.width * (0.5 - i * 0.04), s.y + s.height / 2);
	await page.mouse.up();
	const seq = await query<{ sequenceId: string }>(page, 'sequence.summary');
	await expect
		.poll(async () => {
			const r = await query<{ effects?: { effectId: string }[] }>(page, 'doc.get', {
				path: ['sequences', seq.sequenceId, 'clips', staticTitle],
				fields: ['effects'],
			});
			return (r.effects ?? []).map((e) => e.effectId);
		})
		.toEqual(['jasper.lumetri']);
	const program = page.getByTestId('program-player-wrapper');
	await expect(program.locator('[data-grade-chip]')).toHaveText('Grade pending', { timeout: 10_000 });
	// 2 s after the last change the engine bakes and grades a preview; the layer then plays it.
	await expect(program.locator('[data-baked="preview"]')).toBeVisible({ timeout: 180_000 });
	await expect(program.locator('[data-grade-chip]')).toHaveCount(0);
	// @remotion/media draws the preview into a canvas (WebCodecs) — read the brightest opaque pixel once drawn.
	const maxLuma = async () =>
		program.locator('[data-baked="preview"]').evaluate((el) => {
			const src = el.querySelector('canvas, video') as HTMLCanvasElement | HTMLVideoElement | null;
			if (!src) return -1;
			const c = document.createElement('canvas');
			c.width = 320;
			c.height = 180;
			const g = c.getContext('2d', { willReadFrequently: true })!;
			try {
				g.drawImage(src, 0, 0, c.width, c.height);
			} catch {
				return -1;
			}
			const d = g.getImageData(0, 0, c.width, c.height).data;
			let max = -1;
			for (let i = 0; i < d.length; i += 4)
				if (d[i + 3]! > 200) max = Math.max(max, 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!);
			return max;
		});
	await expect.poll(maxLuma, { timeout: 30_000 }).toBeGreaterThan(5);
	// The white title is graded down (opaque glyph pixels well below white).
	expect(await maxLuma()).toBeLessThan(200);
	await page.getByTestId('workspace-tab-editing').click();
});

test('Auto exports `hybrid`: one PNG for the static title, a master for the keyframed one; pixels show both', async ({
	request,
}) => {
	test.setTimeout(600_000);
	mkdirSync(EXPORT_DIR, { recursive: true });
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'layer-bake.mp4',
		expectPath: /hybrid/i,
		outDir: EXPORT_DIR,
	});
	expect(out.job.result?.renderPath).toBe('hybrid');
	const jobs = (await (await request.get('/api/jobs')).json()).jobs as {
		id: string;
		kind: string;
		parentId?: string;
		result?: { still: boolean };
	}[];
	const exportId = (out.job as { id?: string }).id;
	// The keyframed title is baked as a master in a child job of the export; the static title's PNG was baked
	// for its graded preview already (same key: the grade is applied by ffmpeg) and is reused from the cache.
	const bakes = jobs.filter((j) => j.kind === 'layer-bake' && j.parentId === exportId);
	expect(bakes.map((j) => j.result?.still)).toEqual([false]);
	const all = jobs.filter((j) => j.kind === 'layer-bake' && j.result);
	expect(all.some((j) => j.result?.still === true || (j.result as { sourceKey?: string })?.sourceKey)).toBe(
		true,
	);
	const probe = ffprobe(out.file);
	const v = probe.streams.find((s) => s.codec_type === 'video')!;
	expect([v.width, v.height]).toEqual([1920, 1080]);
	const centre = { x: 0.3, y: 0.4, w: 0.4, h: 0.2 };
	// Static title over black (after the footage), graded darker but visible.
	expect(
		regionLuma(out.file, 12, centre) - regionLuma(out.file, 12, { x: 0.02, y: 0.02, w: 0.1, h: 0.1 }),
	).toBeGreaterThan(0.2);
	// The keyframed title's opacity ramp (100 % at 15 s → 20 % at 19 s).
	// Luma above the black level of the same frame (TV-range black is not 0).
	const corner = { x: 0.02, y: 0.02, w: 0.1, h: 0.1 };
	const lift = (t: number) => regionLuma(out.file, t, centre) - regionLuma(out.file, t, corner);
	const a = lift(15.5);
	const b = lift(18.5);
	expect(a).toBeGreaterThan(3);
	// ≈ 30/90 with linear keys; the stopwatch's default interpolation eases, so allow a band around it.
	expect(b / a).toBeGreaterThan(0.2);
	expect(b / a).toBeLessThan(0.6);
	// After the last key (19 s) the title holds 20 %: dimmer than at 18.5 s.
	expect(lift(19.6)).toBeLessThan(b);
});
