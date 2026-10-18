// @vitest-environment node
// Chrome can leave resume() pending if suspend() follows before it settles.
// The Player also needs the audio clock to move after resume before another suspend.
import { type Browser, chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installSerialAudioContext } from '../src/audio/serial-audio-context.ts';
import { CHROME } from './gl-browser.ts';

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

	// The shim's guarantee, on every Chrome: each resume settles and the audio clock moves before the next suspend.
	it('with the shim every resume right before a suspend settles and the clock moves', async () => {
		const fixed = await browser.newPage();
		await fixed.setContent('<!doctype html><html><body></body></html>');
		await fixed.evaluate(`(${installSerialAudioContext.toString()})()`);
		const after = await fixed.evaluate(probe);
		expect(after.every((x) => x.resume === 'ok'), JSON.stringify(after)).toBe(true);
		expect(after.every((x) => x.moved), JSON.stringify(after)).toBe(true);
	}, 60_000);

	// The browser behaviour the shim works around, kept visible: Chrome 150 (where the shim was written) leaves a resume
	// pending here, Chrome 142 settles every one. On a Chrome without the race this is skipped with what it saw; if a
	// Chrome update fixes the race, the shim is harmless and this test can go.
	it('without the shim a suspend right after a resume leaves the resume pending (where this Chrome has the race)', async (ctx) => {
		const raw = await browser.newPage();
		await raw.setContent('<!doctype html><html><body></body></html>');
		const before = await raw.evaluate(probe);
		ctx.skip(
			!before.some((x) => x.resume === 'pending'),
			`Chrome ${browser.version()} settles every resume (${JSON.stringify(before)}): no race to work around here`,
		);
		expect(before.some((x) => x.resume === 'pending')).toBe(true);
	}, 60_000);
});
