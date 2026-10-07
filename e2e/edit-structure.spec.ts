// edit-structure through the real UI of the built app (docs/wp-notes/edit-structure.md): Clip ▸ Nest… with the
// Nested Sequence Name dialog, double-click into the nest, Group (Ctrl+G), Project ▸ New Item ▸ Bars and Tone /
// Adjustment Layer, frame hold from the clip menu, the Program monitor drawing the nest, the bars and the
// adjustment scope, and a native export whose frames are checked with ffmpeg (nested frame, bars, adjustment).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	importFiles,
	query,
	ROOT,
	sequenceSummary,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let mainSeq = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-edit-structure-final.png' });
	await page?.close();
});

type Doc = {
	items: Record<
		string,
		{ id: string; kind: string; name: string; syntheticId?: string; sequenceId?: string }
	>;
	synthetics: Record<string, { id: string; kind: string }>;
	sequences: Record<string, { clips: Record<string, { id: string; kind: string; frameHold?: unknown }> }>;
};
const doc = () => query<Doc>(page, 'doc.get');

function pixel(file: string, frame: number, x: number, y: number): [number, number, number] {
	const b = execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	return [b[0]!, b[1]!, b[2]!];
}

test('Clip ▸ Nest… nests the selected clips; double-click opens the nested sequence', async () => {
	await createProject(page, 'E2E Edit Structure');
	await importFiles(page, ['clip-a.mp4']);
	mainSeq = (await sequenceSummary(page)).sequenceId;
	const d = await doc();
	const item = Object.values(d.items).find((i) => i.kind === 'media')!;
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { projectItemId: item.id },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 3 } },
		},
	]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	const [v] = await clips(page, ['V1']);
	const box = await clipBox(page, v!.id);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Clip', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Nest…/ }).click();
	await expect(page.getByTestId('nest-dialog')).toBeVisible();
	await page.getByTestId('nest-name').fill('E2E Nest');
	await page.getByRole('button', { name: 'OK' }).click();
	await expect.poll(async () => (await clips(page, ['V1']))[0]?.kind).toBe('nest-video');
	const nest = (await clips(page, ['V1']))[0]!;
	expect(Object.values((await doc()).items).some((i) => i.kind === 'sequence' && i.name === 'E2E Nest')).toBe(
		true,
	);
	// The Program monitor draws the nested sequence.
	await expect(page.locator('[data-nest]').first()).toBeAttached({ timeout: 30_000 });
	// Double-click opens it.
	const nb = await clipBox(page, nest.id);
	await page.mouse.dblclick(nb.x + 20, nb.y + nb.height / 2);
	await expect.poll(async () => (await sequenceSummary(page)).sequenceId).not.toBe(mainSeq);
});

test('New Item ▸ Bars and Tone and Adjustment Layer; the Program draws them', async () => {
	// Back to the main sequence through its project item.
	const main = Object.values((await doc()).items).find(
		(i) => i.kind === 'sequence' && i.sequenceId === mainSeq,
	)!;
	await page.getByTestId('project-row').filter({ hasText: main.name }).first().dblclick();
	await expect.poll(async () => (await sequenceSummary(page)).sequenceId).toBe(mainSeq);
	await page.getByTestId('project-new-item').click();
	await page.getByTestId('new-item-bars').click();
	await expect(page.getByTestId('project-row').filter({ hasText: 'Bars and Tone' })).toBeVisible();
	await page.getByTestId('project-new-item').click();
	await page.getByTestId('new-item-adjustment').click();
	await expect(page.getByTestId('project-row').filter({ hasText: 'Adjustment Layer' })).toBeVisible();
	const d = await doc();
	const bars = Object.values(d.items).find(
		(i) => i.kind === 'synthetic' && d.synthetics[i.syntheticId!]?.kind === 'bars-and-tone',
	)!;
	const adj = Object.values(d.items).find(
		(i) => i.kind === 'synthetic' && d.synthetics[i.syntheticId!]?.kind === 'adjustment',
	)!;
	const r = await transact(page, [
		{
			type: 'clip.place',
			sequenceId: mainSeq,
			source: { projectItemId: bars.id },
			at: 90,
			tracks: { video: 'V1', audio: 'A1' },
		},
		{
			type: 'clip.place',
			sequenceId: mainSeq,
			source: { projectItemId: adj.id },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
			tracks: { video: 'V3' },
			ref: '$adj',
		},
		{
			type: 'effect.add',
			target: { clipId: '$adj' },
			effectId: 'jasper.black-white',
		},
	]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	await expect(page.locator('[data-adjustment-scope]').first()).toBeAttached({ timeout: 30_000 });
	await page.evaluate(() =>
		(window as unknown as { jasper: { query(n: string, a: unknown): unknown } }).jasper.query(
			'playhead.set',
			{ frame: 95 },
		),
	);
	await expect(page.locator('canvas[data-generator]').first()).toBeAttached({ timeout: 30_000 });
});

test('Group (Ctrl+G) and Add Frame Hold from the clip menu', async () => {
	const v1 = await clips(page, ['V1']);
	const nest = v1.find((c) => c.kind === 'nest-video')!;
	const bars = v1.find((c) => c.kind === 'solid')!;
	const a = await clipBox(page, nest.id);
	const b = await clipBox(page, bars.id);
	await page.mouse.click(a.x + 10, a.y + a.height / 2);
	await page.keyboard.down('Shift');
	await page.mouse.click(b.x + 5, b.y + b.height / 2);
	await page.keyboard.up('Shift');
	await page.keyboard.press('Control+KeyG');
	await expect
		.poll(async () => {
			const s = (await doc()).sequences[mainSeq]!;
			return !!(s.clips[nest.id] as { groupId?: string | null }).groupId;
		})
		.toBe(true);
	await page.keyboard.press('Control+Shift+KeyG');
	await page.evaluate(() =>
		(window as unknown as { jasper: { query(n: string, a: unknown): unknown } }).jasper.query(
			'playhead.set',
			{
				frame: 30,
			},
		),
	);
	await page.mouse.click(a.x + 10, a.y + a.height / 2);
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Clip', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Video Options/ }).hover();
	await page.getByRole('menuitem', { name: /^Add Frame Hold/ }).click();
	await expect
		.poll(async () => Object.values((await doc()).sequences[mainSeq]!.clips).some((c) => c.frameHold))
		.toBe(true);
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect
		.poll(async () => Object.values((await doc()).sequences[mainSeq]!.clips).some((c) => c.frameHold))
		.toBe(false);
});

test('exports natively: the nested frames, the bars and the adjustment layer', async ({ request }) => {
	const outDir = join(ROOT, 'test-results', 'e2e-edit-structure');
	mkdirSync(outDir, { recursive: true });
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'edit-structure.mp4',
		expectPath: /native/i,
		outDir,
	});
	// Bars at 4 s (frame ~ 120 at 29.97): 75 % white bar after the 40 % grey side panel.
	const white = pixel(file, 100, 300, 100);
	expect(white.every((c) => Math.abs(c - 191) < 10)).toBe(true);
	const grey = pixel(file, 100, 100, 100);
	expect(grey.every((c) => Math.abs(c - 102) < 10)).toBe(true);
	// Under the Black & White adjustment the nest's picture is there and grey.
	const p = pixel(file, 10, 960, 540);
	expect(p.some((c) => c > 10)).toBe(true);
	expect(Math.max(...p) - Math.min(...p)).toBeLessThan(12);
});

test('an adjustment layer with a shader-only effect routes the export through Remotion', async ({
	request,
}) => {
	const adj = Object.values((await doc()).sequences[mainSeq]!.clips).find((c) => c.kind === 'adjustment')!;
	const r = await transact(page, [
		{
			type: 'effect.add',
			target: { clipId: adj.id },
			effectId: 'jasper.gaussian-blur',
			params: { radius: 8 },
		},
	]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	const outDir = join(ROOT, 'test-results', 'e2e-edit-structure');
	const { file } = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'edit-structure-remotion.mp4',
		expectPath: /Remotion/i,
		outDir,
		jobTimeoutMs: 600_000,
	});
	// Bars come from the same generator in the browser.
	const white = pixel(file, 100, 300, 100);
	expect(white.every((c) => Math.abs(c - 191) < 12)).toBe(true);
});
