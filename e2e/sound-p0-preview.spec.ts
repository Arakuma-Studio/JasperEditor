// WP0.1 (spec 12 Phase 0) in the real app: the Program monitor's audio is tapped at the AudioContext destination while
// the same click file plays on A1 (through a 2048-sample Pitch Shifter track insert, zero shift = a pure delay) and on
// A2 (no insert). With the track insert latency compensated the two clicks coincide (one click of twice the size);
// uncompensated they arrive 2048 samples (43 ms) apart. Also: Preferences ▸ Audio shows the voice-over Latency Offset.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	createProject,
	enableAgentBridge,
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

/** Taps every AudioContext destination: window.__tap.on starts recording channel 0 of what reaches the speakers. */
const TAP = () => {
	const w = window as unknown as { __tap: { on: boolean; data: Float32Array[][]; rate: number } };
	w.__tap = { on: false, data: [], rate: 0 };
	const tapped = new WeakSet<BaseAudioContext>();
	const connect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => unknown;
	AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
		const dest = args[0];
		if (dest instanceof AudioDestinationNode && !tapped.has(this.context)) {
			tapped.add(this.context);
			const ctx = this.context;
			const mine: Float32Array[] = [];
			w.__tap.data.push(mine);
			const sp = ctx.createScriptProcessor(1024, 2, 1);
			sp.onaudioprocess = (e) => {
				if (!w.__tap.on) return;
				w.__tap.rate = ctx.sampleRate;
				mine.push(new Float32Array(e.inputBuffer.getChannelData(0)));
			};
			const mute = ctx.createGain();
			mute.gain.value = 0;
			connect.call(this, sp);
			connect.call(sp, mute);
			connect.call(mute, dest);
		}
		return connect.apply(this, args);
	} as typeof AudioNode.prototype.connect;
};

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage();
	await page.addInitScript(TAP);
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

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
	await focusTimeline(page);
	await page.evaluate(() => {
		(window as unknown as { __tap: { on: boolean } }).__tap.on = true;
	});
	await page.keyboard.press('Space');
	await page.waitForTimeout(2600);
	await page.keyboard.press('Space');
	const tap = await page.evaluate(() => {
		const t = (window as unknown as { __tap: { on: boolean; data: Float32Array[][]; rate: number } }).__tap;
		t.on = false;
		// the context that played the program (the loudest; others are silent)
		const flat = t.data.map((blocks) => {
			const a = new Float32Array(blocks.reduce((x, b) => x + b.length, 0));
			let o = 0;
			for (const b of blocks) {
				a.set(b, o);
				o += b.length;
			}
			return a;
		});
		const peakOf = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
		const all = flat.reduce((best, a) => (peakOf(a) > peakOf(best) ? a : best), new Float32Array(0));
		const n = all.length;
		// peaks: local maxima above 0.05, merged within 5 ms
		const peaks: { at: number; v: number }[] = [];
		for (let i = 0; i < n; i++) {
			const v = Math.abs(all[i]!);
			if (v < 0.05) continue;
			const last = peaks[peaks.length - 1];
			if (last && i - last.at < t.rate * 0.005) {
				if (v > last.v) Object.assign(last, { at: i, v });
			} else peaks.push({ at: i, v });
		}
		return { rate: t.rate, peaks };
	});
	test.info().annotations.push({ type: 'peaks', description: JSON.stringify(tap) });
	expect(tap.rate).toBeGreaterThan(0);
	expect(tap.peaks.length).toBeGreaterThanOrEqual(2);
	// one click per 0.5 s, each the sum of both tracks (≈ 2 × 0.5 through the default pan / fader)
	for (let i = 1; i < tap.peaks.length; i++) {
		const gap = (tap.peaks[i]!.at - tap.peaks[i - 1]!.at) / tap.rate;
		expect(Math.abs(gap - 0.5), JSON.stringify(tap.peaks)).toBeLessThan(0.01);
	}
	const s = await sequenceSummary(page);
	expect(s.sequenceId).toBeTruthy();
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
