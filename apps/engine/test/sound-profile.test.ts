// Reference sound profiles (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4") on a real engine with generated "films":
// 20 s of stereo pink noise with a click on each of 10 picture cuts (0.5 cut/s, colour changes encoded as FFV1 video).
//   - a profile of three films (two by path, one as project media) gives the expected ranges; a 1 s file is skipped;
//   - a matching sequence (the same recipe, the cuts as colour mattes) passes every Reference row;
//   - a seeded mismatch (air −6 dB, 2 s of dead air, sound on 1 of 6 cuts) is flagged by the right rows with timecodes;
//   - a profile holding this very sequence scores it leave-one-out;
//   - export (GET) → import round-trips; hostile files are refused; a damaged file in the library is moved aside;
//   - rename; delete asks an agent's user (refused without an editor window), the editor deletes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type SoundCheckReport,
	SoundCheckResultSchema,
	SoundProfileBuildResultSchema,
	SoundProfileSchema,
	SoundProfilesResponseSchema,
} from '@jasper/api';
import { Biquad, designBiquad, encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';

const SR = 48_000;
const FPS = 25;
const DUR = 20;
const CUTS = Array.from({ length: 10 }, (_, i) => 1 + 2 * i);
const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_prof_0123456789abcdef0123';
const KEY = 'key_prof_0123456789abcdef0123';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'profile-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

let app: TestApp;
let dir = '';
let projects = 0;
const timings: { name: string; ms: number }[] = [];

// ── generated media ─────────────────────────────────────────────────────────────────────────────────────────────────
function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		return (s / 2 ** 32) * 2 - 1;
	};
}
function pink(n: number, seed: number): Float32Array {
	const r = rng(seed);
	const out = new Float32Array(n);
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let b3 = 0;
	let b4 = 0;
	let b5 = 0;
	let b6 = 0;
	for (let i = 0; i < n; i++) {
		const w = r();
		b0 = 0.99886 * b0 + w * 0.0555179;
		b1 = 0.99332 * b1 + w * 0.0750759;
		b2 = 0.969 * b2 + w * 0.153852;
		b3 = 0.8665 * b3 + w * 0.3104856;
		b4 = 0.55 * b4 + w * 0.5329522;
		b5 = -0.7616 * b5 - w * 0.016898;
		out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.01;
		b6 = w * 0.115926;
	}
	return out;
}
/** The 8–16 kHz "air" changed by `db` (a Linkwitz–Riley 4 crossover at 8 kHz: the bands sum flat at 0 dB). */
function air(x: Float32Array, db: number): Float32Array {
	if (db === 0) return x;
	const lp = [new Biquad(designBiquad('lowPass', SR, 8000, Math.SQRT1_2)), new Biquad(designBiquad('lowPass', SR, 8000, Math.SQRT1_2))];
	const hp = [new Biquad(designBiquad('highPass', SR, 8000, Math.SQRT1_2)), new Biquad(designBiquad('highPass', SR, 8000, Math.SQRT1_2))];
	const g = 10 ** (db / 20);
	const out = new Float32Array(x.length);
	for (let i = 0; i < x.length; i++) {
		const lo = lp[1]!.processSample(lp[0]!.processSample(x[i]!));
		const hi = hp[1]!.processSample(hp[0]!.processSample(x[i]!));
		out[i] = lo + g * hi;
	}
	return out;
}
type Recipe = {
	seed: number;
	clickAt: readonly number[];
	airDb?: number;
	/** Where the sound stops (default the end), and the fade before it (default 0.4 s). */
	soundSec?: number;
	fadeSec?: number;
	clickGain?: number;
};
/** A film's soundtrack: decorrelated stereo pink noise, a 20 ms 3 kHz click at each time, a 0.4 s fade at its end. */
function soundtrack(r: Recipe): Float32Array[] {
	const n = DUR * SR;
	const sound = Math.round((r.soundSec ?? DUR) * SR);
	const common = pink(n, r.seed * 7 + 1);
	const chans = [pink(n, r.seed * 7 + 2), pink(n, r.seed * 7 + 3)].map((c) => {
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = c[i]! * 0.8 + common[i]! * 0.6;
		return out;
	});
	for (const c of chans)
		for (const t of r.clickAt) {
			const at = Math.round(t * SR);
			for (let i = 0; i < 0.02 * SR && at + i < n; i++)
				c[at + i]! += (r.clickGain ?? 0.5) * Math.exp(-i / (SR * 0.003)) * Math.sin((2 * Math.PI * 3000 * i) / SR);
		}
	return chans.map((c0) => {
		const c = air(c0, r.airDb ?? 0);
		const fade = Math.round((r.fadeSec ?? 0.4) * SR);
		for (let i = 0; i < n; i++) {
			if (i >= sound) c[i] = 0;
			else if (i >= sound - fade) c[i]! *= (sound - i) / fade;
		}
		return c;
	});
}
const COLOURS: [number, number, number][] = [
	[230, 40, 40],
	[40, 200, 60],
	[40, 60, 230],
	[240, 220, 40],
	[200, 40, 200],
	[40, 210, 210],
];
/** A film: the soundtrack and a 64×36 FFV1 picture whose colour changes at each cut. */
function film(name: string, r: Recipe): string {
	const wav = join(dir, `${name}.wav`);
	writeFileSync(wav, encodeWav(soundtrack(r), SR, 's16'));
	const W = 64;
	const Hh = 36;
	const frames = DUR * FPS;
	const raw = Buffer.alloc(frames * W * Hh * 3);
	for (let f = 0; f < frames; f++) {
		const shot = CUTS.filter((c) => f >= Math.round(c * FPS)).length;
		const [cr, cg, cb] = COLOURS[(shot + r.seed) % COLOURS.length]!;
		for (let p = 0; p < W * Hh; p++) {
			const o = (f * W * Hh + p) * 3;
			raw[o] = cr;
			raw[o + 1] = cg;
			raw[o + 2] = cb;
		}
	}
	const rgb = join(dir, `${name}.rgb`);
	writeFileSync(rgb, raw);
	const out = join(dir, `${name}.mkv`);
	const res = spawnSync(
		TEST_FFMPEG,
		[
			...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${Hh}`, '-r', String(FPS), '-i', rgb],
			...['-i', wav, '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-shortest', out],
		],
		{ encoding: 'utf8' },
	);
	if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
	return out;
}

// ── harness ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(++projects + 900).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope({ ...doc, projectId }, { revision: 3, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' }),
		),
	);
	return projectId;
}
async function req(
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	url: string,
	body?: unknown,
	headers: Record<string, string> = AGENT_H,
) {
	return app.inject({
		method,
		url,
		headers: body === undefined ? headers : json(headers),
		...(body === undefined ? {} : { payload: JSON.stringify(body) }),
	});
}
async function waitJob(r: { statusCode: number; body: string; json(): unknown }): Promise<EngineJob> {
	expect(r.statusCode, r.body).toBe(202);
	return coreServices(app).queue.wait((r.json() as EngineJob).id);
}
async function build(body: Record<string, unknown>, name: string) {
	const t0 = Date.now();
	const job = await waitJob(await req('POST', '/api/sound-design/profiles', body));
	timings.push({ name, ms: Date.now() - t0 });
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return SoundProfileBuildResultSchema.parse(job.result);
}
async function getProfile(id: string) {
	const r = await req('GET', `/api/sound-design/profiles/${id}`);
	expect(r.statusCode, r.body).toBe(200);
	return SoundProfileSchema.parse(r.json());
}
async function check(projectId: string, name: string, extra: Record<string, unknown> = {}): Promise<SoundCheckReport> {
	const t0 = Date.now();
	const job = await waitJob(await req('POST', '/api/sound-design/check', { projectId, ...extra }));
	timings.push({ name, ms: Date.now() - t0 });
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return SoundCheckResultSchema.parse(job.result).report;
}
const rowsText = (r: SoundCheckReport) =>
	(r.reference?.rows ?? [])
		.map((x) => `${x.metric} ${x.status} ${x.value} [${x.range[0]}, ${x.range[1]}] ${x.weight}`)
		.join('\n');

/** A sequence: the soundtrack on A1, colour mattes on V1 cut at `cuts` (30 fps), 20 s long. */
async function sequenceDoc(r: Recipe, cuts: readonly number[], name: string): Promise<DocBuilder> {
	const b = new DocBuilder();
	const wav = join(dir, `${name}.wav`);
	writeFileSync(wav, encodeWav(soundtrack(r), SR, 's16'));
	const m = b.addMedia(await register(app, wav, { authorization: `Bearer ${TOKEN}` }));
	b.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' }, ref: '$a' }]);
	const fps = 30;
	const at = [0, ...cuts].map((s) => Math.round(s * fps));
	const end = DUR * fps;
	at.forEach((f, i) => {
		const len = (at[i + 1] ?? end) - f;
		const [cr, cg, cb] = COLOURS[i % COLOURS.length]!;
		const res = b.tx([
			{ type: 'synthetic.create', kind: 'color-matte', params: { color: [cr / 255, cg / 255, cb / 255, 1] }, ref: '$m' },
		]);
		const item =
			Object.values(b.doc.items).find(
				(it) => it.kind === 'synthetic' && (it as { syntheticId?: string }).syntheticId === res.refs.$m,
			) ??
			Object.values(b.doc.items)
				.filter((it) => it.kind === 'synthetic')
				.at(-1)!;
		b.tx([{ type: 'clip.place', source: { projectItemId: item.id }, at: f, tracks: { video: 'V1' } }]);
		const clip = Object.values(b.doc.sequences[b.seqId]!.clips).find((c) => c.kind !== 'audio' && c.start === f)!;
		if (len !== clip.duration) b.tx([{ type: 'clip.trim', clipId: clip.id, edge: 'out', deltaFrames: len - clip.duration }]);
	});
	return b;
}

let films: string[] = [];
let profileId = '';

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	dir = mkdtempSync(join(tmpdir(), 'jasper-profile-'));
	films = [
		film('film1', { seed: 1, clickAt: CUTS }),
		film('film2', { seed: 2, clickAt: CUTS, clickGain: 0.6 }),
		film('film3', { seed: 3, clickAt: CUTS, clickGain: 0.45 }),
	];
	const short = join(dir, 'short.wav');
	writeFileSync(short, encodeWav([pink(SR, 9)], SR, 's16'));
	films.push(short);
}, 180_000);
afterAll(async () => {
	console.log(`sound profile timings (ms): ${timings.map((t) => `${t.name} ${t.ms}`).join(', ')}`);
	await closeApps();
});

describe('reference sound profiles (real engine)', { timeout: 600_000 }, () => {
	it('a profile of three generated films gives the expected ranges; a 1 s file is skipped', async () => {
		// film 3 as project media, films 1 and 2 by path, the short file by path
		const b = new DocBuilder();
		const mediaId = b.addMedia(await register(app, films[2]!, { authorization: `Bearer ${TOKEN}` }));
		const projectId = seed(b.doc);
		const out = await build(
			{ name: 'Generated films', projectId, mediaIds: [mediaId], paths: [films[0], films[1], films[3]] },
			'build 3 films',
		);
		expect(out.profile.n).toBe(3);
		expect(out.skipped).toEqual([{ title: 'short.wav', reason: expect.stringMatching(/shorter than 3 s/) }]);
		profileId = out.profile.id;
		const p = await getProfile(profileId);
		expect(p.references.map((r) => r.title)).toEqual(['film3.mkv', 'film1.mkv', 'film2.mkv']);
		expect(p.references.every((r) => r.hasPicture && r.fps === FPS && r.kind === 'media')).toBe(true);
		// numbers only: no path, no audio
		expect(JSON.stringify(p)).not.toContain(dir);
		const m = p.metrics;
		console.log(`profile medians: ${Object.entries(m).map(([k, s]) => `${k} ${s.median} [${s.min}, ${s.max}]`).join('; ')}`);
		// the picture: 10 colour cuts in 20 s, each found by the scene detector, each with its click
		expect(m.cut_rate).toMatchObject({ n: 3, min: 0.5, max: 0.5 });
		expect(m.cuts_with_sound).toMatchObject({ n: 3, min: 1, max: 1 });
		expect(m.cut_frame_sync).toMatchObject({ min: 1, max: 1 });
		expect(p.chance.cuts_with_sound!.median!).toBeLessThan(0.3);
		// one onset per click: 0.5 onsets/s; a hit per click
		expect(m.onset_rate!.min!).toBeGreaterThanOrEqual(0.45);
		expect(m.onset_rate!.max!).toBeLessThanOrEqual(0.8);
		expect(m.hit_rate!.min!).toBeGreaterThanOrEqual(0.4);
		// sound from the first sample to the end, no gap, a short fade
		expect(m.first_sound_s!.max!).toBeLessThan(0.05);
		expect(m.end_silence_s!.max!).toBeLessThan(0.05);
		expect(m.max_gap_s!.max).toBe(0);
		expect(m.fade_s!.max!).toBeLessThan(0.5);
		// a pink bed (−34 dBFS) under 3 kHz clicks: air ≈ −12 dB of the total, three films within 1 dB of each other;
		// partly correlated stereo
		expect(m.band_air!.median!).toBeGreaterThan(-15);
		expect(m.band_air!.median!).toBeLessThan(-9);
		expect(m.band_air!.max! - m.band_air!.min!).toBeLessThan(1);
		expect(m.correlation!.median!).toBeGreaterThan(0.2);
		expect(m.correlation!.median!).toBeLessThan(0.6);
		expect(p.arc!.median).toHaveLength(11);
		const list = SoundProfilesResponseSchema.parse((await req('GET', '/api/sound-design/profiles')).json());
		expect(list.paths).toBe(true);
		expect(list.profiles.map((x) => x.id)).toContain(profileId);
	});

	it('a matching sequence passes every row; a seeded mismatch is flagged by the right rows with timecodes', async () => {
		const ok = await sequenceDoc({ seed: 4, clickAt: CUTS }, CUTS, 'match');
		ok.tx([{ type: 'soundDesign.setSettings', referenceProfile: profileId }]);
		const okReport = await check(seed(ok.doc), 'check matching');
		const ref = okReport.reference!;
		expect(ref, JSON.stringify(okReport.warnings)).toBeDefined();
		const { rows: _rows, ...head } = ref;
		expect(head).toMatchObject({ profileId, source: 'sequence', n: 3, scoredAgainst: 3, leaveOneOut: null });
		expect(ref.rows.filter((r) => r.status === 'low' || r.status === 'high'), rowsText(okReport)).toEqual([]);
		expect(okReport.issues.filter((i) => i.code === 'REFERENCE')).toEqual([]);
		expect(ref.counts.scored).toBeGreaterThan(15);
		expect(ref.rows.find((r) => r.metric === 'cut_rate')!.value).toBeCloseTo(0.5, 3);

		// air −6 dB, the sound stops 2 s early (hard), six cuts of which only the first has a click (the clicks are the
		// references' own, at the odd seconds: the same density and spectrum, off the picture)
		const six = [3, 6, 8.5, 10.5, 14, 16.5];
		const bad = await sequenceDoc(
			{ seed: 5, clickAt: CUTS.filter((t) => t < 18), airDb: -6, soundSec: 18, fadeSec: 0 },
			six,
			'mismatch',
		);
		const badReport = await check(seed(bad.doc), 'check mismatch', { profileId });
		console.log(`mismatch rows:\n${rowsText(badReport)}`);
		expect(badReport.reference!.source).toBe('request');
		const finding = (metric: string) => badReport.issues.find((i) => i.id === `REFERENCE:${metric}`);
		const airIssue = finding('band_air')!;
		expect(airIssue, rowsText(badReport)).toBeDefined();
		expect(airIssue).toMatchObject({ code: 'REFERENCE', category: 'reference', severity: 'info' });
		expect(airIssue.message.text).toMatch(/^Air 8–16 kHz share is low/);
		expect(airIssue.advice![0]!.text).toMatch(/^No air/);
		const dead = finding('end_silence_s')!;
		expect(dead).toMatchObject({ severity: 'warning', timecode: '00:00:18:00' });
		expect(dead.advice![0]!.text).toMatch(/^2\.0 s of dead air after the sound ends at 00:00:18:00/);
		const cuts = finding('cuts_with_sound')!;
		expect(cuts.severity).toBe('warning');
		expect(cuts.measured).toMatchObject({ value: 0.167, silentCuts: 5 });
		expect(cuts.advice![0]!.text).toBe(
			`5 of 6 picture events have no onset within 100 ms (chance ${Math.round((badReport.reference!.rows.find((r) => r.metric === 'cuts_with_sound')!.chance ?? 0) * 100)} %); no sound at all at 00:00:06:00, 00:00:08:15, 00:00:10:15, 00:00:14:00, 00:00:16:15: add a whoosh into the cut, a hit or a click there.`,
		);
		expect(cuts.timecode).toBe('00:00:06:00');
		// never an error; the rows the mismatch did not touch stay in range
		expect(badReport.issues.filter((i) => i.code === 'REFERENCE' && i.severity === 'error')).toEqual([]);
		for (const metric of ['band_low', 'band_mid', 'first_sound_s', 'max_gap_s'])
			expect(badReport.reference!.rows.find((r) => r.metric === metric)!.status, metric).toBe('ok');
		// null: no comparison even though the request could pick one
		const none = await check(seed(bad.doc), 'check without profile', { profileId: null });
		expect(none.reference).toBeUndefined();
		expect(none.issues.filter((i) => i.code === 'REFERENCE')).toEqual([]);
	});

	it('a profile holding this very sequence scores it leave-one-out; a missing profile is a warning', async () => {
		const b = await sequenceDoc({ seed: 6, clickAt: CUTS }, CUTS, 'loo');
		const projectId = seed(b.doc);
		const out = await build(
			{ name: 'With this sequence', projectId, sequenceIds: [b.seqId], paths: [films[0], films[1]] },
			'build with sequence',
		);
		const p = await getProfile(out.profile.id);
		expect(p.references[0]).toMatchObject({ kind: 'sequence', hasPicture: true });
		expect(p.references[0]!.fingerprint.startsWith(`${projectId}/${b.seqId}@`)).toBe(true);
		const r = await check(projectId, 'check loo', { profileId: out.profile.id });
		expect(r.reference!.leaveOneOut).toMatchObject({ referenceId: 'ref_1', by: 'identity' });
		expect(r.reference!.scoredAgainst).toBe(2);
		expect(r.warnings.map((w) => w.code)).toContain('W_REFERENCE_LEAVE_ONE_OUT');
		const missing = await check(projectId, 'check missing', { profileId: 'sprf_00000000000000aa' });
		expect(missing.reference).toBeUndefined();
		expect(missing.warnings.find((w) => w.code === 'W_REFERENCE_PROFILE_MISSING')?.message).toMatch(
			/sprf_00000000000000aa is not in the sound library/,
		);
	});

	it('export → import round-trips; hostile files are refused; a damaged library file is moved aside', async () => {
		const exported = (await req('GET', `/api/sound-design/profiles/${profileId}`)).json();
		const imp = await req('POST', '/api/sound-design/profiles/import', { profile: exported, name: 'Shared' });
		expect(imp.statusCode, imp.body).toBe(200);
		const copy = await getProfile((imp.json() as { id: string }).id);
		const orig = await getProfile(profileId);
		expect(copy.id).not.toBe(orig.id);
		expect(copy.name).toBe('Shared');
		expect(copy.references).toEqual(orig.references);
		expect(copy.metrics).toEqual(orig.metrics);
		const bad = async (profile: unknown) => {
			const r = await req('POST', '/api/sound-design/profiles/import', { profile });
			return [r.statusCode, (r.json() as { code?: string }).code];
		};
		expect(await bad({ ...(exported as object), format: 'earshot' })).toEqual([400, 'SOUND_PROFILE_INVALID']);
		expect(await bad({ ...(exported as object), references: [] })).toEqual([400, 'SOUND_PROFILE_INVALID']);
		const many = { ...(exported as { references: unknown[] }) };
		many.references = Array.from({ length: 21 }, (_, i) => ({ ...(many.references[0] as object), id: `ref_${i + 1}` }));
		expect(await bad(many)).toEqual([400, 'SOUND_PROFILE_INVALID']);
		expect(await bad('not a profile')).toEqual([400, 'SOUND_PROFILE_INVALID']);
		const tampered = JSON.parse(JSON.stringify(exported)) as { references: { metrics: Record<string, unknown> }[] };
		tampered.references[0]!.metrics.band_air = 'NaN';
		expect(await bad(tampered)).toEqual([400, 'SOUND_PROFILE_INVALID']);
		// a damaged file in the library: listed as unreadable, moved aside, never served
		const pdir = join(appdirPaths(app.appdir).soundsDir, 'profiles');
		writeFileSync(join(pdir, 'sprf_00000000000000bb.json'), '{"format": "jasper-sound-profile", "version": 1');
		const list = SoundProfilesResponseSchema.parse((await req('GET', '/api/sound-design/profiles')).json());
		expect(list.unreadable).toEqual([{ file: 'sprf_00000000000000bb.json', error: 'not JSON' }]);
		expect(existsSync(join(pdir, 'sprf_00000000000000bb.json'))).toBe(false);
		expect(readdirSync(pdir).some((f) => f.startsWith('sprf_00000000000000bb.json.unreadable-'))).toBe(true);
		expect((await req('GET', '/api/sound-design/profiles/sprf_00000000000000bb')).statusCode).toBe(404);
		expect((await req('GET', '/api/sound-design/profiles/..%2F..%2Fetc')).statusCode).toBe(404);
	});

	it('rename; an agent’s delete asks the user (refused without an editor window); the editor deletes', async () => {
		const r = await req('PUT', `/api/sound-design/profiles/${profileId}/name`, { name: 'My channel' });
		expect(r.statusCode, r.body).toBe(200);
		expect((await getProfile(profileId)).name).toBe('My channel');
		expect((await req('PUT', `/api/sound-design/profiles/${profileId}/name`, { name: '' })).statusCode).toBe(400);
		const del = await req('DELETE', `/api/sound-design/profiles/${profileId}`);
		expect(del.statusCode, del.body).toBe(403);
		expect((del.json() as { code: string }).code).toBe('APPROVAL_DENIED');
		expect((await req('GET', `/api/sound-design/profiles/${profileId}`)).statusCode).toBe(200);
		const ed = await req('DELETE', `/api/sound-design/profiles/${profileId}`, undefined, EDITOR_H);
		expect(ed.statusCode, ed.body).toBe(200);
		expect((await req('GET', `/api/sound-design/profiles/${profileId}`)).statusCode).toBe(404);
		// refusals of the build route
		expect((await req('POST', '/api/sound-design/profiles', { name: 'x' })).statusCode).toBe(400);
		expect(
			(await req('POST', '/api/sound-design/profiles', { name: 'x', mediaIds: ['med_1'] })).statusCode,
		).toBe(400);
		const b = new DocBuilder();
		const projectId = seed(b.doc);
		const unknown = await req('POST', '/api/sound-design/profiles', { name: 'x', projectId, mediaIds: ['med_nope'] });
		expect([unknown.statusCode, (unknown.json() as { code: string }).code]).toEqual([404, 'MEDIA_NOT_FOUND']);
		const nothing = await waitJob(
			await req('POST', '/api/sound-design/profiles', { name: 'x', paths: [join(dir, 'missing.wav')] }),
		);
		expect(nothing.state).toBe('failed');
		expect(nothing.error?.code).toBe('NO_REFERENCES');
		expect(nothing.error?.message).toMatch(/missing\.wav \(the file does not exist\)/);
	});
});
