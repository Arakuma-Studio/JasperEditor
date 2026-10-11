// Colour grading E2E (S06). `Lumetri UI` (wp-m2-color, web UI): Color workspace, Lumetri panel edits (first edit
// adds the instance, a slider drag is one history entry, curve point), and the LUT look picker.
// Forced WebGL preview pixels are compared with the independent CPU LUT implementation.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	applyLut,
	bakeColorRun,
	defaultEffectRegistry,
	type EffectParams,
	LUMETRI_EFFECT_ID,
	parseCube,
} from '../packages/project/src/index.ts';
import {
	appliedLabels,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	expectTransaction,
	FIXTURES,
	importFiles,
	query,
	timelineArea,
} from './support.ts';

test.describe('Lumetri UI', () => {
	test.describe.configure({ mode: 'serial' });

	let page: Page;
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
		await enableAgentBridge(page);
	});

	test.afterAll(async () => {
		if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-color.png' });
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
});

/** A representative grade (the same as the engine's native/Remotion parity tests). */
const PARITY_GRADE = (look: string): EffectParams => ({
	temperature: -30,
	tint: 6,
	exposure: 0.3,
	contrast: 15,
	highlights: -25,
	shadows: 30,
	saturation: 115,
	look: { mediaId: look },
	lookIntensity: 80,
	vibrance: 15,
	curveMaster: {
		curve: [
			[0, 0.02],
			[0.5, 0.52],
			[1, 0.98],
		],
	},
	midtonesWheel: [0.1, 0.2],
});

test('the forced WebGL Program canvas matches the independent CPU LUT reference (S06 §9.4)', async ({
	page,
}) => {
	await page.addInitScript(() => window.localStorage.setItem('jasper:color-stage', 'webgl'));
	await enableAgentBridge(page);
	await createProject(page, 'Colour parity');
	const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
	test.skip(
		!webgl,
		'WebGL2 is unavailable in this browser (the WEBGL_UNAVAILABLE path is covered by the engine test)',
	);
	await importFiles(page, ['chart.png', 'look-33.cube']);
	const media = (await query<{ media: { mediaId: string; kind: string }[] }>(page, 'media.list')).media;
	const chart = media.find((m) => m.kind === 'image')!.mediaId;
	const look = media.find((m) => m.kind === 'lut')!.mediaId;
	const tx = await page.evaluate(
		([c, grade]) =>
			window.jasper!.transact({
				label: 'Grade chart',
				commands: [
					{ type: 'clip.place', source: { mediaId: c }, at: 0, ref: '$c' },
					{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.lumetri', params: grade },
				],
			}),
		[chart, PARITY_GRADE(look)] as const,
	);
	expectTransaction(tx);
	const clipId = tx.refs.$c!;
	// Light probe first (size only); the pixels travel as a lossless PNG data URL (8 MB of numbers through the
	// protocol is very slow with tracing on).
	const probe = () =>
		page.evaluate((id) => {
			const c = document.querySelector(
				`[data-testid="program-player-wrapper"] [data-clip-id="${id}"] canvas`,
			) as HTMLCanvasElement | null;
			return c && c.width > 0 ? [c.width, c.height] : null;
		}, clipId);
	await expect.poll(probe, { timeout: 60_000 }).toEqual([1920, 1080]);
	const grab = () =>
		page.evaluate((id) => {
			const c = document.querySelector(
				`[data-testid="program-player-wrapper"] [data-clip-id="${id}"] canvas`,
			) as HTMLCanvasElement;
			return c.toDataURL('image/png');
		}, clipId);
	// The chain draws asynchronously after the image decoded: wait until the canvas stops changing.
	let last = '';
	for (let i = 0; i < 30; i++) {
		const url = await grab();
		if (url === last) break;
		last = url;
		await page.waitForTimeout(1000);
	}
	const decodeRgb = (input: string | Buffer) =>
		execFileSync(
			'ffmpeg',
			[
				'-v',
				'error',
				'-i',
				typeof input === 'string' ? input : 'pipe:0',
				'-f',
				'rawvideo',
				'-pix_fmt',
				'rgb24',
				'-',
			],
			{ maxBuffer: 1 << 28, ...(typeof input === 'string' ? {} : { input }) },
		);
	const got = decodeRgb(Buffer.from(last.slice(last.indexOf(',') + 1), 'base64'));

	const lookLut = parseCube(readFileSync(join(FIXTURES, 'look-33.cube'), 'utf8'));
	const lut = bakeColorRun(
		[
			{
				id: 'g',
				effectId: LUMETRI_EFFECT_ID,
				effectVersion: 1,
				enabled: true,
				params: PARITY_GRADE('L'),
			},
		],
		defaultEffectRegistry,
	type EffectParams,
		{ lut: (id) => (id === 'L' ? lookLut : null) },
		33,
	)!;
	const src = decodeRgb(join(FIXTURES, 'chart.png'));
	expect(got.length).toBe(src.length);
	const hist = new Array<number>(256).fill(0);
	const c: [number, number, number] = [0, 0, 0];
	for (let i = 0; i < src.length; i += 3) {
		c[0] = src[i]! / 255;
		c[1] = src[i + 1]! / 255;
		c[2] = src[i + 2]! / 255;
		applyLut(lut, c);
		for (let k = 0; k < 3; k++) hist[Math.abs(got[i + k]! - Math.round(c[k]! * 255))]!++;
	}
	const n = src.length;
	const within1 = (hist[0]! + hist[1]!) / n;
	console.info(
		`[S06 §9.4] preview (webgl) vs TS reference: exact ${((hist[0]! / n) * 100).toFixed(3)} %, ≤1 ${(within1 * 100).toFixed(3)} %`,
	);
	expect(within1).toBeGreaterThanOrEqual(0.995);
});
