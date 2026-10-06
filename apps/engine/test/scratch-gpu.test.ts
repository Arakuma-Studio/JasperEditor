import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, it } from 'vitest';
import { closeApps, DocBuilder, ensureFixtures, fixture, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

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
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

async function plan(name: string, d: DocBuilder) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
	});
	const p = r.json();
	appendFileSync('/tmp/nae/gpuplan.txt', `${name}: ${r.statusCode} path=${p.path} blockers=${JSON.stringify(p.blockers)} groups=${JSON.stringify(p.segments?.[0]?.graphicsGroups)}\n`);
}

it('plans', async () => {
	const m = await register(app, fixture('clip-a.mp4'));
	for (const [name, fx] of [
		['video+flicker', 'jasper.s.flicker'],
		['video+bevel', 'jasper.bevel-edges'],
	] as const) {
		const d = new DocBuilder();
		const a = d.addMedia(m);
		const r = d.tx([{ type: 'clip.place', source: { mediaId: a }, at: 0, ref: '$v' }]);
		d.tx([{ type: 'effect.add', target: { clipId: r.refs.$v }, effectId: fx }]);
		await plan(name, d);
	}
	{
		const d = new DocBuilder();
		const r = d.tx([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1], ref: '$s' }]);
		d.tx([{ type: 'effect.add', target: { clipId: r.refs.$s }, effectId: 'jasper.s.flicker' }]);
		await plan('solid+flicker', d);
	}
	{
		const d = new DocBuilder();
		const r = d.tx([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hi' }, ref: '$t' }]);
		d.tx([{ type: 'effect.add', target: { clipId: r.refs.$t }, effectId: 'jasper.s.flicker' }]);
		await plan('text+flicker', d);
	}
	{
		const d = new DocBuilder();
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1] },
			{ type: 'transition.add', trackId: 'V1', at: 30, effectId: 'jasper.push', duration: 20 },
		]);
		await plan('solids+push', d);
	}
}, 120_000);
