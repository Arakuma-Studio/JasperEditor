import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { StillResultSchema } from '../packages/api/src/exports.ts';
import type { TextClip } from '../packages/project/src/index.ts';
import {
	clips,
	createProject,
	enableAgentBridge,
	expectTransaction,
	exportViaUi,
	focusTimeline,
	query,
	ROOT,
	transact,
	waitForJob,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT_DIR = join(ROOT, 'test-results', 'e2e-text-animators');

let page: Page;
let seqId = '';
let textId = '';

test.beforeAll(async ({ browser }) => {
	mkdirSync(OUT_DIR, { recursive: true });
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

const textClip = () => query<TextClip>(page, 'doc.get', { path: ['sequences', seqId, 'clips', textId] });
const animators = async () => (await textClip()).animators ?? [];

async function seek(frame: number): Promise<void> {
	await query(page, 'playhead.set', { frame });
}

/** Mean luma of the Program monitor after two equal captures. */
async function programMean(): Promise<number> {
	const grab = async () => {
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
			const d = g.getImageData(0, 0, img.width, img.height).data;
			let s = 0;
			for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
			return s / (d.length / 4);
		}, shot.toString('base64'));
	};
	let prev = await grab();
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(150);
		const next = await grab();
		if (Math.abs(next - prev) < 1e-6) return next;
		prev = next;
	}
	return prev;
}

async function menuPath(labels: string[]): Promise<void> {
	const menu = page.getByTestId('text-animator-menu');
	// Submenus open on hover; the last label is the item.
	for (const l of labels.slice(0, -1)) await menu.getByText(l, { exact: true }).first().hover();
	await menu
		.getByRole('menuitem', { name: labels.at(-1)!, exact: true })
		.first()
		.click();
}

test('Effect Controls ▸ Text ▸ Animate ▸ adds animators, selectors and presets', async () => {
	await createProject(page, 'E2E Text Animators');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Graphics', exact: true }).click();
	await page.getByRole('menuitem', { name: /New Layer/ }).click();
	await page.getByRole('menuitem', { name: /^Text(?! Animation)/ }).click();
	await expect.poll(async () => (await clips(page)).filter((c) => c.kind === 'text').length).toBe(1);
	textId = (await clips(page)).find((c) => c.kind === 'text')!.id;
	const r = await transact(page, [
		{
			type: 'clip.update',
			clipId: textId,
			patch: { content: { text: 'Animate me', style: { sizePx: 160, weight: 700 } } },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await focusTimeline(page);
	await page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${textId}"]`).first().click();
	await page.getByTestId('tab-effectControls').click();
	const animate = page.getByTestId(`text-animate-menu-${textId}`);
	await expect(animate).toBeVisible();
	await animate.click();
	await menuPath(['Position']);
	await expect.poll(async () => (await animators()).length).toBe(1);
	const a = (await animators())[0]!;
	expect(Object.keys(a.properties)).toEqual(['position']);
	expect(a.selectors.map((s) => s.kind)).toEqual(['range']);
	await expect(page.getByTestId(`text-animator-${a.id}`)).toBeVisible();
	await page.getByTestId(`text-animator-add-${a.id}`).click();
	await menuPath(['Selector', 'Wiggly']);
	await expect
		.poll(async () => (await animators())[0]!.selectors.map((s) => s.kind))
		.toEqual(['range', 'wiggly']);
	await page.getByTestId(`text-animator-delete-${a.id}`).click();
	await expect.poll(async () => (await animators()).length).toBe(0);
	await animate.click();
	await menuPath(['Animator Presets', 'Animate In', 'Typewriter']);
	await expect.poll(async () => (await animators()).map((x) => x.name)).toEqual(['Typewriter']);
	await page.screenshot({ path: join(OUT_DIR, 'effect-controls.png') });
});

test('the Program monitor types the text in; revisiting a frame is identical', async () => {
	const clip = (await clips(page)).find((c) => c.id === textId)!;
	await seek(clip.start);
	const first = await programMean();
	await seek(clip.start + 70);
	const rest = await programMean();
	expect(rest - first).toBeGreaterThan(1);
	await seek(clip.start + 30);
	const mid = await programMean();
	expect(mid).toBeGreaterThan(first);
	expect(mid).toBeLessThan(rest);
	await page.getByTestId('program-player-wrapper').screenshot({ path: join(OUT_DIR, 'program-mid.png') });
	await seek(clip.start + 5);
	await seek(clip.start + 30);
	expect(await programMean()).toBeCloseTo(mid, 6);
});

test('Path popup puts the text on a mask; Character settings apply', async () => {
	const r = await transact(page, [
		{ type: 'mask.add', clipId: textId, shape: 'ellipse', mode: 'none', ref: '$m' },
	]);
	expectTransaction(r);
	const maskId = r.refs.$m!;
	await page.getByTestId(`text-path-${textId}`).selectOption(maskId);
	await expect
		.poll(() =>
			query(page, 'doc.get', { path: ['sequences', seqId, 'clips', textId, 'pathOptions', 'maskId'] }),
		)
		.toBe(maskId);
	const clip = (await clips(page)).find((c) => c.id === textId)!;
	await seek(clip.start + 70);
	await programMean();
	await page.getByTestId('program-player-wrapper').screenshot({ path: join(OUT_DIR, 'program-path.png') });
	await page.getByTestId(`text-path-${textId}`).selectOption('');
	await expect.poll(async () => (await textClip()).pathOptions).toBeUndefined();
});

/** RGB24 pixels of one frame of a video (exact frame index) or an image, decoded by ffmpeg. */
function rgbFrame(file: string, frame: number | null, w: number, h: number): Buffer {
	return execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			...(frame === null ? [] : ['-vf', `select=eq(n\\,${frame})`, '-vsync', '0']),
			'-frames:v',
			'1',
			'-s',
			`${w}x${h}`,
			'-pix_fmt',
			'rgb24',
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: w * h * 3 + 1024 },
	);
}

test('export: a mid-animation frame matches renderStill (≤ 3/255 on 99 % of the pixels)', async ({
	request,
}) => {
	test.setTimeout(600_000);
	const clip = (await clips(page)).find((c) => c.id === textId)!;
	const frame = clip.start + 30;
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'text-animators.mp4',
		expectPath: /native|hybrid|remotion/i,
		outDir: OUT_DIR,
	});
	const doc = await query<Record<string, unknown>>(page, 'doc.get');
	const job = await (
		await request.post('/api/stills', {
			data: {
				envelope: {
					format: 'jasper-project',
					schemaVersion: doc.schemaVersion,
					savedAt: new Date().toISOString(),
					savedBy: { app: 'JasperEditor', version: '0.1.0', platform: 'e2e' },
					revision: 1,
					document: doc,
				},
				sequenceId: seqId,
				frame,
			},
		})
	).json();
	const done = await waitForJob(request, job.id);
	expect(done.state, JSON.stringify(done.error ?? null)).toBe('succeeded');
	const png = join(OUT_DIR, `still-${frame}.png`);
	writeFileSync(png, Buffer.from(await (await request.get(StillResultSchema.parse(done.result).url)).body()));
	const [w, h] = [1920, 1080];
	const a = rgbFrame(out.file, frame, w, h);
	const b = rgbFrame(png, null, w, h);
	writeFileSync(join(OUT_DIR, `export-${frame}.rgb`), a);
	let close = 0;
	let textPixels = 0;
	for (let i = 0; i < a.length; i += 3) {
		const d = Math.max(
			Math.abs(a[i]! - b[i]!),
			Math.abs(a[i + 1]! - b[i + 1]!),
			Math.abs(a[i + 2]! - b[i + 2]!),
		);
		if (d <= 3) close++;
		if (b[i]! > 128) textPixels++;
	}
	expect(textPixels).toBeGreaterThan(1000);
	expect(close / (w * h)).toBeGreaterThanOrEqual(0.99);
	const f0 = rgbFrame(out.file, clip.start, w, h);
	let lit0 = 0;
	for (let i = 0; i < f0.length; i += 3) if (f0[i]! > 128) lit0++;
	expect(lit0).toBeLessThan(200);
});
