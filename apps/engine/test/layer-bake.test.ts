// Layer bake (M2, S11 §6): DOM layers, static detection, crop rects, render keys, the planner (`hybrid`, blockers,
// anime templates), the builder (`still`, `rect`, `colorRuns`, GPL scan), the cache (GC, capability), the preview
// route's validation, the usage log, the `auto` fallback to Remotion (LBK-023) and parallel bakes (LBK-022: page
// budget, shared browser, dedupe, abort; renders stubbed). No headless browser: renders are covered by
// layer-bake.e2e.test.ts and layer-bake-parallel.e2e.test.ts (REMOTION_E2E=1).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type EngineJob, RenderPlanSchema } from '@jasper/api';
import { isAnimeTemplate, mgRegistry } from '@jasper/mg-templates';
import {
	buildRenderSnapshot,
	LUMETRI_EFFECT_ID,
	type ProjectDocument,
	type RenderSnapshot,
	type RenderVisualClip,
} from '@jasper/project';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createColorExtension, gplFiltersIn } from '../src/color/extension.ts';
import { buildNativeGraph } from '../src/export/native.ts';
import type { NativeExtension } from '../src/export/native-ext.ts';
import { nativeBlockers, type PlanCapabilities, type PlannedExport } from '../src/export/planner.ts';
import { type LayerBakePrepared, layerBakeExtension } from '../src/layer-bake/extension.ts';
import { type BakeEnvironment, keyOf, normalisedClip } from '../src/layer-bake/key.ts';
import {
	bakeClip,
	bakeDoc,
	clipFonts,
	contentBleed,
	cropRect,
	effectRunsOrderWarning,
	isDomLayer,
	isStaticLayer,
} from '../src/layer-bake/layer.ts';
import { LAYER_CACHE_TTL_MS, type LayerBakeService } from '../src/layer-bake/service.ts';
import { BUNDLE_STAMP_FILE, RemotionService } from '../src/remotion/service.ts';
import { layerBakeService } from '../src/routes/layer-bake.ts';
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
	tempAppdir,
	until,
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
	it('claims every text clip, shapes and anime templates; not fframes templates or media', () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Hi', { at: 0, track: 'V1' });
		inject(d, ANIME_CLIP, { id: 'clp_ANIME00000000001', track: 'V2', start: 0 });
		inject(d, SHAPE_CLIP, { id: 'clp_SHAPE00000000001', track: 'V3', start: 0 });
		const ff = { ...ANIME_CLIP, template: { id: 'lower-third', version: 1 } };
		d.tx([{ type: 'track.add', kind: 'video' }]);
		inject(d, ff, { id: 'clp_FFRAMES00000001', track: 'V4', start: 0 });
		const s = snapOf(d);
		expect(isDomLayer(clipOf(s, t))).toBe(true);
		expect(isDomLayer(clipOf(s, 'clp_ANIME00000000001'))).toBe(true);
		expect(isDomLayer(clipOf(s, 'clp_SHAPE00000000001'))).toBe(true);
		expect(isDomLayer(clipOf(s, 'clp_FFRAMES00000001'))).toBe(false);
	});

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
		expect(isStaticLayer(keyed)).toBe(false);
		const baked = bakeClip(keyed, { variant: { recipe: 'master' }, stripColor: true });
		expect(baked.effects).toEqual([]);
		expect(isStaticLayer(baked)).toBe(true);
	});

	it('normalises the baked clip: span-relative times and fades, one-frame stills, whole-pixel shifts', () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Shift', { at: 40, track: 'V1' });
		const clip = {
			...clipOf(snapOf(d), t),
			headHandle: 5,
			tailHandle: 3,
			fades: [{ type: 'in' as const, start: 34, frames: 12 }],
		};
		const m = bakeClip(clip, { variant: { recipe: 'master' }, stripColor: true });
		expect(m).toMatchObject({
			start: 5,
			headHandle: 5,
			tailHandle: 3,
			fades: [{ type: 'in', start: -1, frames: 12 }],
		});
		const s = bakeClip(clip, { variant: { recipe: 'still' }, stripColor: true });
		expect(s).toMatchObject({ start: 0, duration: 1 });
		expect(s.fades).toBeUndefined();
		expect(s.headHandle).toBeUndefined();
		const sh = bakeClip(clip, { variant: { recipe: 'master' }, stripColor: true, shift: { x: 100, y: 50 } });
		expect(sh.transform!.position.value).toEqual([
			clip.transform!.position.value[0] - 100,
			clip.transform!.position.value[1] - 50,
		]);
		const doc = bakeDoc(snapOf(d), sh, {
			variant: { recipe: 'master' },
			rect: { x: 100, y: 50, w: 400, h: 200 },
			media: {},
			fonts: [],
		});
		expect(doc).toMatchObject({
			settings: { width: 400, height: 200, backgroundColor: [0, 0, 0, 0] },
			range: { start: 0, end: 38 },
			durationFrames: 38,
			audioClips: [],
		});
		const frame = bakeDoc(snapOf(d), m, {
			variant: { recipe: 'frame', frame: 7 },
			rect: null,
			media: {},
			fonts: [],
		});
		expect(frame.range).toEqual({ start: 7, end: 8 });
		expect(frame.settings.width).toBe(1280);
	});
});

describe('crop rect (LBK-005)', () => {
	it('is the union of the per-frame layer bounds plus a 10 % bleed, even-aligned and clamped', () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Box', { at: 0, track: 'V1' });
		const clip = clipOf(snapOf(d), t);
		const seq = { width: 1280, height: 720, fps: { num: 30, den: 1 } };
		const r = cropRect(clip, { f0: 0, f1: 30 }, seq)!;
		// Box 300 × 80 centred at 640, 360; bleed 72 px.
		const p = clip.transform!.position.value;
		const a = clip.transform!.anchor.value;
		const x0 = p[0] - a[0];
		const y0 = p[1] - a[1];
		expect(r.x).toBeLessThanOrEqual(x0 - 72);
		expect(r.y).toBeLessThanOrEqual(y0 - 72);
		expect(r.x + r.w).toBeGreaterThanOrEqual(x0 + 300 + 72);
		expect(r.y + r.h).toBeGreaterThanOrEqual(y0 + 80 + 72);
		expect((r.x % 2) + (r.y % 2) + (r.w % 2) + (r.h % 2)).toBe(0);
		expect(r.w).toBeLessThan(300 + 2 * 72 + 4);
		// Moving across the frame (position keyframes) grows the union.
		d.tx([
			{
				type: 'param.setAnimated',
				target: ['clip', t, 'transform', 'position'],
				animated: true,
				at: { sequenceFrame: 0 },
			},
		]);
		d.tx([
			{
				type: 'param.set',
				target: ['clip', t, 'transform', 'position'],
				value: [300, 200],
				at: { sequenceFrame: 29 },
			},
		]);
		const moving = clipOf(snapOf(d), t);
		const r2 = cropRect(moving, { f0: 0, f1: 30 }, seq)!;
		expect(r2.x).toBeLessThan(r.x);
		expect(r2.y).toBeLessThan(r.y);
		expect(r2.x + r2.w).toBeGreaterThanOrEqual(r.x + r.w - 2);
		// A blur effect widens the bleed; an unknown effect disables the crop.
		const blurred = {
			...clip,
			effects: [
				{
					id: 'fx',
					effectId: 'jasper.gaussian-blur',
					effectVersion: 1,
					enabled: true,
					params: { radius: { value: 20, keyframes: [] } },
				},
			],
		} as RenderVisualClip;
		expect(contentBleed(blurred)).toBe(60);
		expect(cropRect(blurred, { f0: 0, f1: 1 }, seq)!.w).toBeGreaterThan(r.w);
		const unknown = {
			...clip,
			effects: [{ ...blurred.effects[0]!, effectId: 'x.glow' }],
		} as RenderVisualClip;
		expect(cropRect(unknown, { f0: 0, f1: 1 }, seq)).toBeNull();
	});

	it('covers the whole frame when the layer is large; a minimal rect when it is off-screen', () => {
		const d = new DocBuilder('hd-720p-30');
		const big = d.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 10,
				track: 'V1',
				content: { text: 'Big' },
				box: { width: 1200, height: 600, autoSize: 'none' },
				ref: '$b',
			},
		]).refs.$b!;
		const seq = { width: 1280, height: 720, fps: { num: 30, den: 1 } };
		expect(cropRect(clipOf(snapOf(d), big), { f0: 0, f1: 1 }, seq)).toBeNull();
		const t = smallTitle(d, 'Away', { at: 0, track: 'V2' });
		d.tx([{ type: 'param.set', target: ['clip', t, 'transform', 'position'], value: [5000, 5000] }]);
		expect(cropRect(clipOf(snapOf(d), t), { f0: 0, f1: 1 }, seq)).toEqual({ x: 1278, y: 718, w: 2, h: 2 });
	});
});

describe('render keys (LBK-020)', () => {
	let app: TestApp;
	let svc: LayerBakeService;
	beforeAll(async () => {
		app = await makeApp();
		svc = layerBakeService(app)!;
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

	it('font files enter the key by content hash', async () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Font', { at: 0, track: 'V1' });
		const p = await planned(d);
		const plan = await svc.planBake(p, clipOf(p.snapshot, t), { env: ENV });
		expect(plan.material.fonts.length).toBeGreaterThan(0);
		expect(plan.material.fonts[0]!.fileSha256).toMatch(/^[0-9a-f]{64}$/);
		const changed = {
			...plan.material,
			fonts: plan.material.fonts.map((f) => ({ ...f, fileSha256: '0'.repeat(64) })),
		};
		expect(keyOf(changed)).not.toBe(plan.key);
		// Signed URLs in the render document, never in the key.
		expect(plan.doc.fonts[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/fonts\/.*sig=/);
		expect(JSON.stringify(plan.material)).not.toMatch(/sig=|http:/);
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

	it('fonts of styled runs belong to the bake (any font id the clip source mentions)', () => {
		const clip = {
			source: {
				text: {
					text: 'ab',
					style: { fontId: 'fnt_A' },
					runs: [{ from: 0, to: 1, style: { fontId: 'fnt_B' } }],
				},
			},
		} as unknown as RenderVisualClip;
		const fonts = [
			{ fontId: 'fnt_A', family: 'A', weight: 400, style: 'normal' as const, url: '/fonts/a' },
			{ fontId: 'fnt_B', family: 'B', weight: 700, style: 'normal' as const, url: '/fonts/b' },
			{ fontId: 'fnt_C', family: 'C', weight: 400, style: 'normal' as const, url: '/fonts/c' },
		];
		expect(clipFonts(clip, fonts).map((f) => f.fontId)).toEqual(['fnt_A', 'fnt_B']);
	});

	it('only the faces a text draws with: other weights of its font do not enter the bake (review fix 5)', async () => {
		const face = (fontId: string, weight: number, style: 'normal' | 'italic' = 'normal') => ({
			fontId,
			family: fontId,
			weight,
			style,
			url: `/fonts/${fontId}-${weight}-${style}`,
		});
		const fonts = [face('fnt_A', 400), face('fnt_A', 700), face('fnt_A', 400, 'italic'), face('fnt_B', 700)];
		const text = (style: Record<string, unknown>, runs: Record<string, unknown>[] = []) =>
			({
				source: { text: { text: 'ab', style, runs: runs.map((r) => ({ from: 0, to: 1, style: r })) } },
			}) as never;
		const pick = (c: RenderVisualClip) =>
			clipFonts(c, fonts).map((f) => `${f.fontId}:${f.weight}:${f.style}`);
		expect(pick(text({ fontId: 'fnt_A', weight: 700, italic: false }))).toEqual(['fnt_A:700:normal']);
		// Styled runs: their own weight/style over the base style; a face the snapshot lacks falls back to the font's
		// first face (what TextLayer draws with).
		expect(
			pick(text({ fontId: 'fnt_A', weight: 400, italic: false }, [{ italic: true }, { fontId: 'fnt_B' }])),
		).toEqual(['fnt_A:400:normal', 'fnt_A:400:italic', 'fnt_B:700:normal']);
		// End to end: another weight of the same font on another title keeps the key.
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Regular', { at: 0, track: 'V1' });
		const k0 = await keyOfClip(d, t);
		const b = smallTitle(d, 'Bold', { at: 0, track: 'V2' });
		d.tx([{ type: 'clip.update', clipIds: [b], patch: { content: { style: { weight: 700 } } } }]);
		const p = await planned(d);
		expect(p.snapshot.fonts.length).toBeGreaterThan(1);
		expect(await keyOfClip(d, t)).toBe(k0);
		const plan = await svc.planBake(p, clipOf(p.snapshot, t), { env: ENV });
		expect(plan.doc.fonts.map((f) => f.weight)).toEqual([400]);
	});

	it('graded stills get the transition fades; grade keys hold the real timing (review fixes 1 and 3)', async () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Graded', { at: 20, track: 'V1', duration: 40 });
		d.tx([
			{ type: 'effect.add', target: { clipId: t }, effectId: LUMETRI_EFFECT_ID, params: { saturation: 0 } },
		]);
		const ctx = {
			extensions: svc.extensions(),
			signal: new AbortController().signal,
			scratchDir: async () => tempAppdir('jasper-lb-grade-'),
			log: () => {},
			jobId: 'job_test',
		};
		const gradeOf = async (patch: Partial<RenderVisualClip> = {}) => {
			const p = await planned(d);
			const clip = { ...clipOf(p.snapshot, t), ...patch };
			const bake = await svc.planBake(p, clip, { env: ENV });
			return { bake, grade: await svc.planGrade(p, clip, bake, ctx) };
		};
		const g0 = await gradeOf();
		expect(g0.bake.variant).toEqual({ recipe: 'still' });
		expect(g0.grade.filters.join(',')).toMatch(/lut3d/);
		expect(g0.grade.filters.join(',')).not.toMatch(/fade=/);
		d.tx([
			{ type: 'transition.add', clipId: t, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 10 },
		]);
		const g1 = await gradeOf();
		// The still itself has no fades (same bake); its graded span gets them, after the grade.
		expect(g1.bake.key).toBe(g0.bake.key);
		expect(g1.grade.key).not.toBe(g0.grade.key);
		expect(g1.grade.filters.join(',')).toMatch(/lut3d=[^,]+(,[^,]+)*,fade=t=in:s=\d+:n=10:alpha=1/);
		expect(g1.grade.filters.at(-1)).toBe('setpts=PTS-STARTPTS');
		expect(g1.grade.filters.every((f) => gplFiltersIn(f).length === 0)).toBe(true);
		// Same span, other split between duration and tail handle (a reversed clip maps content time through its
		// duration): another graded entry.
		const reversed = { speed: { rate: 1, reverse: true } } as Partial<RenderVisualClip>;
		const a = await gradeOf(reversed);
		const c = clipOf((await planned(d)).snapshot, t);
		const b = await gradeOf({ ...reversed, duration: c.duration - 5, tailHandle: (c.tailHandle ?? 0) + 5 });
		expect(b.grade.frames).toBe(a.grade.frames);
		expect(b.grade.key).not.toBe(a.grade.key);
		expect(a.grade.material.clip).toMatchObject({ duration: c.duration, tailHandle: c.tailHandle ?? 0 });
		// Masters carry their fades already: no fade filters in their grade.
		d.tx([
			{
				type: 'param.setAnimated',
				target: ['clip', t, 'opacity'],
				animated: true,
				at: { sequenceFrame: 20 },
			},
		]);
		d.tx([{ type: 'param.set', target: ['clip', t, 'opacity'], value: 10, at: { sequenceFrame: 50 } }]);
		const m = await gradeOf();
		expect(m.bake.variant).toEqual({ recipe: 'master' });
		expect(m.grade.filters.join(',')).not.toMatch(/fade=/);
	});

	it('masters key the span; the clip id only enters the key of seed-bearing layers', async () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Seed', { at: 0, track: 'V1' });
		d.tx([
			{ type: 'param.setAnimated', target: ['clip', t, 'opacity'], animated: true, at: { sequenceFrame: 0 } },
		]);
		d.tx([{ type: 'param.set', target: ['clip', t, 'opacity'], value: 0, at: { sequenceFrame: 20 } }]);
		const p = await planned(d);
		const plan = await svc.planBake(p, clipOf(p.snapshot, t), { env: ENV });
		expect(plan.variant).toEqual({ recipe: 'master' });
		expect(plan.material.span).toBe(30);
		expect(normalisedClip(clipOf(p.snapshot, t)).clipId).toBe('clip');
		inject(d, ANIME_CLIP, { id: 'clp_ANIME00000000001', track: 'V2', start: 0 });
		const anime = clipOf(snapOf(d), 'clp_ANIME00000000001');
		expect(normalisedClip(anime).clipId).toBe('clp_ANIME00000000001');
		// Anime templates clip their drawing to the canvas (= the layer box), so the crop needs no extra bleed.
		expect(contentBleed(anime)).toBe(0);
		// Anime templates key their registry renderVersion (title-reveal@1 is installed by wp-m2-anime-templates;
		// a template that is not installed keys null).
		const pa = await planned(d);
		const ap = await svc.planBake(pa, clipOf(pa.snapshot, 'clp_ANIME00000000001'), { env: ENV });
		const installed = mgRegistry.getDefinition('title-reveal', 1);
		expect(installed && isAnimeTemplate(installed)).toBe(true);
		expect(ap.material).toHaveProperty(
			'renderVersion',
			installed && isAnimeTemplate(installed) ? installed.renderVersion : null,
		);
		expect(keyOf({ ...ap.material, renderVersion: (ap.material.renderVersion ?? 0) + 1 })).not.toBe(ap.key);
		// Stills of a non-static layer without a cached master: a one-frame bake keyed by the frame.
		const f12 = await keyOfClip(d, t, ENV, 12);
		const f13 = await keyOfClip(d, t, ENV, 13);
		expect(f12).not.toBe(f13);
		expect(f12).not.toBe(plan.key);
	});
});

describe('planner (LBK-002, LBK-024)', () => {
	let app: TestApp;
	beforeAll(async () => {
		ensureFixtures();
		app = await makeApp();
	}, 600_000);
	afterAll(closeApps);

	it('footage + titles + shape + anime template plan `hybrid` with one graphics group per baked layer', async () => {
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

	it('without Remotion every DOM layer is blocked; blend modes still block; no extension = "requires graphics rendering"', async () => {
		const d = new DocBuilder('hd-720p-30');
		const t = smallTitle(d, 'Title', { at: 0, track: 'V1' });
		inject(d, ANIME_CLIP, { id: 'clp_ANIME00000000001', track: 'V2', start: 0 });
		const svc = layerBakeService(app)!;
		const ext = coreServices(app)
			.exports.nativeExtensions.all()
			.find((e) => e.id === 'layer-bake')!;
		const s = snapOf(d);
		const orig = svc.unavailableReason.bind(svc);
		svc.unavailableReason = () => 'no browser';
		try {
			expect(nativeBlockers(clipOf(s, t), CAPS, [ext])).toEqual([
				'graphics layers need the Remotion renderer to bake (no browser)',
			]);
			const r = await app.inject({
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
		} finally {
			svc.unavailableReason = orig;
		}
		expect(nativeBlockers(clipOf(s, t), CAPS, [ext])).toEqual([]);
		expect(nativeBlockers({ ...clipOf(s, t), blendMode: 'screen' }, CAPS, [ext])).toEqual([
			'text clip "Title" uses blend mode "screen"',
		]);
		// Without the extension: the M1 blocker texts; anime templates never ask for fframes.
		expect(nativeBlockers(clipOf(s, t), CAPS)).toEqual(['text layer "Title" requires graphics rendering']);
		const anime = nativeBlockers(clipOf(s, 'clp_ANIME00000000001'), CAPS);
		expect(anime.join()).toMatch(/requires graphics rendering \(anime template\)/);
		expect(anime.join()).not.toMatch(/fframes/);
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
		expect(effectRunsOrderWarning(clip)).toMatch(/after jasper.gaussian-blur/);
		expect(effectRunsOrderWarning({ ...clip, effects: [...clip.effects].reverse() })).toBeNull();
	});
});

describe('builder: still, rect and colour runs on overrides (LBK-004/005/010, LBK-031)', () => {
	const output = {
		width: 1280,
		height: 720,
		fps: { num: 30, den: 1 },
		frames: 60,
		durationSec: 2,
		scaling: 'fit',
		crf: 18,
		x264Preset: 'veryfast',
		audioChannels: 2,
		audioBitrateKbps: 192,
	} as never;

	it('loops a still with the fades applied, overlays a rect, grades with lut3d, uses no GPL filter', async () => {
		const d = new DocBuilder('hd-720p-30');
		const s1 = smallTitle(d, 'Static', { at: 10, track: 'V1', duration: 40 });
		const s2 = smallTitle(d, 'Graded', { at: 0, track: 'V2', duration: 60 });
		d.tx([
			{ type: 'effect.add', target: { clipId: s2 }, effectId: LUMETRI_EFFECT_ID, params: { saturation: 0 } },
			{ type: 'transition.add', clipId: s1, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 10 },
		]);
		const snap = snapOf(d);
		const c2 = clipOf(snap, s2);
		const lutDir = tempAppdir('jasper-luts-');
		const color = createColorExtension({ lutCacheDir: lutDir });
		const plannedLike = {
			snapshot: snap,
			document: d.doc,
			media: {},
			range: snap.range,
		} as unknown as PlannedExport;
		const colorPrepared = await color.prepare!(plannedLike, {
			signal: new AbortController().signal,
			stage: () => {},
			scratchDir: async () => lutDir,
			log: () => {},
			jobId: 'job_test',
		});
		const prepared: LayerBakePrepared = new Map([
			[
				s1,
				{
					override: {
						path: '/cache/layers/k1/still.png',
						space: 'sequence',
						startFrame: 0,
						still: true,
						includesFades: false,
						rect: { x: 400, y: 300, w: 480, h: 220 },
					},
				},
			],
			[
				s2,
				{
					override: {
						path: '/cache/layers/k2/master.mov',
						space: 'sequence',
						startFrame: 0,
						includesFades: true,
						colorRuns: true,
					},
				},
			],
		]);
		const lb = layerBakeExtension({} as LayerBakeService);
		const g = buildNativeGraph({
			snapshot: snap,
			output,
			outputFile: '/tmp/x.mp4',
			sources: { media: () => null, mgMaster: () => null },
			threads: 1,
			extensions: {
				list: [color, lb],
				prepared: new Map<string, unknown>([
					['color', colorPrepared],
					['layer-bake', prepared],
				]),
			},
		});
		const stillInput = g.inputs.find((a) => a.includes('/cache/layers/k1/still.png'))!;
		expect(stillInput.slice(0, 4)).toEqual(['-loop', '1', '-framerate', '30/1']);
		expect(stillInput).not.toContain('-ss');
		const masterInput = g.inputs.find((a) => a.includes('/cache/layers/k2/master.mov'))!;
		expect(masterInput).toContain('-ss');
		// The still: scaled to its rect, faded by the builder, overlaid at the rect.
		expect(g.filter).toMatch(/scale=480:220:[^,]*,setsar=1,format=rgba,fade=t=in/);
		expect(g.filter).toMatch(/overlay=x=400:y=300:format=rgb/);
		// The graded master: the colour extension's lut3d on the override stream, no fades (baked in).
		expect(g.filter).toMatch(
			/scale=1280:720:[^,]*,setsar=1,format=rgba,lut3d=file='[^']+\.cube':interp=tetrahedral,setpts/,
		);
		expect(gplFiltersIn(g.filter)).toEqual([]);
		void c2;
	});
});

describe('cache, capability, preview route, usage log (LBK-021, LBK-030, LBK-026)', () => {
	let app: TestApp;
	let svc: LayerBakeService;
	beforeAll(async () => {
		app = await makeApp();
		svc = layerBakeService(app)!;
	});
	afterAll(closeApps);

	it('GC removes entries unused for 14 days and keeps the others', async () => {
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
		mk(old, new Date(Date.now() - LAYER_CACHE_TTL_MS - 60_000));
		mk(fresh, new Date());
		mkdirSync(join(svc.dir, orphan), { recursive: true });
		const t = (Date.now() - LAYER_CACHE_TTL_MS - 3600_000) / 1000;
		utimesSync(join(svc.dir, orphan), t, t);
		expect(await svc.gc()).toBe(2);
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

	it('GC keeps entries held by running jobs and entries a lookup marks used meanwhile (review fix 4)', async () => {
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
		const longAgo = () => new Date(Date.now() - LAYER_CACHE_TTL_MS - 60_000);
		// A lease (a running job reading the entry) keeps it; released, the next pass removes it.
		const held = 'd'.repeat(40);
		mk(held, longAgo());
		const release = svc.lease([held]);
		expect(await svc.gc()).toBe(0);
		expect(existsSync(join(svc.dir, held, 'still.png'))).toBe(true);
		release();
		release();
		expect(await svc.gc()).toBe(1);
		expect(existsSync(join(svc.dir, held))).toBe(false);
		// `lookup` has written `lastUsedAt` when it returns.
		const used = 'e'.repeat(40);
		mk(used, longAgo());
		expect(await svc.lookup(used)).not.toBeNull();
		expect(await svc.gc()).toBe(0);
		expect(existsSync(join(svc.dir, used, 'still.png'))).toBe(true);
		// A lookup racing a GC pass either keeps the entry or misses (never returns a path the GC removes).
		const racing = 'f'.repeat(40);
		mk(racing, longAgo());
		const [n, hit] = await Promise.all([svc.gc(), svc.lookup(racing)]);
		if (hit) {
			expect(n).toBe(0);
			expect(existsSync(hit.path)).toBe(true);
		} else expect(existsSync(join(svc.dir, racing, 'still.png'))).toBe(false);
		// ensureBake (export reads the bake later): held from before the lookup until the export job finishes.
		const exported = '1'.repeat(40);
		mk(exported, longAgo());
		const queue = coreServices(app).queue;
		const wait = queue.wait.bind(queue);
		let finish: () => void = () => {};
		const parentDone = new Promise<EngineJob>((r) => {
			finish = () => r({ id: 'job_PARENT0000000000', state: 'succeeded' } as EngineJob);
		});
		queue.wait = (id: string) => (id === 'job_PARENT0000000000' ? parentDone : wait(id));
		try {
			const gcPass = svc.gc();
			const bake = await svc.ensureBake({ key: exported, clipName: 'x' } as never, {
				parentId: 'job_PARENT0000000000',
				signal: new AbortController().signal,
			});
			await gcPass;
			expect(existsSync(bake.path)).toBe(true);
			// Even once it is old again, the running export keeps it.
			mk(exported, longAgo());
			expect(await svc.gc()).toBe(0);
			finish();
			await parentDone;
			await new Promise((r) => setTimeout(r, 10));
			expect(await svc.gc()).toBe(1);
		} finally {
			queue.wait = wait;
		}
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
		// One signature covers the entry's sequence; the frame number rides along.
		const signed = coreServices(app).signer.signUrl('', `/mg/layers/${key}/graded.png`);
		expect(coreServices(app).signer.verify(`${signed}&n=1`)).toBe(true);
	});

	it('features.layerBake reports readiness and the cache size', async () => {
		await svc.refreshBytes();
		const caps = (
			await app.inject({ method: 'GET', url: '/api/capabilities', headers: { host: '127.0.0.1:47900' } })
		).json();
		expect(caps.features.layerBake).toMatchObject({ cacheBytes: expect.any(Number) });
		expect(['ready', 'unavailable']).toContain(caps.features.layerBake.state);
		const orig = svc.unavailableReason.bind(svc);
		svc.unavailableReason = () => 'no renderer';
		try {
			expect(svc.capability()).toMatchObject({ state: 'unavailable', reason: 'no renderer' });
		} finally {
			svc.unavailableReason = orig;
		}
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

	it('the usage log records every Remotion call with its purpose (LC-004, LBK-026)', async () => {
		const log = join(coreServices(app).config.paths.logsDir, 'remotion-usage.jsonl');
		await coreServices(app).remotion.recordUsage('media', 'layer-bake');
		await coreServices(app).remotion.recordUsage('media', 'mg-prerender');
		const lines = readFileSync(log, 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		expect(lines.slice(-2)).toMatchObject([
			{ kind: 'media', purpose: 'layer-bake' },
			{ kind: 'media', purpose: 'mg-prerender' },
		]);
	});
});

describe('parallel bakes: page budget, shared browser, dedupe, abort (LBK-022)', () => {
	let app: TestApp;
	let svc: LayerBakeService;
	const calls: { kind: 'still' | 'master'; pages: number; browser: unknown }[] = [];
	let active = { renders: 0, pages: 0 };
	let peak = { renders: 0, pages: 0 };
	let delayMs = 150;
	let failOn: string | null = null;
	const browsers = { opened: 0, closed: 0 };
	const sharedInstance = { shared: true };
	let parents = 0;

	/** A transparent ProRes 4444 / PNG of the document's size (the crop safety net decodes it). */
	const writeTransparent = (out: string, doc: RenderSnapshot, frames: number) => {
		const ff = coreServices(app).ffmpeg.bins.ffmpeg!;
		const still = out.endsWith('.png');
		const r = spawnSync(ff, [
			'-v',
			'error',
			'-y',
			'-f',
			'lavfi',
			'-i',
			`color=c=black@0.0:s=${doc.settings.width}x${doc.settings.height}:r=30,format=rgba`,
			'-frames:v',
			String(still ? 1 : frames),
			...(still ? ['-c:v', 'png'] : ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']),
			out,
		]);
		if (r.status !== 0) throw new Error(String(r.stderr));
	};
	/** Simulated render: counts what is in flight, honours the signal, fails on request. */
	const render = async (
		kind: 'still' | 'master',
		pages: number,
		signal: AbortSignal,
		o: { name: string; browser?: unknown },
	) => {
		calls.push({ kind, pages, browser: o.browser });
		active = { renders: active.renders + 1, pages: active.pages + pages };
		peak = { renders: Math.max(peak.renders, active.renders), pages: Math.max(peak.pages, active.pages) };
		try {
			await new Promise<void>((res, rej) => {
				const t = setTimeout(res, delayMs);
				signal.addEventListener('abort', () => {
					clearTimeout(t);
					rej(new Error('cancelled'));
				});
			});
			if (failOn && o.name.includes(failOn)) throw new Error(`synthetic failure of ${o.name}`);
		} finally {
			active = { renders: active.renders - 1, pages: active.pages - pages };
		}
	};
	const docName = (props: Record<string, unknown>) => {
		const doc = props.doc as RenderSnapshot;
		return doc.videoTracks.flatMap((t) => t.clips)[0]?.name ?? '';
	};

	beforeAll(async () => {
		app = await makeApp({ totalSlots: 12 });
		svc = layerBakeService(app)!;
		svc.environment = async () => ENV;
		svc.unavailableReason = () => null;
		const r = coreServices(app).remotion;
		r.openSharedBrowser = async () => {
			browsers.opened++;
			return {
				instance: sharedInstance as never,
				close: async () => {
					browsers.closed++;
				},
			};
		};
		r.renderStill = async (input) => {
			await render('still', 1, input.signal, {
				name: docName(input.inputProps),
				browser: input.browser?.instance,
			});
			writeTransparent(input.output, (input.inputProps as { doc: RenderSnapshot }).doc, 1);
		};
		r.renderAlphaMaster = async (input) => {
			const doc = (input.inputProps as { doc: RenderSnapshot }).doc;
			await render('master', input.concurrency ?? 1, input.signal, {
				name: docName(input.inputProps),
				browser: input.browser?.instance,
			});
			writeTransparent(input.output, doc, doc.durationFrames);
			return { frames: doc.durationFrames };
		};
	});
	afterAll(closeApps);
	beforeEach(() => {
		calls.length = 0;
		active = { renders: 0, pages: 0 };
		peak = { renders: 0, pages: 0 };
		delayMs = 150;
		failOn = null;
		browsers.opened = 0;
		browsers.closed = 0;
		svc.parallelism = { maxInFlight: null, sharedBrowser: true };
	});

	/** Six DOM layers: three static titles (stills), two keyframed titles (masters of 40 and 70 frames), a text animator. */
	function sixLayers(tag: string): DocBuilder {
		const d = new DocBuilder('hd-720p-30');
		for (const [i, track] of ['V1', 'V2', 'V3'].entries())
			smallTitle(d, `${tag} static ${i}`, { at: 0, track, duration: 90 });
		for (const [i, [track, duration]] of (
			[
				['V4', 40],
				['V5', 70],
			] as const
		).entries()) {
			const id = smallTitle(d, `${tag} moving ${i}`, { at: 0, track, duration });
			d.tx([
				{
					type: 'param.setAnimated',
					target: ['clip', id, 'opacity'],
					animated: true,
					at: { sequenceFrame: 0 },
				},
			]);
			d.tx([
				{
					type: 'param.set',
					target: ['clip', id, 'opacity'],
					value: 10,
					at: { sequenceFrame: duration - 1 },
				},
			]);
		}
		d.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 60,
				track: 'V6',
				content: { text: `${tag} animated` },
				box: { width: 300, height: 80, autoSize: 'none' },
				textAnimation: { in: { preset: 'fade', durationFrames: 10 } },
			},
		]);
		return d;
	}

	async function plannedOf(d: DocBuilder): Promise<PlannedExport> {
		return coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
	}

	/** `prepare` of the extension as the export runs it, under a real parent job id. */
	async function prepare(d: DocBuilder, o: { budget: number; signal?: AbortSignal }) {
		const planned = await plannedOf(d);
		const stages: string[] = [];
		// The export's job id (a stand-in: the children only need it as their parent).
		const parent = { id: `job_PREP${String(++parents).padStart(12, '0')}` };
		const ext = layerBakeExtension(svc);
		const result = ext.prepare!(planned, {
			signal: o.signal ?? new AbortController().signal,
			stage: (t) => stages.push(t),
			scratchDir: async () => tempAppdir('jasper-lbp-scratch-'),
			log: () => undefined,
			jobId: parent.id,
			purpose: 'native',
			concurrency: o.budget,
		}) as Promise<LayerBakePrepared>;
		return { result, stages, parentId: parent.id, planned };
	}
	const childrenOf = (id: string) =>
		coreServices(app)
			.queue.list({})
			.filter((j) => j.parentId === id);

	it('runs the bakes side by side within the budget, in one shared browser, and reports "Baking graphics i/n"', async () => {
		const { result, stages, parentId } = await prepare(sixLayers('par'), { budget: 4 });
		const prepared = await result;
		expect(prepared.size).toBe(6);
		expect([...prepared.values()].every((p) => p.override && existsSync(p.override.path))).toBe(true);
		expect(calls.filter((c) => c.kind === 'still')).toHaveLength(3);
		expect(calls.filter((c) => c.kind === 'master')).toHaveLength(3);
		// Several at once, never more pages than the budget; masters get pages by length (≤ 30 frames per page).
		expect(peak.renders).toBeGreaterThanOrEqual(2);
		expect(peak.pages).toBeLessThanOrEqual(4);
		for (const c of calls.filter((x) => x.kind === 'master')) expect(c.pages).toBeLessThanOrEqual(3);
		// One browser for the whole export, closed when the bakes are done.
		expect(calls.every((c) => c.browser === sharedInstance)).toBe(true);
		expect(browsers).toEqual({ opened: 1, closed: 1 });
		expect(stages[0]).toBe('Baking graphics 0/6 · 0 %');
		expect(stages.at(-1)).toBe('Baking graphics 6/6');
		expect(stages.some((s) => /^Baking graphics [1-5]\/6 · \d+ %$/.test(s))).toBe(true);
		const kids = childrenOf(parentId);
		expect(kids).toHaveLength(6);
		expect(kids.every((k) => k.cpuSlots === 0 && k.state === 'succeeded')).toBe(true);
		// A second run hits the cache: nothing rendered, no browser launched.
		calls.length = 0;
		const again = await prepare(sixLayers('par'), { budget: 4 });
		expect((await again.result).size).toBe(6);
		expect(calls).toHaveLength(0);
		expect(browsers.opened).toBe(1);
	}, 120_000);

	it('maxInFlight 1 is the sequential path: one bake at a time, masters with the whole budget, own browsers', async () => {
		svc.parallelism = { maxInFlight: 1, sharedBrowser: true };
		const { result } = await prepare(sixLayers('seq'), { budget: 4 });
		expect((await result).size).toBe(6);
		expect(peak.renders).toBe(1);
		expect(calls.filter((c) => c.kind === 'master').every((c) => c.pages === 4)).toBe(true);
		expect(calls.every((c) => c.browser === undefined)).toBe(true);
		expect(browsers.opened).toBe(0);
	}, 120_000);

	it('a failing bake cancels the others and fails the preparation with its error', async () => {
		delayMs = 400;
		failOn = 'fail moving 1';
		const { result, parentId } = await prepare(sixLayers('fail'), { budget: 6 });
		await expect(result).rejects.toMatchObject({ code: 'LAYER_BAKE_FAILED' });
		const kids = childrenOf(parentId);
		expect(kids.some((k) => k.state === 'failed')).toBe(true);
		expect(kids.every((k) => ['failed', 'cancelled', 'succeeded'].includes(k.state))).toBe(true);
		expect(active.renders).toBe(0);
		expect(browsers.closed).toBe(browsers.opened);
	}, 120_000);

	it('aborting the export cancels every bake in flight and starts no more', async () => {
		delayMs = 5_000;
		const ac = new AbortController();
		const { result, parentId } = await prepare(sixLayers('abort'), { budget: 4, signal: ac.signal });
		await until(() => active.renders >= 2, 20_000, 20);
		ac.abort();
		await expect(result).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		await until(() => childrenOf(parentId).every((k) => k.state === 'cancelled'), 10_000, 50);
		expect(childrenOf(parentId).length).toBeLessThan(6);
		expect(calls.length).toBeLessThan(6);
		expect(active.renders).toBe(0);
		expect(browsers).toEqual({ opened: 1, closed: 1 });
	}, 120_000);

	it('two parents needing the same bake render it once; when its owner is cancelled the other renders it', async () => {
		delayMs = 600;
		const d = sixLayers('dedupe');
		const planned = await plannedOf(d);
		const clip = planned.snapshot.videoTracks
			.flatMap((t) => t.clips)
			.find((c) => c.name.includes('moving 0'))!;
		const plan = await svc.planBake(planned, clip, { env: ENV });
		const joined0 = svc.stats.joined;
		const [a, b] = await Promise.all([
			svc.ensureBake(plan, { parentId: 'job_PARENTA000000000', signal: new AbortController().signal }),
			svc.ensureBake(plan, { parentId: 'job_PARENTB000000000', signal: new AbortController().signal }),
		]);
		expect(a.path).toBe(b.path);
		expect(calls).toHaveLength(1);
		expect(svc.stats.joined - joined0).toBe(1);
		// The owner's export is cancelled while the other one waits: the other renders it itself.
		const other = await svc.planBake(
			planned,
			planned.snapshot.videoTracks.flatMap((t) => t.clips).find((c) => c.name.includes('moving 1'))!,
			{ env: ENV },
		);
		calls.length = 0;
		const owner = new AbortController();
		const first = svc.ensureBake(other, { parentId: 'job_PARENTC000000000', signal: owner.signal });
		await until(() => active.renders === 1, 10_000, 10);
		const second = svc.ensureBake(other, {
			parentId: 'job_PARENTD000000000',
			signal: new AbortController().signal,
		});
		await new Promise((r) => setTimeout(r, 50));
		owner.abort();
		await expect(first).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		expect(existsSync((await second).path)).toBe(true);
		expect(calls).toHaveLength(2);
	}, 120_000);
});

describe('bundle identity (LBK-020, build-remotion stamp)', () => {
	it('a prebuilt bundle is identified by its stamp, else by its content; dev bundles by the source hash', () => {
		const dir = tempAppdir('jasper-bundle-');
		writeFileSync(join(dir, 'index.html'), '<html></html>');
		writeFileSync(join(dir, 'bundle.js'), 'x');
		const make = () =>
			new RemotionService({ bundleCacheDir: tempAppdir(), usageLog: null, env: {}, prebuiltBundleDir: dir });
		const unstamped = make().bundleId();
		expect(unstamped).toMatch(/^content-[0-9a-f]{16}$/);
		writeFileSync(join(dir, 'bundle.js'), 'y');
		expect(make().bundleId()).not.toBe(unstamped);
		writeFileSync(
			join(dir, BUNDLE_STAMP_FILE),
			JSON.stringify({ bundleId: 'abc123', animejs: '9.9.9', remotion: '4.0.499' }),
		);
		const stamped = make();
		expect(stamped.bundleId()).toBe('abc123');
		expect(stamped.animejsVersion()).toBe('9.9.9');
		const dev = new RemotionService({
			bundleCacheDir: tempAppdir(),
			usageLog: null,
			env: {},
			prebuiltBundleDir: null,
		});
		expect(dev.bundleId()).toMatch(/^[0-9a-f]{16}$/);
		expect(dev.animejsVersion()).toBe('4.5.0');
	});
});

describe('auto fallback to Remotion when a native preparation fails (LBK-023)', () => {
	let app: TestApp;
	beforeAll(async () => {
		app = await makeApp({ totalSlots: 4 });
	});
	afterAll(closeApps);

	it('auto → Remotion with NATIVE_FALLBACK; forced native fails with the cause', async () => {
		const core = coreServices(app);
		// A failing extension (any extension: e.g. a bake or a warp that cannot run).
		const failing: NativeExtension = {
			id: 'failing',
			prepare: async () => {
				throw Object.assign(new Error('prepare exploded'), { code: 'BAKE_BROKEN' });
			},
		};
		const off = core.registerNativeExtension(failing);
		// Stub the Remotion render: an ffmpeg test card with the frame count Remotion would have rendered.
		const ff = core.ffmpeg.bins.ffmpeg!;
		const renderMedia = core.remotion.renderMedia.bind(core.remotion);
		core.remotion.renderMedia = async (input) => {
			const doc = (input.inputProps as { doc: RenderSnapshot }).doc;
			const n = doc.durationFrames;
			const codec = input.output.endsWith('.mov')
				? ['-c:v', 'prores_ks']
				: input.output.endsWith('.webm')
					? ['-c:v', 'libvpx-vp9']
					: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
			const r = spawnSync(ff, [
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				`color=c=red:s=${doc.settings.width}x${doc.settings.height}:r=30`,
				'-frames:v',
				String(n),
				...codec,
				input.output,
			]);
			if (r.status !== 0) throw new Error(String(r.stderr));
			return { frames: n };
		};
		try {
			const d = new DocBuilder('hd-720p-30');
			d.tx([{ type: 'clip.addSolid', at: 0, duration: 15, track: 'V1', color: [0, 0, 1, 1] }]);
			const start = async (engine: string) => {
				const r = await app.inject({
					method: 'POST',
					url: '/api/exports',
					headers: JSON_H,
					payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, { engine }) },
				});
				expect(r.statusCode, r.body).toBeLessThan(300);
				const id = r.json().id as string;
				await until(() => ['succeeded', 'failed'].includes(core.queue.get(id)!.state), 120_000, 100);
				return core.queue.get(id)! as EngineJob;
			};
			const auto = await start('auto');
			expect(auto.state, JSON.stringify(auto.error)).toBe('succeeded');
			expect(auto.result).toMatchObject({
				renderPath: 'remotion',
				frames: 15,
				warnings: [{ code: 'NATIVE_FALLBACK', message: expect.stringMatching(/prepare exploded/) }],
			});
			const forced = await start('native');
			expect(forced.state).toBe('failed');
			expect(forced.error).toMatchObject({
				code: 'BAKE_BROKEN',
				message: expect.stringMatching(/prepare exploded/),
			});
		} finally {
			off();
			core.remotion.renderMedia = renderMedia;
		}
	}, 180_000);
});
