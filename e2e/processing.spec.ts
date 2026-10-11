// S07 processing: timeline action queues actual processing, replaces a clip in one undo step,
// switches media versions, submits Smooth path keyboard choices and persists remote settings.
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
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-processing-final.png' });
	await page?.close();
});

test('Process Clip… (denoise) swaps the clip to the processed version in one undo step', async () => {
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

	// Timeline clip context menu → Process Clip…
	await clipElement(page, videoClip).click({ button: 'right', position: { x: 30, y: 20 } });
	// The clip menu is long (labels) and may extend below the viewport; activate the entry directly.
	await page.getByRole('menuitem', { name: 'Process Clip…' }).dispatchEvent('click');
	const dialog = page.getByTestId('process-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('checkbox', { name: 'Denoise' }).click();
	await dialog.getByRole('button', { name: 'Start' }).click();
	await expect(dialog).toBeHidden();

	// The job runs in the engine; the client commits media.derive when it succeeds.
	await expect
		.poll(() => appliedLabels(page), { timeout: 240_000, intervals: [1000] })
		.toContain('Process Clip');
	const labels = await appliedLabels(page);
	expect(labels.filter((l) => l === 'Process Clip')).toHaveLength(1);
	const processedId = await clipMedia();
	expect(processedId).not.toBe(originalId);
	const d2 = await doc();
	expect(d2.media[processedId!]?.derivation?.recipe.op).toBe('process');

	// Media Version section of the selected clip shows the processed version.
	await clipElement(page, videoClip).click({ position: { x: 30, y: 20 } });
	await expect(page.getByTestId('media-version-info')).toContainText('Denoised');
	await page.screenshot({ path: 'test-results/e2e-processed-clip.png' });

	// One Undo restores the original (and removes the processed version from the project).
	await undo();
	await expect.poll(clipMedia).toBe(originalId);
	expect(Object.keys((await doc()).media)).toEqual([originalId]);
});

test('Media Version dropdown swaps and undoes', async () => {
	// Redo brings the processed version back, then switch with the dropdown.
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(clipMedia).not.toBe(originalId);
	const processedId = await clipMedia();
	await clipElement(page, videoClip).click({ position: { x: 30, y: 20 } });
	const section = page.getByTestId('media-version');
	await section.getByRole('combobox', { name: 'Media version' }).click();
	await page.getByRole('option', { name: 'Original' }).click();
	await expect.poll(clipMedia).toBe(originalId);
	expect((await appliedLabels(page)).at(-1)).toBe('Use Original Version');
	await undo();
	await expect.poll(clipMedia).toBe(processedId);
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
		{
			op: 'stabilize',
			method: 'smoothpath',
			smoothing: 30,
			borders: 'crop',
			lockVertical: true,
			lockRotation: true,
			maxZoom: 112,
		},
	]);
	await undo();
	await expect
		.poll(async () => (await doc()).media[(await clipMedia())!]?.derivation?.recipe.op)
		.toBe('process');
});

test('Preferences ▸ Processing saves the remote settings', async () => {
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await page.getByRole('menuitem', { name: /^Preferences…/ }).click();
	const prefs = page.getByTestId('preferences-dialog');
	await expect(prefs).toBeVisible();
	await prefs.getByTestId('prefs-page-processing').click();
	await expect(prefs.getByTestId('prefs-processing')).toBeVisible();
	await expect(prefs.getByTestId('remote-host')).toBeEnabled();
	await prefs.getByTestId('remote-host').fill('127.0.0.1');
	await prefs.getByTestId('remote-port').fill('1');
	await prefs.getByTestId('remote-user').fill('e2e');
	await prefs.getByTestId('remote-dir').fill('/tmp/jasper-e2e-remote');
	await prefs.getByTestId('prefs-processing-save').click();
	await expect
		.poll(async () => (await (await page.request.get('/api/settings/processing')).json()).remote)
		.toMatchObject({
			host: '127.0.0.1',
			port: 1,
			user: 'e2e',
			remoteDir: '/tmp/jasper-e2e-remote',
		});
});
