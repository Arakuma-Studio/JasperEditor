// Colour grading E2E (S06). `Lumetri UI` (wp-m2-color, web UI): Color workspace, Lumetri panel edits (first edit
// adds the instance, a slider drag is one history entry, curve point), the LUT look picker, Effect Controls hosting
// the Lumetri editor with the curve/wheel rows hidden, and the scopes drawing a trace.
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	importFiles,
	query,
	timelineArea,
	watchPage,
} from './support.ts';

test.describe('Lumetri UI', () => {
	test.describe.configure({ mode: 'serial' });

	let page: Page;
	let watcher: { errors: string[] };
	let clipId = '';

	type Fx = { id: string; effectId: string; params: Record<string, { value: unknown }> };
	const lumetri = async (): Promise<Fx[]> => {
		const seq = await query<{ sequenceId: string }>(page, 'sequence.summary');
		const r = await query<{ effects?: Fx[] }>(page, 'doc.get', {
			path: ['sequences', seq.sequenceId, 'clips', clipId],
			fields: ['effects'],
		});
		return (r.effects ?? []).filter((e) => e.effectId === 'jasper.lumetri');
	};

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage();
		watcher = watchPage(page);
		await enableAgentBridge(page);
	});

	test.afterAll(async () => {
		await page?.close();
	});

	test('Color workspace with a graded clip: Lumetri edit = one history entry', async () => {
		await createProject(page, 'E2E Color UI');
		await importFiles(page, ['clip-a.mp4', 'look-33.cube']);
		// The LUT item shows its size and title (LUT-002).
		await expect(page.getByTestId('project-row').filter({ hasText: 'look-33.cube' })).toContainText('33³');
		const row = page.getByTestId('project-row').filter({ hasText: 'clip-a.mp4' });
		await row.click();
		const box = (await timelineArea(page).boundingBox())!;
		await row.dragTo(timelineArea(page), { targetPosition: { x: 0, y: box.height - 150 } });
		await expect.poll(async () => (await clips(page)).length).toBe(2);
		clipId = (await clips(page)).find((c) => c.kind === 'video')!.id;

		await page.getByTestId('workspace-tab-color').click();
		await expect(page.getByTestId('lumetri-panel')).toBeVisible();
		await expect(page.getByTestId('scopes-panel')).toBeVisible();
		const cb = await clipBox(page, clipId);
		await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
		await expect(page.getByTestId('lumetri-chip')).toHaveText('clip-a.mp4');
		expect(await lumetri()).toHaveLength(0);

		// Exposure slider drag: creates the instance and sets the value in ONE history entry.
		const before = (await appliedLabels(page)).length;
		const slider = page.getByTestId('lumetri-exposure');
		const s = (await slider.boundingBox())!;
		await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
		await page.mouse.down();
		for (let i = 1; i <= 8; i++) await page.mouse.move(s.x + s.width * (0.5 + i * 0.025), s.y + s.height / 2);
		await page.mouse.up();
		await expect.poll(async () => (await appliedLabels(page)).length).toBe(before + 1);
		expect((await appliedLabels(page)).at(-1)).toBe('Exposure');
		const [fx] = await lumetri();
		expect(fx).toBeTruthy();
		expect(fx!.params.exposure!.value as number).toBeGreaterThan(0.5);

		// Look picker lists the imported LUT; picking it is one entry on the same instance.
		const look = page.getByTestId('lumetri-look');
		await expect(look.locator('option')).toHaveText(['None', 'look-33.cube (33³)', 'Browse…']);
		await look.selectOption({ label: 'look-33.cube (33³)' });
		await expect.poll(async () => (await appliedLabels(page)).length).toBe(before + 2);
		const after = await lumetri();
		expect(after).toHaveLength(1);
		expect((after[0]!.params.look!.value as { mediaId: string }).mediaId).not.toBe('');

		// A click in the curves editor adds a point (sorted curve, one entry).
		const curve = page.getByTestId('lumetri-curve');
		await curve.scrollIntoViewIfNeeded();
		const c = (await curve.boundingBox())!;
		await page.mouse.click(c.x + c.width * 0.5, c.y + c.height * 0.3);
		await expect.poll(async () => (await appliedLabels(page)).length).toBe(before + 3);
		const pts = ((await lumetri())[0]!.params.curveMaster!.value as { curve: number[][] }).curve;
		expect(pts).toHaveLength(3);
		expect(pts.map((p) => p[0])).toEqual([...pts.map((p) => p[0])].sort((a, b) => a - b));

		// Undo restores the previous curve.
		await page.keyboard.press('Control+KeyZ');
		await expect
			.poll(
				async () => ((await lumetri())[0]!.params.curveMaster!.value as { curve: number[][] }).curve.length,
			)
			.toBe(2);
	});

	test('Effect Controls shows the Lumetri editor and hides the curve/wheel rows', async () => {
		await page.getByTestId('tab-effectControls').click();
		const [fx] = await lumetri();
		await expect(page.getByTestId(`fx-editor-${fx!.id}`)).toBeVisible();
		await expect(page.getByTestId('lumetri-editor-effectControls')).toBeAttached();
		await expect(page.locator(`[data-row="effects.${fx!.id}.exposure"]`)).toBeAttached();
		await expect(page.locator(`[data-row="effects.${fx!.id}.curveMaster"]`)).toHaveCount(0);
		await expect(page.locator(`[data-row="effects.${fx!.id}.shadowsWheel"]`)).toHaveCount(0);
		await page.getByTestId('tab-lumetri').click();
	});

	test('Lumetri Scopes draws a trace of the selected clip', async () => {
		await page.getByTestId('scopes-mode-waveform').click();
		await expect
			.poll(
				() =>
					page.getByTestId('scopes-canvas').evaluate((c) => {
						const cv = c as HTMLCanvasElement;
						const g = cv.getContext('2d');
						if (!g || !cv.width) return 0;
						const d = g.getImageData(0, 0, cv.width, cv.height).data;
						let bright = 0;
						for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > 300) bright++;
						return bright;
					}),
				{ timeout: 20_000 },
			)
			.toBeGreaterThan(50);
		await page.getByTestId('scopes-mode-vectorscope').click();
		await expect(page.getByTestId('scopes-canvas')).toHaveAttribute('data-mode', 'vectorscope');
		expect(watcher.errors.filter((e) => !/favicon|ResizeObserver/.test(e))).toEqual([]);
	});
});
