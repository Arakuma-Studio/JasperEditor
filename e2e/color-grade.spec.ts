// color-grade E2E: the Lumetri completion in the real app — HSL Secondary eyedropper on the Program monitor, Auto,
// Comparison View + Apply Match against another clip, the Looks browser, the vignette in the Program monitor and in
// the export (the spatial GPU stage through the layer bake), and the Lumetri Scopes layouts.
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
	importFiles,
	mediaIdForFile,
	query,
	ROOT,
	regionLuma,
	timelineArea,
	transact,
} from './support.ts';

const OUT = join(ROOT, 'test-results', 'color-grade');

test.describe('Lumetri completion and scopes', () => {
	test.describe.configure({ mode: 'serial' });

	let page: Page;
	let clipA = '';
	let clipB = '';
	let startB = 0;

	type Fx = { id: string; effectId: string; params: Record<string, { value: unknown }> };
	const lumetriOf = async (clipId: string): Promise<Fx | undefined> => {
		const seq = await query<{ sequenceId: string }>(page, 'sequence.summary');
		const r = await query<{ effects?: Fx[] }>(page, 'doc.get', {
			path: ['sequences', seq.sequenceId, 'clips', clipId],
			fields: ['effects'],
		});
		return (r.effects ?? []).find((e) => e.effectId === 'jasper.lumetri');
	};
	const seek = async (frame: number) => {
		await query(page, 'playhead.set', { frame });
	};
	/** Mean luma of the corner and the centre of clip A's picture in the Program monitor. */
	const cornerCenter = () =>
		page.getByTestId('program-player-wrapper').evaluate((root, id) => {
			const host = root.querySelector(`[data-clip-id="${id}"]`);
			const el = (host?.querySelector('canvas') ?? host?.querySelector('video')) as
				| HTMLCanvasElement
				| HTMLVideoElement
				| null;
			if (!el) return null;
			const w = 160;
			const h = 90;
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			const g = c.getContext('2d', { willReadFrequently: true })!;
			g.drawImage(el, 0, 0, w, h);
			const d = g.getImageData(0, 0, w, h).data;
			const mean = (x0: number, y0: number, x1: number, y1: number) => {
				let s = 0;
				let n = 0;
				for (let y = y0; y < y1; y++)
					for (let x = x0; x < x1; x++) {
						const i = (y * w + x) * 4;
						s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
						n++;
					}
				return s / n;
			};
			return { corner: mean(0, 0, 12, 8), center: mean(74, 40, 86, 50) };
		}, clipA);

	test.beforeAll(async ({ browser }) => {
		mkdirSync(OUT, { recursive: true });
		page = await browser.newPage();
		await enableAgentBridge(page);
	});

	test.afterAll(async () => {
		if (page && !page.isClosed()) await page.screenshot({ path: join(OUT, 'final.png') });
		await page?.close();
	});

	test('two clips in the Color workspace', async () => {
		await createProject(page, 'E2E Color Grade');
		await importFiles(page, ['clip-a.mp4', 'clip-b.mp4']);
		const row = page.getByTestId('project-row').filter({ hasText: 'clip-a.mp4' });
		await row.click();
		const box = (await timelineArea(page).boundingBox())!;
		await row.dragTo(timelineArea(page), { targetPosition: { x: 0, y: box.height - 150 } });
		await expect.poll(async () => (await clips(page)).length).toBe(2);
		const a = (await clips(page)).find((c) => c.kind === 'video')!;
		clipA = a.id;
		startB = a.start + a.duration;
		const placed = await transact(page, [
			{
				type: 'clip.place',
				source: { mediaId: await mediaIdForFile(page, 'clip-b.mp4') },
				at: startB,
				audio: false,
			},
		]);
		expect(placed.ok, JSON.stringify(placed)).toBe(true);
		clipB = (await clips(page)).find((c) => c.kind === 'video' && c.id !== clipA)!.id;
		// A warm, saturated reference grade on clip B.
		const r = await transact(page, [
			{
				type: 'effect.add',
				target: { clipId: clipB },
				effectId: 'jasper.lumetri',
				params: { highlightsWheel: [0.6, 0.15], shadowsWheel: [-0.3, -0.4], saturation: 140 },
			},
		]);
		expect(r.ok).toBe(true);
		await page.getByTestId('workspace-tab-color').click();
		await expect(page.getByTestId('lumetri-panel')).toBeVisible();
		const cb = await clipBox(page, clipA);
		await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
		await expect(page.getByTestId('lumetri-chip')).toHaveText('clip-a.mp4');
		await seek(10);
	});

	test('HSL Secondary Set Color samples the Program monitor (one history entry)', async () => {
		await page.getByTestId('section-toggle-lumetri.secondary').click();
		await page.getByTestId('lumetri-secondary-set').click();
		await expect(page.getByTestId('lumetri-eyedropper-overlay')).toBeVisible();
		const before = (await appliedLabels(page)).length;
		const wrap = (await page.getByTestId('program-player-wrapper').boundingBox())!;
		await page.mouse.click(wrap.x + wrap.width * 0.3, wrap.y + wrap.height * 0.5);
		await expect.poll(async () => (await appliedLabels(page)).length).toBe(before + 1);
		expect((await appliedLabels(page)).at(-1)).toBe('HSL Secondary: Set Color');
		await expect(page.getByTestId('lumetri-eyedropper-overlay')).toBeHidden();
		const fx = (await lumetriOf(clipA))!;
		expect(fx.params.secLumaLow!.value).not.toBe(0);
		// Show the key, then hide it again (the mask view).
		await transact(page, [
			{ type: 'param.set', target: ['effect', fx.id, 'secShowMask'], value: true },
			{ type: 'param.set', target: ['effect', fx.id, 'secMaskStyle'], value: 'whiteBlack' },
		]);
		await page.waitForTimeout(1500);
		await page.getByTestId('program-player-wrapper').screenshot({ path: join(OUT, 'secondary-mask.png') });
		await transact(page, [{ type: 'param.set', target: ['effect', fx.id, 'secShowMask'], value: false }]);
	});

	test('Auto sets the tone sliders in one step', async () => {
		const before = (await appliedLabels(page)).length;
		await page.getByTestId('lumetri-auto').click();
		await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 }).toBe(before + 1);
		expect((await appliedLabels(page)).at(-1)).toBe('Auto Tone');
	});

	test('Comparison View + Apply Match grades clip A towards clip B', async () => {
		await page.getByTestId('lumetri-comparison-view').click();
		await expect(page.getByTestId('comparison-view')).toBeVisible();
		// Reference: a frame of clip B (step to it, Set to Playhead), then back on clip A.
		await seek(startB + 10);
		await page.getByTestId('comparison-set').click();
		await seek(10);
		await expect(page.getByTestId('comparison-frame')).toHaveText(String(startB + 10));
		await page.waitForTimeout(1000);
		await page.getByTestId('comparison-view').screenshot({ path: join(OUT, 'comparison-before.png') });
		const before = (await appliedLabels(page)).length;
		await page.getByTestId('lumetri-apply-match').click();
		await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 180_000 }).toBe(before + 1);
		expect((await appliedLabels(page)).at(-1)).toBe('Apply Match');
		const fx = (await lumetriOf(clipA))!;
		const sat = fx.params.saturation!.value as number;
		expect(sat).toBeGreaterThan(100);
		await page.waitForTimeout(1500);
		await page.getByTestId('comparison-view').screenshot({ path: join(OUT, 'comparison-after.png') });
		await page.getByTestId('lumetri-comparison-view').click();
		await expect(page.getByTestId('comparison-view')).toBeHidden();
	});

	test('the Looks browser applies a built-in look', async () => {
		await page.getByTestId('lumetri-looks-browser').click();
		const before = (await appliedLabels(page)).length;
		await page.getByTestId('lumetri-look-tile-teal-orange').click();
		await expect.poll(async () => (await appliedLabels(page)).length).toBe(before + 1);
		expect((await appliedLabels(page)).at(-1)).toBe('Look: Teal & Orange');
		await page.getByTestId('lumetri-panel').screenshot({ path: join(OUT, 'looks-browser.png') });
	});

	test('the vignette darkens the corners in the Program monitor', async () => {
		await page.waitForTimeout(1500);
		const plain = await cornerCenter();
		expect(plain).not.toBeNull();
		const fx = (await lumetriOf(clipA))!;
		await transact(page, [
			{ type: 'param.set', target: ['effect', fx.id, 'vignetteAmount'], value: -4 },
			{ type: 'param.set', target: ['effect', fx.id, 'vignetteFeather'], value: 30 },
		]);
		await expect
			.poll(
				async () => {
					const v = await cornerCenter();
					return v ? v.corner / Math.max(1, plain!.corner) : 1;
				},
				{ timeout: 60_000 },
			)
			.toBeLessThan(0.6);
		await page.getByTestId('program-player-wrapper').screenshot({ path: join(OUT, 'vignette-preview.png') });
	});

	test('Lumetri Scopes: four-scope layout draws traces', async () => {
		await page.getByTestId('scopes-layout').selectOption('four-up-yuv');
		await expect(page.getByTestId('scopes-canvas')).toHaveAttribute('data-has-trace', 'true', {
			timeout: 30_000,
		});
		await page.getByTestId('scopes-settings').click();
		await page.getByTestId('scopes-matrix').selectOption('bt2020');
		await page.getByTestId('scopes-scale').selectOption('10bit');
		await page.waitForTimeout(1000);
		await page.getByTestId('scopes-panel').screenshot({ path: join(OUT, 'scopes-four-up.png') });
	});

	test('export renders the spatial stage (vignette) through the layer bake', async ({ request }) => {
		const out = await exportViaUi(page, request, {
			engine: 'auto',
			fileName: 'color-grade.mp4',
			expectPath: /hybrid|Remotion|baked/i,
			outDir: OUT,
			jobTimeoutMs: 600_000,
		});
		const corner = regionLuma(out.file, 10 / 29.97, { x: 0, y: 0, w: 0.08, h: 0.08 });
		const center = regionLuma(out.file, 10 / 29.97, { x: 0.45, y: 0.45, w: 0.1, h: 0.1 });
		expect(corner).toBeLessThan(center * 0.6);
	});
});
