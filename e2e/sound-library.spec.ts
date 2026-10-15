// Sound Library (spec 12 §2.7, P1-R7/R8) in the built app: the panel in the Audio workspace indexes the bundled
// starter kit; search → audition (Space, aria-live, the Mix meters move, no history entry) → insert peak-aligned at the
// playhead (Enter, one undo step, Essential Sound SFX, "Sound Effects" bin) → undo → drag onto the timeline with the
// peak snapping to the playhead (ghost with peak tick) → File ▸ Export ▸ Sound Credits…. Screenshots of the panel
// (normal, high contrast) and of the drag ghost go to test-results/e2e-sound-library.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { appliedLabels, createProject, enableAgentBridge, query, ROOT } from './support.ts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-library');
let page: Page;

type Clip = {
	id: string;
	kind: string;
	trackId: string;
	start: number;
	duration: number;
	sourceIn: number;
	mediaId: string;
};
type Seq = {
	clips: Record<string, Clip>;
	audioTracks: { id: string; name: string | null }[];
	settings: { frameRate: { num: number; den: number } };
};

async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}
async function media(
	p: Page,
): Promise<Record<string, { id: string; library?: { soundId: string; descriptors?: { peakSec: number } } }>> {
	return query(p, 'doc.get', { path: ['media'] });
}
const FLICKS = 705_600_000;

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage();
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('search, audition, insert peak-aligned, undo, drag with peak snapping, credits', async () => {
	test.setTimeout(600_000);
	await createProject(page, 'E2E Sound Library');
	await page.keyboard.press('Alt+Shift+Digit7');
	const tab = page.locator('.dv-tab', { hasText: 'Sound Library' }).first();
	await tab.click();
	// (the dock tab and body carry the panel kind too: the panel is the element with the instance id)
	const panel = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	// the throwaway appdir indexes the starter kit on first use
	const list = panel.getByRole('listbox', { name: 'Sounds' });
	await expect(list.getByRole('option').first()).toBeVisible({ timeout: 360_000 });
	await expect(panel.getByTestId('sound-status')).toContainText('Starter kit', { timeout: 360_000 });
	await expect(panel.locator('[data-waveform="ready"]').first()).toBeVisible({ timeout: 60_000 });
	await panel.screenshot({ path: join(outDir, 'panel.png') });

	// search
	await panel.getByTestId('sound-search').fill('crunch');
	await expect(list.getByRole('option').first()).toHaveAttribute('aria-label', /crunch/i, {
		timeout: 30_000,
	});
	const first = list.getByRole('option').first();
	const label = (await first.getAttribute('aria-label'))!;
	expect(label).toMatch(/peak at \d+ ms/);

	// audition: Space plays alone (aria-live), the Mix meters show it, no history entry
	await query(page, 'playhead.set', { frame: 45 });
	const historyBefore = await appliedLabels(page);
	await first.click();
	await page.keyboard.press('Space');
	await expect(panel.getByTestId('sound-live')).toHaveText(/^Playing /, { timeout: 30_000 });
	await expect(page.getByTestId('audio-meters')).toHaveAttribute('data-live', 'true', { timeout: 10_000 });
	await page.keyboard.press('Space');
	await expect(panel.getByTestId('sound-live')).toHaveText('Audition stopped');
	expect(await appliedLabels(page)).toEqual(historyBefore);

	// insert at the playhead with the peak on frame 45 (one undo step)
	await first.click();
	await page.keyboard.press('Enter');
	await expect
		.poll(async () => Object.keys((await sequence(page)).clips).length, { timeout: 60_000 })
		.toBe(1);
	let seq = await sequence(page);
	const clip = Object.values(seq.clips)[0]!;
	const m = (await media(page))[clip.mediaId]!;
	expect(m.library?.soundId).toMatch(/^snd_/);
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	const peakAt = clip.start * F + m.library!.descriptors!.peakSec * FLICKS - clip.sourceIn;
	expect(peakAt).toBeGreaterThanOrEqual(45 * F - 2);
	expect(peakAt).toBeLessThan(46 * F);
	expect(JSON.stringify(clip)).toContain('"sfx"');
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Add Sound /);
	expect(await page.locator('[data-testid="project-panel"]').innerText()).toContain('Sound Effects');
	await page.screenshot({ path: join(outDir, 'inserted.png') });

	// undo removes the clip, the media and the bin in one step
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => Object.keys((await sequence(page)).clips).length).toBe(0);
	expect(Object.keys(await media(page))).toHaveLength(0);

	// drag onto A1 near the playhead: the ghost shows, the peak snaps to the playhead
	const head = await page.getByTestId('timeline-playhead').boundingBox();
	const row = await page
		.locator(`[data-testid="timeline-track-area"] [data-track-id="${seq.audioTracks[0]!.id}"]`)
		.first()
		.boundingBox();
	expect(head && row).toBeTruthy();
	const src = await first.boundingBox();
	await page.mouse.move(src!.x + 60, src!.y + src!.height / 2);
	await page.mouse.down();
	await page.mouse.move(src!.x + 80, src!.y + src!.height / 2, { steps: 4 });
	const target = { x: head!.x + head!.width / 2 + 3, y: row!.y + row!.height / 2 };
	await page.mouse.move(target.x, target.y, { steps: 12 });
	await page.mouse.move(target.x + 1, target.y, { steps: 2 });
	const ghost = page.locator('[data-sound-ghost]');
	await expect(ghost).toBeVisible({ timeout: 10_000 });
	await expect(page.locator('[data-sound-ghost-peak]')).toBeVisible();
	await expect(page.locator('[data-snap-indicator]')).toBeVisible();
	await page.screenshot({ path: join(outDir, 'drag-ghost.png') });
	await page.mouse.up();
	await expect
		.poll(async () => Object.keys((await sequence(page)).clips).length, { timeout: 60_000 })
		.toBe(1);
	seq = await sequence(page);
	const dropped = Object.values(seq.clips)[0]!;
	const dm = (await media(page))[dropped.mediaId]!;
	const droppedPeak = dropped.start * F + dm.library!.descriptors!.peakSec * FLICKS - dropped.sourceIn;
	expect(droppedPeak).toBeGreaterThanOrEqual(45 * F - 2);
	expect(droppedPeak).toBeLessThan(46 * F);
	expect(dropped.trackId).toBe(seq.audioTracks[0]!.id);

	// File ▸ Export ▸ Sound Credits…
	await page.getByRole('menuitem', { name: 'File' }).click();
	await page.getByRole('menuitem', { name: 'Export' }).hover();
	await page.getByRole('menuitem', { name: 'Sound Credits…' }).click();
	const dialog = page.getByTestId('sound-credits-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('sound-credits-preview')).toHaveValue(/## Sound credits/);
	await page.screenshot({ path: join(outDir, 'credits.png') });
	const download = page.waitForEvent('download');
	await dialog.getByRole('button', { name: 'Save…' }).click();
	expect((await download).suggestedFilename()).toMatch(/sound-credits\.md$/);

	// high contrast
	await page.evaluate(() => document.documentElement.setAttribute('data-pr-contrast', 'high'));
	await panel.screenshot({ path: join(outDir, 'panel-high-contrast.png') });
	await page.evaluate(() => document.documentElement.removeAttribute('data-pr-contrast'));
});
