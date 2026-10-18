import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	browserLaunch,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	importFiles,
	query,
	ROOT,
	sequenceSummary,
	transact,
} from './support.ts';

test.use({
	launchOptions: browserLaunch([
		'--use-fake-device-for-media-stream',
		'--use-fake-ui-for-media-stream',
		'--autoplay-policy=no-user-gesture-required',
	]),
	permissions: ['microphone'],
});
test.describe.configure({ mode: 'serial' });

let page: Page;
const outDir = join(ROOT, 'test-results', 'e2e-audio-mix');

type Doc = {
	items: Record<string, { id: string; kind: string; name: string }>;
	sequences: Record<
		string,
		{
			audioTracks: { id: string; mute?: boolean; pan?: { value: number } }[];
			submixTracks?: { id: string }[];
			clips: Record<string, { id: string; kind: string; name: string; gainDb?: number; trackId: string }>;
		}
	>;
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

/** Mean volume (dB) of one channel of an exported file (ffmpeg volumedetect, reported on stderr). */
function channelDbOf(file: string, channel: 0 | 1): number {
	const r = spawnSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-hide_banner', '-i', file, '-af', `pan=mono|c0=c${channel},volumedetect`, '-vn', '-f', 'null', '-'],
		{ encoding: 'utf8' },
	);
	const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(String(r.stderr));
	return !m || m[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(m[1]);
}

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

test('Audio Track Mixer: balance knob and a submix', async () => {
	await focusTimeline(page);
	await page.keyboard.press('Shift+Digit6');
	const mixer = page.getByTestId('audio-track-mixer');
	await expect(mixer).toBeVisible();
	await expect(mixer.getByTestId('mixer-strip-A1')).toBeVisible();
	await expect(mixer.getByTestId('mixer-strip-Mix')).toBeVisible();
	const knob = mixer.getByTestId('mixer-strip-A2').getByTestId('mixer-pan');
	await knob.focus();
	for (let i = 0; i < 100; i++) await knob.press('ArrowLeft');
	const seq = (await sequenceSummary(page)).sequenceId;
	await expect.poll(async () => (await doc()).sequences[seq]!.audioTracks[1]!.pan?.value).toBe(-100);
	// mute A1 (clip-a's own sound) so the export below hears only the panned tone
	await mixer.getByTestId('mixer-strip-A1').getByTitle('Mute Track').click();
	await expect.poll(async () => (await doc()).sequences[seq]!.audioTracks[0]!.mute).toBe(true);
	await mixer.getByTestId('mixer-add-submix').click();
	await expect.poll(async () => (await doc()).sequences[seq]!.submixTracks?.length ?? 0).toBe(1);
	await expect(mixer.getByTestId('mixer-strip-S1')).toBeVisible();
	await page.screenshot({ path: join(outDir, 'mixer.png') });
});

test('Audio Gain (G): Normalize Max Peak measures and sets the clip gain', async () => {
	const [a] = await clips(page, ['A2']);
	const box = await clipBox(page, a!.id);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await page.keyboard.press('KeyG');
	const dlg = page.getByTestId('audio-gain-dialog');
	await expect(dlg).toBeVisible();
	await dlg.getByTestId('audio-gain-normalizeMax').check();
	// tone.wav peaks at −9.0 dBFS (ffmpeg volumedetect)
	await expect(dlg.getByTestId('audio-gain-peak')).toHaveText(/-9\.\d dB/, { timeout: 30_000 });
	await dlg.getByRole('button', { name: 'OK' }).click();
	await expect(dlg).toBeHidden();
	const seq = (await sequenceSummary(page)).sequenceId;
	await expect.poll(async () => (await doc()).sequences[seq]!.clips[a!.id]!.gainDb ?? 0).toBeGreaterThan(8.5);
	// back to unity so the export below measures the mixer only
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await doc()).sequences[seq]!.clips[a!.id]!.gainDb ?? 0).toBe(0);
});

for (const engine of ['native', 'remotion'] as const)
	test(`${engine} export renders the mixer balance`, async ({ request }) => {
		test.setTimeout(900_000);
		const { file, job } = await exportViaUi(page, request, {
			engine,
			fileName: `audio-mix-${engine}.mp4`,
			expectPath: new RegExp(engine, 'i'),
			outDir,
			jobTimeoutMs: 900_000,
		});
		expect(job.state).toBe('succeeded');
		const left = channelDbOf(file, 0);
		const right = channelDbOf(file, 1);
		// A1 is muted; the tone on A2 (mean −19.1 dB) is balanced hard left
		expect(left).toBeGreaterThan(-25);
		expect(right).toBeLessThan(left - 40);
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
	expect(take!.name).toMatch(/Voice-over 1/);
	expect(take!.duration).toBeGreaterThan(0);
	const labels = (
		await query<{ entries: { label: string; applied: boolean }[] }>(page, 'history.list')
	).entries
		.filter((e) => e.applied)
		.map((e) => e.label);
	expect(labels).toContain('Record Voice-over');
	await page.screenshot({ path: join(outDir, 'voiceover.png') });
});
