// @vitest-environment node
// previews (playback robustness): the Remotion Player stall after seeks. Chrome leaves `AudioContext.resume()`
// pending when `suspend()` follows before it settled, and the Player waits for the audio clock to move after every
// resume — so a seek's suspend right after a play froze playback. `installSerialAudioContext` serialises the context's
// state changes and lets the clock move before such a suspend. In a real Chrome: the browser behaviour without the
// shim (documented: a browser fix shows up here) and the fix. Runs when a Chrome is found; FX_GL=0 skips it.
import { existsSync } from 'node:fs';
import { type Browser, chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installSerialAudioContext } from '../src/audio/serial-audio-context.ts';

const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));
const run = !!CHROME && process.env.FX_GL !== '0';

/** Resume then suspend 0–2 ms later, a few times: whether the resumes settle and the clock moved after them. */
const probe = async () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const settle = (p: Promise<unknown>, ms: number) =>
		Promise.race([
			p.then(
				() => 'ok',
				() => 'rejected',
			),
			sleep(ms).then(() => 'pending'),
		]);
	const ctx = new AudioContext();
	const osc = ctx.createOscillator();
	osc.connect(ctx.destination);
	osc.start();
	await settle(ctx.resume(), 2000);
	await sleep(100);
	const out: { resume: string; moved: boolean }[] = [];
	for (let i = 0; i < 4; i++) {
		await settle(ctx.suspend(), 1000);
		await sleep(30);
		const t0 = ctx.getOutputTimestamp().contextTime ?? 0;
		const r = ctx.resume();
		await sleep(i % 2);
		const s = ctx.suspend();
		const resume = await settle(r, 1000);
		await settle(s, 1000);
		out.push({ resume, moved: (ctx.getOutputTimestamp().contextTime ?? 0) > t0 });
	}
	await ctx.close();
	return out;
};

describe.runIf(run)('AudioContext resume/suspend races', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await chromium.launch({
			executablePath: CHROME!,
			headless: true,
			args: ['--autoplay-policy=no-user-gesture-required'],
		});
	}, 60_000);
	afterAll(async () => {
		await browser?.close();
	});

	it('a suspend right after a resume leaves the resume pending without the shim; with it every resume settles and the clock moves', async () => {
		const raw = await browser.newPage();
		await raw.setContent('<!doctype html><html><body></body></html>');
		const before = await raw.evaluate(probe);
		// The browser behaviour the shim works around (if a Chrome update fixes it, this expectation can go).
		expect(before.some((x) => x.resume === 'pending')).toBe(true);

		const fixed = await browser.newPage();
		await fixed.setContent('<!doctype html><html><body></body></html>');
		await fixed.evaluate(`(${installSerialAudioContext.toString()})()`);
		const after = await fixed.evaluate(probe);
		expect(after.every((x) => x.resume === 'ok')).toBe(true);
		expect(after.every((x) => x.moved)).toBe(true);
	}, 60_000);
});
