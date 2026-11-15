import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { RenderPlanSchema } from '@jasper/api';
import {
	buildRenderSnapshot,
	LUMETRI_EFFECT_ID,
	type ProjectDocument,
	type RenderSnapshot,
	type RenderVisualClip,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanCapabilities, PlannedExport } from '../src/export/planner.ts';
import { layerBakeExtension } from '../src/layer-bake/extension.ts';
import type { BakeEnvironment } from '../src/layer-bake/key.ts';
import { bakeClip, effectRunsOrderWarning, isStaticLayer } from '../src/layer-bake/layer.ts';
import type { LayerBakeService } from '../src/layer-bake/service.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	TEST_HOST,
	type TestApp,
} from './helpers.ts';

const FIXTURE_V4 = join(
	__dirname,
	'..',
	'..',
	'..',
	'packages',
	'project',
	'test',
	'fixtures',
	'v4',
	'basic.jasper',
);
const v4 = JSON.parse(readFileSync(FIXTURE_V4, 'utf8')).document as ProjectDocument;
const v4seq = Object.values(v4.sequences)[0]!;
const ANIME_CLIP = v4seq.clips.clp_VEYXW57CH91ZEK52 as unknown as Record<string, unknown>;
const SHAPE_CLIP = v4seq.clips.clp_3ZN7BJXAHGY9J4G2 as unknown as Record<string, unknown>;

function inject(
	d: DocBuilder,
	clip: Record<string, unknown>,
	o: { id: string; track: string; start: number },
) {
	const seq = d.doc.sequences[d.seqId]!;
	const c = { ...structuredClone(clip), id: o.id, trackId: d.track(o.track), start: o.start };
	d.doc = {
		...d.doc,
		sequences: { ...d.doc.sequences, [d.seqId]: { ...seq, clips: { ...seq.clips, [o.id]: c as never } } },
	};
	d.revision++;
}

function snapOf(d: DocBuilder): RenderSnapshot {
	return buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null });
}

function clipOf(snap: RenderSnapshot, id: string): RenderVisualClip {
	return snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === id)!;
}

const ENV: BakeEnvironment = {
	bundleId: 'b1',
	animejs: '4.5.0',
	remotion: '4.0.499',
	browser: '/usr/bin/chrome|1|1',
	gl: 'swangle',
};

const CAPS: PlanCapabilities = {
	native: true,
	remotionLocal: 'ready',
	fframes: 'unavailable',
	mgMasters: false,
};

const settings = (seqId: string, extra: Record<string, unknown> = {}) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'auto',
	video: {
		codec: 'h264',
		width: 1280,
		height: 720,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 20 },
		encoderSpeed: 'fast',
	},
	...extra,
});

function smallTitle(d: DocBuilder, text: string, o: { at: number; track: string; duration?: number }) {
	return d.tx([
		{
			type: 'clip.addText',
			at: o.at,
			duration: o.duration ?? 30,
			track: o.track,
			content: { text },
			box: { width: 300, height: 80, autoSize: 'none' },
			ref: '$t',
		},
	]).refs.$t!;
}

describe('DOM layers and static detection (LBK-001, LBK-004)', () => {
	it('static = no animator, no keyframes anywhere, no anime template, no unknown effect', () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Still', { at: 0, track: 'V1' });
		inject(d, ANIME_CLIP, { id: 'clp_ANIME00000000001', track: 'V2', start: 0 });
		inject(d, SHAPE_CLIP, { id: 'clp_SHAPE00000000001', track: 'V3', start: 0 });
		let s = snapOf(d);
		expect(isStaticLayer(clipOf(s, t))).toBe(true);
		expect(isStaticLayer(clipOf(s, 'clp_SHAPE00000000001'))).toBe(true);
		expect(isStaticLayer(clipOf(s, 'clp_ANIME00000000001'))).toBe(false);
		d.tx([
			{ type: 'param.setAnimated', target: ['clip', t, 'opacity'], animated: true, at: { sequenceFrame: 0 } },
		]);
		s = snapOf(d);
		expect(isStaticLayer(clipOf(s, t))).toBe(false);
		const textClip = clipOf(s, t);
		const withAnim = {
			...textClip,
			opacity: { value: 100, keyframes: [] },
			source: {
				...(textClip.source as object),
				animation: { in: { preset: 'fade', version: 1, params: {}, frames: 10 } },
			},
		} as unknown as RenderVisualClip;
		expect(isStaticLayer(withAnim)).toBe(false);
		const shape = clipOf(s, 'clp_SHAPE00000000001');
		const kf = { id: 'k', time: 0, value: [10, 10], interpolation: 'linear', easeIn: {}, easeOut: {} };
		const keyed = {
			...shape,
			source: {
				shape: { ...(shape.source as { shape: object }).shape, size: { value: [10, 10], keyframes: [kf] } },
			},
		} as unknown as RenderVisualClip;
		expect(isStaticLayer(keyed)).toBe(false);
		// An effect the registry does not know may vary with time.
		const unknown = {
			...shape,
			effects: [{ id: 'fx', effectId: 'x.unknown', effectVersion: 1, enabled: true, params: {} }],
		} as RenderVisualClip;
		expect(isStaticLayer(unknown)).toBe(false);
	});

	it('a keyframed grade does not make a DOM layer a master: colour runs are applied by ffmpeg (LBK-010)', () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Graded', { at: 0, track: 'V1' });
		d.tx([
			{
				type: 'effect.add',
				target: { clipId: t },
				effectId: LUMETRI_EFFECT_ID,
				params: { saturation: 0 },
				ref: '$g',
			},
		]);
		const clip = clipOf(snapOf(d), t);
		const fx = clip.effects[0]!;
		const keyed = {
			...clip,
			effects: [
				{
					...fx,
					params: {
						...fx.params,
						exposure: {
							value: 0,
							keyframes: [
								{ id: 'a', time: 0, value: 0, interpolation: 'linear', easeIn: {}, easeOut: {} },
								{ id: 'b', time: 1e9, value: 1, interpolation: 'linear', easeIn: {}, easeOut: {} },
							],
						},
					},
				},
			],
		} as unknown as RenderVisualClip;
		const baked = bakeClip(keyed, { variant: { recipe: 'master' }, stripColor: true });
		expect(baked.effects).toEqual([]);
		expect(isStaticLayer(baked)).toBe(true);
	});
});

describe('render keys (LBK-020)', () => {
	let app: TestApp;
	let svc: LayerBakeService;
	beforeAll(async () => {
		app = await makeApp();
		svc = app.jasper.services.layerBake as LayerBakeService;
	});
	afterAll(closeApps);

	async function planned(d: DocBuilder): Promise<PlannedExport> {
		return coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
	}

	async function keyOfClip(d: DocBuilder, id: string, env = ENV): Promise<string> {
		const p = await planned(d);
		return (await svc.planBake(p, clipOf(p.snapshot, id), { env })).key;
	}

	it('changes with text, font, bundle, anime.js, Remotion, browser and GL; not with time or duration', async () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Title', { at: 10, track: 'V1' });
		const k0 = await keyOfClip(d, t);
		expect(k0).toMatch(/^[0-9a-f]{40}$/);
		d.tx([{ type: 'clip.move', clipIds: [t], deltaFrames: 25 }]);
		expect(await keyOfClip(d, t)).toBe(k0);
		d.tx([{ type: 'clip.trim', clipId: t, edge: 'out', deltaFrames: -10 }]);
		expect(await keyOfClip(d, t)).toBe(k0);
		d.tx([{ type: 'clip.update', clipIds: [t], patch: { content: { text: 'Other' } } }]);
		const k1 = await keyOfClip(d, t);
		expect(k1).not.toBe(k0);
		d.tx([{ type: 'clip.update', clipIds: [t], patch: { content: { style: { weight: 700 } } } }]);
		const k2 = await keyOfClip(d, t);
		expect(k2).not.toBe(k1);
		for (const change of [
			{ bundleId: 'b2' },
			{ animejs: '4.5.1' },
			{ remotion: '4.0.500' },
			{ browser: 'other' },
			{ gl: 'angle' },
		])
			expect(await keyOfClip(d, t, { ...ENV, ...change })).not.toBe(k2);
	});

	it('an export composited at its output size bakes masters at it: the scale is in the key, the rect on whole output pixels', async () => {
		const d = new DocBuilder('hd-1080p-30');
		inject(d, ANIME_CLIP, { id: 'clp_ANIME00000000009', track: 'V1', start: 0 });
		const p = await planned(d);
		const clip = clipOf(p.snapshot, 'clp_ANIME00000000009');
		const full = await svc.planBake(p, clip, { env: ENV });
		const small = await svc.planBake(p, clip, { env: { ...ENV, scale: 2 / 3 } });
		expect(full.variant.recipe).toBe('master');
		expect(full.material.scale).toBeUndefined();
		expect(small.material.scale).toBe(2 / 3);
		expect(small.key).not.toBe(full.key);
		for (const v of Object.values(small.rect ?? { x: 0, y: 0, w: 1920, h: 1080 })) {
			expect(v % 2, `rect ${JSON.stringify(small.rect)}`).toBe(0);
			expect(Number.isInteger((v * 2) / 3), `rect ${JSON.stringify(small.rect)}`).toBe(true);
		}
	});

	it('identical titles share a bake unless a text animation or shader seeds them by clip id', async () => {
		const d = new DocBuilder('hd-720p-30');
		const a = smallTitle(d, 'Twin', { at: 0, track: 'V1' });
		const b = smallTitle(d, 'Twin', { at: 0, track: 'V2' });
		expect(await keyOfClip(d, a)).toBe(await keyOfClip(d, b));
		// With a text animator (random unit order uses hash32(clipId), S11:ANM-007) the keys differ; the animator's
		// params and compressed window lengths are part of the key too.
		const seq = d.doc.sequences[d.seqId]!;
		const anim = (order: string, frames = 10) => ({
			in: { preset: 'fade', version: 1, durationFrames: frames, params: { order } },
		});
		const withAnim = (o: string, frames?: number) => {
			d.doc = {
				...d.doc,
				sequences: {
					...d.doc.sequences,
					[d.seqId]: {
						...seq,
						clips: {
							...seq.clips,
							[a]: { ...seq.clips[a]!, textAnimation: anim(o, frames) } as never,
							[b]: { ...seq.clips[b]!, textAnimation: anim(o, frames) } as never,
						},
					},
				},
			};
			d.revision++;
		};
		withAnim('random');
		const ka = await keyOfClip(d, a);
		expect(ka).not.toBe(await keyOfClip(d, b));
		withAnim('forward');
		expect(await keyOfClip(d, a)).not.toBe(ka);
		const kf = await keyOfClip(d, a);
		withAnim('forward', 12);
		expect(await keyOfClip(d, a)).not.toBe(kf);
		// Shader noise also depends on clip id, even when the source and effect instance are unchanged.
		const shader = new DocBuilder('hd-720p-30');
		const x = smallTitle(shader, 'Noise', { at: 0, track: 'V1' });
		shader.tx([
			{ type: 'effect.add', target: { clipId: x }, effectId: 'jasper.noise', params: { amount: 10 } },
		]);
		const p = await planned(shader);
		const source = clipOf(p.snapshot, x);
		const first = await svc.planBake(p, source, { env: ENV });
		const renamed = await svc.planBake(p, { ...source, clipId: b }, { env: ENV });
		expect(renamed.key).not.toBe(first.key);
	});

	it('another title using a different font weight does not invalidate this title’s bake', async () => {
		// Another weight of the same font on another title must not invalidate this title's bake.
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Regular', { at: 0, track: 'V1' });
		const k0 = await keyOfClip(d, t);
		const b = smallTitle(d, 'Bold', { at: 0, track: 'V2' });
		d.tx([{ type: 'clip.update', clipIds: [b], patch: { content: { style: { weight: 700 } } } }]);
		const p = await planned(d);
		expect(p.snapshot.fonts.length).toBeGreaterThan(1);
		expect(await keyOfClip(d, t)).toBe(k0);
	});
});

describe('planner (LBK-002, LBK-024)', () => {
	let app: TestApp;
	beforeAll(async () => {
		ensureFixtures();
		app = await makeApp();
	}, 600_000);
	afterAll(closeApps);

	it('footage with text, shape and anime layers has a hybrid export plan', async () => {
		const clipA = await register(app, fixture('clip-a.mp4'));
		const d = new DocBuilder('hd-720p-30');
		const a = d.addMedia(clipA);
		d.tx([{ type: 'clip.place', source: { mediaId: a }, at: 0 }]);
		const t = smallTitle(d, 'Title', { at: 0, track: 'V2' });
		d.tx([
			{ type: 'track.add', kind: 'video' },
			{ type: 'track.add', kind: 'video' },
		]);
		inject(d, SHAPE_CLIP, { id: 'clp_SHAPE00000000001', track: 'V3', start: 0 });
		inject(d, ANIME_CLIP, { id: 'clp_ANIME00000000001', track: 'V4', start: 0 });
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		const plan = RenderPlanSchema.parse(r.json());
		expect(plan.blockers).toEqual([]);
		expect(plan.path).toBe('hybrid');
		expect(plan.audio.mode).toBe('native-mix');
		expect(plan.segments[0]!.mode).toBe('mixed');
		const groups = plan.segments[0]!.graphicsGroups;
		expect(groups.every((g) => g.engine === 'remotion')).toBe(true);
		expect(groups.flatMap((g) => g.itemIds).sort()).toEqual(
			['clp_ANIME00000000001', 'clp_SHAPE00000000001', t].sort(),
		);
		const forced = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId, { engine: 'native' }),
			},
		});
		expect(forced.json().path).toBe('hybrid');
	});

	it('a forced native plan rejects a graphics layer when Remotion is unavailable', async () => {
		const d = new DocBuilder('hd-720p-30');
		smallTitle(d, 'Title', { at: 0, track: 'V1' });
		const unavailable = await makeApp({
			dev: false,
			env: { JASPER_REMOTION_BIN_DIR: '/nonexistent/remotion-binaries' },
		});
		const r = await unavailable.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId, { engine: 'native' }),
			},
		});
		expect(r.statusCode).toBe(409);
		expect(r.json().code).toBe('PATH_NOT_ELIGIBLE');
	});

	it('`needs-browser-download` is not a blocker (warning BROWSER_DOWNLOAD)', async () => {
		const d = new DocBuilder('hd-720p-30');
		smallTitle(d, 'Title', { at: 0, track: 'V1' });
		const { planExport } = await import('../src/export/planner.ts');
		const core = coreServices(app);
		const p = await planExport(
			{ envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) as never },
			{
				registry: core.registry,
				fonts: core.fonts,
				capabilities: { ...CAPS, remotionLocal: 'needs-browser-download' },
				extensions: core.exports.nativeExtensions.all(),
			},
		);
		expect(p.plan.path).toBe('hybrid');
		expect(p.plan.warnings.map((w) => w.code)).toContain('BROWSER_DOWNLOAD');
	});

	it('warns when a colour effect precedes a pixel-mixing effect on a DOM layer', () => {
		const clip = {
			name: 'T',
			effects: [
				{ id: 'a', effectId: LUMETRI_EFFECT_ID, effectVersion: 1, enabled: true, params: {} },
				{ id: 'b', effectId: 'jasper.gaussian-blur', effectVersion: 1, enabled: true, params: {} },
			],
		} as unknown as RenderVisualClip;
		expect(effectRunsOrderWarning(clip)).not.toBeNull();
		expect(effectRunsOrderWarning({ ...clip, effects: [...clip.effects].reverse() })).toBeNull();
	});
});

describe('shared render browsers (S11:LBK-022)', () => {
	afterAll(closeApps);

	it('a native export bakes as many titles at once as its CPU slots allow: 12 in flight with 2 pages each on 24', async () => {
		// the real project's bake: 17 animated title cards of 363 frames
		const clips = Array.from(
			{ length: 17 },
			(_, i) =>
				({
					clipId: `card${i}`,
					name: `Card ${i}`,
					kind: 'text',
					engine: 'remotion',
					effects: [],
					masks: [],
					trackId: 'V2',
					start: i * 400,
					duration: 363,
				}) as unknown as RenderVisualClip,
		);
		const planned = {
			range: { start: 0, end: 17 * 400 },
			snapshot: { videoTracks: [{ trackId: 'V2', clips }] },
		} as unknown as PlannedExport;
		let inFlight = 0;
		let most = 0;
		const pages: number[] = [];
		const svc = {
			unavailableReason: () => null,
			environment: async () => ({}),
			parallelism: { maxInFlight: null, sharedBrowser: false, pagesPerBrowser: 2 },
			stats: { rendered: 0, reused: 0, joined: 0 },
			planBake: async (_p: unknown, clip: RenderVisualClip) => ({
				clipId: clip.clipId,
				clipName: clip.name,
				key: `key-${clip.clipId}`,
				variant: { recipe: 'master' },
				rect: null,
				frames: 363,
				startFrame: clip.start,
				colorRuns: false,
				material: {},
			}),
			lookup: async () => null,
			ensureBake: async (plan: { key: string }, meta: { concurrency?: number }) => {
				pages.push(meta.concurrency ?? 0);
				most = Math.max(most, ++inFlight);
				await setImmediate();
				inFlight--;
				return {
					key: plan.key,
					path: '/bake.mov',
					still: false,
					rect: null,
					frames: 363,
					width: 1280,
					height: 720,
				};
			},
		} as unknown as LayerBakeService;
		const prepared = await layerBakeExtension(svc).prepare!(planned, {
			signal: new AbortController().signal,
			stage: () => undefined,
			scratchDir: async () => '/tmp',
			log: () => undefined,
			jobId: 'job_bake',
			purpose: 'native',
			concurrency: 12,
			bakePages: 24,
		});
		expect((prepared as Map<string, unknown>).size).toBe(17);
		expect(most).toBe(12);
		expect(pages).toEqual(new Array(17).fill(2));
	});

	it('a browser serves at most pagesPerBrowser pages: more bakes in flight open more browsers, closed with the session', async () => {
		const app = await makeApp();
		const svc = app.jasper.services.layerBake as LayerBakeService;
		const closed: number[] = [];
		let n = 0;
		const open = vi.spyOn(coreServices(app).remotion, 'openSharedBrowser').mockImplementation(async () => {
			const id = n++;
			return {
				instance: { id } as never,
				close: async () => {
					closed.push(id);
				},
			};
		});
		svc.parallelism = { ...svc.parallelism, pagesPerBrowser: 4 };
		const release = svc.browserSession('job_bake');
		const a = svc.acquireBrowser('job_bake', 2)!;
		const b = svc.acquireBrowser('job_bake', 2)!;
		const c = svc.acquireBrowser('job_bake', 2)!;
		expect(await b.browser).toBe(await a.browser);
		expect(await c.browser).not.toBe(await a.browser);
		expect(open).toHaveBeenCalledTimes(2);
		// a finished: the next bake joins the least busy browser instead of opening one
		a.release();
		const d = svc.acquireBrowser('job_bake', 2)!;
		expect(await d.browser).toBe(await b.browser);
		expect(open).toHaveBeenCalledTimes(2);
		// no session: the bake opens a browser of its own
		expect(svc.acquireBrowser('job_other', 1)).toBeNull();
		await release();
		expect(closed.sort()).toEqual([0, 1]);
	});
});

describe('cache, capability and preview route (LBK-021, LBK-030)', () => {
	let app: TestApp;
	let svc: LayerBakeService;
	beforeAll(async () => {
		app = await makeApp();
		svc = app.jasper.services.layerBake as LayerBakeService;
		await coreServices(app).cache.start();
	});
	afterAll(closeApps);

	function cacheStill(key: string, lastUsed: Date) {
		mkdirSync(join(svc.dir, key), { recursive: true });
		writeFileSync(join(svc.dir, key, 'still.png'), 'x');
		writeFileSync(
			join(svc.dir, key, 'meta.json'),
			JSON.stringify({
				kind: 'layer',
				key,
				recipe: 'still',
				rect: null,
				frames: 1,
				width: 10,
				height: 10,
				createdAt: lastUsed.toISOString(),
				lastUsedAt: lastUsed.toISOString(),
			}),
		);
		for (const file of ['still.png', 'meta.json', ''])
			utimesSync(join(svc.dir, key, file), lastUsed, lastUsed);
	}

	it('GC removes entries unused for 14 days and keeps the others', async () => {
		const day = 24 * 60 * 60 * 1000;
		const old = 'a'.repeat(40);
		const fresh = 'b'.repeat(40);
		const orphan = 'c'.repeat(40);
		cacheStill(old, new Date(Date.now() - 15 * day));
		cacheStill(fresh, new Date(Date.now() - 13 * day));
		mkdirSync(join(svc.dir, orphan), { recursive: true });
		const t = (Date.now() - 15 * day) / 1000;
		utimesSync(join(svc.dir, orphan), t, t);
		await coreServices(app).cache.clean('auto', ['layers']);
		expect(existsSync(join(svc.dir, old))).toBe(false);
		expect(existsSync(join(svc.dir, orphan))).toBe(false);
		expect(existsSync(join(svc.dir, fresh, 'still.png'))).toBe(true);
		expect(await svc.lookup(fresh)).toMatchObject({ still: true, path: join(svc.dir, fresh, 'still.png') });
		const r = await app.inject({
			method: 'GET',
			url: `/mg/layers/${fresh}/still.png`,
			headers: { host: TEST_HOST },
		});
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toBe('image/png');
		const bad = await app.inject({
			method: 'GET',
			url: `/mg/layers/${fresh}/meta.json`,
			headers: { host: TEST_HOST },
		});
		expect(bad.statusCode).toBe(404);
	});

	it('GC keeps leased entries and entries a lookup marks used meanwhile', async () => {
		const longAgo = () => new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
		// A lease (a running job reading the entry) keeps it; released, the next pass removes it.
		const held = 'd'.repeat(40);
		cacheStill(held, longAgo());
		const release = svc.lease([held]);
		await coreServices(app).cache.clean('auto', ['layers']);
		expect(existsSync(join(svc.dir, held, 'still.png'))).toBe(true);
		release();
		release();
		await coreServices(app).cache.clean('auto', ['layers']);
		expect(existsSync(join(svc.dir, held))).toBe(false);
		const used = 'e'.repeat(40);
		cacheStill(used, longAgo());
		expect(await svc.lookup(used)).not.toBeNull();
		await coreServices(app).cache.clean('auto', ['layers']);
		expect(existsSync(join(svc.dir, used, 'still.png'))).toBe(true);
		// A lookup after GC scans old metadata must keep the entry even though the scan snapshot is stale.
		const racing = 'f'.repeat(40);
		cacheStill(racing, longAgo());
		const cache = coreServices(app).cache;
		const scan = cache.scan.bind(cache);
		const file = join(svc.dir, racing, 'still.png');
		const scanned = vi.spyOn(cache, 'scan').mockImplementationOnce(async (force) => {
			const snapshot = await scan(force);
			expect(await svc.lookup(racing)).toMatchObject({ path: file });
			return snapshot;
		});
		try {
			await cache.clean('auto', ['layers']);
			expect(existsSync(file)).toBe(true);
		} finally {
			scanned.mockRestore();
		}
	});

	it('graded masters are PNG frame sequences served per frame under one signed URL', async () => {
		const key = '2'.repeat(40);
		mkdirSync(join(svc.dir, key, 'graded'), { recursive: true });
		for (const n of [0, 1]) writeFileSync(join(svc.dir, key, 'graded', `00000${n}.png`), `frame ${n}`);
		const get = (q: string) =>
			app.inject({
				method: 'GET',
				url: `/mg/layers/${key}/graded.png${q}`,
				headers: { host: TEST_HOST },
			});
		const r1 = await get('?n=1');
		expect(r1.statusCode).toBe(200);
		expect(r1.headers['content-type']).toBe('image/png');
		expect(r1.body).toBe('frame 1');
		expect((await get('')).body).toBe('frame 0');
		for (const bad of ['?n=2', '?n=-1', '?n=1.5', '?n=x']) expect((await get(bad)).statusCode).toBe(404);
		const signed = coreServices(app).signer.signUrl('', `/mg/layers/${key}/graded.png`);
		expect((await get(`${signed.slice(signed.indexOf('?'))}&n=1`)).body).toBe('frame 1');
	});

	it('POST /api/layer-bake/preview validates the request and the clip', async () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Plain', { at: 0, track: 'V1' });
		const post = (body: unknown) =>
			app.inject({ method: 'POST', url: '/api/layer-bake/preview', headers: JSON_H, payload: body as never });
		const missing = await post({ clipId: t });
		expect(missing.statusCode).toBe(400);
		expect(missing.json().code).toBe('VALIDATION_FAILED');
		const base = { envelope: d.envelope(), sequenceId: d.seqId };
		const invalid = await post({ ...base, clipId: '' });
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json().code).toBe('VALIDATION_FAILED');
		const r404 = await post({ ...base, clipId: 'clp_NOPE00000000000' });
		expect(r404.statusCode).toBe(404);
		const plain = await post({ ...base, clipId: t });
		expect(plain.statusCode).toBe(422);
		expect(plain.json().code).toBe('LAYER_NOT_GRADED');
		d.tx([{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V2', color: [1, 0, 0, 1], ref: '$s' }]);
		const solid = d.clipIds().find((id) => d.doc.sequences[d.seqId]!.clips[id]!.kind === 'solid')!;
		const notDom = await post({ envelope: d.envelope(), sequenceId: d.seqId, clipId: solid });
		expect(notDom.json().code).toBe('NOT_A_GRAPHICS_LAYER');
	});
});
