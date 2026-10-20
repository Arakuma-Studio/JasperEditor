import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	createProject,
	enableAgentBridge,
	importFiles,
	query,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let videoClip = '';
let originalId = '';

type Doc = {
	media: Record<string, { id: string; originalName: string; derivation: { recipe: { op: string } } | null }>;
	sequences: Record<string, { clips: Record<string, { id: string; kind: string; mediaId?: string }> }>;
};

async function doc(): Promise<Doc> {
	return query<Doc>(page, 'doc.get');
}

async function clipMedia(): Promise<string | undefined> {
	const d = await doc();
	for (const s of Object.values(d.sequences)) if (s.clips[videoClip]) return s.clips[videoClip]!.mediaId;
	return undefined;
}

async function undo(): Promise<void> {
	await page.getByTestId('timeline-track-area').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('Control+KeyZ');
}

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Processing');
	await importFiles(page, ['clip-b.mp4']);
	const d0 = await doc();
	originalId = Object.values(d0.media).find((m) => m.originalName === 'clip-b.mp4')!.id;
	const placed = await page.evaluate(
		(mediaId) =>
			window.jasper!.transact({
				label: 'Place clip-b',
				commands: [{ type: 'clip.place', source: { mediaId }, at: 0 }],
			}),
		originalId,
	);
	expect(placed.ok).toBe(true);
	const d1 = await doc();
	videoClip = Object.values(Object.values(d1.sequences)[0]!.clips).find((c) => c.kind === 'video')!.id;
	await expect(clipElement(page, videoClip)).toBeVisible();
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-processing-final.png' });
	await page?.close();
});

test('Process Clip… with Smooth path: keyboard selection submits the chosen processing recipe', async () => {
	await clipElement(page, videoClip).click({ button: 'right', position: { x: 30, y: 20 } });
	await page.getByRole('menuitem', { name: 'Process Clip…' }).dispatchEvent('click');
	const dialog = page.getByTestId('process-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('checkbox', { name: 'Stabilize' }).click();
	// Pick the method with the keyboard only: Enter opens the focused Select (no global shortcut takes it), the
	// arrows move, Enter on the option picks it without also pressing Start.
	const method = dialog.getByRole('combobox', { name: 'Stabilize method' });
	await method.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('option', { name: 'Smooth path (one even move)' })).toBeVisible();
	const smooth = page.getByRole('option', { name: 'Smooth path (one even move)' });
	await expect
		.poll(async () => {
			if (await smooth.evaluate((el) => el === document.activeElement)) return true;
			await page.keyboard.press('ArrowDown');
			return false;
		})
		.toBe(true);
	await page.keyboard.press('Enter');
	await expect(dialog).toBeVisible();
	await expect(method).toContainText('Smooth path');
	await dialog.getByRole('checkbox', { name: 'Vertical (no tilt)' }).click();
	await dialog.getByRole('checkbox', { name: 'Rotation (level horizon)' }).click();
	await dialog.screenshot({ path: 'test-results/e2e/process-dialog-smoothpath.png' });
	const before = (await appliedLabels(page)).filter((l) => l === 'Process Clip').length;
	await dialog.getByRole('button', { name: 'Start' }).click();
	await expect(dialog).toBeHidden();
	await expect
		.poll(async () => (await appliedLabels(page)).filter((l) => l === 'Process Clip').length, {
			timeout: 400_000,
			intervals: [2000],
		})
		.toBe(before + 1);
	const d = await doc();
	const processed = d.media[(await clipMedia())!] as unknown as {
		originalName: string;
		derivation: { recipe: { op: string; steps: Array<Record<string, unknown>> } };
	};
	expect(processed.derivation.recipe.steps).toEqual([
		expect.objectContaining({
			op: 'stabilize',
			method: 'smoothpath',
			lockVertical: true,
			lockRotation: true,
		}),
	]);
	await test
		.info()
		.attach('processing-result', { body: JSON.stringify(processed), contentType: 'application/json' });
	await undo();
	await expect.poll(clipMedia).toBe(originalId);
});
