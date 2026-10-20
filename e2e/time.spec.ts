import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	importFiles,
	pointerDrag,
	query,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let coded = '';

test.beforeAll(async ({ browser }) => {
	// Tall enough for the whole clip context menu.
	page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-time-final.png' });
	await page?.close();
});

type RemapClip = {
	id: string;
	kind: string;
	start: number;
	duration: number;
	timeRemap?: { enabled: boolean; keyframes: unknown[]; speedBefore?: number };
	timeInterpolation?: string;
};
type Doc = {
	items: Record<string, { id: string; kind: string; name: string }>;
	sequences: Record<string, { clips: Record<string, RemapClip> }>;
};
const doc = () => query<Doc>(page, 'doc.get');
async function clipDoc(id: string): Promise<RemapClip> {
	const d = await doc();
	for (const s of Object.values(d.sequences)) if (s.clips[id]) return s.clips[id]!;
	throw new Error(`no clip ${id}`);
}

const SEQ_FPS = 30000 / 1001;
test('Show Clip Keyframes ▸ Time Remapping ▸ Speed; dragging the band slows the clip down', async () => {
	await createProject(page, 'E2E Time');
	await importFiles(page, ['frame-code.mp4', 'scenes.mp4']);
	const d = await doc();
	const item = Object.values(d.items).find((i) => i.name.startsWith('frame-code'))!;
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { projectItemId: item.id },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const [v] = await clips(page, ['V1']);
	coded = v!.id;
	const before = (await clipDoc(coded)).duration;
	// The speed band requires expanded tracks to expose its drag target.
	await focusTimeline(page);
	await page.keyboard.press('Shift+Equal');
	const box = await clipBox(page, coded);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await clipElement(page, coded).click({
		button: 'right',
		position: { x: box.width / 2, y: box.height / 2 },
	});
	await page.getByRole('menu').getByText('Show Clip Keyframes', { exact: true }).hover();
	await page.getByRole('menu').getByText('Time Remapping', { exact: true }).hover();
	await page.getByRole('menuitem', { name: /Speed$/ }).click();
	const line = page.locator(`[data-speed-band="${coded}"] [data-speed-band-line]`);
	await expect(line).toBeAttached();
	const lb = (await line.boundingBox())!;
	const x = lb.x + lb.width / 2;
	const y = lb.y + lb.height / 2;
	// Downward speed-band drags reduce speed and increase duration.
	await pointerDrag(page, { x, y }, { x, y: y + 8 });
	await expect.poll(async () => (await clipDoc(coded)).timeRemap?.enabled).toBe(true);
	expect((await clipDoc(coded)).duration).toBeGreaterThan(before);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clipDoc(coded)).duration).toBe(before);
});

test('Scene Edit Detection… cuts at the four hard cuts in one undo step', async () => {
	const d = await doc();
	const item = Object.values(d.items).find((i) => i.name.startsWith('scenes'))!;
	const start = (await clipDoc(coded)).duration + 30;
	const r = await transact(page, [{ type: 'clip.place', source: { projectItemId: item.id }, at: start }]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const scenes = (await clips(page, ['V1'])).find((c) => c.start === start)!;
	await page.keyboard.press('Backslash');
	const box = await clipBox(page, scenes.id);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await clipElement(page, scenes.id).click({
		button: 'right',
		position: { x: box.width / 2, y: box.height / 2 },
	});
	await page.getByRole('menuitem', { name: /^Scene Edit Detection/ }).click();
	const dialog = page.getByTestId('scene-detect-dialog');
	await expect(dialog).toBeVisible();
	const labels = (await appliedLabels(page)).length;
	await dialog.getByRole('button', { name: 'Analyze' }).click();
	await expect(dialog).toBeHidden({ timeout: 120_000 });
	const pieces = (await clips(page, ['V1'])).filter((c) => c.start >= start);
	expect(pieces.length).toBe(5);
	const cuts = pieces.slice(1).map((c) => c.start - start);
	// 30 fps source cuts 45, 75, 120, 198 in a 29.97 sequence.
	for (const [i, src] of [45, 75, 120, 198].entries())
		expect(Math.abs(cuts[i]! - src * (SEQ_FPS / 30)), `cut ${i}`).toBeLessThanOrEqual(1);
	const after = await appliedLabels(page);
	expect(after.length).toBe(labels + 1);
	expect(after.at(-1)).toBe('Scene Edit Detection');
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1'])).filter((c) => c.start >= start).length).toBe(1);
});

test.afterEach(async () => {
	await test
		.info()
		.attach('retimed-document', { body: JSON.stringify(await doc()), contentType: 'application/json' });
});
