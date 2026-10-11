// The builder draws transition sides outside the baked span and overlays the span master in their track.
import { defaultEffectRegistry } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import type { NativeExtension } from '../src/export/native-ext.ts';
import type { BakeEnvironment } from '../src/layer-bake/key.ts';
import { hasBrowserEffect, isStaticLayer, needsBake } from '../src/layer-bake/layer.ts';
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

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'auto',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

type Plan = {
	path: string;
	blockers: { reason: string }[];
	segments: { graphicsGroups: { engine: string; itemIds: string[] }[] }[];
};

async function plan(d: DocBuilder): Promise<Plan> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
	});
	expect(r.statusCode, r.body).toBe(200);
	return r.json() as Plan;
}

function solidsWithPush(): { d: DocBuilder; a: string; b: string; t: string } {
	const d = new DocBuilder();
	const a = d.tx([
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
	]).refs.$a!;
	const b = d.tx([
		{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1], ref: '$b' },
	]).refs.$b!;
	const t = d.tx([
		{ type: 'transition.add', trackId: 'V1', at: 30, effectId: 'jasper.push', duration: 20, ref: '$t' },
	]).refs.$t!;
	return { d, a, b, t };
}

describe('planner: GPU effects and GPU transitions keep the native path (hybrid)', () => {
	it('a video / still / solid layer with GPU effects is baked; the rest stays native', async () => {
		const d = new DocBuilder();
		const m = d.addMedia(await register(app, fixture('clip-a.mp4')));
		const v = d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, ref: '$v' }]).refs.$v!;
		const s = d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V2', color: [1, 0, 0, 1], ref: '$s' },
		]).refs.$s!;
		d.tx([
			{ type: 'effect.add', target: { clipId: s }, effectId: 'jasper.bevel-edges' },
			{ type: 'effect.add', target: { clipId: s }, effectId: 'jasper.s.flicker' },
		]);
		const p = await plan(d);
		expect(p.path).toBe('hybrid');
		expect(p.blockers).toEqual([]);
		const groups = p.segments[0]!.graphicsGroups;
		expect(groups).toEqual([{ id: 'lb1', engine: 'remotion', itemIds: [s] }]);
		expect(groups.flatMap((g) => g.itemIds)).not.toContain(v);
	});

	it('a GPU transition is a graphics group of its own (its span); its sides stay native', async () => {
		const { d, a, b, t } = solidsWithPush();
		const p = await plan(d);
		expect(p.path).toBe('hybrid');
		expect(p.blockers).toEqual([]);
		const items = p.segments[0]!.graphicsGroups.flatMap((g) => g.itemIds);
		expect(items).toEqual([t]);
		expect(items).not.toContain(a);
		expect(items).not.toContain(b);
	});

	it('without a span renderer (no layer-bake extension) a GPU transition still sends the export to Remotion', async () => {
		const { d } = solidsWithPush();
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		expect(planned.plan.path).toBe('hybrid');
		const { planExport } = await import('../src/export/planner.ts');
		const bare = await planExport(
			{ envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) as never },
			{
				registry: coreServices(app).registry,
				fonts: coreServices(app).fonts,
				capabilities: { native: true, remotionLocal: 'ready', fframes: 'ready', mgMasters: true },
				extensions: [],
			},
		);
		expect(bare.plan.path).toBe('remotion');
		expect(bare.plan.blockers.map((x) => x.reason).join('\n')).toMatch(
			/transition "Push" is a GPU transition and no span renderer is available/,
		);
	});
});

describe('layer-bake: what is baked', () => {
	it('media layers with browser-only effects; colour ops, crop and flips stay native', () => {
		const fx = (effectId: string) => ({ id: 'fx', effectId, effectVersion: 1, enabled: true, params: {} });
		const video = { kind: 'video', engine: 'native', effects: [fx('jasper.s.flicker')] } as never;
		expect(needsBake(video)).toBe(true);
		expect(hasBrowserEffect({ effects: [fx('jasper.crop'), fx('jasper.flip-horizontal')] } as never)).toBe(
			false,
		);
		const lut = defaultEffectRegistry.list().find((s) => s.color)!;
		expect(hasBrowserEffect({ effects: [fx(lut.id)] } as never)).toBe(false);
		expect(hasBrowserEffect({ effects: [{ ...fx('jasper.bevel-edges'), enabled: false }] } as never)).toBe(
			false,
		);
		expect(
			isStaticLayer({
				kind: 'video',
				source: {},
				transform: null,
				opacity: { value: 100, keyframes: [] },
				effects: [],
			} as never),
		).toBe(false);
	});
});

describe('builder: a baked transition span replaces its sides over the span', () => {
	it('sides end / start at the span, the span master is overlaid in the track (seeked into)', async () => {
		const { d, t } = solidsWithPush();
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const fake: NativeExtension = {
			id: 'fake-span',
			transitionOverride: (tr) =>
				tr.id === t
					? { path: '/tmp/span-master.mov', space: 'sequence', startFrame: tr.start, includesFades: true }
					: null,
		};
		const g = buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: '/tmp/x.mp4',
			sources: { media: () => null, mgMaster: () => null },
			threads: 2,
			extensions: { list: [fake], prepared: new Map() },
		});
		const tr = planned.snapshot.videoTracks[0]!.transitions![0]!;
		expect([tr.start, tr.duration]).toEqual([20, 20]);
		// A: 0–20 (its tail handle is cut), B: 40–60, the span 20–40 from the master.
		const enables = [...g.filter.matchAll(/overlay=[^[]*enable='between\(t,([^,]+),([^)]+)\)'/g)].map((m) => [
			Math.round(Number(m[1]) * 30 + 0.5) + 0,
			Math.round(Number(m[2]) * 30 + 0.5),
		]);
		expect(enables).toEqual([
			[0, 20],
			[40, 60],
			[20, 40],
		]);
		const k = g.inputs.findIndex((args) => args.includes('/tmp/span-master.mov'));
		expect(k).toBeGreaterThanOrEqual(0);
		expect(g.inputs[k]).toContain('-ss');
	});
});

describe('span bakes: the cache key covers the transition inputs (wave-4 transition polish)', () => {
	const ENV: BakeEnvironment = {
		bundleId: 'b1',
		animejs: '4.0.0',
		remotion: '4.0.499',
		browser: 'c',
		gl: 'swiftshader',
	};

	it("includes the image params' media fingerprint and the sides' tracks", async () => {
		const d = new DocBuilder();
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1] },
		]);
		const img = d.addMedia(await register(app, fixture('still.png')));
		d.tx([
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 30,
				effectId: 'jasper.gradient-wipe',
				duration: 20,
				params: { gradientImage: { mediaId: img } },
			},
		]);
		const svc = app.jasper.services.layerBake as LayerBakeService;
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const track = planned.snapshot.videoTracks[0]!;
		const t = track.transitions![0]!;
		const span = await svc.planSpan(planned, track.trackId, t, { env: ENV });
		expect(span.doc.media[img]).toBeTruthy();
		expect(span.material.media.map((m) => m.mediaId)).toContain(img);
		const again = await svc.planSpan(planned, track.trackId, t, { env: ENV });
		expect(again.key).toBe(span.key);
		const local = planned.media[img];
		if (local) local.record = { ...local.record, fingerprint: 'q1:other' } as never;
		planned.document.media[img] = { ...planned.document.media[img]!, fingerprint: 'q1:other' };
		const changed = await svc.planSpan(planned, track.trackId, t, { env: ENV });
		expect(changed.key).not.toBe(span.key);
		// The sides' tracks are part of the transition, hence of the key.
		const frame = {
			kind: 'point' as const,
			corners: null,
			point: [10, 10] as [number, number],
			confidence: 1,
			tracked: true,
		};
		const tracked = await svc.planSpan(
			planned,
			track.trackId,
			{ ...t, tracks: { in: { trackerId: 'tkr_1', name: 'T', kind: 'point', frames: [frame] } } },
			{ env: ENV },
		);
		expect(tracked.key).not.toBe(changed.key);
	});
});
