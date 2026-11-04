// @vitest-environment node
// Chrome can leave resume() pending if suspend() follows before it settles.
// The Player also needs the audio clock to move after resume before another suspend.
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleGlEntry, CHROME } from './gl-browser.ts';

const run = !!CHROME && process.env.FX_GL !== '0';

/** Same-turn and next-task requests settle in order and let the real audio clock advance. */
const probe = async () => {
	const ctx = new AudioContext();
	const osc = ctx.createOscillator();
	osc.connect(ctx.destination);
	osc.start();
	const out: { resume: string; moved: boolean }[] = [];
	try {
		await ctx.resume();
		for (let i = 0; i < 4; i++) {
			await ctx.suspend();
			const t0 = ctx.getOutputTimestamp().contextTime ?? 0;
			let resume = 'pending';
			void ctx.resume().then(
				() => {
					resume = 'ok';
				},
				() => {
					resume = 'rejected';
				},
			);
			if (i % 2)
				await new Promise<void>((resolve) => {
					const { port1, port2 } = new MessageChannel();
					port1.onmessage = () => {
						port1.close();
						port2.close();
						resolve();
					};
					port2.postMessage(null);
				});
			await ctx.suspend();
			out.push({ resume, moved: (ctx.getOutputTimestamp().contextTime ?? 0) > t0 });
			if (resume !== 'ok') break;
		}
		return out;
	} finally {
		await ctx.close();
	}
};

describe.runIf(run)('AudioContext resume/suspend races', () => {
	let browser: Browser;
	let installScript: string;
	beforeAll(async () => {
		installScript = await bundleGlEntry(
			fileURLToPath(new URL('./serial-audio-context/entry.ts', import.meta.url)),
		);
		browser = await chromium.launch({
			executablePath: CHROME!,
			headless: true,
			args: ['--autoplay-policy=no-user-gesture-required'],
		});
	}, 60_000);
	afterAll(async () => {
		await browser?.close();
	});

	it('overlapping resume and suspend settle and advance the audio clock', async () => {
		const fixed = await browser.newPage();
		const errors: string[] = [];
		fixed.on('pageerror', (error) => errors.push(error.message));
		await fixed.setContent('<!doctype html><html><body></body></html>');
		await fixed.addScriptTag({ content: installScript });
		const after = await fixed.evaluate(probe);
		expect(errors).toEqual([]);
		expect(
			after.every((x) => x.resume === 'ok'),
			JSON.stringify(after),
		).toBe(true);
		expect(
			after.every((x) => x.moved),
			JSON.stringify(after),
		).toBe(true);
	});
});
