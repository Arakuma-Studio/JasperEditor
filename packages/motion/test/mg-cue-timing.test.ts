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
	flicksPerFrame,
} from '@jasper/project';
import { type Browser, chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MotionBox, MotionSample } from './mg-cue-renderer.tsx';

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

/** Cues of one clip at frame 0 on V1 (`rate`: the sequence preset; `sourceIn`: content frames trimmed off its head). */
function cues(
	template: string,
	params: Record<string, unknown>,
	duration: number,
	opts: { rate?: string; sourceIn?: number } = {},
) {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'Motion cues', preset: `hd-1080p-${opts.rate ?? '59.94'}` });
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
					ref: '$m',
				},
			],
		},
		{ ids, now: () => '2026-10-17T10:00:00.000Z', revision: 0, registries: defaultRegistries(mgRegistry) },
	);
	if (!applied.result.ok) throw new Error(JSON.stringify(applied.result.errors));
	const document = structuredClone(applied.document);
	if (opts.sourceIn) {
		const seq = document.sequences[sequenceId]!;
		(seq.clips[applied.result.refs.$m!] as { sourceIn: number }).sourceIn =
			opts.sourceIn * flicksPerFrame(seq.settings.frameRate);
	}
	return deriveCues(document, sequenceId, {
		sources: ['mg'],
		density: 'rich',
		mgTemplates: mgRegistry,
	}).cues;
}

// Sound-design.md §§WP2.2/WP2.2a: screen travel in canvas diagonals/s, opacity weight 0.25,
// log-scale weight 0.6, movement ends at 0.03. Fixed values are independent of production constants.
function boxSpeed(a: MotionBox, b: MotionBox): number {
	const scale =
		a.width > 0 && b.width > 0 ? 0.6 * Math.abs(Math.log(b.width / a.width)) : a.width !== b.width ? 3 : 0;
	return Math.max(
		Math.hypot(b.x - a.x, b.y - a.y) / Math.hypot(1920, 1080),
		0.25 * Math.abs(b.opacity - a.opacity),
		scale,
	);
}

// A small element inside a picture (a word, an icon) moves by the px its box travels or grows, not as a scale of the
// whole picture (sound-design.md "Motion-graphic land / exit from the rendered motion": a word's or the heart's scale
// counts as px of its size).
function elementSpeed(a: MotionBox, b: MotionBox): number {
	return Math.max(
		Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.abs(b.width - a.width)) / Math.hypot(1920, 1080),
		0.25 * Math.abs(b.opacity - a.opacity),
	);
}

// A changed text moves the picture; otherwise the fastest observed box wins. With parts (social-comment), the first
// part is the whole card (a picture of its own) and the label and the other parts are elements inside it.
function speed(a: MotionSample, b: MotionSample, rate = fps): number {
	if (a.text !== b.text) return 1;
	if (!a.parts) return boxSpeed(a, b) * rate;
	const parts = a.parts.map((p, i) => {
		const q = b.parts?.[i];
		if (!q) return 1;
		return i === 0 ? boxSpeed(p, q) : elementSpeed(p, q);
	});
	return Math.max(elementSpeed(a, b), ...parts) * rate;
}

/** Rendered speed from each frame to the next of `from … to` (`opts.fps`: the clip's rate). */
async function measure(
	template: string,
	params: Record<string, unknown>,
	duration: number,
	from: number,
	to: number,
	opts: { fps?: number; name?: string } = {},
) {
	const rate = opts.fps ?? fps;
	const samples = await page.evaluate(
		({ template, params, duration, frames, rate }) => {
			return (
				window as unknown as {
					captureMotion(...args: [string, Record<string, unknown>, number, number[], number]): MotionSample[];
				}
			).captureMotion(template, params, duration, frames, rate);
		},
		{ template, params, duration, frames: Array.from({ length: to - from + 1 }, (_, i) => from + i), rate },
	);
	const measured = samples
		.slice(1)
		.map((sample, i) => ({ frame: sample.frame, speed: speed(samples[i]!, sample, rate) }));
	const artifact = resolve(process.env.JASPER_TEST_RESULTS ?? 'test-results', 'motion-cues');
	mkdirSync(artifact, { recursive: true });
	writeFileSync(
		join(artifact, `${opts.name ?? template}.json`),
		JSON.stringify({ samples, measured }, null, 2),
	);
	return measured;
}

async function motion(
	template: string,
	params: Record<string, unknown>,
	duration: number,
	from: number,
	to: number,
) {
	const measured = await measure(template, params, duration, from, to);
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

// social-comment@1 (social-comment design §7.6, sound-design.md "Motion-graphic land / exit from the rendered motion"):
// its land / exit cues come from the shared schedule's motion model; they must sit where the rendered card comes to
// rest after its entrance, word reveal and like tick, and where it starts leaving. The rule, from the work note:
// movements are runs of frames above 0.03 reaching 0.12, at least 2 frames, joined across pauses of ≤ round(0.25·fps)
// frames; the intro is the first movement when it starts within round(0.1·fps) + 1 frames and lands on its last moving
// frame (never on the last content frame); the exit is the first frame of the last later movement.
const RATES: Record<string, number> = {
	'23.976': 24000 / 1001,
	'25': 25,
	'29.97': 30000 / 1001,
	'30': 30,
	'50': 50,
	'59.94': 60000 / 1001,
};

function restAndLeave(measured: { frame: number; speed: number }[], rate: number, total: number) {
	const speedAt = new Array<number>(total).fill(0);
	for (const m of measured) speedAt[m.frame] = m.speed;
	const runs: [number, number, number][] = [];
	for (let i = 0; i < total; ) {
		if (!(speedAt[i]! > 0.03)) {
			i++;
			continue;
		}
		const a = i;
		let peak = 0;
		while (i < total && speedAt[i]! > 0.03) peak = Math.max(peak, speedAt[i++]!);
		runs.push([a, i - 1, peak]);
	}
	const joined: [number, number, number][] = [];
	for (const r of runs) {
		const last = joined.at(-1);
		if (last && r[0] - last[1] - 1 <= Math.max(1, Math.round(0.25 * rate))) {
			last[1] = r[1];
			last[2] = Math.max(last[2], r[2]);
		} else joined.push([...r]);
	}
	const moves = joined.filter((m) => m[2] >= 0.12 && m[1] - m[0] + 1 >= 2);
	const first = moves[0];
	const intro = first && first[0] <= Math.round(0.1 * rate) + 1 ? first : undefined;
	const land = intro && intro[1] < total - 1 ? intro[1] : null;
	const last = moves.at(-1);
	const exit = last && last !== intro && (land === null || last[0] > land) ? last[0] : null;
	return { land, exit, moves: moves.length };
}

type SocialRow = { rate: string; seconds: number; sourceIn?: number; params: Record<string, unknown> };
const ENTRANCES = ['classic-pop', 'soft-spring', 'grow-from-tail', 'drop-bounce'] as const;
const SOCIAL_ROWS: SocialRow[] = [
	// every entrance × the extras (none, word reveal, like tick, both) on the TikTok comment
	...ENTRANCES.flatMap((entrance) =>
		(
			[
				[false, false],
				[true, false],
				[false, true],
				[true, true],
			] as const
		).map(([wordReveal, likeTick]) => ({
			rate: '30',
			seconds: 5,
			params: { variant: 'tiktok-comment', entrance, wordReveal, likeTick },
		})),
	),
	// the default card (TikTok reply bubble: no likes drawn, so no tick), other rates, a huge count, a long comment
	// (the reveal compresses to its span), extras squeezed before the exit, intro and outro compressed, a head trim
	{ rate: '25', seconds: 5, params: { entrance: 'drop-bounce', wordReveal: true } },
	{
		rate: '59.94',
		seconds: 4,
		params: { variant: 'tiktok-comment', entrance: 'classic-pop', likeTick: true, likes: 4_812_345 },
	},
	{
		rate: '23.976',
		seconds: 6,
		params: {
			entrance: 'grow-from-tail',
			wordReveal: true,
			text: 'Okay this is ==honestly the best== tutorial I have seen all week 😂 I tried it on my own videos and the engagement doubled overnight, can you please make a part two about ||editing||? 🔥🙏 ~~Thanks~~ so much!',
		},
	},
	{ rate: '30', seconds: 1.5, params: { variant: 'tiktok-comment', wordReveal: true, likeTick: true } },
	{ rate: '30', seconds: 0.6, params: { entrance: 'drop-bounce' } },
	{
		rate: '30',
		seconds: 4,
		sourceIn: 5,
		params: { variant: 'tiktok-comment', entrance: 'soft-spring', likeTick: true },
	},
	// Instagram: the post comment draws likes (its tick runs), the Reels reply card does not (word reveal only)
	...(['classic-pop', 'grow-from-tail'] as const).flatMap((entrance) => [
		{
			rate: '30',
			seconds: 5,
			params: { variant: 'instagram-post', entrance, wordReveal: true, likeTick: true, likes: 114 },
		},
		{
			rate: '30',
			seconds: 5,
			params: { variant: 'instagram-reel-reply', entrance, wordReveal: true, likeTick: true },
		},
	]),
	{
		rate: '25',
		seconds: 1.5,
		params: { variant: 'instagram-post', entrance: 'soft-spring', likeTick: true, likes: 987_654 },
	},
	// X: every entrance with both extras, a huge count on the dark theme at 50 fps, word reveal on a short clip
	...ENTRANCES.map((entrance) => ({
		rate: '30',
		seconds: 5,
		params: { variant: 'x-post', entrance, wordReveal: true, likeTick: true },
	})),
	{
		rate: '50',
		seconds: 3,
		params: {
			variant: 'x-post',
			theme: 'dark',
			entrance: 'soft-spring',
			likeTick: true,
			likes: 987_654_321_000,
		},
	},
	{
		rate: '29.97',
		seconds: 1.5,
		params: { variant: 'x-post', entrance: 'grow-from-tail', wordReveal: true },
	},
	// YouTube: the comment ticks its thumb; the Shorts card has no likes (a like tick there must be ignored)
	...ENTRANCES.map((entrance) => ({
		rate: '30',
		seconds: 5,
		params: { variant: 'youtube-comment', entrance, wordReveal: true, likeTick: true },
	})),
	{
		rate: '25',
		seconds: 3,
		params: {
			variant: 'youtube-comment',
			theme: 'dark',
			entrance: 'soft-spring',
			likeTick: true,
			likes: 1_234_567,
		},
	},
	{
		rate: '30',
		seconds: 5,
		params: { variant: 'youtube-shorts-reply', entrance: 'grow-from-tail', wordReveal: true },
	},
	{
		rate: '59.94',
		seconds: 2,
		params: { variant: 'youtube-shorts-reply', entrance: 'drop-bounce', likeTick: true, wordReveal: true },
	},
	// store reviews: the like tick fills the stars one by one — every entrance with both extras on the three cards, a
	// 1-star review on a short clip, another rate
	...(['play-store-review', 'app-store-review', 'app-store-review-ios'] as const).flatMap((variant) =>
		ENTRANCES.map((entrance) => ({
			rate: '30',
			seconds: 5,
			params: { variant, entrance, wordReveal: true, likeTick: true, rating: 4 },
		})),
	),
	{
		rate: '25',
		seconds: 1.5,
		params: { variant: 'play-store-review', entrance: 'drop-bounce', likeTick: true, rating: 1 },
	},
	{
		rate: '59.94',
		seconds: 4,
		params: { variant: 'app-store-review-ios', entrance: 'soft-spring', likeTick: true, rating: 5 },
	},
];

describe('social-comment cues follow the rendered card', () => {
	it.each(SOCIAL_ROWS.map((row, i) => [i, row] as const))(
		'%i: %j',
		async (i, row) => {
			const rate = RATES[row.rate]!;
			const duration = Math.round(row.seconds * rate);
			const s = row.sourceIn ?? 0;
			const total = s + duration;
			const found = cues('social-comment', row.params, duration, { rate: row.rate, sourceIn: s });
			const land = found.find((c) => c.kind === 'land');
			const exit = found.find((c) => c.kind === 'exit');
			// the clip starts at frame 0 and shows content frame f at sequence frame f − sourceIn
			const measured = await measure('social-comment', row.params, total, 0, total - 1, {
				fps: rate,
				name: `social-comment-${i}`,
			});
			const truth = restAndLeave(measured, rate, total);
			expect(truth.moves).toBeGreaterThan(0); // the card rendered and moved
			if (truth.land !== null && truth.land > s) {
				expect(land, 'land cue').toBeDefined();
				expect(Math.abs(land!.frame + s - truth.land)).toBeLessThanOrEqual(1);
			} else expect(land).toBeUndefined();
			if (truth.exit !== null && truth.exit > s) {
				expect(exit, 'exit cue').toBeDefined();
				expect(Math.abs(exit!.frame + s - truth.exit)).toBeLessThanOrEqual(1);
			} else expect(exit).toBeUndefined();
		},
		120_000,
	);
});
