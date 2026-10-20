// Fixed PQ graphics-white and linear-blend reference values (S12, docs/wp-notes/color-mgmt.md).
// PQ(203 cd/m²) = 148.1/255, displayed as 230.4/255; a 50% linear blend over black is
// 129.9/255, displayed as 190.3/255. Encoded blending would display 69.1/255.

import { execFileSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';
import {
	browserLaunch,
	clips,
	createProject,
	enableAgentBridge,
	expectTransaction,
	ffprobe,
	focusTimeline,
	query,
	transact,
	waitForJob,
} from './support.ts';

test.use({ launchOptions: browserLaunch(['--enable-features=CanvasDrawElement']) });
test.describe.configure({ mode: 'serial' });

let page: Page;
let seqId = '';
let white = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Colour management');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
});
test.afterAll(async () => {
	await page?.close();
});

/** Mean colour at the centre of the Program monitor output (its canvases drawn into a small canvas). */
async function programCenter(): Promise<number> {
	return page.getByTestId('program-player-wrapper').evaluate((root) => {
		const c = document.createElement('canvas');
		c.width = 64;
		c.height = 36;
		const g = c.getContext('2d', { willReadFrequently: true })!;
		for (const s of [...root.querySelectorAll('canvas')] as HTMLCanvasElement[]) {
			try {
				g.drawImage(s, 0, 0, 64, 36);
			} catch {
				// not drawable
			}
		}
		return g.getImageData(32, 18, 1, 1).data[1]!;
	});
}

async function settings(): Promise<{ workingColorSpace: string; color?: { blendLinear?: boolean } }> {
	return query(page, 'doc.get', { path: ['sequences', seqId, 'settings'] });
}

test('Properties ▸ Colour: a PQ working space is previewed through the display transform', async () => {
	const r = await transact(page, [
		// These uniform-color oracles use the same render path at a smaller raster size.
		{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: 320, height: 180 } },
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0, 0, 0, 1] },
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V2', color: [1, 1, 1, 1] },
	]);
	expectTransaction(r);
	white = (await clips(page)).find((c) => c.track === 'V2')!.id;
	const select = page.getByTestId('seq-working-space');
	await expect(select).toBeVisible();
	await select.selectOption('rec2100-pq');
	expect((await settings()).workingColorSpace).toBe('rec2100-pq');
	// Graphics white = 203 cd/m², shown tone mapped (230); the raw PQ signal would read 148.
	await expect.poll(programCenter, { timeout: 20_000 }).toBeGreaterThan(225);
	expect(await programCenter()).toBeLessThan(236);
	await page.screenshot({ path: 'test-results/color-mgmt-pq-display.png' });
});

test('Blend using 1.0 gamma composites in linear light', async () => {
	expect(
		(await transact(page, [{ type: 'param.set', target: ['clip', white, 'opacity'], value: 50 }])).ok,
	).toBe(true);
	await page.getByLabel('Blend using 1.0 gamma').check();
	expect((await settings()).color?.blendLinear).toBe(true);
	// The monitor shows the linear-light mix (129.9) through the display transform = 190.3;
	// encoded blending would show 69.1.
	await expect
		.poll(async () => Math.abs((await programCenter()) - 190), { timeout: 20_000 })
		.toBeLessThanOrEqual(3);
	await page.screenshot({ path: 'test-results/color-mgmt-linear-blend.png' });
});

test('the export writes 10-bit PQ ProRes with HDR tags and mastering metadata', async ({ request }) => {
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	await page.getByTestId('export-codec').selectOption('prores');
	await page.getByTestId('export-color-space').selectOption('working');
	await page.getByTestId('export-bit-depth').selectOption('auto');
	await page.getByTestId('export-maxcll').fill('203');
	await page.getByTestId('export-filename').fill('pq.mov');
	// Linear-light blending is drawn by the GPU compositor: the native path refuses it.
	await expect(page.getByTestId('plan-path')).toContainText(/remotion/i, { timeout: 30_000 });
	const before = new Set(
		((await (await request.get('/api/jobs')).json()).jobs as { id: string }[]).map((j) => j.id),
	);
	await page.getByTestId('export-start').click({ timeout: 10_000 });
	let jobId = '';
	await expect
		.poll(async () => {
			const jobs = (await (await request.get('/api/jobs')).json()).jobs as { id: string; kind: string }[];
			jobId = jobs.find((j) => j.kind === 'export' && !before.has(j.id))?.id ?? '';
			return jobId;
		})
		.not.toBe('');
	const job = await waitForJob(request, jobId, 300_000);
	expect(job.state, JSON.stringify(job.error ?? null)).toBe('succeeded');
	const jobsPanel = page.getByTestId('jobs-panel');
	const row = jobsPanel.locator(`[data-testid="job-row"][data-job-id="${jobId}"]`);
	await expect(row).toHaveAttribute('data-status', /succeeded|done|finished/i, { timeout: 30_000 });
	const download = page.waitForEvent('download');
	await row.getByTestId('job-download').click();
	const file = test.info().outputPath('pq.mov');
	await (await download).saveAs(file);
	const v = ffprobe(file).streams.find((s) => s.codec_type === 'video') as Record<string, unknown>;
	expect(v.pix_fmt).toMatch(/10le$/);
	expect(v.color_transfer).toBe('smpte2084');
	expect(v.color_primaries).toBe('bt2020');
	expect(v.color_space).toBe('bt2020nc');
	// mdcv / clli boxes written after the encode (MaxCLL from the field above).
	const side = (v.side_data_list ?? []) as { side_data_type: string; max_content?: number }[];
	expect(side.map((x) => x.side_data_type)).toEqual(
		expect.arrayContaining(['Mastering display metadata', 'Content light level metadata']),
	);
	expect(side.find((x) => x.side_data_type === 'Content light level metadata')?.max_content).toBe(203);
	// The frame holds the working PQ signal of the linear-light mix (129.9/255; neutral, so the matrix is moot).
	const raw = execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		...['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1'],
		...['-vf', 'crop=16:16:iw/2:ih/2,scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-'],
	]);
	expect(Math.abs(raw[1]! - 130)).toBeLessThanOrEqual(3);
	await test.info().attach('pq-export', { path: file, contentType: 'video/quicktime' });
	await test.info().attach('pq-metadata', { body: JSON.stringify(v), contentType: 'application/json' });
});
