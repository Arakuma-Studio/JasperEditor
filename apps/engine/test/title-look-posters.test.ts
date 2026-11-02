// Spec 19 TL-087: posters come from the render path, are cached by content, render once per key, and a request nobody
// waits for stops. The renderer is a stand-in here (it records what it was asked); `title-look-posters.e2e.test.ts`
// draws a real one.
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LookPosterRequest } from '@jasper/api';
import { LookPosterRequestSchema } from '@jasper/api';
import { afterEach, describe, expect, it } from 'vitest';
import { JobError } from '../src/jobs/types.ts';
import {
	LookPosterService,
	lookPosterDocument,
	lookPosterKey,
	posterTextSize,
} from '../src/title-looks/posters.ts';

const recipe = {
	palette: { face: [1, 0.8, 0.2, 1] },
	layers: [{ type: 'rim', params: { width: 8 } }, { type: 'face' }],
};
const req = (over: Partial<LookPosterRequest> = {}): LookPosterRequest =>
	LookPosterRequestSchema.parse({ recipe, text: 'Aa Title', ...over });

type Call = { output: string; signal: AbortSignal; props: Record<string, unknown>; finish(): void };

function fakeRemotion(opts: { hold?: boolean; fail?: unknown } = {}) {
	const calls: Call[] = [];
	const browsers = { opened: 0, closed: 0 };
	return {
		calls,
		browsers,
		remotion: {
			async openSharedBrowser() {
				browsers.opened++;
				return {
					instance: {} as never,
					close: async () => {
						browsers.closed++;
					},
				};
			},
			renderStill(input: {
				inputProps: Record<string, unknown>;
				output: string;
				signal: AbortSignal;
			}): Promise<void> {
				return new Promise<void>((resolve, reject) => {
					const finish = () => {
						if (opts.fail) return reject(opts.fail);
						writeFileSync(input.output, 'png');
						resolve();
					};
					calls.push({ output: input.output, signal: input.signal, props: input.inputProps, finish });
					input.signal.addEventListener('abort', () => reject(new JobError('JOB_CANCELLED', 'Cancelled')));
					if (!opts.hold) finish();
				});
			},
		},
	};
}

const services: LookPosterService[] = [];
const dirs: string[] = [];
function make(remotion: ReturnType<typeof fakeRemotion>['remotion'], browserIdleMs = 5) {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-posters-'));
	dirs.push(dir);
	const s = new LookPosterService({ dir, remotion, resolveFont: () => null, browserIdleMs });
	services.push(s);
	return { s, dir };
}
const ac = () => new AbortController();

afterEach(async () => {
	for (const s of services.splice(0)) await s.close();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('look posters (TL-087)', () => {
	it('keys by content: key order does not matter, any visible difference does', () => {
		const a = lookPosterKey(req());
		const reordered = {
			layers: recipe.layers.map((l) => ({ params: l.params, type: l.type })),
			palette: recipe.palette,
		};
		expect(lookPosterKey(req({ recipe: reordered }))).toBe(a);
		expect(lookPosterKey(req({ text: 'Other' }))).not.toBe(a);
		expect(lookPosterKey(req({ width: 360 }))).not.toBe(a);
		expect(lookPosterKey(req({ palette: { face: [0, 0, 1, 1] } }))).not.toBe(a);
		expect(lookPosterKey(req({ font: { family: 'Inter' } }))).not.toBe(a);
	});

	it('applies the look with the same commands as a person, on the requested text', () => {
		const { doc, sequenceId } = lookPosterDocument(req({ palette: { face: [0, 1, 0, 1] } }));
		const clips = Object.values(doc.sequences[sequenceId]!.clips) as unknown as {
			kind: string;
			content?: { text: string };
			effects?: { effectId: string; appearance?: { palette: { face?: { value: number[] } } } }[];
		}[];
		const title = clips.find((c) => c.kind === 'text')!;
		expect(title.content!.text).toBe('Aa Title');
		const fx = title.effects!.find((e) => e.effectId === 'jasper.title-look')!;
		expect(fx.appearance!.palette.face!.value).toEqual([0, 1, 0, 1]);
		expect(doc.sequences[sequenceId]!.settings.width).toBe(240);
		expect(doc.sequences[sequenceId]!.settings.height).toBe(136);
	});

	it('refuses an unusable recipe with its command code, without rendering', async () => {
		const f = fakeRemotion();
		const { s } = make(f.remotion);
		const bad = req({ recipe: { layers: [{ type: 'no-such-layer' }] } });
		await expect(s.poster(bad, ac().signal)).rejects.toMatchObject({ code: 'E_INVALID_PARAM' });
		const huge = req({ recipe: { layers: Array.from({ length: 25 }, () => ({ type: 'face' })) } });
		await expect(s.poster(huge, ac().signal)).rejects.toMatchObject({ code: 'E_LIMIT' });
		expect(f.calls).toHaveLength(0);
	});

	it('renders once, then answers from disk', async () => {
		const f = fakeRemotion();
		const { s } = make(f.remotion);
		const first = await s.poster(req(), ac().signal);
		expect(first.cached).toBe(false);
		expect(existsSync(first.file)).toBe(true);
		const second = await s.poster(req(), ac().signal);
		expect(second).toEqual({ file: first.file, cached: true });
		expect(f.calls).toHaveLength(1);
		expect(readdirSync(dirname(first.file))).toEqual(['poster.png']);
	});

	it('shares one render between clients asking at the same time', async () => {
		const f = fakeRemotion({ hold: true });
		const { s } = make(f.remotion);
		const a = s.poster(req(), ac().signal);
		const b = s.poster(req(), ac().signal);
		await expect.poll(() => f.calls.length).toBe(1);
		f.calls[0]!.finish();
		const [x, y] = await Promise.all([a, b]);
		expect(x.file).toBe(y.file);
		expect(f.calls).toHaveLength(1);
	});

	it('runs at most two renders and starts the next when one ends', async () => {
		const f = fakeRemotion({ hold: true });
		const { s } = make(f.remotion);
		const all = ['a', 'b', 'c'].map((text) => s.poster(req({ text }), ac().signal));
		await expect.poll(() => f.calls.length).toBe(2);
		await new Promise((r) => setTimeout(r, 10));
		expect(f.calls).toHaveLength(2);
		f.calls[0]!.finish();
		await expect.poll(() => f.calls.length).toBe(3);
		f.calls[1]!.finish();
		f.calls[2]!.finish();
		await Promise.all(all);
	});

	it('drops a queued request nobody waits for, without rendering it', async () => {
		const f = fakeRemotion({ hold: true });
		const { s } = make(f.remotion);
		const held = ['a', 'b'].map((text) => s.poster(req({ text }), ac().signal));
		await expect.poll(() => f.calls.length).toBe(2);
		const c = ac();
		const queued = s.poster(req({ text: 'c' }), c.signal);
		c.abort();
		await expect(queued).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		f.calls[0]!.finish();
		f.calls[1]!.finish();
		await Promise.all(held);
		await new Promise((r) => setTimeout(r, 10));
		expect(f.calls).toHaveLength(2);
	});

	it('cancels a running render when the last client leaves, leaving no file', async () => {
		const f = fakeRemotion({ hold: true });
		const { s } = make(f.remotion);
		const c = ac();
		const p = s.poster(req(), c.signal);
		await expect.poll(() => f.calls.length).toBe(1);
		c.abort();
		await expect(p).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		await expect.poll(() => f.calls[0]!.signal.aborted).toBe(true);
		expect(existsSync(s.fileOf(lookPosterKey(req())))).toBe(false);
	});

	it('keeps rendering while another client still waits', async () => {
		const f = fakeRemotion({ hold: true });
		const { s } = make(f.remotion);
		const left = ac();
		const a = s.poster(req(), left.signal);
		const b = s.poster(req(), ac().signal);
		await expect.poll(() => f.calls.length).toBe(1);
		left.abort();
		await expect(a).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		expect(f.calls[0]!.signal.aborted).toBe(false);
		f.calls[0]!.finish();
		expect((await b).cached).toBe(false);
	});

	it('propagates a render failure and removes the partial; the next request renders again', async () => {
		const failing = fakeRemotion({ fail: new JobError('RENDER_FAILED', 'boom', true) });
		const { s, dir } = make(failing.remotion);
		await expect(s.poster(req(), ac().signal)).rejects.toMatchObject({ code: 'RENDER_FAILED' });
		const leftovers = readdirSync(join(dir, lookPosterKey(req())));
		expect(leftovers).toEqual([]);
		expect(failing.calls).toHaveLength(1);
		await expect(s.poster(req(), ac().signal)).rejects.toMatchObject({ code: 'RENDER_FAILED' });
		expect(failing.calls).toHaveLength(2);
	});

	it('treats an empty render as a failure, never as a poster', async () => {
		const f = fakeRemotion();
		f.remotion.renderStill = async (input) => writeFileSync(input.output, '');
		const { s } = make(f.remotion);
		await expect(s.poster(req(), ac().signal)).rejects.toMatchObject({ code: 'RENDER_FAILED' });
		expect(existsSync(s.fileOf(lookPosterKey(req())))).toBe(false);
	});

	it('shares one render browser across a burst and closes it when idle', async () => {
		const f = fakeRemotion();
		const { s } = make(f.remotion);
		await Promise.all(['a', 'b', 'c'].map((text) => s.poster(req({ text }), ac().signal)));
		expect(f.browsers.opened).toBe(1);
		await expect.poll(() => f.browsers.closed).toBe(1);
		await s.poster(req({ text: 'd' }), ac().signal);
		expect(f.browsers.opened).toBe(2);
	});

	it('stops what waits at shutdown', async () => {
		const f = fakeRemotion({ hold: true });
		const { s } = make(f.remotion);
		const all = ['a', 'b', 'c'].map((text) => s.poster(req({ text }), ac().signal));
		await expect.poll(() => f.calls.length).toBe(2);
		await s.close();
		for (const r of await Promise.allSettled(all)) expect(r.status).toBe('rejected');
	});

	it('fits the sample text on one line', () => {
		expect(posterTextSize('Aa', 240, 135)).toBe(43);
		expect(posterTextSize('A long title typed by somebody', 240, 135)).toBeLessThanOrEqual(11);
		expect(posterTextSize('x'.repeat(160), 240, 135)).toBe(8);
	});
});

describe('POST /api/title-looks/poster (TL-087)', () => {
	it('validates the body at the entry point', () => {
		expect(LookPosterRequestSchema.safeParse({ recipe, text: '' }).success).toBe(false);
		expect(LookPosterRequestSchema.safeParse({ recipe, text: 'x', width: 13 }).success).toBe(false);
		expect(LookPosterRequestSchema.safeParse({ recipe, text: 'x'.repeat(161) }).success).toBe(false);
		expect(LookPosterRequestSchema.safeParse({ recipe, text: 'x', stray: 1 }).success).toBe(false);
	});
});
