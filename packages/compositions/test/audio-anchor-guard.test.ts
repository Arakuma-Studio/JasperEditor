// @vitest-environment node
// Sound design Phase 6 → preview transport carry-overs: the anchor guard of the preview mix graph
// (`MixGraph.attachSync`). Remotion re-anchors every media player (stops their queued buffers and schedules again
// from a new anchor: an audible jump) whenever, at a frame's commit, `currentTime − frame / fps` is off by more than
// 0.1 s + the output latency. While playing the guard refuses a later anchor (a frame committed late) unless Remotion
// keeps asking for it with the picture updating regularly — then the picture is behind for real and catches up
// (frames dropped), and the audio does not jump. An earlier anchor (the picture ahead of the audio clock) is taken.
// Driven in headless Chrome as Remotion drives it (`entry.ts` `guard`).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRenderSnapshot } from '@jasper/project';
import { bundleForBrowser, findChrome } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from '../../project/test/helpers.ts';
import { ANCHOR_CONFIRM } from '../src/audio/graph.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = findChrome();
const SR = 48000;
const FPS = 30;

function mix() {
	const h = new Harness();
	return buildRenderSnapshot(h.doc, h.seqId, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
}

describe.runIf(!!CHROME)(
	'the preview graph refuses Remotion re-anchors while playing (headless Chrome)',
	{ timeout: 300_000 },
	() => {
		let browser: Browser;
		let page: Page;
		let workletUrl: string;

		beforeAll(async () => {
			const [entry, worklet] = await Promise.all([
				bundleForBrowser(join(here, 'audio-oracle', 'entry.ts')),
				bundleForBrowser(join(here, '..', 'src', 'audio', 'worklet.ts')),
			]);
			browser = await chromium.launch({ executablePath: CHROME ?? undefined });
			page = await browser.newPage();
			await page.route('http://localhost/oracle', (r) =>
				r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
			);
			await page.goto('http://localhost/oracle');
			await page.addScriptTag({ content: entry });
			workletUrl = await page.evaluate(
				(code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' })),
				worklet,
			);
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		type Result = { anchors: number[]; changed: number[]; advanced: { frame: number; frames: number }[] };
		async function run(asks: { frame: number; delta: number }[], skip: number[] = []): Promise<Result> {
			const s = mix();
			return page.evaluate(
				(spec) =>
					(window as unknown as { __mix: { guard: (s: unknown) => Promise<unknown> } }).__mix.guard(spec),
				{
					workletUrl,
					mix: s.audioMix,
					fps: { num: FPS, den: 1 },
					fpsValue: FPS,
					length: Math.round(2 * SR),
					asks,
					skip,
				},
			) as Promise<Result>;
		}

		it('a frame committed late (one or two asks for a later anchor): refused, the players are not told', async () => {
			const r = await run([
				{ frame: 20, delta: 0.21 },
				{ frame: 21, delta: 0.19 },
			]);
			expect(r.changed).toEqual([]);
			expect(new Set(r.anchors)).toEqual(new Set([0]));
			expect(r.advanced).toEqual([]);
		});

		it('the picture behind for real (asked on every frame, frames regular): it catches up, the audio does not move', async () => {
			const asks = Array.from({ length: 25 }, (_, i) => ({ frame: 20 + i, delta: 0.2 }));
			const r = await run(asks);
			expect(r.changed).toEqual([]);
			expect(new Set(r.anchors)).toEqual(new Set([0]));
			// once, after ANCHOR_CONFIRM of asking: 0.2 s at 30 fps
			expect(r.advanced).toHaveLength(1);
			expect(r.advanced[0]!.frames).toBe(6);
			expect(r.advanced[0]!.frame - 20).toBeGreaterThanOrEqual(Math.floor(ANCHOR_CONFIRM * FPS));
			expect(r.advanced[0]!.frame - 20).toBeLessThanOrEqual(Math.ceil(ANCHOR_CONFIRM * FPS) + 1);
		});

		it('asked on every frame while the frames come late (a busy main thread): only refused', async () => {
			const asks = Array.from({ length: 30 }, (_, i) => ({ frame: 20 + i, delta: 0.2 }));
			// every fourth frame updates (0.13 s apart)
			const skip = Array.from({ length: 40 }, (_, i) => 18 + i).filter((k) => k % 4 !== 0);
			const r = await run(asks, skip);
			expect(r.changed).toEqual([]);
			expect(r.advanced).toEqual([]);
			expect(new Set(r.anchors)).toEqual(new Set([0]));
		});

		it('an earlier anchor (the picture ahead of the audio clock) is taken and the players are told', async () => {
			const r = await run([{ frame: 20, delta: -0.2 }]);
			expect(r.changed).toEqual([20]);
			expect(r.anchors.at(-1)).toBe(-0.2);
			expect(r.advanced).toEqual([]);
		});
	},
);
