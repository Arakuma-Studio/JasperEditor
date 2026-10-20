// The built app (wp-note sound-design "Fix: preview loudness parity, codec-aware Sound Check, delivery speed"): a loud
// mix normalised to −14 LUFS / −1 dBTP → Sequence ▸ Loudness Normalization… ▸ Analyze stores the export's converged
// delivery (the dialog says the gain "as the export delivers it"; the preview plays it) → the Sound Check panel's
// "Check for" starts at the Web preset's typical AAC 256 kb/s, Run checks for it and the summary says so; choosing
// Opus 160 kb/s makes the summary stale. Screenshots (looked at): test-results/e2e-sound-delivery-parity.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, query, ROOT, transact } from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-delivery-parity');
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
const CHECK_MS = 900_000;
let page: Page;

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

/** A quiet noise bed with a noise snare every 0.5 s (instant attack): normalised to −14 LUFS the limiter works on every hit. */
function loudWav(): string {
	const file = join(outDir, 'loud.wav');
	const r = spawnSync(FFMPEG, [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		'aevalsrc=(random(0)*2-1)*(0.04+0.7*exp(-mod(t\\,0.5)/0.03)):d=10:s=48000',
		'-ac',
		'2',
		'-c:a',
		'pcm_s16le',
		file,
	]);
	expect(r.status, String(r.stderr)).toBe(0);
	return file;
}

type Analysis = {
	integratedLufs: number;
	delivery?: { targetLufs: number; gainDb: number; limiterCeilingDbtp: number; passes: number };
};

test('Analyze stores the converged delivery; Sound Check checks for the export encoding', async () => {
	test.setTimeout(3_600_000);
	await createProject(page, 'E2E Delivery Parity');
	const wav = loudWav();
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([wav]);
	await expect(page.getByTestId('project-row').filter({ hasText: 'loud.wav' })).toBeVisible({
		timeout: 120_000,
	});
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = Object.values(items).find((i) => i.name === 'loud.wav')!;
	const setup = await transact(page, [
		{ type: 'clip.place', source: { projectItemId: item.id }, at: 0, tracks: { audio: 'A1' } },
		{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
	] as never);
	expect(setup.ok, JSON.stringify(setup)).toBe(true);

	// Sequence ▸ Loudness Normalization… ▸ Analyze
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Loudness Normalization…', exact: true }).click();
	const dialog = page.getByTestId('loudness-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('loudness-analyze').click();
	await expect(dialog.getByTestId('loudness-gain')).toContainText('as the export delivers it', {
		timeout: CHECK_MS,
	});
	await page.screenshot({ path: join(outDir, '01-loudness-dialog.png') });
	const seqs = await query<Record<string, { master: { loudness: { analysis: Analysis } } }>>(
		page,
		'doc.get',
		{
			path: ['sequences'],
		},
	);
	const analysis = Object.values(seqs)[0]!.master.loudness.analysis;
	console.log('e2e analysis', JSON.stringify(analysis));
	expect(analysis.delivery).toBeDefined();
	expect(analysis.delivery!.targetLufs).toBe(-14);
	expect(analysis.delivery!.limiterCeilingDbtp).toBe(-1);
	// the limiter works on this mix: the export's gain is over the one-pass gain the preview played before
	expect(analysis.delivery!.gainDb).toBeGreaterThan(-14 - analysis.integratedLufs + 0.2);
	await expect(dialog.getByTestId('loudness-gain')).toContainText(analysis.delivery!.gainDb.toFixed(1));
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();

	// the Sound Check panel: Check for
	// (the Sound Design workspace, then Sequence ▸ Sound Design ▸ Run Sound Check opens the panel and runs)
	await page.keyboard.press('Alt+Shift+Digit9');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await page.getByRole('menuitem', { name: 'Run Sound Check', exact: true }).click();
	const panel = page.locator('[data-panel-kind="soundCheck"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	const row = panel.getByTestId('sound-check-check-for');
	await expect(row).toContainText('AAC 256 kb/s');
	await expect(row).toContainText('(typical for this delivery target)');
	await expect(panel.getByTestId('sound-check-verdict')).toBeVisible({ timeout: CHECK_MS });
	await expect(panel.getByTestId('sound-check-progress')).toBeHidden({ timeout: CHECK_MS });
	await expect(panel.getByTestId('sound-check-checked-for')).toHaveText('checked for AAC 256 kb/s');
	await expect(panel.getByTestId('sound-check-stale')).toHaveCount(0);
	await page.screenshot({ path: join(outDir, '02-sound-check-aac.png') });
	const seqs2 = await query<Record<string, { soundDesign?: { lastCheck?: { exportAudio?: unknown } } }>>(
		page,
		'doc.get',
		{ path: ['sequences'] },
	);
	expect(Object.values(seqs2)[0]!.soundDesign?.lastCheck?.exportAudio).toEqual({
		codec: 'aac',
		bitrateKbps: 256,
	});
	// another encoding to check for: the summary is stale for it
	await row.getByRole('combobox').click();
	await page.getByRole('option', { name: 'Opus 160 kb/s' }).click();
	await expect(panel.getByTestId('sound-check-stale')).toContainText(
		'the export encoding to check for changed',
	);
	await page.screenshot({ path: join(outDir, '03-sound-check-stale-opus.png') });
});
