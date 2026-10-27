// Describe-it search in the built app (spec 12 P6-E14, WP-E9; wp-note "Phase 6 → WP-E9"). With the real model
// (E2E_CLAP=1 and JASPER_MODEL_CATALOG
// naming a catalogue whose files are local — the build server; never downloaded in CI): it is installed after its
// licence is shown, the library is embedded, a described search ranks with matches, Find Moment finds a glass ping
// placed at 33 s in a generated 60 s recording of a user folder, and inserts it at the playhead. Screenshots go to
// test-results/e2e-sound-describe.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, query, ROOT } from './support.ts';

const outDir = join(ROOT, 'test-results', 'e2e-sound-describe');
const REAL = process.env.E2E_CLAP === '1';
test.skip(!REAL, 'needs E2E_CLAP=1 and a local CLAP catalogue (build server only)');

async function openDescribe(p: Page) {
	await p.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await p.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await p.getByRole('menuitem', { name: /^Preferences…/ }).click();
	const prefs = p.getByTestId('preferences-dialog');
	await expect(prefs).toBeVisible();
	await prefs.getByTestId('prefs-page-sound-library').click();
	const section = prefs.getByTestId('sound-prefs-describe');
	await section.scrollIntoViewIfNeeded();
	return { prefs, section };
}

async function openLibrary(p: Page) {
	await p.keyboard.press('Alt+Shift+Digit7');
	await p.locator('.dv-tab', { hasText: 'Sound Library' }).first().click();
	const panel = p.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	return panel;
}

test('with the real model: install, describe, find a moment and insert it', async ({ page, request }) => {
	test.setTimeout(1_800_000);
	mkdirSync(outDir, { recursive: true });
	await enableAgentBridge(page);
	const projectId = await createProject(page, 'E2E Describe');
	// a 60 s user-folder recording: a quiet noise bed with a glass ping at 33 s and a UI click at 12 s
	const dir = join(outDir, 'folder');
	mkdirSync(dir, { recursive: true });
	const kit = join(ROOT, 'apps', 'engine', 'sounds', 'starter');
	execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		'anoisesrc=d=60:c=brown:r=48000:a=0.02',
		'-i',
		join(kit, 'chime-glass-01.ogg'),
		'-i',
		join(kit, 'click-ui-02.ogg'),
		'-filter_complex',
		'[1:a]aformat=channel_layouts=stereo,adelay=33000|33000[a];[2:a]aformat=channel_layouts=stereo,adelay=12000|12000[b];[0:a]aformat=channel_layouts=stereo[n];[n][a][b]amix=inputs=3:normalize=0:duration=first',
		'-ar',
		'48000',
		join(dir, 'field_recording.wav'),
	]);
	const put = await request.put('/api/sounds/roots', {
		data: { roots: [{ path: dir, label: 'Field', license: 'LicenseRef-UserRoyaltyFree', enabled: true }] },
	});
	expect(put.ok(), await put.text()).toBe(true);

	const { prefs, section } = await openDescribe(page);
	const row = section.locator('[data-model-state]').first();
	if ((await row.getAttribute('data-model-state')) !== 'installed') {
		await row.getByRole('button', { name: 'Download…' }).click();
		const confirm = page.getByTestId('confirm-dialog');
		await expect(confirm).toContainText('Licence: Apache-2.0');
		await expect(confirm).toContainText('never makes sounds');
		await page.screenshot({ path: join(outDir, 'licence-before-download.png') });
		await confirm.getByRole('button', { name: 'Accept Licence and Download' }).click();
	}
	await expect(row).toHaveAttribute('data-model-state', 'installed', { timeout: 600_000 });
	await expect
		.poll(
			async () => {
				const s = (await (await request.get('/api/sounds/semantic')).json()) as {
					embedded: number;
					total: number;
					job: unknown;
				};
				return s.total > 0 && s.embedded === s.total && !s.job;
			},
			{ timeout: 1_500_000, intervals: [5_000] },
		)
		.toBe(true);
	await expect(section.getByTestId('describe-embedded')).toBeVisible({ timeout: 30_000 });
	await section.screenshot({ path: join(outDir, 'prefs-describe-installed.png') });
	await page.keyboard.press('Escape');
	await expect(prefs).toBeHidden();

	const panel = await openLibrary(page);
	const toggle = panel.getByTestId('sound-describe');
	if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
	await panel.getByLabel('Search sounds').fill('a bright glass ping');
	await expect(panel.getByTestId('sound-describe-info')).toHaveAttribute('data-describe-mode', 'semantic', {
		timeout: 60_000,
	});
	await expect(panel.locator('[data-match-verdict]').first()).toBeVisible();
	await panel.screenshot({ path: join(outDir, 'describe-semantic.png') });

	// Find Moment on the recording
	await panel.getByLabel('Search sounds').fill('field recording');
	await toggle.click(); // words: the recording by its name
	const option = panel
		.getByRole('listbox', { name: 'Sounds' })
		.getByRole('option', { name: /^field recording/i });
	await expect(option).toBeVisible({ timeout: 60_000 });
	await option.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Find Moment…' }).click();
	const dialog = page.getByTestId('sound-find-moment-dialog');
	await dialog.getByTestId('sound-find-moment-description').fill('a glass ping');
	await dialog.getByRole('button', { name: 'Find' }).click();
	const results = dialog.getByTestId('sound-find-moment-results');
	await expect(results).toBeVisible({ timeout: 600_000 });
	const first = Number(await results.locator('li').first().getAttribute('data-moment-start'));
	expect(first).toBeGreaterThanOrEqual(32);
	expect(first).toBeLessThanOrEqual(34);
	await dialog.screenshot({ path: join(outDir, 'find-moment.png') });
	await query(page, 'playhead.set', { frame: 30 });
	await dialog.getByTestId('sound-find-moment-insert-0').click();
	await expect(dialog.getByTestId('sound-find-moment-status')).toContainText('Added a moment', {
		timeout: 60_000,
	});
	type Clip = { start: number; sourceIn: number };
	const clips = await query<Record<string, Clip>>(page, 'doc.get', { path: ['sequences'] });
	expect(JSON.stringify(clips)).toContain('"start":30');
	await page.screenshot({ path: join(outDir, 'moment-inserted.png') });

	// the listening transcript names the inserted moment's sound (P6-E6 tags)
	const started = await request.post('/api/sound-design/listen', {
		data: { projectId, tags: true, detail: 'high' },
	});
	expect(started.ok(), await started.text()).toBe(true);
	const jobId = ((await started.json()) as { id: string }).id;
	let job: { state: string; result?: { lines: { timecode: string; text: string }[] } } = { state: 'queued' };
	await expect
		.poll(
			async () => {
				job = await (await request.get(`/api/jobs/${jobId}`)).json();
				return ['succeeded', 'failed', 'cancelled'].includes(job.state);
			},
			{ timeout: 600_000, intervals: [2_000] },
		)
		.toBe(true);
	expect(job.state).toBe('succeeded');
	const named = job.result!.lines.filter((l) => l.text.includes('sounds like'));
	console.log(`named transcript lines:\n${named.map((l) => `${l.timecode}  ${l.text}`).join('\n')}`);
	expect(named.length).toBeGreaterThan(0);
});
