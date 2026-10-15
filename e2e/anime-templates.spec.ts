// Export path: with the layer-bake extension ready (`features.layerBake.state === 'ready'`) the
// plan must be native/hybrid; without it (this package alone) Auto plans the Remotion path because the anime
// template has a native blocker. The test checks the actual selected path and never skips.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { ExportResultSchema } from '../packages/api/src/exports.ts';
import { createProject, enableAgentBridge, focusTimeline, query, ROOT, waitForJob } from './support.ts';

test.describe.configure({ mode: 'serial' });

const EXPORT_DIR = join(ROOT, 'test-results', 'e2e-anime-templates');
mkdirSync(EXPORT_DIR, { recursive: true });

let page: Page;

const program = () => page.getByTestId('program-player-wrapper');

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

/** RGB frames decoded with ffmpeg (rgb24, sequence size). */
function rgbFrame(file: string, args: string[]): Buffer {
	return execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-v', 'error', '-i', file, ...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
		{ maxBuffer: 64 << 20 },
	);
}

async function exportProRes(
	request: APIRequestContext,
	expectPath: RegExp,
	filename = 'anime-templates.mov',
): Promise<{ file: string; renderPath: string }> {
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	await page.getByTestId('export-engine').selectOption('auto');
	await page.getByTestId('export-codec').selectOption('prores');
	await page.getByTestId('export-filename').fill(filename);
	await expect(page.getByTestId('plan-path')).toContainText(expectPath, { timeout: 60_000 });
	const known = new Set(
		((await (await request.get('/api/jobs')).json()).jobs as { id: string }[]).map((j) => j.id),
	);
	await page.getByTestId('export-start').click();
	let jobId = '';
	await expect
		.poll(async () => {
			const jobs = (await (await request.get('/api/jobs')).json()).jobs as { id: string; kind: string }[];
			jobId = jobs.find((j) => j.kind === 'export' && !known.has(j.id))?.id ?? '';
			return jobId;
		})
		.not.toBe('');
	const job = await waitForJob(request, jobId, 600_000);
	expect(job.state, JSON.stringify(job.error ?? null)).toBe('succeeded');
	const res = await request.get(`/renders/${jobId}/output`);
	expect(res.ok()).toBe(true);
	const file = join(EXPORT_DIR, filename);
	writeFileSync(file, await res.body());
	return { file, renderPath: ExportResultSchema.parse(job.result).renderPath ?? '' };
}

function redPixels(
	rgb: Buffer,
	width: number,
	height: number,
	region: { left: number; right: number; top: number; bottom: number },
): number {
	let count = 0;
	for (let y = Math.floor(region.top * height); y < Math.floor(region.bottom * height); y++) {
		for (let x = Math.floor(region.left * width); x < Math.floor(region.right * width); x++) {
			const i = (y * width + x) * 3;
			if (rgb[i]! > 160 && rgb[i]! > rgb[i + 1]! + 100 && rgb[i]! > rgb[i + 2]! + 100) count++;
		}
	}
	return count;
}

test('an out-of-canvas callout is clipped in the Program and exported frame', async ({
	request,
}, testInfo) => {
	test.setTimeout(900_000);
	await createProject(page, 'E2E Callout Clipping');
	const tx = await page.evaluate(() =>
		window.jasper!.transact({
			label: 'Callout at canvas edge',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 90,
					track: 'V1',
					template: { id: 'callout', version: 1 },
					params: { label: 'EDGE LABEL', labelX: 0.95, boxColor: [1, 0, 0, 1] },
					ref: '$callout',
				},
				{ type: 'param.set', target: ['clip', '$callout', 'transform', 'scale'], value: 50 },
			],
		}),
	);
	expect(tx.ok).toBe(true);
	await query(page, 'playhead.set', { frame: 50 });
	await expect.poll(async () => (await query<{ frame: number }>(page, 'playhead.get')).frame).toBe(50);
	const preview = await program().screenshot();
	writeFileSync(join(EXPORT_DIR, 'callout-clipped-program.png'), preview);
	const width = preview.readUInt32BE(16);
	const height = preview.readUInt32BE(20);
	const previewRgb = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
		{ input: preview, maxBuffer: 64 << 20 },
	);
	// At 50% scale, a centred 16:9 template occupies x=25%..75%. The label begins inside
	// the right edge, and labelX=0.95 places the rest outside the specified canvas.
	const inside = { left: 0.73, right: 0.748, top: 0.39, bottom: 0.43 };
	const outside = { left: 0.758, right: 0.81, top: 0.39, bottom: 0.43 };
	expect(redPixels(previewRgb, width, height, inside)).toBeGreaterThan(20);
	expect(redPixels(previewRgb, width, height, outside)).toBe(0);

	const caps = await (await request.get('/api/capabilities')).json();
	const bake = caps.features?.layerBake?.state === 'ready';
	const out = await exportProRes(request, bake ? /native|hybrid/i : /remotion/i, 'callout-clipped.mov');
	expect(out.renderPath).toMatch(bake ? /native|hybrid/ : /remotion/);
	const exported = rgbFrame(out.file, ['-vf', 'select=eq(n\\,50)', '-frames:v', '1']);
	expect(exported.length).toBe(1920 * 1080 * 3);
	expect(redPixels(exported, 1920, 1080, inside)).toBeGreaterThan(100);
	expect(redPixels(exported, 1920, 1080, outside)).toBe(0);
	await testInfo.attach('clipped-preview', { body: preview, contentType: 'image/png' });
	await testInfo.attach('clipped-export', { path: out.file, contentType: 'video/quicktime' });
});
