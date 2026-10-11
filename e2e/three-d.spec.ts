// HTML-in-Canvas enables the GPU 3D preview, as in Electron and Remotion.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	expectTransaction,
	exportViaUi,
	importFiles,
	query,
	transact,
} from './support.ts';

test.use({ launchOptions: { args: ['--enable-features=CanvasDrawElement'] } });
test.describe.configure({ mode: 'serial' });

let page: Page;
let seqId = '';
let floor = '';
let card = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E three-d');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
});
test.afterAll(async () => {
	await page?.close();
});

const clipDoc = async <T>(id: string) =>
	query<T>(page, 'doc.get', { path: ['sequences', seqId, 'clips', id] });

/** Mean colour of a region (fractions) of the Program monitor output. */
async function programRegion(x: number, y: number, w = 0.06, h = 0.06): Promise<[number, number, number]> {
	return page.getByTestId('program-player-wrapper').evaluate(
		(root, r) => {
			const W = 160;
			const H = 90;
			const c = document.createElement('canvas');
			c.width = W;
			c.height = H;
			const g = c.getContext('2d', { willReadFrequently: true })!;
			for (const s of [...root.querySelectorAll('canvas')] as HTMLCanvasElement[]) {
				try {
					g.drawImage(s, 0, 0, W, H);
				} catch {
					// not drawable
				}
			}
			const d = g.getImageData(
				Math.round(r.x * W),
				Math.round(r.y * H),
				Math.max(1, Math.round(r.w * W)),
				Math.max(1, Math.round(r.h * H)),
			).data;
			const s = [0, 0, 0];
			for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k]!;
			const n = d.length / 4;
			return [s[0]! / n, s[1]! / n, s[2]! / n] as [number, number, number];
		},
		{ x, y, w, h },
	);
}

async function menu(top: string, ...path: (string | RegExp)[]) {
	await page.getByTestId('title-bar').getByRole('menuitem', { name: top, exact: true }).click();
	for (let i = 0; i < path.length; i++) {
		const n = path[i]!;
		const opts = typeof n === 'string' ? { name: n, exact: true } : { name: n };
		const item = page
			.getByRole('menuitem', opts)
			.or(page.getByRole('menuitemcheckbox', opts))
			.or(page.getByRole('menuitemradio', opts));
		if (i < path.length - 1) await item.first().hover();
		else await item.first().click();
	}
}

test('Clip ▸ 3D Layer and the Effect Controls 3D switch make two solids one 3D run', async () => {
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [0.3, 0.35, 0.4, 1], ref: '$floor' },
		{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V2', color: [0.95, 0.4, 0.1, 1], ref: '$card' },
		{ type: 'param.set', target: ['clip', '$card', 'transform', 'scale'], value: 30 },
	]);
	expectTransaction(r);
	const all = await clips(page);
	floor = all.find((c) => c.track === 'V1')!.id;
	card = all.find((c) => c.track === 'V2')!.id;
	await query(page, 'playhead.set', { frame: 10 });
	await clipElement(page, card).click();
	await menu('Clip', /^3D Layer/);
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('3D Layer');
	expect((await clipDoc<{ threeD?: { enabled: boolean } }>(card)).threeD?.enabled).toBe(true);
	await clipElement(page, floor).click();
	await page.getByTestId('tab-effectControls').click();
	const sw = page.getByTestId(`ec-3d-switch-${floor}`);
	await sw.scrollIntoViewIfNeeded();
	await sw.click();
	await expect
		.poll(async () => (await clipDoc<{ threeD?: { enabled: boolean } }>(floor)).threeD?.enabled)
		.toBe(true);
	expect(
		(
			await transact(page, [
				{ type: 'param.set', target: ['clip', floor, 'threeD', 'rotationX'], value: 80 },
				{ type: 'param.set', target: ['clip', floor, 'transform', 'position'], value: [960, 780] },
				{ type: 'param.set', target: ['clip', card, 'threeD', 'rotationY'], value: 35 },
				{ type: 'param.set', target: ['clip', card, 'threeD', 'material', 'castsShadows'], value: 'on' },
			])
		).ok,
	).toBe(true);
	await expect(page.getByTestId('scene3d-overlay')).toBeVisible();
	await page.screenshot({ path: 'test-results/three-d-run.png' });
});

test('File ▸ New ▸ Camera… and Light…: the Program monitor draws the run through the camera, lit', async () => {
	const before = await programRegion(0.47, 0.47);
	await menu('File', 'New', /^Camera…/);
	const dlg = page.getByTestId('camera-settings-dialog');
	await expect(dlg).toBeVisible();
	await dlg.getByRole('button', { name: 'OK' }).click();
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('New Camera');
	const cam = (await clips(page)).find((c) => !['V1', 'V2'].includes(c.track))!;
	expect(
		(
			await transact(page, [
				{ type: 'camera.settings', clipId: cam.id, cameraType: 'two-node' },
				{ type: 'param.set', target: ['clip', cam.id, 'camera', 'position'], value: [1500, 200, -2000] },
				{ type: 'param.set', target: ['clip', cam.id, 'camera', 'pointOfInterest'], value: [960, 600, 0] },
			])
		).ok,
	).toBe(true);
	await menu('File', 'New', /^Light…/);
	const ldlg = page.getByTestId('light-settings-dialog');
	await expect(ldlg).toBeVisible();
	await ldlg.getByRole('button', { name: 'OK' }).click();
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('New Light');
	await expect
		.poll(
			async () => {
				const c = await programRegion(0.47, 0.47);
				return Math.max(...c.map((v, i) => Math.abs(v - before[i]!)));
			},
			{ timeout: 30_000 },
		)
		.toBeGreaterThan(20);
	await page.screenshot({ path: 'test-results/three-d-camera-light.png' });
});

test('the 3D view chip switches the Program monitor to Custom View 1 and back', async () => {
	const select = page.getByTestId('scene3d-view-select');
	const active = await programRegion(0.3, 0.3, 0.4, 0.4);
	await select.selectOption('custom1');
	await expect
		.poll(
			async () => {
				const c = await programRegion(0.3, 0.3, 0.4, 0.4);
				return Math.max(...c.map((v, i) => Math.abs(v - active[i]!)));
			},
			{ timeout: 30_000 },
		)
		.toBeGreaterThan(4);
	await page.screenshot({ path: 'test-results/three-d-custom-view.png' });
	await select.selectOption('activeCamera');
});

test('Sequence ▸ 3D Renderer ▸ Advanced 3D draws extruded text', async () => {
	await menu('Sequence', '3D Renderer', /^Advanced 3D/);
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('3D Renderer');
	expect(
		(
			await transact(page, [
				{
					type: 'clip.addText',
					at: 0,
					duration: 120,
					track: 'V3',
					content: { text: 'JASPER', style: { sizePx: 220 } },
					ref: '$t',
				},
				{ type: 'clip.set3d', clipIds: ['$t'], enabled: true },
				{ type: 'param.set', target: ['clip', '$t', 'threeD', 'rotationY'], value: 30 },
				{ type: 'param.set', target: ['clip', '$t', 'threeD', 'geometry', 'extrusionDepth'], value: 60 },
				{ type: 'param.set', target: ['clip', '$t', 'threeD', 'geometry', 'bevelStyle'], value: 'convex' },
			])
		).ok,
	).toBe(true);
	await page.waitForTimeout(1500);
	await page.screenshot({ path: 'test-results/three-d-advanced-text.png' });
});

test('the export renders the 3D scene on the Remotion path (named in the plan)', async ({ request }) => {
	// 120 frames of 1080p through the 3D renderer in a GPU-less headless Chrome (SwiftShader).
	test.setTimeout(1_200_000);
	const outDir = mkdtempSync(join(tmpdir(), 'jasper-e2e-3d-'));
	const { file } = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'three-d.mp4',
		expectPath: /remotion/i,
		expectBlocker: /3D/,
		outDir,
		jobTimeoutMs: 1_100_000,
	});
	execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		'-v',
		'error',
		'-y',
		'-ss',
		'0.5',
		'-i',
		file,
		'-frames:v',
		'1',
		'test-results/three-d-export.png',
	]);
	const raw = execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		...['-v', 'error', '-ss', '0.5', '-i', file, '-frames:v', '1'],
		...['-vf', 'scale=64:36:flags=area,format=rgb24', '-f', 'rawvideo', '-'],
	]);
	let orange = 0;
	let lit = 0;
	for (let i = 0; i < raw.length; i += 3) {
		if (raw[i]! > 60 && raw[i]! > raw[i + 2]! * 1.6 && raw[i]! > raw[i + 1]! * 1.3) orange++;
		if (raw[i]! + raw[i + 1]! + raw[i + 2]! > 60) lit++;
	}
	expect(orange).toBeGreaterThan(5);
	expect(lit).toBeGreaterThan(40);
});

test('3D Camera Tracker: Track Camera solves the dolly plate, three points → Create Text and Camera', async () => {
	test.setTimeout(900_000);
	await createProject(page, 'E2E camera tracker');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	// The export opened the Jobs panel in the Project panel's frame: show the Project panel again.
	const projectTab = page.getByTestId('tab-project');
	if (await projectTab.isVisible()) await projectTab.click();
	await importFiles(page, ['camtrack-dolly.mp4']);
	const media = await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list');
	const mediaId = media.media.find((m) => m.originalName === 'camtrack-dolly.mp4')!.mediaId;
	expect(
		(
			await transact(page, [
				{
					type: 'clip.place',
					source: { mediaId },
					at: 0,
					tracks: { video: 'V1' },
					matchSequence: 'keep',
					audio: false,
					ref: '$c',
				},
				{ type: 'clip.fitToFrame', clipIds: ['$c'], mode: 'fit' },
			])
		).ok,
	).toBe(true);
	const plate = (await clips(page)).find((c) => c.track === 'V1')!.id;
	await query(page, 'playhead.set', { frame: 20 });
	await clipElement(page, plate).click();
	await menu('Clip', /^Track Camera/);
	await expect
		.poll(async () => (await appliedLabels(page)).slice(-2), { timeout: 600_000, intervals: [2000] })
		.toEqual(['Track Camera', 'Solve Camera']);
	const t = (
		await clipDoc<{
			cameraTracker?: { solve: { methodUsed: string; averageError: number; points: unknown[] } };
		}>(plate)
	).cameraTracker!;
	expect(t.solve.methodUsed).toBe('typical');
	expect(t.solve.averageError).toBeLessThan(1);
	await expect(page.getByTestId('camtrack-section')).toHaveAttribute('data-solved', '1');
	const overlay = page.getByTestId('camtrack-overlay');
	await expect(overlay).toBeVisible();
	expect(Number(await overlay.getAttribute('data-points'))).toBeGreaterThan(50);
	await page.screenshot({ path: 'test-results/three-d-camtrack-points.png' });
	// Pick three points on the floor (the lower part of the frame), Shift-click to add.
	const pts = await overlay.locator('[data-point-id]').evaluateAll((els) =>
		els
			.map((e) => {
				const c = e.querySelector('circle')!.getBoundingClientRect();
				return { id: Number(e.getAttribute('data-point-id')), x: c.x + c.width / 2, y: c.y + c.height / 2 };
			})
			.sort((a, b) => b.y - a.y),
	);
	const chosen = [
		pts[0]!,
		pts.find((p) => Math.abs(p.x - pts[0]!.x) > 60)!,
		pts.find((p) => p.y < pts[0]!.y - 25)!,
	];
	await page.mouse.click(chosen[0]!.x, chosen[0]!.y);
	await page.keyboard.down('Shift');
	await page.mouse.click(chosen[1]!.x, chosen[1]!.y);
	await page.mouse.click(chosen[2]!.x, chosen[2]!.y);
	await page.keyboard.up('Shift');
	await expect(page.getByTestId('camtrack-target')).toBeVisible();
	await page.screenshot({ path: 'test-results/three-d-camtrack-target.png' });
	await page.getByTestId('camtrack-create-text').click();
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Create Text and Camera');
	const all = await clips(page);
	const camClip = all.find((c) => c.kind === 'camera');
	const text = all.find((c) => c.kind === 'text');
	expect(camClip && text).toBeTruthy();
	const cam = await clipDoc<{ camera: { transform: { position: { keyframes: unknown[] } } } }>(camClip!.id);
	expect(cam.camera.transform.position.keyframes.length).toBeGreaterThan(50);
	expect((await clipDoc<{ threeD?: { enabled: boolean } }>(text!.id)).threeD?.enabled).toBe(true);
	await page.waitForTimeout(1500);
	await page.screenshot({ path: 'test-results/three-d-camtrack-text.png' });
});
