// WP0.1 (spec 12 Phase 0) in the real app: the Program monitor's audio is tapped at the AudioContext destination while
// the same click file plays on A1 (through a Hard Limiter track insert: 374 samples of look-ahead, a pure delay below
// its ceiling) and on A2 (no insert). With the track insert latency compensated the two clicks coincide (one click of
// twice the size); uncompensated they arrive 374 samples (7.8 ms) apart. Before the WP0.1 fixes this run measured
// pairs of single clicks 374 samples apart (and an insert added after playback started was not heard at all). Also: Preferences ▸ Audio shows the voice-over Latency Offset.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { ATTEMPTS, arm, disarm, disturbances, peaks, TAP } from './sound-tap.ts';
import {
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	query,
	ROOT,
	sequenceSummary,
	transact,
} from './support.ts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
test.describe.configure({ mode: 'serial' });

let page: Page;
const outDir = join(ROOT, 'test-results', 'e2e-sound-p0');

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage();
	await page.addInitScript(TAP);
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

/**
 * Plays the sequence from frame 0 for 2.6 s and returns the click peaks the monitor tap heard (channel 0; `at` in
 * samples from the first recorded one, exact context frames). A play whose scheduling Remotion lost (it rescheduled,
 * or started a buffer late: a starved main thread on a loaded host) is played again; it measures Remotion, not the
 * graph.
 */
async function playAndTap(page: Page): Promise<{ rate: number; peaks: { at: number; v: number }[] }> {
	let out = { rate: 0, peaks: [] as { at: number; v: number }[] };
	for (let a = 0; a < ATTEMPTS; a++) {
		await focusTimeline(page);
		await page.keyboard.press('Home');
		await page.waitForTimeout(500);
		await arm(page);
		await page.keyboard.press('Space');
		await page.waitForTimeout(2600);
		await page.keyboard.press('Space');
		await page.waitForTimeout(200);
		const rec = await disarm(page);
		const first = rec.frames[0] ?? 0;
		out = {
			rate: rec.rate,
			peaks: peaks(rec).map((p) => ({ at: Math.round(p.t * rec.rate) - first, v: p.v })),
		};
		const end = rec.frames.length ? (rec.frames[rec.frames.length - 1]! + 128) / rec.rate : rec.armed;
		const d = disturbances(rec, rec.armed, end);
		if (d.length === 0) break;
		console.log('Remotion lost its scheduling during the play (load), again:', d.join('; '));
	}
	return out;
}

test('track insert latency is compensated in the Program monitor', async () => {
	test.setTimeout(240_000);
	// clicks.wav: 3 s of silence with a full-scale click every 0.5 s
	const wav = join(outDir, 'clicks.wav');
	const ff = spawnSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		"aevalsrc='if(lt(mod(n\\,24000)\\,1)\\,0.5\\,0)':s=48000:d=3",
		'-ac',
		'2',
		'-c:a',
		'pcm_s16le',
		wav,
	]);
	expect(ff.status, String(ff.stderr)).toBe(0);
	await createProject(page, 'E2E Sound P0');
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([wav]);
	await expect(page.getByTestId('project-row').filter({ hasText: 'clicks.wav' })).toBeVisible({
		timeout: 60_000,
	});
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = Object.values(items).find((i) => i.name === 'clicks.wav')!;
	const r = await transact(page, [
		{ type: 'clip.place', source: { projectItemId: item.id }, at: 0, tracks: { audio: 'A1' } },
		{ type: 'clip.place', source: { projectItemId: item.id }, at: 0, tracks: { audio: 'A2' } },
		{ type: 'effect.add', target: { trackId: 'A1' }, effectId: 'jasper.audio.hard-limiter' },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const tap = await playAndTap(page);
	test.info().annotations.push({ type: 'peaks', description: JSON.stringify(tap) });
	console.log('peaks', JSON.stringify(tap));
	expect(tap.rate).toBeGreaterThan(0);
	expect(tap.peaks.length).toBeGreaterThanOrEqual(2);
	// one click per 0.5 s, each the sum of both tracks: twice the level of one track's click (0.3535 here)
	for (const p of tap.peaks) expect(p.v, JSON.stringify(tap.peaks)).toBeGreaterThan(0.65);
	for (let i = 1; i < tap.peaks.length; i++) {
		const gap = (tap.peaks[i]!.at - tap.peaks[i - 1]!.at) / tap.rate;
		expect(Math.abs(gap - 0.5), JSON.stringify(tap.peaks)).toBeLessThan(0.01);
	}
	const s = await sequenceSummary(page);
	expect(s.sequenceId).toBeTruthy();
});

/** Peaks of channel 0 of a file's audio (48 kHz), as in the monitor tap: local maxima above 0.05, merged within 5 ms. */
function filePeaks(file: string): { at: number; v: number }[] {
	const raw = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			'-map',
			'0:a:0',
			'-ac',
			'1',
			'-af',
			'pan=mono|c0=c0',
			'-ar',
			'48000',
			'-f',
			'f32le',
			'-',
		],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	const a = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
	const peaks: { at: number; v: number }[] = [];
	for (let i = 0; i < a.length; i++) {
		const v = Math.abs(a[i]!);
		if (v < 0.05) continue;
		const last = peaks[peaks.length - 1];
		if (last && i - last.at < 240) {
			if (v > last.v) Object.assign(last, { at: i, v });
		} else peaks.push({ at: i, v });
	}
	return peaks;
}

test('the export of the same track insert lines both tracks up on the source clicks', async ({ request }) => {
	test.setTimeout(420_000);
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'sound-p0-insert.mp4',
		expectPath: /native/i,
		outDir,
		jobTimeoutMs: 360_000,
	});
	const peaks = filePeaks(file);
	test.info().annotations.push({ type: 'export peaks', description: JSON.stringify(peaks) });
	console.log('export peaks', JSON.stringify(peaks));
	// clicks at 0, 0.5 … 2.5 s: six, each both tracks summed (an uncompensated insert gives twelve single clicks)
	expect(peaks.length, JSON.stringify(peaks)).toBe(6);
	peaks.forEach((p, i) => {
		expect(Math.abs(p.at - i * 24_000), JSON.stringify(peaks)).toBeLessThanOrEqual(4);
		// both tracks summed (≈ 0.707; one track alone is 0.354); AAC smooths the click at sample 0 a little
		expect(p.v, JSON.stringify(peaks)).toBeGreaterThan(0.5);
	});
});

test('a clip that starts mid-playback is heard from its first sample (read-ahead with a track insert)', async () => {
	test.setTimeout(240_000);
	// head.wav: 1 s with one click (0.25) on its very first sample, placed on A3 at frame 40 (64 064 samples at
	// 29.97 fps). The graph's read-ahead (A1's Hard Limiter) starts every source early; a clip mounted only when the
	// picture reaches it cannot start early and lost its first `read-ahead` samples (the click).
	const wav = join(outDir, 'head.wav');
	const ff = spawnSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		"aevalsrc='if(lt(n\\,1)\\,0.25\\,0)':s=48000:d=1",
		'-ac',
		'2',
		'-c:a',
		'pcm_s16le',
		wav,
	]);
	expect(ff.status, String(ff.stderr)).toBe(0);
	await page.getByTestId('tab-project').click(); // the export left the Jobs tab in front
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([wav]);
	await expect(page.getByTestId('project-row').filter({ hasText: 'head.wav' })).toBeVisible({
		timeout: 60_000,
	});
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = Object.values(items).find((i) => i.name === 'head.wav')!;
	const r = await transact(page, [
		{ type: 'clip.place', source: { projectItemId: item.id }, at: 40, tracks: { audio: 'A3' } },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const { frameRate } = (await sequenceSummary(page)).settings;
	const at = Math.round((40 * 48000 * frameRate.den) / frameRate.num);
	for (let run = 0; run < 2; run++) {
		const tap = await playAndTap(page);
		test.info().annotations.push({ type: `head peaks ${run}`, description: JSON.stringify(tap) });
		console.log('head peaks', run, JSON.stringify(tap));
		// A1 + A2 click together every 24 000 samples from timeline 0 (the one at 0 itself falls on the first sample of
		// the start fade-in, gain 0): they give where timeline 0 is in the tap.
		const ref = tap.peaks[0]!;
		expect(ref.v, JSON.stringify(tap.peaks)).toBeGreaterThan(0.65);
		const zero = ref.at % 24_000;
		const head = tap.peaks.find((p) => Math.abs(p.at - zero - at) <= 8);
		expect(head, `no click at ${at} samples after the first: ${JSON.stringify(tap.peaks)}`).toBeTruthy();
		expect(head!.v).toBeGreaterThan(0.12);
	}
});

test('Essential Sound on an SFX clip', async () => {
	const a2 = (await clips(page, ['A2']))[0]!;
	const box = await clipBox(page, a2.id);
	await page.mouse.click(box.x + 20, box.y + box.height / 2);
	await page.getByTestId('workspace-tab-audio').click();
	const es = page.getByTestId('essential-sound');
	await expect(es).toBeVisible();
	await es.getByTestId('essential-type-sfx').click();
	await expect(es.getByTestId('essential-current-type')).toContainText(/SFX/i);
	await page.screenshot({ path: join(outDir, 'essential-sound-sfx.png') });
});

test('Preferences ▸ Audio: voice-over Latency Offset', async () => {
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await page.getByRole('menuitem', { name: /^Preferences…/ }).click();
	const prefs = page.getByTestId('preferences-dialog');
	await expect(prefs).toBeVisible();
	await prefs.getByTestId('prefs-page-audio').click();
	const row = prefs.getByText('Latency Offset', { exact: true });
	await row.scrollIntoViewIfNeeded();
	await expect(row).toBeVisible();
	await page.screenshot({ path: join(outDir, 'preferences-audio.png') });
});
