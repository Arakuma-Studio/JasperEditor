// Layer-bake planning, cache retention and HTTP contracts (S11 §6). Rendered output is checked by the
// opt-in layer-bake E2E tests.
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RenderPlanSchema } from '@jasper/api';
import {
	buildRenderSnapshot,
	LUMETRI_EFFECT_ID,
	type ProjectDocument,
	type RenderSnapshot,
	type RenderVisualClip,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanCapabilities, PlannedExport } from '../src/export/planner.ts';
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

/** Adds a clip copied from the v4 fixture (shape / anime template: their commands land with other packages). */
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
	return o.id;
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
		colorTags: 'rec709',
	},
	...extra,
});

/** A small, centred title (its box fits a crop rect). */
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
		// Keyframes on Motion, opacity or an effect param make it a master.
		d.tx([
			{ type: 'param.setAnimated', target: ['clip', t, 'opacity'], animated: true, at: { sequenceFrame: 0 } },
		]);
		s = snapOf(d);
		expect(isStaticLayer(clipOf(s, t))).toBe(false);
		// Text animators (even with presets the catalogue does not know yet).
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
		// Keyframed shape props (deep scan of the source).
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

	async function keyOfClip(d: DocBuilder, id: string, env = ENV, frame?: number): Promise<string> {
		const p = await planned(d);
		return (await svc.planBake(p, clipOf(p.snapshot, id), { env, ...(frame !== undefined ? { frame } : {}) }))
			.key;
	}

	it('changes with text, font, bundle, anime.js, Remotion, browser and GL; not with time or duration', async () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Title', { at: 10, track: 'V1' });
		const k0 = await keyOfClip(d, t);
		expect(k0).toMatch(/^[0-9a-f]{40}$/);
		// Moving the static title in time and trimming it hit the cache.
		d.tx([{ type: 'clip.move', clipIds: [t], deltaFrames: 25 }]);
		expect(await keyOfClip(d, t)).toBe(k0);
		d.tx([{ type: 'clip.trim', clipId: t, edge: 'out', deltaFrames: -10 }]);
		expect(await keyOfClip(d, t)).toBe(k0);
		// Content and font.
		d.tx([{ type: 'clip.update', clipIds: [t], patch: { content: { text: 'Other' } } }]);
		const k1 = await keyOfClip(d, t);
		expect(k1).not.toBe(k0);
		d.tx([{ type: 'clip.update', clipIds: [t], patch: { content: { style: { weight: 700 } } } }]);
		const k2 = await keyOfClip(d, t);
		expect(k2).not.toBe(k1);
		// Environment.
		for (const change of [
			{ bundleId: 'b2' },
			{ animejs: '4.5.1' },
			{ remotion: '4.0.500' },
			{ browser: 'other' },
			{ gl: 'angle' },
		])
			expect(await keyOfClip(d, t, { ...ENV, ...change })).not.toBe(k2);
	});

	it('identical titles share a bake unless they are seeded by their clip id (text animators, anime templates)', async () => {
		const d = new DocBuilder('hd-720p-30');
		const a = smallTitle(d, 'Twin', { at: 0, track: 'V1' });
		const b = smallTitle(d, 'Twin', { at: 0, track: 'V2' });
		// Same content, style, box and Motion: one bake for both.
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
		// Forcing native keeps the hybrid composite.
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

describe('cache, capability and preview route (LBK-021, LBK-030)', () => {
	let app: TestApp;
	let svc: LayerBakeService;
	beforeAll(async () => {
		app = await makeApp();
		svc = app.jasper.services.layerBake as LayerBakeService;
	});
	afterAll(closeApps);

	it('GC removes entries unused for 14 days and keeps the others', async () => {
		const day = 24 * 60 * 60 * 1000;
		const mk = (key: string, lastUsed: Date) => {
			mkdirSync(join(svc.dir, key), { recursive: true });
			writeFileSync(join(svc.dir, key, 'still.png'), 'x');
			writeFileSync(
				join(svc.dir, key, 'meta.json'),
				JSON.stringify({
					kind: 'layer',
					key,
					recipe: 'still',
					createdAt: lastUsed.toISOString(),
					lastUsedAt: lastUsed.toISOString(),
				}),
			);
		};
		const old = 'a'.repeat(40);
		const fresh = 'b'.repeat(40);
		const orphan = 'c'.repeat(40);
		mk(old, new Date(Date.now() - 15 * day));
		mk(fresh, new Date(Date.now() - 13 * day));
		mkdirSync(join(svc.dir, orphan), { recursive: true });
		const t = (Date.now() - 15 * day) / 1000;
		utimesSync(join(svc.dir, orphan), t, t);
		await svc.gc();
		expect(existsSync(join(svc.dir, old))).toBe(false);
		expect(existsSync(join(svc.dir, orphan))).toBe(false);
		expect(existsSync(join(svc.dir, fresh, 'still.png'))).toBe(true);
		// Lookups mark entries as used; the files route serves them.
		expect(await svc.lookup(fresh)).toMatchObject({ still: true, path: join(svc.dir, fresh, 'still.png') });
		const r = await app.inject({
			method: 'GET',
			url: `/mg/layers/${fresh}/still.png`,
			headers: { host: '127.0.0.1:47900' },
		});
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toBe('image/png');
		const bad = await app.inject({
			method: 'GET',
			url: `/mg/layers/${fresh}/meta.json`,
			headers: { host: '127.0.0.1:47900' },
		});
		expect(bad.statusCode).toBe(404);
	});

	it('GC keeps leased entries and entries a lookup marks used meanwhile (review fix 4)', async () => {
		const mk = (key: string, lastUsed: Date) => {
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
		};
		const longAgo = () => new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
		// A lease (a running job reading the entry) keeps it; released, the next pass removes it.
		const held = 'd'.repeat(40);
		mk(held, longAgo());
		const release = svc.lease([held]);
		await svc.gc();
		expect(existsSync(join(svc.dir, held, 'still.png'))).toBe(true);
		release();
		release();
		await svc.gc();
		expect(existsSync(join(svc.dir, held))).toBe(false);
		// `lookup` has written `lastUsedAt` when it returns.
		const used = 'e'.repeat(40);
		mk(used, longAgo());
		expect(await svc.lookup(used)).not.toBeNull();
		await svc.gc();
		expect(existsSync(join(svc.dir, used, 'still.png'))).toBe(true);
		// A lookup racing a GC pass either keeps the entry or misses (never returns a path the GC removes).
		const racing = 'f'.repeat(40);
		mk(racing, longAgo());
		const [, hit] = await Promise.all([svc.gc(), svc.lookup(racing)]);
		if (hit) {
			expect(existsSync(hit.path)).toBe(true);
		} else expect(existsSync(join(svc.dir, racing, 'still.png'))).toBe(false);
	});

	it('graded masters are PNG frame sequences served per frame under one signed URL (review fix 1)', async () => {
		const key = '2'.repeat(40);
		mkdirSync(join(svc.dir, key, 'graded'), { recursive: true });
		for (const n of [0, 1]) writeFileSync(join(svc.dir, key, 'graded', `00000${n}.png`), `frame ${n}`);
		const get = (q: string) =>
			app.inject({
				method: 'GET',
				url: `/mg/layers/${key}/graded.png${q}`,
				headers: { host: '127.0.0.1:47900' },
			});
		const r1 = await get('?n=1');
		expect(r1.statusCode).toBe(200);
		expect(r1.headers['content-type']).toBe('image/png');
		expect(r1.body).toBe('frame 1');
		expect((await get('')).body).toBe('frame 0');
		for (const bad of ['?n=2', '?n=-1', '?n=1.5', '?n=x']) expect((await get(bad)).statusCode).toBe(404);
		// A frame number can be appended to the entry's signed URL.
		const signed = coreServices(app).signer.signUrl('', `/mg/layers/${key}/graded.png`);
		expect((await get(`${signed.slice(signed.indexOf('?'))}&n=1`)).body).toBe('frame 1');
	});

	it('features.layerBake reports readiness and the cache size', async () => {
		await svc.refreshBytes();
		const caps = (
			await app.inject({ method: 'GET', url: '/api/capabilities', headers: { host: '127.0.0.1:47900' } })
		).json();
		expect(caps.features.layerBake).toMatchObject({ cacheBytes: expect.any(Number) });
		expect(['ready', 'unavailable']).toContain(caps.features.layerBake.state);
	});

	it('POST /api/layer-bake/preview validates the request and the clip', async () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Plain', { at: 0, track: 'V1' });
		const post = (body: unknown) =>
			app.inject({ method: 'POST', url: '/api/layer-bake/preview', headers: JSON_H, payload: body as never });
		expect((await post({ clipId: t })).statusCode).toBe(400);
		const base = { envelope: d.envelope(), sequenceId: d.seqId };
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
