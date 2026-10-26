// Motion template inserts never overwrite (social-comments design §7.9; docs/wp-notes/social-comments.md
// "Placement & agent API"): inserting twice at the same playhead from the Motion Templates gallery stacks the
// clips on the first free video tracks, each insert one undo step.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { clips, createProject, enableAgentBridge, focusTimeline, ROOT } from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-mg-insert-placement');
mkdirSync(OUT, { recursive: true });

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

test('gallery inserts at one playhead stack on free tracks; undo removes the last one', async () => {
	await createProject(page, 'E2E First-free insert');
	await page.getByText('Motion Templates', { exact: true }).first().click();
	const card = page.getByRole('listitem', { name: 'Lower Third (Lower Thirds)' });
	await expect(card).toBeVisible();
	await card.dblclick();
	await expect.poll(async () => (await clips(page)).length).toBe(1);
	await card.dblclick();
	await expect.poll(async () => (await clips(page)).length).toBe(2);
	const placed = await clips(page);
	expect(placed.map((c) => [c.track, c.start])).toEqual([
		['V1', 0],
		['V2', 0],
	]);
	await page.getByTestId('timeline-track-area').screenshot({ path: join(OUT, 'stacked.png') });
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page)).map((c) => c.track)).toEqual(['V1']);
});
