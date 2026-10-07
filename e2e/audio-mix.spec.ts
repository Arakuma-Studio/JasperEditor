// audio-mix through the real UI of the built app (docs/wp-notes/audio-mix.md): the Audio Meters panel driven by
// the preview mix (levels + R128), the Audio Track Mixer (balance knob, submix), the Audio Gain dialog (G,
// Normalize Max Peak measured on the engine), a native export whose channel levels follow the mixer, and a
// voice-over take recorded from Chrome's fake microphone into A2 and placed at the record point.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
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
	sequences: Record<
		string,
		{
			audioTracks: { id: string; pan?: { value: number } }[];
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
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
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

test('native export renders the mixer balance', async ({ request }) => {
	const { file, job } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'audio-mix.mp4',
		expectPath: /native/i,
		outDir,
	});
	expect(job.state).toBe('succeeded');
	const left = channelDbOf(file, 0);
	const right = channelDbOf(file, 1);
	// clip-a's own audio (if any) plays centred on A1; the tone on A2 is hard left
	expect(left - right).toBeGreaterThan(6);
});

test('Voice-over: the fake microphone is recorded into A3 at the playhead', async () => {
	const summary = await sequenceSummary(page);
	const a3 = summary.tracks?.find((t) => t.label === 'A3');
	expect(a3, JSON.stringify(summary.tracks)).toBeTruthy();
	const header = page.locator(`[data-track-header="${a3!.id}"]`);
	await header.locator('[data-control="voiceover"]').click();
	// pre-roll 2 s with countdown, then record ~2 s
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
