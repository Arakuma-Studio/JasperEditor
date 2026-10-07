// Anime templates E2E (S11 §11 test 3, wp-m2-anime-templates): drag `title-reveal` from the gallery (badge R, hover
// preview), edit its text and colour in Properties, keyframe a colour param (Effect Controls/Properties
// stopwatch), stretch the clip (intro and outro frame-exact), apply a Gaussian blur and a corner pin (visible in the
// Program), export, and compare an exported frame with `renderStill`. fframes templates keep their twin + badge.
//
// Export path: with the layer-bake extension ready (`features.layerBake.state === 'ready'`, wp-m2-layer-bake) the
// plan must be native/hybrid; without it (this package alone) Auto plans the Remotion path because the anime
// template has a native blocker. The test records which one it checked as an annotation — it never skips.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { makeEnvelope, type ProjectDocument } from '../packages/project/src/index.ts';
import {
	appliedLabels,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	query,
	ROOT,
	timelineArea,
	waitForJob,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const EXPORT_DIR = join(ROOT, 'test-results', 'e2e-anime-templates');
mkdirSync(EXPORT_DIR, { recursive: true });

let page: Page;
let clipId = '';
let seqId = '';

type MgClipDoc = {
	start: number;
	duration: number;
	template: { id: string; version: number; renderer?: string };
	params: Record<string, unknown>;
	paramKeyframes?: Record<string, { time: number; value: unknown }[]>;
	effects?: { id: string; effectId: string }[];
};

const clipDoc = async (): Promise<MgClipDoc> =>
	query<MgClipDoc>(page, 'doc.get', { path: ['sequences', seqId, 'clips', clipId] });

const program = () => page.getByTestId('program-player-wrapper');
const templateIn = () => program().locator('[data-anime-template="title-reveal@1"]');

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

test('dragging a title-reveal template onto the timeline shows it in the Program', async () => {
	await createProject(page, 'E2E Anime Templates');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	await page.getByTestId('tab-motionTemplates').click();
	const card = page.locator('[data-template="title-reveal@1"]');
	await expect(card).toBeVisible();
	const area = (await timelineArea(page).boundingBox())!;
	await card.dragTo(timelineArea(page), { targetPosition: { x: 40, y: area.height - 220 } });
	await expect
		.poll(async () => (await clips(page)).filter((c) => c.kind === 'motion-graphic').length)
		.toBe(1);
	clipId = (await clips(page)).find((c) => c.kind === 'motion-graphic')!.id;
	const doc = await clipDoc();
	expect(doc.template).toEqual({ id: 'title-reveal', version: 1, renderer: 'anime' });
	await query(page, 'playhead.set', { frame: doc.start + 60 });
	await expect(templateIn()).toBeVisible({ timeout: 60_000 });
});

test('edit the title text and colour in Properties', async () => {
	const cb = await clipBox(page, clipId);
	await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
	await expect(page.getByTestId('mg-template-section')).toBeVisible();
	const title = page.getByTestId('prop-params.title');
	await title.fill('Anime Works');
	await title.press('Enter');
	await page.getByTestId('prop-params.titleColor').fill('#ff3300');
	await expect.poll(async () => (await clipDoc()).params.title).toBe('Anime Works');
	await expect.poll(async () => (await clipDoc()).params.titleColor).toEqual([1, 0.2, 0, 1]);
	const doc = await clipDoc();
	await query(page, 'playhead.set', { frame: doc.start + 70 });
	await expect(program().locator('[data-part="title"]')).toHaveText('Anime Works');
	await expect(program().locator('[data-part="title"]')).toHaveCSS('color', 'rgb(255, 51, 0)');
});

test('keyframe a colour param with the stopwatch: the Program colour changes over time', async () => {
	const doc = await clipDoc();
	const f0 = doc.start + 40;
	const f1 = doc.start + 100;
	await query(page, 'playhead.set', { frame: f0 });
	const labels = (await appliedLabels(page)).length;
	// Effect Controls ▸ Template · Title Reveal: the stopwatch of a colour param (S05:ECP-008).
	await page.getByTestId('tab-effectControls').click();
	const ec = page.getByTestId('effect-controls-panel');
	await ec.getByTestId('stopwatch-params.accentColor').click();
	await expect.poll(async () => (await clipDoc()).paramKeyframes?.accentColor?.length ?? 0).toBe(1);
	await query(page, 'playhead.set', { frame: f1 });
	await ec.getByTestId('prop-params.accentColor').fill('#00ff00');
	await expect.poll(async () => (await clipDoc()).paramKeyframes?.accentColor?.length ?? 0).toBe(2);
	expect((await appliedLabels(page)).length).toBe(labels + 2);
	const accent = async (frame: number) => {
		await query(page, 'playhead.set', { frame });
		await expect.poll(async () => (await query<{ frame: number }>(page, 'playhead.get')).frame).toBe(frame);
		const png = await program().screenshot();
		const width = png.readUInt32BE(16);
		const height = png.readUInt32BE(20);
		const rgb = execFileSync(
			process.env.JASPER_FFMPEG ?? 'ffmpeg',
			['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
			{ input: png, maxBuffer: 64 << 20 },
		);
		let green = 0;
		let blue = 0;
		let pixels = 0;
		for (let i = 0; i < width * height; i++) {
			const y = Math.floor(i / width);
			if (y < height * 0.4 || y > height * 0.7) continue;
			const [r, g, b] = [rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!];
			if (Math.max(g, b) < 120 || Math.max(g, b) - r < 40) continue;
			green += g;
			blue += b;
			pixels++;
		}
		return { green: green / pixels, blue: blue / pixels, pixels };
	};
	const a = await accent(f0);
	const b = await accent(f1);
	const mid = await accent(Math.round((f0 + f1) / 2));
	expect(Math.min(a.pixels, b.pixels, mid.pixels)).toBeGreaterThan(20);
	expect(a.blue).toBeGreaterThan(a.green + 40);
	expect(b.green).toBeGreaterThan(b.blue + 70);
	expect(mid.green).toBeGreaterThan(a.green + 20);
	expect(mid.blue).toBeGreaterThan(b.blue + 20);
});

test('Gaussian blur and corner pin visibly change the template in the Program', async () => {
	const doc = await clipDoc();
	await query(page, 'playhead.set', { frame: doc.start + 60 });
	const shot = () => program().screenshot();
	const gray = (png: Buffer) =>
		execFileSync(
			process.env.JASPER_FFMPEG ?? 'ffmpeg',
			['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
			{ input: png, maxBuffer: 64 << 20 },
		);
	const edgeEnergy = (pixels: Buffer, width: number) => {
		let sum = 0;
		for (let i = 0; i + 1 < pixels.length; i++)
			if (i % width !== width - 1) sum += Math.abs(pixels[i]! - pixels[i + 1]!);
		return sum;
	};
	const baseline = await shot();
	const width = baseline.readUInt32BE(16);
	await page.getByTestId('tab-effects').click();
	await page.getByTestId('effects-search').fill('Gaussian');
	await page
		.locator('[data-effect-id="jasper.gaussian-blur"]')
		.dragTo(page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${clipId}"]`).first());
	await expect
		.poll(async () => (await clipDoc()).effects?.some((e) => e.effectId === 'jasper.gaussian-blur'))
		.toBe(true);
	const beforeEdges = edgeEnergy(gray(baseline), width);
	await expect.poll(async () => edgeEnergy(gray(await shot()), width)).toBeLessThan(beforeEdges * 0.95);
	const blurred = await shot();
	await page.getByTestId('effects-search').fill('Corner Pin');
	await page
		.locator('[data-effect-id="jasper.corner-pin"]')
		.dragTo(page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${clipId}"]`).first());
	const pin = (await clipDoc()).effects?.find((e) => e.effectId === 'jasper.corner-pin');
	expect(pin).toBeDefined();
	const result = await page.evaluate(
		(id) =>
			(window as unknown as { jasper: { transact(tx: unknown): Promise<{ ok: boolean }> } }).jasper.transact({
				label: 'Corner pin',
				commands: [{ type: 'param.set', target: ['effect', id, 'topLeft'], value: [0.12, 0.08] }],
			}),
		pin!.id,
	);
	expect(result.ok).toBe(true);
	const beforePin = gray(blurred);
	const changedPixels = async () => {
		const afterPin = gray(await shot());
		let changed = 0;
		for (let i = 0; i < beforePin.length; i++) if (Math.abs(beforePin[i]! - afterPin[i]!) > 10) changed++;
		return changed;
	};
	await expect.poll(changedPixels).toBeGreaterThan(1000);
	writeFileSync(join(EXPORT_DIR, 'anime-effect-before.png'), baseline);
	writeFileSync(join(EXPORT_DIR, 'anime-effect-blurred.png'), blurred);
	writeFileSync(join(EXPORT_DIR, 'anime-effect-pinned.png'), await shot());
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
	return { file, renderPath: String(job.result?.renderPath ?? '') };
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

test('export (native with layer-bake, else Remotion) matches renderStill', async ({ request }) => {
	test.setTimeout(900_000);
	const caps = await (await request.get('/api/capabilities')).json();
	const bake = caps.features?.layerBake?.state === 'ready';
	test.info().annotations.push({
		type: 'export-path',
		description: bake
			? 'layer-bake ready: the anime template is baked, the plan must be native/hybrid'
			: 'layer-bake not available (this package alone): Auto plans the Remotion path for the anime template',
	});
	const out = await exportProRes(request, bake ? /native|hybrid/i : /remotion/i);
	expect(out.renderPath).toMatch(bake ? /native|hybrid/ : /remotion/);

	// renderStill of the same frame (engine POST /api/stills over the live document).
	const doc = await query<ProjectDocument>(page, 'doc.get');
	const clip = doc.sequences[seqId]!.clips[clipId] as unknown as MgClipDoc;
	const frame = clip.start + 24; // inside the intro: chars, subtitle and underline mid-animation
	const envelope = makeEnvelope(doc, { revision: 1, savedAt: new Date().toISOString(), platform: 'e2e' });
	const still = await request.post('/api/stills', { data: { envelope, sequenceId: seqId, frame } });
	expect(still.status()).toBe(202);
	const stillJob = await waitForJob(request, (await still.json()).id, 300_000);
	expect(stillJob.state, JSON.stringify(stillJob.error ?? null)).toBe('succeeded');
	const png = join(EXPORT_DIR, `still-${frame}.png`);
	writeFileSync(png, await (await request.get(String(stillJob.result?.url))).body());

	const a = rgbFrame(out.file, ['-vf', `select=eq(n\\,${frame})`, '-frames:v', '1']);
	const b = rgbFrame(png, []);
	expect(a.length).toBe(b.length);
	let within = 0;
	let max = 0;
	for (let i = 0; i < a.length; i += 3) {
		const d = Math.max(
			Math.abs(a[i]! - b[i]!),
			Math.abs(a[i + 1]! - b[i + 1]!),
			Math.abs(a[i + 2]! - b[i + 2]!),
		);
		if (d <= 3) within++;
		max = Math.max(max, d);
	}
	const ratio = within / (a.length / 3);
	console.info(
		`[anime-templates] export ${out.renderPath} vs renderStill frame ${frame}: ${(ratio * 100).toFixed(2)} % within 3/255, max ${max}`,
	);
	test.info().annotations.push({
		type: 'still-parity',
		description: `${(ratio * 100).toFixed(2)} % within 3/255 (max ${max})`,
	});
	expect(ratio).toBeGreaterThanOrEqual(0.99);
	// The frame is not trivially black: the title is drawn.
	let lit = 0;
	for (let i = 0; i < b.length; i += 3) if (b[i]! + b[i + 1]! + b[i + 2]! > 60) lit++;
	expect(lit).toBeGreaterThan(1000);
});

test('an out-of-canvas callout is clipped in the Program and exported frame', async ({ request }) => {
	test.setTimeout(900_000);
	await createProject(page, 'E2E Callout Clipping');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	const tx = await page.evaluate(() =>
		(window as unknown as { jasper: { transact(tx: unknown): Promise<{ ok: boolean }> } }).jasper.transact({
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
});
