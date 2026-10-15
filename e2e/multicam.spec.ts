import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	importFiles,
	playheadFrame,
	query,
	sequenceSummary,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let mainSeq = '';
let sourceSeq = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-multicam-final.png' });
	await page?.close();
});

type Doc = {
	items: Record<string, { id: string; kind: string; name: string; sequenceId?: string; mediaId?: string }>;
	sequences: Record<
		string,
		{
			multicam?: { angles: { id: string; name: string }[]; audio: string };
			merged?: unknown;
			clips: Record<
				string,
				{ id: string; kind: string; start: number; duration: number; multicam?: { angle: string } }
			>;
		}
	>;
};
const doc = () => query<Doc>(page, 'doc.get');

const setPlayhead = (frame: number) =>
	page.evaluate(
		(f) =>
			window.jasper!.query('playhead.set', {
				frame: f,
			}),
		frame,
	);

const angleCameras = async () => {
	const d = await doc();
	const angles = d.sequences[sourceSeq]!.multicam!.angles.map((a) => a.id);
	return Object.values(d.sequences[mainSeq]!.clips)
		.filter((c) => c.kind === 'nest-video')
		.sort((a, b) => a.start - b.start)
		.map((c) => angles.indexOf(c.multicam!.angle) + 1);
};

test('Project panel ▸ Create Multi-Camera Source Sequence… builds the source; placing it makes multi-camera clips', async () => {
	await createProject(page, 'E2E Multicam');
	await importFiles(page, ['xfade-red.mp4', 'xfade-blue.mp4', 'tone.wav']);
	mainSeq = (await sequenceSummary(page)).sequenceId;
	const red = page.getByTestId('project-row').filter({ hasText: 'xfade-red.mp4' }).first();
	const blue = page.getByTestId('project-row').filter({ hasText: 'xfade-blue.mp4' }).first();
	await red.click();
	await blue.click({ modifiers: ['Control'] });
	await blue.click({ button: 'right' });
	await page.getByTestId('project-menu-create-multicam').click();
	await expect(page.getByTestId('create-multicam-dialog')).toBeVisible();
	await page.getByRole('button', { name: 'OK' }).click();
	await expect.poll(async () => Object.values((await doc()).sequences).some((s) => s.multicam)).toBe(true);
	const d = await doc();
	sourceSeq = Object.entries(d.sequences).find(([, s]) => s.multicam)![0];
	expect(d.sequences[sourceSeq]!.multicam!.angles).toHaveLength(2);
	const r = await transact(page, [
		{ type: 'clip.place', sequenceId: mainSeq, source: { sequenceId: sourceSeq }, at: 0 },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await expect.poll(async () => (await clips(page, ['V1']))[0]?.kind).toBe('nest-video');
});

test('Multi-Camera view (Shift+0): the grid next to the program; clicking a cell switches the clip', async () => {
	await setPlayhead(30);
	await page.getByTestId('program-viewport').click({ position: { x: 20, y: 20 } });
	await page.keyboard.press('Shift+Digit0');
	await expect(page.getByTestId('multicam-overlay')).toBeVisible();
	await expect(page.getByTestId('multicam-cell-1')).toHaveAttribute('data-active', 'true');
	await expect(page.getByTestId('multicam-cell-2')).toBeVisible();
	await page.screenshot({ path: 'test-results/e2e-multicam-view.png' });
	await page.getByTestId('multicam-cell-2').click();
	await expect.poll(angleCameras).toEqual([2]);
	await expect(page.getByTestId('multicam-cell-2')).toHaveAttribute('data-active', 'true');
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(angleCameras).toEqual([1]);
});

test('live switching: keys while playing record cuts, committed as one undo step on stop', async () => {
	await setPlayhead(0);
	await focusTimeline(page);
	const before = (await appliedLabels(page)).length;
	await page.keyboard.press('Space');
	// wait until playback really runs (the Player may buffer first), then switch twice while it plays
	await expect.poll(() => playheadFrame(page), { timeout: 30_000 }).toBeGreaterThan(8);
	await page.keyboard.press('Digit2');
	const first = await playheadFrame(page);
	await expect.poll(() => playheadFrame(page), { timeout: 30_000 }).toBeGreaterThan(first + 15);
	await page.keyboard.press('Digit1');
	const second = await playheadFrame(page);
	await expect.poll(() => playheadFrame(page), { timeout: 30_000 }).toBeGreaterThan(second + 5);
	await page.keyboard.press('Space');
	await expect.poll(angleCameras).toEqual([1, 2, 1]);
	const labels = await appliedLabels(page);
	expect(labels.length).toBe(before + 1);
	await page.screenshot({ path: 'test-results/e2e-multicam-recorded.png' });
});

test('Merge Clips… with audio: an unrelated recording is flagged before merging anyway', async () => {
	await page.getByTestId('program-viewport').click({ position: { x: 20, y: 20 } });
	await page.keyboard.press('Shift+Digit0');
	await expect(page.getByTestId('multicam-overlay')).toBeHidden();
	await page.keyboard.press('Shift+Digit1');
	const red = page.getByTestId('project-row').filter({ hasText: 'xfade-red.mp4' }).first();
	const tone = page.getByTestId('project-row').filter({ hasText: 'tone.wav' }).first();
	await red.click();
	await tone.click({ modifiers: ['Control'] });
	await tone.click({ button: 'right' });
	await page.getByTestId('project-menu-merge-clips').click();
	await expect(page.getByTestId('merge-clips-dialog')).toBeVisible();
	await page.getByTestId('sync-point-audio').check();
	await page.getByRole('button', { name: 'OK' }).click();
	// a steady tone matches at many lags: the dialog shows the figures and asks before merging
	await expect(page.getByTestId('sync-audio-warning')).toBeVisible({ timeout: 60_000 });
	await page.screenshot({ path: 'test-results/e2e-multicam-merge-warning.png' });
	await page.getByRole('button', { name: 'Merge Anyway' }).click();
	await expect
		.poll(async () => Object.values((await doc()).sequences).some((s) => s.merged), { timeout: 30_000 })
		.toBe(true);
});

test.afterEach(async () => {
	await test
		.info()
		.attach('multicam-document', { body: JSON.stringify(await doc()), contentType: 'application/json' });
});
