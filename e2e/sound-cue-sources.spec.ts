// Engine cue sources in the built app (spec 12 §2.2, §2.7, P6-R2; wp-note "Phase 6 → WP6.2"): footage of a box that
// rests, moves and stops (`fixtures/media/box-move.mp4`, `pnpm fixtures`) → Sequence ▸ Sound Design ▸ Suggest Cues… →
// "Picture motion in footage" is not analysed yet → Analyze… (a `motion-analysis` job) → counts → tick it → Suggest →
// a move cue over the box's motion (frames 31–60) and a land where it stops, anchored to the footage, one undo step.
// Screenshots go to test-results/e2e-sound-cue-sources.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	createProject,
	enableAgentBridge,
	importFiles,
	mediaIdForFile,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-cue-sources');
let page: Page;

type Cue = {
	id: string;
	frame: number;
	kind: string;
	source: string;
	reason?: string;
	anchor?: { type: string };
	window?: { start: number; end: number };
};

async function cues(p: Page): Promise<Cue[]> {
	const seqs = await query<Record<string, { soundDesign?: { cues?: Record<string, Cue> } }>>(p, 'doc.get', {
		path: ['sequences'],
	});
	const seq = Object.values(seqs)[0]!;
	return Object.values(seq.soundDesign?.cues ?? {}).sort((a, b) => a.frame - b.frame);
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('Suggest Cues with Picture motion finds the box moving and stopping', async () => {
	test.setTimeout(300_000);
	await createProject(page, 'E2E Cue Sources');
	await importFiles(page, ['box-move.mp4']);
	const mediaId = await mediaIdForFile(page, 'box-move.mp4');
	const r = await transact(page, [
		{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1' } },
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);

	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await page.getByRole('menuitem', { name: 'Suggest Cues…' }).click();
	const dialog = page.getByTestId('suggest-cues-dialog');
	await expect(dialog).toBeVisible();
	const count = (s: string) => dialog.locator(`[data-cue-source-count="${s}"]`);
	await expect(count('pixel')).toHaveText('Not analysed yet', { timeout: 30_000 });
	await expect(count('beat')).toHaveText('No music clip in the range');
	await dialog.screenshot({ path: join(outDir, 'dialog-before.png') });

	await dialog.getByTestId('analyze-pixel').click();
	await expect(count('pixel')).toHaveText(/^\d+ found · 0 kept$/, { timeout: 180_000 });
	await dialog.locator('[data-cue-source="pixel"]').getByRole('checkbox').click();
	await expect(count('pixel')).toHaveText(/^(\d+) found · \1 kept$/);
	await dialog.screenshot({ path: join(outDir, 'dialog-analysed.png') });

	const button = dialog.getByRole('button', { name: /^Suggest \d+ Cues$/ });
	await button.click();
	await expect(dialog).toBeHidden();
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Suggest Cues \(\d+\)$/);
	const all = await cues(page);
	const move = all.find((c) => c.kind === 'move');
	const land = all.find((c) => c.kind === 'land');
	expect(move, JSON.stringify(all)).toBeTruthy();
	expect(land, JSON.stringify(all)).toBeTruthy();
	// the sequence is 29.97 fps, the footage 30: the box moves over sequence frames ≈ 31…60
	expect(Math.abs(move!.window!.start - 31), JSON.stringify(move)).toBeLessThanOrEqual(2);
	expect(Math.abs(land!.frame - 60), JSON.stringify(land)).toBeLessThanOrEqual(2);
	expect(move!.anchor?.type).toBe('scene');
	expect(move!.reason).toContain('Picture motion');
	await expect(page.getByTestId('cue-seam')).toBeVisible();
	await page.screenshot({ path: join(outDir, 'seam.png') });
	// one undo step
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await cues(page)).length).toBe(0);
});
