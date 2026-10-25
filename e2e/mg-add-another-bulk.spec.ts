// "Add another" and the spreadsheet bulk import in the built app (social-comments design §7.9; docs/wp-notes/
// social-comments.md "Add another & bulk import"), with the `counter` anime template and its presets: the timeline
// clip menu adds a copy right after the clip, the Motion Templates panel opens the import dialog, the preview leaves
// out a bad row, Insert adds the rest one after another from the playhead as one undo step.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	query,
	ROOT,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-mg-add-another-bulk');
mkdirSync(OUT, { recursive: true });

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

const clipEl = (id: string) =>
	page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${id}"]`).first();

test('Add Another from the timeline clip menu places a copy right after the clip (one undo step)', async () => {
	await createProject(page, 'E2E Add another');
	await page.getByText('Motion Templates', { exact: true }).first().click();
	const card = page.getByRole('listitem', { name: 'Percentage · Counter (Counters)' });
	await expect(card).toBeVisible();
	await card.dblclick();
	await expect.poll(async () => (await clips(page)).length).toBe(1);
	const [first] = await clips(page);
	await clipEl(first!.id).click({ button: 'right', position: { x: 12, y: 10 } });
	await page.getByRole('menuitem', { name: 'Add Another' }).click();
	await expect.poll(async () => (await clips(page)).length).toBe(2);
	const placed = await clips(page);
	expect(placed.map((c) => [c.track, c.start, c.duration])).toEqual([
		['V1', 0, first!.duration],
		['V1', first!.duration, first!.duration],
	]);
	expect((await appliedLabels(page)).at(-1)).toBe('Add Another');
	await page.getByTestId('timeline-track-area').screenshot({ path: join(OUT, 'add-another.png') });
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page)).length).toBe(1);
	// the Motion Templates panel button does the same for the selection
	await page.getByText('Motion Templates', { exact: true }).first().click();
	await clipEl(first!.id).click({ position: { x: 12, y: 10 } });
	await page.getByTestId('motion-templates-add-another').click();
	await expect.poll(async () => (await clips(page)).length).toBe(2);
});

test('bulk import: paste spreadsheet rows, preview (bad row left out), insert from the playhead in one undo step', async () => {
	await createProject(page, 'E2E Bulk import');
	await page.getByText('Motion Templates', { exact: true }).first().click();
	await page.getByTestId('motion-templates-bulk-import').click();
	const dialog = page.getByTestId('mg-bulk-import-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('mg-bulk-template').selectOption('counter@1:percentage');
	const tsv = [
		'Label\tTo\tSuffix\tDuration',
		'Likes\t1.2K\t\t2s',
		'Followers\t3.5M\t+\t',
		'Shares\toops\t\t',
	].join('\n');
	await dialog.getByTestId('mg-bulk-text').fill(tsv);
	const rows = dialog.getByTestId('mg-bulk-preview').locator('tbody tr');
	await expect(rows).toHaveCount(3);
	await expect(rows.nth(2)).toHaveAttribute('data-included', 'false');
	await expect(rows.nth(2)).toContainText('"oops" is not a number');
	await expect(rows.nth(0)).toContainText('1200');
	await expect(dialog.getByTestId('mg-bulk-summary')).toContainText('2 of 3 rows will be added');
	await dialog.screenshot({ path: join(OUT, 'bulk-preview.png') });
	await dialog.getByTestId('mg-bulk-insert').click();
	await expect(dialog).toBeHidden();
	await expect.poll(async () => (await clips(page)).length).toBe(2);
	const placed = await clips(page);
	expect(placed[0]!.start).toBe(0);
	expect(placed[1]!.start).toBe(placed[0]!.end);
	expect(placed[0]!.track).toBe(placed[1]!.track);
	expect((await appliedLabels(page)).at(-1)).toBe('Import 2 Motion Graphics');
	await page.getByTestId('timeline-track-area').screenshot({ path: join(OUT, 'bulk-inserted.png') });
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page)).length).toBe(0);
});

type Doc = { sequences: Record<string, { clips: Record<string, { params?: Record<string, unknown> }> }> };
const paramsOf = async (id: string) => {
	const doc = await query<Doc>(page, 'doc.get');
	for (const seq of Object.values(doc.sequences)) if (seq.clips[id]) return seq.clips[id]!.params ?? {};
	throw new Error(`clip ${id} not found`);
};

test('social comments: Add Another gives a new identity and stats, keeps look and text; bulk import maps User / Comment / Verified', async () => {
	await createProject(page, 'E2E Social comments');
	await page.getByText('Motion Templates', { exact: true }).first().click();
	const card = page.getByRole('listitem', { name: /^TikTok · Comment · Social comment/ });
	await expect(card).toBeVisible();
	await card.dblclick();
	await expect.poll(async () => (await clips(page)).length).toBe(1);
	const [first] = await clips(page);
	const src = await paramsOf(first!.id);
	await clipEl(first!.id).click({ button: 'right', position: { x: 12, y: 10 } });
	await page.getByRole('menuitem', { name: 'Add Another' }).click();
	await expect.poll(async () => (await clips(page)).length).toBe(2);
	const second = (await clips(page)).find((c) => c.id !== first!.id)!;
	expect([second.track, second.start]).toEqual([first!.track, first!.end]);
	const copy = await paramsOf(second.id);
	for (const k of [
		'variant',
		'theme',
		'emojiStyle',
		'text',
		'entrance',
		'wordReveal',
		'likeTick',
		'verified',
	])
		expect(copy[k]).toEqual(src[k]);
	expect(copy.displayName).not.toEqual(src.displayName);
	expect(copy.likes).not.toEqual(src.likes);
	await query(page, 'playhead.set', { frame: second.start + 60 });
	await page.waitForTimeout(1500);
	await page
		.getByTestId('program-player-wrapper')
		.screenshot({ path: join(OUT, 'social-add-another-program.png') });
	await query(page, 'playhead.set', { frame: 0 });

	// bulk import with the TikTok comment preset, from the playhead (frame 0) on the first free track above the cards
	await clipEl(second.id).click({ position: { x: 12, y: 10 } });
	await page.getByTestId('motion-templates-bulk-import').click();
	const dialog = page.getByTestId('mg-bulk-import-dialog');
	await expect(dialog.getByTestId('mg-bulk-template')).toHaveValue('social-comment@1');
	await dialog.getByTestId('mg-bulk-template').selectOption('social-comment@1:tiktok-comment');
	const tsv = [
		'User\tComment\tLikes\tVerified\tImage URL',
		'Luna Park\tThis is ==so good== 🔥\t1.2K\tyes\thttps://example.com/a.png',
		'\tWho else is here in 2026?\t\t\t',
		'Jake\t||spoiler|| ending\tmany\t\t',
	].join('\n');
	await dialog.getByTestId('mg-bulk-text').fill(tsv);
	const rows = dialog.getByTestId('mg-bulk-preview').locator('tbody tr');
	await expect(rows).toHaveCount(3);
	await expect(rows.nth(2)).toHaveAttribute('data-included', 'false');
	await expect(dialog.getByTestId('mg-bulk-columns')).toContainText('Image URL');
	await expect(rows.nth(1).locator('[data-filled]').first()).toBeVisible();
	await dialog.screenshot({ path: join(OUT, 'social-bulk-preview.png') });
	await dialog.getByTestId('mg-bulk-insert').click();
	await expect(dialog).toBeHidden();
	await expect.poll(async () => (await clips(page)).length).toBe(4);
	const added = (await clips(page)).filter((c) => c.id !== first!.id && c.id !== second.id);
	const p0 = await paramsOf(added[0]!.id);
	expect(p0).toMatchObject({
		variant: 'tiktok-comment',
		displayName: 'Luna Park',
		text: 'This is ==so good== 🔥',
		likes: 1200,
		verified: true,
	});
	const p1 = await paramsOf(added[1]!.id);
	expect(p1).toMatchObject({ variant: 'tiktok-comment', text: 'Who else is here in 2026?' });
	expect(p1.displayName).not.toBe(p0.displayName);
	await page.getByTestId('timeline-track-area').screenshot({ path: join(OUT, 'social-bulk-timeline.png') });
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page)).length).toBe(2);
});
