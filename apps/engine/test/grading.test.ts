// color-grade: the grading analysis routes — `POST /api/grading/scopes` (Lumetri Scopes as numbers of a rendered
// frame, whole Program or one clip alone), `/api/grading/match` (Colour Match into Lumetri params, Face Detection
// falling back to the skin-tone test without the face model) and `/api/grading/auto-tone`. Native stills (ffmpeg).
import { BRIGHTNESS_CONTRAST_EFFECT, LUMETRI_EFFECT_ID, readScopes, signalFromRgba8 } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
}, 180_000);
afterAll(closeApps);

/** Two chart clips: A (0–29, optionally darkened, with a neutral Lumetri) and B (30–59, warm Lumetri grade). */
async function twoClips(opts: { darkenA?: boolean } = {}) {
	const chart = await register(app, fixture('chart.png'));
	const d = new DocBuilder();
	const m = d.addMedia(chart);
	const place = (at: number, ref: string) => ({
		type: 'clip.place',
		source: { mediaId: m },
		at,
		sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
		ref,
	});
	const { refs } = d.tx([place(0, '$a'), place(30, '$b')]);
	const a = refs.$a!;
	const b = refs.$b!;
	if (opts.darkenA)
		d.tx([
			{
				type: 'effect.add',
				target: { clipId: a },
				effectId: BRIGHTNESS_CONTRAST_EFFECT.id,
				params: { brightness: -45, contrast: -30 },
			},
		]);
	const fxA = d.tx([
		{
			type: 'effect.add',
			target: { clipId: a },
			effectId: LUMETRI_EFFECT_ID,
			params: { exposure: 0 },
			ref: '$fa',
		},
	]).refs.$fa!;
	d.tx([
		{
			type: 'effect.add',
			target: { clipId: b },
			effectId: LUMETRI_EFFECT_ID,
			params: { highlightsWheel: [0.6, 0.15], shadowsWheel: [-0.4, -0.5], saturation: 130 },
		},
	]);
	return { d, a, b, fxA };
}

const post = (url: string, payload: Record<string, unknown>) =>
	app.inject({ method: 'POST', url, headers: JSON_H, payload: payload as never });

describe('POST /api/grading/scopes', () => {
	it('reads every scope of a Program frame as numbers, like the panel maths on the same frame', async () => {
		const { d } = await twoClips();
		const r = await post('/api/grading/scopes', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 5,
			columns: 4,
			peaks: 3,
			width: 480,
		});
		expect(r.statusCode).toBe(200);
		const j = r.json();
		expect(j.samples[0]).toBeGreaterThan(100);
		expect(j.stats.samples).toBeGreaterThan(1000);
		expect(j.waveform.traces.R).toHaveLength(4);
		expect(j.parade.type).toBe('rgb');
		expect(j.histogram.r).toHaveLength(256);
		expect(j.vectorscopeYuv.peaks).toHaveLength(3);
		expect(j.vectorscopeHls.samples).toBeGreaterThan(0);
		// The same maths on a synthetic frame gives the same structure (shared code).
		const local = readScopes(signalFromRgba8(new Uint8Array(4 * 4 * 4).fill(255), 4, 4));
		expect(Object.keys(j)).toEqual(expect.arrayContaining(Object.keys(local)));
	});

	it('one clip alone; unknown clips are 404', async () => {
		const { d, b } = await twoClips();
		const r = await post('/api/grading/scopes', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 40,
			clipId: b,
			scopes: ['histogram'],
			bins: false,
			width: 320,
		});
		expect(r.statusCode).toBe(200);
		expect(r.json().clipId).toBe(b);
		expect(r.json().waveform).toBeUndefined();
		expect(r.json().histogram.r).toBeUndefined();
		const bad = await post('/api/grading/scopes', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 0,
			clipId: 'clp_nope',
		});
		expect(bad.statusCode).toBe(404);
		expect(bad.json().code).toBe('CLIP_NOT_FOUND');
	});
});

describe('POST /api/grading/match', () => {
	it('solves the clip’s wheels towards the warm reference; Face Detection falls back to the skin-tone test', async () => {
		const { d, a, fxA } = await twoClips();
		const r = await post('/api/grading/match', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			clipId: a,
			frame: 5,
			reference: { sequenceId: d.seqId, frame: 40 },
		});
		expect(r.statusCode).toBe(200);
		const j = r.json();
		expect(j.effectId).toBe(fxA);
		expect(j.after).toBeLessThan(j.before * 0.6);
		// Warm highlights (wheel angle near red) and more saturation, like the reference grade.
		expect(j.params.highlightsWheel[0]).toBeGreaterThan(0.05);
		expect(j.params.saturation).toBeGreaterThan(100);
		expect(j.skin).toBe('hue');
		expect(j.faceNote).toMatch(/FACE_MODEL_NOT_INSTALLED|ORT_UNAVAILABLE/);
	}, 120_000);

	it('refuses a frame outside the clip and an unknown Lumetri instance', async () => {
		const { d, a } = await twoClips();
		const out = await post('/api/grading/match', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			clipId: a,
			frame: 45,
			reference: { sequenceId: d.seqId, frame: 40 },
		});
		expect(out.statusCode).toBe(400);
		const fx = await post('/api/grading/match', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			clipId: a,
			effectId: 'fx_nope',
			frame: 5,
			reference: { sequenceId: d.seqId, frame: 40 },
		});
		expect(fx.statusCode).toBe(404);
	});
});

describe('POST /api/grading/auto-tone', () => {
	it('brightens and stretches a darkened, flattened clip (the picture before its Lumetri)', async () => {
		const { d, a } = await twoClips({ darkenA: true });
		const r = await post('/api/grading/auto-tone', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			clipId: a,
			frame: 5,
		});
		expect(r.statusCode).toBe(200);
		const j = r.json();
		expect(j.params.exposure).toBeGreaterThan(0.2);
		expect(j.after[4] - j.after[0]).toBeGreaterThan(j.before[4] - j.before[0]);
	}, 120_000);
});
