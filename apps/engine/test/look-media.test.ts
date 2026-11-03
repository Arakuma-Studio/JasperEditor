// Spec 19 TL-021 in the engine: a look's picture reaches the export snapshot and the layer bake key, and an offline one
// refuses the export by name (AGENTS §4: the look is never drawn without it), as a missing 3D asset does.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

/** A 4×4 PNG. */
const RED =
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC';

const settings = (seqId: string) => ({
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
});

describe('a look’s media in exports (TL-021)', { timeout: 180_000 }, () => {
	let app: TestApp;
	let picture: Awaited<ReturnType<typeof register>>;
	beforeAll(async () => {
		app = await makeApp();
		const dir = mkdtempSync(join(tmpdir(), 'jasper-look-'));
		writeFileSync(join(dir, 'panorama.png'), Buffer.from(RED, 'base64'));
		picture = await register(app, join(dir, 'panorama.png'));
	}, 120_000);
	afterAll(() => closeApps());

	const titled = (mediaId: string, d: DocBuilder) => {
		const r = d.tx([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Mirror' }, ref: '$t' },
			{
				type: 'look.apply',
				clipIds: ['$t'],
				look: {
					name: 'Mirror',
					recipe: {
						layers: [{ type: 'face', params: { finish: 'reflection', reflectionImage: { mediaId } } }],
					},
				},
			},
		]);
		return r.refs!.$t as string;
	};
	const planRes = (d: DocBuilder) =>
		app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
	const plan = async (d: DocBuilder) => {
		const res = await planRes(d);
		expect(res.statusCode, res.body).toBe(200);
		return res.json() as { warnings: { code: string; itemIds?: string[] }[] };
	};

	it('an online picture plans clean', async () => {
		const d = new DocBuilder('hd-720p-30');
		titled(d.addMedia(picture), d);
		expect((await plan(d)).warnings.map((w) => w.code)).not.toContain('LOOK_MEDIA_OFFLINE');
	});

	it('an offline picture refuses the export, naming the picture and the clip that uses it', async () => {
		const d = new DocBuilder('hd-720p-30');
		const id = d.addMedia({
			...picture,
			locators: [{ type: 'engine-store', engineId: 'x', key: 'mk_ffffffffffffffffffffffff' }],
		});
		const clipId = titled(id, d);
		const res = await planRes(d);
		expect(res.statusCode, res.body).toBe(409);
		const body = res.json() as {
			code: string;
			message: string;
			detail: { blockers: { itemId?: string; reason: string }[] };
		};
		expect(body.code).toBe('LOOK_MEDIA_OFFLINE');
		expect(body.message).toContain('panorama.png');
		expect(body.detail.blockers).toEqual([expect.objectContaining({ itemId: clipId })]);
		expect(body.detail.blockers[0]!.reason).toContain('look picture');
	});
});
