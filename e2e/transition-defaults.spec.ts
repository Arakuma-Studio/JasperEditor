// S10:TUI-031…035 (wp-m3-transdefaults) through the built app: Sequence ▸ Transition Defaults… opens
// Preferences ▸ Timeline; the default video transition, alignment and the project's video duration are changed
// there (the duration is one History step, the preferences none); Ctrl+D then applies exactly those; after a
// reload the project duration (saved with the project) and the preferences (this computer) are still there.
// The two clips are placed by the in-page agent API (setup only) so they have media handles around the cut.

import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	importFiles,
	mediaIdForFile,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

type Tr = {
	id: string;
	effectId: string;
	duration: number;
	alignment: string;
	outgoingClipId: string | null;
	incomingClipId: string | null;
};

let page: Page;
let seqId = '';
let cut = 0;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed())
		await page.screenshot({ path: 'test-results/e2e-transition-defaults-final.png' });
	await page?.close();
});

async function videoTransitionAtCut(): Promise<Tr | undefined> {
	const t = await query<Record<string, Tr>>(page, 'doc.get', { path: ['sequences', seqId, 'transitions'] });
	const [b] = (await clips(page, ['V1'])).filter((c) => c.start === cut);
	return Object.values(t ?? {}).find((x) => x.incomingClipId === b?.id);
}

const menubar = () => page.getByTestId('title-bar').getByRole('menubar');
const dialog = () => page.getByTestId('preferences-dialog');

async function pick(label: string, option: string) {
	await dialog().getByRole('combobox', { name: label, exact: true }).click();
	await page.getByRole('option', { name: option, exact: true }).click();
	await expect(dialog().getByRole('combobox', { name: label, exact: true })).toContainText(option);
}

test('Sequence ▸ Transition Defaults… opens Preferences ▸ Timeline', async () => {
	await createProject(page, 'E2E Transition Defaults');
	await importFiles(page, ['xfade-red.mp4', 'xfade-blue.mp4']);
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	const a = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: await mediaIdForFile(page, 'xfade-red.mp4') },
			at: 0,
			sourceRange: { in: { seconds: 1 }, out: { seconds: 5 } },
		},
	]);
	expect(a.ok, JSON.stringify(a)).toBe(true);
	cut = (await clips(page, ['V1']))[0]!.end;
	const b = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: await mediaIdForFile(page, 'xfade-blue.mp4') },
			at: cut,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 5 } },
		},
	]);
	expect(b.ok, JSON.stringify(b)).toBe(true);
	await expect(page.getByTestId('jobs-badge')).toHaveAttribute('data-active', '0', { timeout: 90_000 });
	await menubar().getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Transition Defaults…/ }).click();
	await expect(dialog()).toBeVisible();
	await expect(dialog().getByTestId('prefs-timeline')).toBeVisible();
	await expect(dialog().getByTestId('prefs-page-timeline')).toHaveAttribute('aria-current', 'page');
	await expect(dialog().getByTestId('pref-video-duration')).toHaveValue('30');
	await expect(dialog().getByTestId('pref-audio-duration')).toHaveValue('1.001');
	await page.screenshot({ path: join(ROOT, 'test-results', 'e2e-transition-defaults-dialog.png') });
});

test('change the default video transition, alignment and duration; only the duration is in History', async () => {
	const n = (await appliedLabels(page)).length;
	await pick('Default video transition', 'Dip to Black');
	await pick('Default transition alignment', 'End at Cut');
	expect((await appliedLabels(page)).length).toBe(n);
	const field = dialog().getByTestId('pref-video-duration');
	await field.fill('12.5');
	await expect(dialog().getByTestId('pref-video-duration-error')).toHaveText('Whole frames only');
	await field.fill('12');
	await field.press('Enter');
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Default Video Transition Duration');
	expect((await appliedLabels(page)).length).toBe(n + 1);
	// Seconds for the audio default: 0.5 s at 29.97 fps is rounded to 15 frames, and the field says so.
	const audio = dialog().getByTestId('pref-audio-duration');
	await audio.fill('0.5');
	await audio.press('Enter');
	await expect(dialog().getByTestId('pref-audio-duration-note')).toHaveText(
		'Rounded to 15 frames at 29.97 fps',
	);
	const settings = await query<{ defaultTransitionFrames: number; defaultAudioTransitionFrames: number }>(
		page,
		'doc.get',
		{ path: ['settings'] },
	);
	expect(settings).toMatchObject({ defaultTransitionFrames: 12, defaultAudioTransitionFrames: 15 });
	await page.screenshot({ path: join(ROOT, 'test-results', 'e2e-transition-defaults-changed.png') });
	// Esc while a field is being edited reverts it and keeps the dialog open; the next Esc closes it.
	await field.fill('99');
	await field.press('Escape');
	await expect(dialog()).toBeVisible();
	await expect(field).toHaveValue('12');
	await field.press('Escape');
	await expect(dialog()).toBeHidden();
	expect(
		(await query<{ defaultTransitionFrames: number }>(page, 'doc.get', { path: ['settings'] }))
			.defaultTransitionFrames,
	).toBe(12);
});

test('Ctrl+D at the playhead applies Dip to Black, 12 frames, End at Cut (one entry)', async () => {
	await query(page, 'playhead.set', { frame: cut - 4 });
	await focusTimeline(page);
	const n = (await appliedLabels(page)).length;
	await page.keyboard.press('Control+KeyD');
	await expect.poll(async () => (await videoTransitionAtCut())?.effectId).toBe('jasper.dip-to-black');
	expect(await videoTransitionAtCut()).toMatchObject({ duration: 12, alignment: 'end-at-cut' });
	const labels = await appliedLabels(page);
	expect(labels.length).toBe(n + 1);
	expect(labels.at(-1)).toBe('Apply Video Transition');
	await page.screenshot({ path: join(ROOT, 'test-results', 'e2e-transition-defaults-ctrl-d.png') });
});

test('after a reload the project duration and the preferences are still there', async () => {
	await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
	await page.reload();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.getByTestId('timeline-track-area')).toBeVisible();
	await menubar().getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await page.getByRole('menuitem', { name: /^Timeline…/ }).click();
	await expect(dialog().getByTestId('prefs-timeline')).toBeVisible();
	await expect(dialog().getByTestId('pref-video-duration')).toHaveValue('12');
	await expect(dialog().getByTestId('pref-audio-duration')).toHaveValue('0.50');
	await expect(
		dialog().getByRole('combobox', { name: 'Default video transition', exact: true }),
	).toContainText('Dip to Black');
	await expect(
		dialog().getByRole('combobox', { name: 'Default transition alignment', exact: true }),
	).toContainText('End at Cut');
	// Show the video duration in seconds (a preference: no History entry).
	const n = (await appliedLabels(page)).length;
	await pick('Video transition duration unit', 'seconds');
	await expect(dialog().getByTestId('pref-video-duration')).toHaveValue('0.40');
	expect((await appliedLabels(page)).length).toBe(n);
	await page.screenshot({ path: join(ROOT, 'test-results', 'e2e-transition-defaults-reloaded.png') });
	await pick('Video transition duration unit', 'frames');
	await dialog().getByTestId('prefs-transitions-reset').click();
	await page.keyboard.press('Escape');
});
