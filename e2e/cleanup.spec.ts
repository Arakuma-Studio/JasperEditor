// Clean Up Voice end to end (spec 14 TC-070): a generated clip (`cleanup-voice.mp4`: synthetic voiced "words" with an
// abandoned take, a filler and long pauses; scripts/fixtures/cleanup.mjs) with its transcript → Text ▸ Transcript ▸
// Clean Up → Analyze (the engine's voice analysis + detector) → review (findings by kind, struck words, live stats,
// a decision re-plans) → Play result (derived timeline, nothing changes) → Apply (ONE History entry "Clean Up Voice: N
// cuts", picture and sound cut together) → Undo restores the timeline.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { cleanupVoiceWords } from '../scripts/fixtures/cleanup.mjs';
import {
	appliedLabels,
	clips,
	createProject,
	enableAgentBridge,
	expectTransaction,
	focusTimeline,
	importFiles,
	mediaIdForFile,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-cleanup');
mkdirSync(OUT, { recursive: true });
const F = 705_600_000;

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: join(OUT, 'final.png') });
	await page?.close();
});

const sequenceEnd = async () => {
	const all = await clips(page);
	return Math.max(...all.map((c) => c.start + c.duration));
};

test('Clean Up mode on a generated clip: analyze, review, play the result, apply in one step, undo', async () => {
	test.setTimeout(180_000);
	await createProject(page, 'E2E Clean Up');
	await importFiles(page, ['cleanup-voice.mp4']);
	const mediaId = await mediaIdForFile(page, 'cleanup-voice.mp4');
	const items = await query<Record<string, { id: string; kind: string; mediaId?: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = Object.values(items).find((i) => i.kind === 'media' && i.mediaId === mediaId)!;
	expectTransaction(await transact(page, [{ type: 'clip.place', source: { projectItemId: item.id }, at: 0 }]));
	const words = cleanupVoiceWords();
	expectTransaction(
		await transact(page, [
			{
				type: 'transcript.create',
				mediaId,
				language: 'es',
				origin: 'manual',
				words: words.map((w) => ({
					text: w.text,
					start: Math.round(w.s * F),
					end: Math.round((w.e + 0.03) * F),
					confidence: 0.9,
				})),
			},
		] as never),
	);
	const before = await clips(page);
	const end0 = await sequenceEnd();

	await page.getByTestId('text.tab.Transcript').click();
	await page.getByTestId('text.transcript.mode.cleanup').click();
	await expect(page.getByTestId('text.cleanup.intro')).toBeVisible();
	await page.getByTestId('text.cleanup.analyze').click();
	await expect(page.getByTestId('text.cleanup.review')).toBeVisible({ timeout: 120_000 });
	await test.info().attach('review', { body: await page.getByTestId('text.cleanup').screenshot(), contentType: 'image/png' });

	// findings by kind; the abandoned take and the filler are struck in the transcript
	const findings = page.getByTestId('text.cleanup.findings');
	await expect(findings.locator('[data-testid^="text.cleanup.kind."][data-testid$=".count"]').first()).toBeVisible();
	const cuts0 = Number(await page.getByTestId('text.cleanup.stat.cuts').textContent());
	expect(cuts0).toBeGreaterThanOrEqual(3);
	await page.getByTestId('text.cleanup.view.transcript').click().catch(() => {});
	const struck = page.getByTestId('text.cleanup.transcript').locator('[data-removed="true"]');
	await expect(struck.first()).toBeVisible();
	const struckTexts = await struck.allTextContents();
	expect(struckTexts).toContain('eh');

	// keep one finding: the statistics follow
	await page.getByTestId('text.cleanup.view.findings').click().catch(() => {});
	const out0 = await page.getByTestId('text.cleanup.stat.length').textContent();
	const firstCut = findings.locator('[data-state="cut"]').first();
	const fid = (await firstCut.getAttribute('data-testid'))!.replace('text.cleanup.finding.', '');
	await page.getByTestId(`text.cleanup.finding.${fid}.reject`).click();
	await expect(page.getByTestId(`text.cleanup.finding.${fid}`)).toHaveAttribute('data-state', 'kept');
	await expect(page.getByTestId('text.cleanup.stat.length')).not.toHaveText(out0!);
	// and back
	await page.getByTestId(`text.cleanup.finding.${fid}.reject`).click();
	await expect(page.getByTestId(`text.cleanup.finding.${fid}`)).toHaveAttribute('data-state', 'cut');
	await expect(page.getByTestId('text.cleanup.stat.length')).toHaveText(out0!);

	// the timeline shows the cut ranges while reviewing
	await expect(page.getByTestId('timeline.cleanupOverlay')).toHaveAttribute('data-cuts', String(cuts0));

	// Play result: a derived timeline in the Program monitor, nothing committed
	const labels0 = await appliedLabels(page);
	await page.getByTestId('text.cleanup.playResult').click();
	await expect(page.getByTestId('cleanup-preview-chip')).toBeVisible();
	await page.waitForTimeout(800);
	await page.getByTestId('text.cleanup.stop').click();
	await expect(page.getByTestId('cleanup-preview-chip')).toBeHidden();
	expect(await appliedLabels(page)).toEqual(labels0);
	expect(await clips(page)).toEqual(before);

	// Apply: one History entry, picture and sound cut together
	await page.getByTestId('text.cleanup.apply').click();
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(labels0.length + 1);
	expect((await appliedLabels(page)).at(-1)).toBe(`Clean Up Voice: ${cuts0} cuts`);
	const after = await clips(page);
	expect(after.length).toBeGreaterThan(before.length);
	expect(await sequenceEnd()).toBeLessThan(end0);
	const v = after.filter((c) => c.track === before.find((b) => b.kind === 'video')!.track);
	const a = after.filter((c) => c.track === before.find((b) => b.kind === 'audio')!.track);
	expect(v.map((c) => [c.start, c.duration])).toEqual(a.map((c) => [c.start, c.duration]));
	await test.info().attach('applied', { body: await page.screenshot(), contentType: 'image/png' });

	// Undo restores the timeline in one step
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(labels0.length);
	expect(await clips(page)).toEqual(before);
});
