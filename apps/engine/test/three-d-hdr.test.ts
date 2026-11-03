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
			payload: JSON.stringify({ path: file }),
		});
		expect(res.statusCode).toBeGreaterThanOrEqual(400);
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
		expect(p.path).toBe('remotion');
		const e = await plan(goldTitle(), caps(false)).catch((x) => x);
		expect(e).toBeInstanceOf(PlanError);
		expect((e as PlanError).code).toBe('THREE_D_NEEDS_FLOAT');
		expect(JSON.stringify((e as PlanError).detail)).toContain('3D layer');
	});

	it('refuses by name when the HDR of an environment light is gone', async () => {
		const d = goldTitle();
		const file = join(dir, 'gone.hdr');
		writeFileSync(file, hdrFile(4, 2, new Array<number>(4 * 2 * 4).fill(128)));
		const m = await register(app, file);
		d.tx([{ type: 'media.register', asset: m, ref: '$m' }]);
		const id = Object.values(d.doc().media).find((x) => x.kind === 'hdri')!.id;
		d.tx([{ type: 'clip.addLight', at: 0, duration: 30, lightType: 'environment', environmentMediaId: id }]);
		rmSync(file);
		const e = await plan(d, caps(true)).catch((x) => x);
		expect(e).toBeInstanceOf(PlanError);
		expect((e as PlanError).code).toBe('THREE_D_ASSET_MISSING');
	});
});
