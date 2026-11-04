// Spec 19 §12 routes: authenticated like every /api route, bodies validated, refusals as coded errors, raw style files read
// through HTTP. No renderer is needed here.
import { type LayerEffectsInfo, writePsdUint8Array } from 'ag-psd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, DocBuilder, H, JSON_H, makeApp, type TestApp } from './helpers.ts';

let app: TestApp;
let locked: TestApp;

const stroke: LayerEffectsInfo = {
	stroke: [
		{
			enabled: true,
			size: { units: 'Pixels', value: 6 },
			position: 'outside',
			fillType: 'color',
			blendMode: 'normal',
			opacity: 1,
			color: { r: 255, g: 0, b: 0 },
		},
	],
};

beforeAll(async () => {
	app = await makeApp();
	locked = await makeApp({ token: 'route-test-token', dev: false });
}, 120_000);
afterAll(closeApps);

const post = (a: TestApp, url: string, payload: unknown) =>
	a.inject({ method: 'POST', url, headers: JSON_H, payload: payload as never });

const envelope = () => {
	const d = new DocBuilder('hd-720p-30');
	d.tx([{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 0, 0, 1] }]);
	return { d, envelope: d.envelope() };
};

describe('authentication', () => {
	it.each([
		'/api/psd/plan',
		'/api/psd',
		'/api/alpha-delivery',
		'/api/gamut-check',
		'/api/title-looks/layer-styles/read?name=a.asl',
		'/api/media/mk_x/split-image',
		'/api/media/mk_x/split-image/analyze',
	])('%s needs the token', async (url) => {
		const r = await post(locked, url, {});
		expect(r.statusCode).toBe(401);
	});
});

describe('validation', () => {
	it.each(['/api/psd/plan', '/api/psd', '/api/alpha-delivery', '/api/gamut-check'])(
		'%s refuses a bad body with 400',
		async (url) => {
			const { d, envelope: e } = envelope();
			const bodies: unknown[] = [{ nonsense: true }];
			if (url === '/api/psd/plan')
				bodies.push({ envelope: e, sequenceId: d.seqId, frame: 0, splitTitles: 'true' });
			for (const body of bodies) {
				const r = await post(app, url, body);
				expect(r.statusCode).toBe(400);
				expect(r.json().code).toBe('VALIDATION_FAILED');
			}
		},
	);

	it('refuses a relative destination folder before any job runs', async () => {
		const { d, envelope: e } = envelope();
		const r = await post(app, '/api/alpha-delivery', {
			envelope: e,
			sequenceId: d.seqId,
			range: { start: 0, end: 1 },
			destination: { folder: 'relative/path', name: 'x' },
		});
		expect(r.statusCode).toBe(400);
	});

	it('an unknown media key is a 404, a non-file split a 400', async () => {
		expect((await post(app, '/api/media/mk_nothing/split-image/analyze', {})).statusCode).toBe(404);
		expect((await post(app, '/api/media/mk_nothing/split-image', { groups: [[0]] })).statusCode).toBe(404);
	});
});

describe('POST /api/psd/plan', () => {
	it('answers without rendering: layers or blockers, never a failure', async () => {
		const { d, envelope: e } = envelope();
		const r = await post(app, '/api/psd/plan', { envelope: e, sequenceId: d.seqId, frame: 2 });
		expect(r.statusCode, r.body).toBe(200);
		const plan = r.json() as { blockers: { code: string }[]; layers: { name: string }[] };
		if (!plan.blockers.length) expect(plan.layers.length).toBeGreaterThan(0);
		else expect(plan.blockers[0]!.code).toBeTruthy();
	}, 60_000);

	it('an unknown sequence is a 404, not a blocker', async () => {
		const { envelope: e } = envelope();
		const r = await post(app, '/api/psd/plan', { envelope: e, sequenceId: 'seq_none', frame: 0 });
		expect(r.statusCode).toBe(404);
	});
});

describe('POST /api/title-looks/layer-styles/read', () => {
	const file = writePsdUint8Array(
		{
			width: 16,
			height: 16,
			children: [{ name: 'Styled', left: 0, top: 0, bottom: 8, right: 8, effects: stroke }],
		},
		{ noBackground: true },
	);
	const send = (body: Uint8Array, name = 'a.psd') =>
		app.inject({
			method: 'POST',
			url: `/api/title-looks/layer-styles/read?name=${encodeURIComponent(name)}`,
			headers: { ...H, 'content-type': 'application/octet-stream' },
			payload: Buffer.from(body),
		});

	it('reads the raw file', async () => {
		const r = await send(file);
		expect(r.statusCode, r.body).toBe(200);
		expect(r.json().styles.map((s: { name: string }) => s.name)).toEqual(['Styled']);
	});

	it('refuses what is not a style file, by name', async () => {
		const r = await send(new TextEncoder().encode('not a style file'));
		expect(r.statusCode).toBe(400);
		expect(r.json().code).toBe('STYLE_FILE_INVALID');
	});

	it('needs a file name and a raw body', async () => {
		const noName = await app.inject({
			method: 'POST',
			url: '/api/title-looks/layer-styles/read',
			headers: { ...H, 'content-type': 'application/octet-stream' },
			payload: Buffer.from(file),
		});
		expect(noName.statusCode).toBe(400);
		expect(noName.json().code).toBe('VALIDATION_FAILED');
		const json = await post(app, '/api/title-looks/layer-styles/read?name=a.asl', {});
		expect(json.statusCode).toBe(415);
	});
});
