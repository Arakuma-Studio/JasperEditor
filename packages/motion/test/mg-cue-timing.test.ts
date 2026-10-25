// @vitest-environment node
// Regression source: sound-design.md, Phase 6 / WP6.5b item 16. Declared template windows placed the
// callout's land 25 frames late and the counter's exit 16 frames early. Compare cues with the actual
// rendered label motion through the public template components, without private timeline targets.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mgRegistry } from '@jasper/mg-templates';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	deriveCues,
} from '@jasper/project';
import { type Browser, chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MotionSample } from './mg-cue-renderer.tsx';

const fps = 60000 / 1001;
let browser: Browser;
let page: Page;

beforeAll(async () => {
	const entry = join(dirname(fileURLToPath(import.meta.url)), 'mg-cue-renderer.tsx');
	const bundle = await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		define: { 'process.env.NODE_ENV': '"production"' },
		logLevel: 'silent',
	});
	browser = await chromium.launch({
		executablePath:
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined),
	});
	page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
	await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
	await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
});
afterAll(async () => browser?.close());

function cues(template: string, params: Record<string, unknown>, duration: number) {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'Motion cues', preset: 'hd-1080p-59.94' });
	const sequenceId = Object.keys(doc.sequences)[0]!;
	const applied = applyTransaction(
		doc,
		{
			label: 'Template',
			origin: 'user',
			sequenceId,
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration,
					track: 'V1',
					template: { id: template, version: 1 },
					params,
				},
			],
		},
		{ ids, now: () => '2026-10-17T10:00:00.000Z', revision: 0, registries: defaultRegistries(mgRegistry) },
	);
	if (!applied.result.ok) throw new Error(JSON.stringify(applied.result.errors));
	return deriveCues(applied.document, sequenceId, {
		sources: ['mg'],
		density: 'rich',
		mgTemplates: mgRegistry,
	}).cues;
}

// Sound-design.md §§WP2.2/WP2.2a: screen travel in canvas diagonals/s, opacity weight 0.25,
// log-scale weight 0.6, movement ends at 0.03. Fixed values are independent of production constants.
function speed(a: MotionSample, b: MotionSample): number {
	if (a.text !== b.text) return 1;
	const scale =
		a.width > 0 && b.width > 0 ? 0.6 * Math.abs(Math.log(b.width / a.width)) : a.width !== b.width ? 3 : 0;
	return (
		Math.max(
			Math.hypot(b.x - a.x, b.y - a.y) / Math.hypot(1920, 1080),
			0.25 * Math.abs(b.opacity - a.opacity),
			scale,
		) * fps
	);
}

async function motion(
	template: string,
	params: Record<string, unknown>,
	duration: number,
	from: number,
	to: number,
) {
	const samples = await page.evaluate(
		({ template, params, duration, frames }) => {
			return (
				window as unknown as {
					captureMotion(...args: [string, Record<string, unknown>, number, number[]]): MotionSample[];
				}
			).captureMotion(template, params, duration, frames);
		},
		{ template, params, duration, frames: Array.from({ length: to - from + 1 }, (_, i) => from + i) },
	);
	const measured = samples
		.slice(1)
		.map((sample, i) => ({ frame: sample.frame, speed: speed(samples[i]!, sample) }));
	const artifact = resolve(process.env.JASPER_TEST_RESULTS ?? 'test-results', 'motion-cues');
	mkdirSync(artifact, { recursive: true });
	writeFileSync(join(artifact, `${template}.json`), JSON.stringify({ samples, measured }, null, 2));
	return measured.filter((sample) => sample.speed > 0.03).map((sample) => sample.frame);
}

describe('rendered template motion and sound cues', () => {
	it('callout motion-path land follows the rendered label, including the overshoot', async () => {
		const params = { ease: 'outBounce', motionPath: true };
		const duration = Math.round(4 * fps);
		const land = cues('callout', params, duration).find((c) => c.kind === 'land')!;
		expect(land.frame).toBe(59); // independently measured historical regression, WP6.5b item 16
		const moving = await motion('callout', params, duration, 0, 120);
		expect(moving.length).toBeGreaterThan(0);
		expect(Math.abs(moving.at(-1)! - land.frame)).toBeLessThanOrEqual(1);
	});

	it.each([
		[
			'title-reveal',
			{ title: 'XY', subtitle: '', underline: false, stagger: 0.55, order: 'forward', ease: 'linear' },
		],
		['lower-third-anim', { name: 'Jasper', role: 'Editor', ease: 'linear' }],
	] as const)('%s land follows the rendered text', async (template, params) => {
		const duration = Math.round(5 * fps);
		const land = cues(template, params, duration).find((c) => c.kind === 'land')!;
		const moving = await motion(template, params, duration, 0, 150);
		expect(moving.length).toBeGreaterThan(0);
		// ATP-003: the second supplied glyph follows the first in a forward stagger.
		if (template === 'title-reveal') expect(moving[0]!).toBeGreaterThan(1);
		expect(Math.abs(moving.at(-1)! - land.frame)).toBeLessThanOrEqual(1);
	});

	it('counter exit follows rendered motion after the number has settled', async () => {
		const params = { ease: 'inOutExpo', from: 1000, to: 0, decimals: 1 };
		const duration = Math.round(5 * fps);
		const exit = cues('counter', params, duration).find((c) => c.kind === 'exit')!;
		expect(exit.frame).toBe(286); // independently measured historical regression, WP6.5b item 16
		const moving = await motion('counter', params, duration, 180, duration - 1);
		expect(moving.length).toBeGreaterThan(0);
		expect(Math.abs(moving[0]! - exit.frame)).toBeLessThanOrEqual(1);
	});
});
