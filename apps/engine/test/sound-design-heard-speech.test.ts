// The masking solver's speech is what the mix lets through (spec 12 §2.4 dialogue guard, P6-R3; wp-note "WP6.5b
// solver"): on a real engine with the Phase 4 fixture (untranscribed dialogue on A2 speaking 4–8 s, a click at 5 s),
// the click overlaps speech — until the dialogue clip is muted by its gain, ducked out by Volume keyframes from 4.5 s,
// or its track muted by automation over that stretch. Voice activity is still measured on the media (unchanged); the
// mix gains decide whether that voice is heard.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Keyframe, ProjectDocument, Sequence } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeasureCache, type MeasureDeps, measureSfxEvents } from '../src/sound-design/bed.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';
import { provenance, writeBedFixture } from './sound-bed-fixture.ts';

const F = 705_600_000 / 30;
let app: TestApp;
let deps: MeasureDeps;
let d: DocBuilder;
const ids: Record<string, string> = {};

beforeAll(async () => {
	app = await makeApp();
	const core = coreServices(app);
	deps = { ff: core.ffmpeg, registry: core.registry, cache: new MeasureCache() };
	const files = writeBedFixture(mkdtempSync(join(tmpdir(), 'jasper-heard-')));
	const b = new DocBuilder('hd-1080p-30', 300);
	const music = b.addMedia(await register(app, files.music));
	const speech = b.addMedia(await register(app, files.speech));
	const click = b.addMedia(await register(app, files.click));
	const r = b.tx([
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
		{ type: 'media.setLibraryInfo', mediaId: click, library: provenance('click') },
	]);
	ids.music = r.refs.$m!;
	ids.speech = r.refs.$s!;
	b.tx([
		{ type: 'essentialSound.setType', clipIds: [ids.music], audioType: 'music' },
		{ type: 'essentialSound.setType', clipIds: [ids.speech], audioType: 'dialogue' },
	]);
	ids.click = b.tx([
		{ type: 'soundDesign.place', frame: 150, layers: [{ mediaId: click, role: 'support', align: 'peak', ref: '$x' }] },
	]).refs.$x!;
	d = b;
}, 120_000);
afterAll(closeApps);

const key = (id: string, time: number, value: number): Keyframe<number> => ({
	id,
	time,
	value,
	interpolation: 'hold',
	easeIn: { influence: 1 / 3, slope: 0 },
	easeOut: { influence: 1 / 3, slope: 0 },
});

function variant(f: (seq: Sequence) => void): ProjectDocument {
	const doc = structuredClone(d.doc) as ProjectDocument;
	f(doc.sequences[d.seqId]!);
	return doc;
}

async function clickSpeech(doc: ProjectDocument) {
	const m = await measureSfxEvents(
		{ bedDoc: doc, sequenceId: d.seqId, targets: [{ doc, clipId: ids.click!, weight: 'support' }] },
		deps,
	);
	const s = m.sounds.get(ids.click!)!;
	return { speech: s.speechOverlap, tracks: s.speechTracks };
}

describe('the solver hears the dialogue the mix lets through (real engine)', { timeout: 300_000 }, () => {
	it('speech under the click, unless the dialogue is muted, ducked out or its track muted there', async () => {
		expect(await clickSpeech(d.doc)).toEqual({ speech: true, tracks: ['A2'] });
		// clip gain −96 dB (−∞ on the fader scale)
		const muted = variant((seq) => {
			(seq.clips[ids.speech!] as { gainDb: number }).gainDb = -96;
		});
		expect(await clickSpeech(muted)).toEqual({ speech: false, tracks: [] });
		// Volume keyframes ducking out the clip from 4.5 s (content time) to −60 dB
		const ducked = variant((seq) => {
			(seq.clips[ids.speech!] as unknown as { volumeDb: unknown }).volumeDb = {
				value: 0,
				keyframes: [key('k0', 0, 0), key('k1', 135 * F, -60)],
			};
		});
		expect((await clickSpeech(ducked)).speech).toBe(false);
		// ducked only by −20 dB: still heard
		const soft = variant((seq) => {
			(seq.clips[ids.speech!] as unknown as { volumeDb: unknown }).volumeDb = {
				value: 0,
				keyframes: [key('k0', 0, 0), key('k1', 135 * F, -20)],
			};
		});
		expect((await clickSpeech(soft)).speech).toBe(true);
		// the dialogue track muted by automation from 4.5 s to 6 s
		const trackMuted = variant((seq) => {
			const t = seq.audioTracks.find((x) => x.id === seq.clips[ids.speech!]!.trackId)! as unknown as {
				mixer?: Record<string, unknown>;
			};
			t.mixer = {
				...(t.mixer ?? {}),
				lanes: { mute: { value: 0, keyframes: [key('m0', 0, 0), key('m1', 135 * F, 1), key('m2', 180 * F, 0)] } },
			};
		});
		expect((await clickSpeech(trackMuted)).speech).toBe(false);
	});
});
