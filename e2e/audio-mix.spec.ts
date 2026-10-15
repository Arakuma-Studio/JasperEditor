import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	importFiles,
	query,
	ROOT,
	sequenceSummary,
	transact,
} from './support.ts';

test.use({
	launchOptions: {
		args: [
			'--use-fake-device-for-media-stream',
			'--use-fake-ui-for-media-stream',
			'--autoplay-policy=no-user-gesture-required',
		],
	},
	permissions: ['microphone'],
});
test.describe.configure({ mode: 'serial' });

let page: Page;
const outDir = join(ROOT, 'test-results', 'e2e-audio-mix');

type Doc = {
	items: Record<string, { id: string; kind: string; name: string }>;
};
const doc = () => query<Doc>(page, 'doc.get');

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	const ctx = await browser.newContext({ permissions: ['microphone'] });
	page = await ctx.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: join(outDir, 'final.png') });
	await page?.context().close();
});

test('Audio Meters follow the preview mix', async () => {
	await createProject(page, 'E2E Audio Mix');
	await importFiles(page, ['clip-a.mp4', 'tone.wav']);
	const d = await doc();
	const tone = Object.values(d.items).find((i) => i.name === 'tone.wav')!;
	const video = Object.values(d.items).find((i) => i.name === 'clip-a.mp4')!;
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { projectItemId: video.id },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 3 } },
		},
		{
			type: 'clip.place',
			source: { projectItemId: tone.id },
			at: 0,
			tracks: { audio: 'A2' },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 3 } },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const meters = page.getByTestId('audio-meters');
	await expect(meters).toBeVisible();
	await focusTimeline(page);
	await page.keyboard.press('Space');
	await expect(meters).toHaveAttribute('data-live', 'true', { timeout: 20_000 });
	const momentary = meters.locator('[data-loudness="M"] [data-value]');
	await expect
		.poll(async () => Number((await momentary.getAttribute('data-value')) || '-200'), { timeout: 20_000 })
		.toBeGreaterThan(-40);
	await page.screenshot({ path: join(outDir, 'meters.png') });
	await page.keyboard.press('Space');
});

test('Voice-over: the fake microphone is recorded into A3 at the playhead', async () => {
	const summary = await sequenceSummary(page);
	const a3 = summary.tracks?.find((t) => t.label === 'A3');
	expect(a3, JSON.stringify(summary.tracks)).toBeTruthy();
	const header = page.locator(`[data-track-header="${a3!.id}"]`);
	await header.locator('[data-control="voiceover"]').click();
	await page.waitForTimeout(4500);
	await header.locator('[data-control="voiceover"]').click();
	await expect.poll(async () => (await clips(page, ['A3'])).length, { timeout: 60_000 }).toBe(1);
	const [take] = await clips(page, ['A3']);
	expect(take!.duration).toBeGreaterThan(0);
	await page.screenshot({ path: join(outDir, 'voiceover.png') });
});
