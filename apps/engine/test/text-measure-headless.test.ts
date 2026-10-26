// spec 13 SH-004: the engine's headless text measurer — measuring rounds, the cache (independent of font ids, which
// a transaction creating its font draws anew every round), failures leaving estimates, the off switch. The browser
// page is faked here; text-paint-export.e2e.test.ts measures in the real render browser.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	applyTransaction,
	type Clip,
	createEmptyProject,
	createRandomIdSource,
	defaultRegistries,
	type TextMeasurer,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { HeadlessTextMeasurer, headlessTextMeasureEnabled } from '../src/fonts/text-measure.ts';

type Job = { content: { text: string; style: { sizePx: number } }; faces: { url: string }[] };

function fakeDeps(o: { fail?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-tm-'));
	writeFileSync(join(dir, 'index.html'), '<!doctype html>');
	const fontFile = join(dir, 'face.woff2');
	writeFileSync(fontFile, 'x');
	const calls: Job[][] = [];
	let opened = 0;
	const deps = {
		remotion: {
			serveUrl: async () => dir,
			openSharedBrowser: async () => {
				opened++;
				if (o.fail) throw new Error('no browser here');
				return {
					instance: {
						newPage: async () => ({
							setViewport: async () => undefined,
							goto: async () => undefined,
							evaluate: async (_fn: unknown, json: string) => {
								const jobs = JSON.parse(json) as Job[];
								calls.push(jobs);
								return jobs.map((j) => ({
									width: j.content.text.length * j.content.style.sizePx * 0.5,
									height: 120,
								}));
							},
						}),
					},
					close: async () => undefined,
				};
			},
		} as never,
		fonts: {
			resolve: () => ({ url: '/fonts/x/face.woff2', family: 'X', fallback: false }),
			filePath: () => fontFile,
		} as never,
	};
	return { deps, calls, opened: () => opened };
}

/** A transaction that creates its font (a new font id every run) and a text clip. */
function run(m: TextMeasurer) {
	const ids = createRandomIdSource();
	const doc = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		doc,
		{
			label: 't',
			origin: 'user',
			sequenceId: Object.keys(doc.sequences)[0]!,
			commands: [
				{
					type: 'clip.addText',
					at: 0,
					duration: 30,
					track: 'V1',
					content: { text: 'Hello', style: { sizePx: 100 } },
				},
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries(), textMeasurer: m },
	);
	if (!result.ok) throw new Error('tx');
	return Object.values(Object.values(document.sequences)[0]!.clips)[0] as Extract<Clip, { kind: 'text' }>;
}

describe('headless text measurer (spec 13 SH-004)', () => {
	it('measures what a transaction misses and runs it again; a second transaction hits the cache', async () => {
		const f = fakeDeps();
		const m = new HeadlessTextMeasurer({ ...f.deps, enabled: true });
		const clip = await m.apply(run);
		expect(clip.layoutPending).toBeUndefined();
		expect(clip.box).toMatchObject({ width: 250, height: 120 });
		expect(f.calls).toHaveLength(1);
		const again = await m.apply(run);
		expect(again.box.width).toBe(250);
		expect(f.calls).toHaveLength(1);
		expect(f.opened()).toBe(1);
		await m.close();
	});

	it('no browser, or switched off: the estimate stays, marked layoutPending', async () => {
		const f = fakeDeps({ fail: true });
		const m = new HeadlessTextMeasurer({ ...f.deps, enabled: true });
		expect((await m.apply(run)).layoutPending).toBe(true);
		await m.close();
		const off = new HeadlessTextMeasurer({ ...fakeDeps().deps, enabled: false });
		expect((await off.apply(run)).layoutPending).toBe(true);
		expect(headlessTextMeasureEnabled({ JASPER_TEXT_MEASURE: 'off' })).toBe(false);
		expect(headlessTextMeasureEnabled({ VITEST: 'true' })).toBe(false);
		expect(headlessTextMeasureEnabled({ VITEST: 'true', JASPER_TEXT_MEASURE: 'on' })).toBe(true);
		expect(headlessTextMeasureEnabled({})).toBe(true);
	});
});
