// Sound credits in the export (spec 12 §2.11, P6-R4; wp-note sound-design "Phase 6 → WP6.4") in the built app: a
// user sound folder declared CC BY 4.0 with an author and a credit template → its sound inserted from the Sound
// Library → Export mode: the SOUND ▸ Credits control defaults to Markdown (a CC BY sound is used); Off shows
// W_SOUND_CREDITS; Markdown again clears it → export → the job result and the Jobs panel name the credits file, which
// holds the exact credit line. Screenshots go to test-results/e2e-sound-credits-export.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { JobListResponseSchema } from '../packages/api/src/jobs.ts';
import { createProject, enableAgentBridge, focusTimeline, query, ROOT, waitForJob } from './support.ts';

test.describe.configure({ mode: 'serial' });
const outDir = join(ROOT, 'test-results', 'e2e-sound-credits-export');
let page: Page;

/** A 0.6 s stereo 48 kHz 16-bit WAV: 50 ms of silence, then a decaying 880 Hz ding. */
function dingWav(): Buffer {
	const sr = 48_000;
	const n = Math.round(0.6 * sr);
	const data = Buffer.alloc(n * 4);
	for (let i = 0; i < n; i++) {
		const t = i / sr - 0.05;
		const v = t < 0 ? 0 : 0.5 * Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t / 0.12);
		const s = Math.round(v * 32767);
		data.writeInt16LE(s, i * 4);
		data.writeInt16LE(s, i * 4 + 2);
	}
	const h = Buffer.alloc(44);
	h.write('RIFF', 0, 'ascii');
	h.writeUInt32LE(36 + data.length, 4);
	h.write('WAVEfmt ', 8, 'ascii');
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(2, 22);
	h.writeUInt32LE(sr, 24);
	h.writeUInt32LE(sr * 4, 28);
	h.writeUInt16LE(4, 32);
	h.writeUInt16LE(16, 34);
	h.write('data', 36, 'ascii');
	h.writeUInt32LE(data.length, 40);
	return Buffer.concat([h, data]);
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage();
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('a CC BY folder sound: the Export dialog warns without credits and writes the exact credit line', async ({
	request,
}) => {
	test.setTimeout(900_000);
	// a user folder declared CC BY 4.0, with its author and credit template (the editor's own request: no card)
	const folder = mkdtempSync(join(tmpdir(), 'jasper-e2e-ccby-'));
	writeFileSync(join(folder, 'Credit Ding.wav'), dingWav());
	const current = (await (await request.get('/api/sounds/roots')).json()) as {
		roots: { id: string; path: string }[];
	};
	const put = await request.put('/api/sounds/roots', {
		data: {
			roots: [
				...current.roots.map((r) => ({ id: r.id, path: r.path })),
				{
					path: folder,
					label: 'E2E CC BY',
					license: 'CC-BY-4.0',
					author: 'Ada Tester',
					attributionTemplate: '"{title}" by {author}, licensed under {license}',
				},
			],
		},
	});
	expect(put.status(), await put.text()).toBe(200);
	const started = (await put.json()) as { job: { id: string } | null };
	if (started.job) expect((await waitForJob(request, started.job.id, 600_000)).state).toBe('succeeded');

	await createProject(page, 'E2E Sound Credits Export');
	await page.keyboard.press('Alt+Shift+Digit9');
	const panel = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	const list = panel.getByRole('listbox', { name: 'Sounds' });
	await expect(list.getByRole('option').first()).toBeVisible({ timeout: 360_000 });
	// the licence filter's default (commercial-safe) shows CC BY sounds
	await panel.getByTestId('sound-search').fill('credit ding');
	const option = list.getByRole('option', { name: /^Credit Ding/ }).first();
	await expect(option).toBeVisible({ timeout: 60_000 });
	await query(page, 'playhead.set', { frame: 30 });
	await option.click();
	await page.keyboard.press('Enter');
	type Media = { library?: { license: string; attribution: string | null; title: string } };
	await expect
		.poll(
			async () =>
				Object.values(await query<Record<string, Media>>(page, 'doc.get', { path: ['media'] })).filter(
					(m) => m.library?.license === 'CC-BY-4.0',
				).length,
			{ timeout: 60_000 },
		)
		.toBe(1);
	const lib = Object.values(await query<Record<string, Media>>(page, 'doc.get', { path: ['media'] })).find(
		(m) => m.library?.license === 'CC-BY-4.0',
	)!.library!;
	expect(lib.attribution).toBe('"Credit Ding" by Ada Tester, licensed under CC-BY-4.0');

	// Export mode: Credits defaults to Markdown; Off → W_SOUND_CREDITS; Markdown again → gone
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	const credits = page.getByTestId('export-credits');
	await expect(credits).toHaveValue('md');
	await credits.selectOption('off');
	const warnings = page.getByTestId('export-sound-warnings');
	await expect(warnings.locator('[data-code="W_SOUND_CREDITS"]')).toContainText(
		'1 sound heard in this export needs a credit (CC-BY-4.0: "Credit Ding")',
		{ timeout: 30_000 },
	);
	await page.getByTestId('export-sound').screenshot({ path: join(outDir, 'export-warning.png') });
	await page.screenshot({ path: join(outDir, 'export-mode-warning.png') });
	await page.getByTestId('export-filename').fill('credits-e2e');
	const replanned = page.waitForResponse(
		(res) =>
			res.url().endsWith('/api/exports/plan') &&
			res.request().method() === 'POST' &&
			res.request().postDataJSON()?.settings?.credits?.sidecar === 'md',
	);
	await credits.selectOption('md');
	await (await replanned).finished();
	await expect(page.getByTestId('plan-path')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('[data-code="W_SOUND_CREDITS"]')).toHaveCount(0, { timeout: 30_000 });
	await page.getByTestId('export-sound').screenshot({ path: join(outDir, 'export-credits-md.png') });
	const before = new Set(
		JobListResponseSchema.parse(await (await request.get('/api/jobs')).json()).jobs.map((j) => j.id),
	);
	await expect(page.getByTestId('export-start')).toBeEnabled({ timeout: 30_000 });
	await page.getByTestId('export-start').click();
	await expect(page.getByTestId('export-mode')).toBeHidden();
	let jobId = '';
	await expect
		.poll(async () => {
			const { jobs } = JobListResponseSchema.parse(await (await request.get('/api/jobs')).json());
			jobId = jobs.find((j) => j.kind === 'export' && !before.has(j.id))?.id ?? '';
			return jobId;
		})
		.not.toBe('');
	const job = await waitForJob(request, jobId, 600_000);
	expect(job.state, JSON.stringify(job.error ?? null)).toBe('succeeded');
	const result = job.result as {
		credits?: { format: string; count: number; name: string; url: string };
		warnings?: { code: string }[];
	};
	expect(result.credits).toMatchObject({ format: 'md', count: 1, name: 'output.credits.md' });
	expect(result.warnings?.map((w) => w.code) ?? []).not.toContain('W_SOUND_CREDITS');
	const file = await request.get(result.credits!.url);
	expect(file.status()).toBe(200);
	const text = await file.text();
	writeFileSync(join(outDir, 'credits-e2e.credits.md'), text);
	expect(text.split('\n')[0]).toBe('## Sound credits');
	expect(text).toContain('| Credit Ding | Ada Tester |');
	// the credit line exactly as the folder's template made it
	expect(text).toContain('| "Credit Ding" by Ada Tester, licensed under CC-BY-4.0 |');
	// the Jobs panel offers the file next to the video
	const row = page.getByTestId('jobs-panel').locator(`[data-testid="job-row"][data-job-id="${jobId}"]`);
	await expect(row.getByText('credits.md')).toBeVisible({ timeout: 30_000 });
	await page.getByTestId('jobs-panel').screenshot({ path: join(outDir, 'jobs-panel.png') });
});
