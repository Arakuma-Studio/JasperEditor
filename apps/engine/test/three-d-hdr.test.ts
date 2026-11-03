// Spec 19 TL-075, TL-076: Radiance media through the import pipeline, and the plan's refusals: a scene that lost its HDR
// or model, and a physical scene with no float targets, are named before anything renders.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PlanCapabilities, PlanError, planExport } from '../src/export/planner.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

let app: TestApp;
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-hdr-'));
	app = await makeApp();
}, 120_000);
afterAll(async () => {
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

const hdrFile = (w: number, h: number, body: number[]) =>
	Buffer.concat([
		Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`, 'latin1'),
		Buffer.from(body),
	]);

describe('Radiance media', () => {
	it('registers a .hdr as kind hdri, with its size', async () => {
		const file = join(dir, 'pano.hdr');
		writeFileSync(file, hdrFile(4, 2, new Array<number>(4 * 2 * 4).fill(128)));
		const m = await register(app, file);
		expect(m.kind).toBe('hdri');
		expect(m.container).toBe('hdr');
	});

	it.each([
		['truncated data', hdrFile(16, 16, [1, 2, 3])],
		['a claimed size past the cap', hdrFile(16384, 16384, [])],
		['not a Radiance file', Buffer.from('hello world, this is not an image')],
	])('refuses %s with INVALID_HDR', async (_name, bytes) => {
		const file = join(dir, `bad-${bytes.length}.hdr`);
		writeFileSync(file, bytes);
		const res = await app.inject({
			method: 'POST',
			url: '/api/media/register',
			headers: JSON_H,
			payload: { projectId: 'prj_0000000000000001', paths: [file] },
		});
		expect(res.body).toContain('INVALID_HDR');
	});
});

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

const caps = (floatTargets: boolean): PlanCapabilities => ({
	native: true,
	remotionLocal: 'ready',
	fframes: 'ready',
	mgMasters: true,
	webgl: async () => ({ state: 'ok', floatTargets }),
});

const plan = (d: DocBuilder, c: PlanCapabilities) =>
	planExport(
		{ envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) as never },
		{ registry: coreServices(app).registry, fonts: coreServices(app).fonts, capabilities: c, extensions: [] },
	);

function goldTitle(): DocBuilder {
	const d = new DocBuilder();
	const r = d.tx([
		{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'GOLD' }, ref: '$t' },
		{ type: 'clip.set3d', clipIds: ['$t'], enabled: true },
		{ type: 'sequence.set3dRenderer', renderer: 'advanced' },
	]);
	d.tx([{ type: 'threeD.setSurface', clipIds: [r.refs.$t!], preset: 'gold' }]);
	return d;
}

describe('the plan of a 3D title', () => {
	it('routes it to Remotion and refuses by name without float targets', async () => {
		const p = await plan(goldTitle(), caps(true));
		expect(p.plan.path).toBe('remotion');
		const e = await plan(goldTitle(), caps(false)).catch((x) => x);
		expect(e).toBeInstanceOf(PlanError);
		expect((e as PlanError).code).toBe('THREE_D_NEEDS_FLOAT');
		expect(JSON.stringify((e as PlanError).detail)).toContain('3D layer');
	});

	/** Media an engine does not have: the offline case of `export.test.ts`. */
	const offline = { locators: [{ type: 'engine-store', engineId: 'x', key: 'mk_ffffffffffffffffffffffff' }] };

	it('refuses by name when the HDR of an environment light is gone; with the file there it plans', async () => {
		const file = join(dir, 'env.hdr');
		writeFileSync(file, hdrFile(4, 2, new Array<number>(4 * 2 * 4).fill(128)));
		const m = await register(app, file);
		const withEnv = (mediaId: string, d: DocBuilder) => {
			d.tx([
				{ type: 'clip.addLight', at: 0, duration: 30, lightType: 'environment', environmentMediaId: mediaId },
			]);
			return d;
		};
		const online = goldTitle();
		const ok = await plan(withEnv(online.addMedia(m), online), caps(true));
		expect(ok.plan.path).toBe('remotion');
		const gone = goldTitle();
		const e = await plan(withEnv(gone.addMedia({ ...m, ...offline } as never), gone), caps(true)).catch(
			(x) => x,
		);
		expect(e).toBeInstanceOf(PlanError);
		expect((e as PlanError).code).toBe('THREE_D_ASSET_MISSING');
		expect(JSON.stringify((e as PlanError).detail)).toContain('Environment');
	});

	it('refuses by name when a 3D model is gone', async () => {
		const obj = join(dir, 'tri.obj');
		writeFileSync(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
		const m = await register(app, obj);
		const place = (d: DocBuilder, mediaId: string) => {
			d.tx([{ type: 'sequence.set3dRenderer', renderer: 'advanced' }]);
			d.tx([{ type: 'clip.place', source: { mediaId }, at: 0 }]);
			return d;
		};
		const online = new DocBuilder();
		expect((await plan(place(online, online.addMedia(m)), caps(true))).plan.path).toBe('remotion');
		const gone = new DocBuilder();
		const e = await plan(place(gone, gone.addMedia({ ...m, ...offline } as never)), caps(true)).catch(
			(x) => x,
		);
		expect(e).toBeInstanceOf(PlanError);
		expect((e as PlanError).code).toBe('THREE_D_ASSET_MISSING');
		expect(JSON.stringify((e as PlanError).detail)).toContain('3D model');
	});
});

describe('Advanced 3D limits in the plan (AGENTS §4)', () => {
	const capsWith = (maxRenderbufferSize?: number): PlanCapabilities => ({
		...caps(true),
		webgl: async () => ({
			state: 'ok',
			floatTargets: true,
			...(maxRenderbufferSize ? { maxRenderbufferSize } : {}),
		}),
	});

	it('warns by name when lights or shadows pass the renderer’s limits, or supersampling the GPU’s', async () => {
		const d = goldTitle();
		d.tx([{ type: 'sequence.set3dRenderer', supersampling: 4 }]);
		d.tx(
			Array.from({ length: 33 }, () => ({
				type: 'clip.addLight',
				at: 0,
				duration: 30,
				lightType: 'point',
				castsShadows: true,
			})),
		);
		const p = await plan(d, capsWith(4096));
		const codes = p.plan.warnings.map((w) => w.code);
		expect(codes).toEqual(
			expect.arrayContaining([
				'THREE_D_LIGHTS_LIMIT',
				'THREE_D_SHADOWS_LIMIT',
				'THREE_D_SUPERSAMPLING_LIMIT',
			]),
		);
		// 1920 × 1080 on 4096 px render buffers: 2×, not 4×.
		expect(p.plan.warnings.find((w) => w.code === 'THREE_D_SUPERSAMPLING_LIMIT')!.message).toContain('2×');
	});

	it('says nothing within them', async () => {
		const d = goldTitle();
		d.tx([{ type: 'clip.addLight', at: 0, duration: 30, lightType: 'point', castsShadows: true }]);
		const codes = (await plan(d, capsWith(16384))).plan.warnings.map((w) => w.code);
		expect(codes.filter((c) => c.startsWith('THREE_D_'))).toEqual([]);
	});
});
