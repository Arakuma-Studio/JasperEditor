// The Sound Check fixture (spec 12 §2.6, P5-R4; wp-note "Phase 5 → WP5.1"): generated media (sound-bed-fixture.ts) on a
// 10 s, 30 fps sequence that passes every check, and the seeded defects built on it. Nothing committed.
//   A1  music: 10 s stereo pink noise (Essential Sound music), A2 dialogue: a syllabic 1.5 kHz tone from 4 to 8 s
//   cue A  frame  30 (1 s)    cut, hero     → "Test hit 0"   (hit.wav)
//   cue B  frame  90 (3 s)    cut, support  → "Test click 0" (click.wav)
//   cue C  frame 255 (8.5 s)  land, hero    → "Test hit 1"   (hit2.wav: the hit 2 dB quieter, another sound)
//   the Mix normalises to −14 LUFS / −1 dBTP (web), the sequence's delivery
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from '@jasper/audio-dsp';
import type { LibraryProvenance, ProjectDocument } from '@jasper/project';
import { DocBuilder, register, type TestApp } from './helpers.ts';
import { hitSamples, provenance, SR, writeBedFixture } from './sound-bed-fixture.ts';

export type FixtureMedia = Record<
	'music' | 'speech' | 'hit' | 'hit2' | 'click',
	Awaited<ReturnType<typeof register>>
>;

/** Writes and registers the fixture's media once (shared by every variant). */
export async function registerCheckMedia(app: TestApp, dir: string, token: string): Promise<FixtureMedia> {
	const files = writeBedFixture(dir);
	const hit2 = join(dir, 'hit2.wav');
	const h = hitSamples().map((c) => c.map((v) => v * 0.8));
	writeFileSync(hit2, encodeWav(h, SR, 's16'));
	const auth = { authorization: `Bearer ${token}` };
	return {
		music: await register(app, files.music, auth),
		speech: await register(app, files.speech, auth),
		hit: await register(app, files.hit, auth),
		hit2: await register(app, hit2, auth),
		click: await register(app, files.click, auth),
	};
}

export type CheckFixture = {
	b: DocBuilder;
	ids: {
		music: string;
		speech: string;
		hitMedia: string;
		hit2Media: string;
		clickMedia: string;
		cueA: string;
		cueB: string;
		cueC: string;
		clipA: string;
		clipB: string;
		clipC: string;
	};
	doc(): ProjectDocument;
};

export type FixtureOptions = {
	/** Licence of the click / the second hit (default LicenseRef-JasperEditor). */
	clickLicense?: string;
	hit2License?: string;
	hit2Attribution?: string | null;
	/** Cue B: weight and media (`hit` makes A and B the same sound back to back), its frame and alternatives. */
	cueB?: { weight?: 'hero' | 'support'; media?: 'click' | 'hit'; frame?: number; alternatives?: string[] };
	/** Music split around a hole `[from, to)` seconds (a digital silence in the mix). */
	musicHole?: [number, number];
	/** Without the dialogue clip. */
	noSpeech?: boolean;
};

const HIT2_PROV = (license: string, attribution: string | null): LibraryProvenance => ({
	...provenance('hit', 1),
	license,
	attribution,
	author: 'Fixture author',
});

/** Builds the clean fixture, or a variant (see the module docs). */
export function buildCheckDoc(m: FixtureMedia, o: FixtureOptions = {}): CheckFixture {
	const b = new DocBuilder('hd-1080p-30', 900);
	const music = b.addMedia(m.music);
	const speech = b.addMedia(m.speech);
	const hit = b.addMedia(m.hit);
	const hit2 = b.addMedia(m.hit2);
	const click = b.addMedia(m.click);
	const clickProv = { ...provenance('click'), ...(o.clickLicense ? { license: o.clickLicense } : {}) };
	const musicClips: string[] = [];
	const base = b.tx([
		{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
		{
			type: 'media.setLibraryInfo',
			mediaId: hit2,
			library: HIT2_PROV(o.hit2License ?? 'LicenseRef-JasperEditor', o.hit2Attribution ?? null),
		},
		{ type: 'media.setLibraryInfo', mediaId: click, library: clickProv },
		...(o.noSpeech
			? []
			: [{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' }]),
	]);
	if (o.musicHole) {
		const [from, to] = o.musicHole;
		const r = b.tx([
			{
				type: 'clip.place',
				source: { mediaId: music },
				sourceRange: { in: { seconds: 0 }, out: { seconds: from } },
				at: 0,
				tracks: { audio: 'A1' },
				ref: '$m1',
			},
			{
				type: 'clip.place',
				source: { mediaId: music },
				sourceRange: { in: { seconds: to }, out: { seconds: 10 } },
				at: { seconds: to },
				tracks: { audio: 'A1' },
				ref: '$m2',
			},
		]);
		musicClips.push(r.refs.$m1!, r.refs.$m2!);
	} else {
		const r = b.tx([
			{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		]);
		musicClips.push(r.refs.$m!);
	}
	b.tx([
		{ type: 'essentialSound.setType', clipIds: musicClips, audioType: 'music' },
		...(o.noSpeech
			? []
			: [{ type: 'essentialSound.setType', clipIds: [base.refs.$s!], audioType: 'dialogue' }]),
		{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
	]);
	const cue = (
		frame: number,
		kind: string,
		weight: 'hero' | 'support',
		mediaId: string,
		role: 'hero' | 'support',
		alternatives?: string[],
	) => {
		const r = b.tx([
			{ type: 'soundCue.add', cues: [{ frame, kind, weight, source: 'user', ref: '$c' }] },
			{
				type: 'soundDesign.place',
				cueId: '$c',
				layers: [{ mediaId, role, align: 'peak', ref: '$x' }],
				...(alternatives ? { alternatives } : {}),
			},
		]);
		return { cue: r.refs.$c!, clip: r.refs.$x! };
	};
	const A = cue(30, 'cut', 'hero', hit, 'hero');
	const bw = o.cueB?.weight ?? 'support';
	const B = cue(
		o.cueB?.frame ?? 90,
		'cut',
		bw,
		o.cueB?.media === 'hit' ? hit : click,
		bw,
		o.cueB?.alternatives,
	);
	const C = cue(255, 'land', 'hero', hit2, 'hero');
	return {
		b,
		ids: {
			music: musicClips[0]!,
			speech: o.noSpeech ? '' : base.refs.$s!,
			hitMedia: hit,
			hit2Media: hit2,
			clickMedia: click,
			cueA: A.cue,
			cueB: B.cue,
			cueC: C.cue,
			clipA: A.clip,
			clipB: B.clip,
			clipC: C.clip,
		},
		doc: () => b.doc,
	};
}
