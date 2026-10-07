import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportAaf, importAaf, sniffAaf } from '../src/aaf/index.ts';
import { audioNeeds } from '../src/essence.ts';
import { detectFormat } from '../src/formats.ts';
import type { IProject, Rate } from '../src/model.ts';
import type { AudioEssence } from '../src/options.ts';
import { Report } from '../src/report.ts';
import { framesToFlicks, RATE_23_976, RATE_25, RATE_29_97, RATE_59_94, timecodeBase } from '../src/time.ts';
import { parseWav } from '../src/wav.ts';
import { arbProject, BASIC } from './support/arbitraries.ts';
import { expectOnlyInterchangeErrors, VENV_PYTHON } from './support/fuzz.ts';
import {
	clip,
	generator,
	key,
	link,
	links,
	marker,
	media,
	project,
	sequence,
	structure,
	transition,
} from './support/ir.ts';

/** V1: fade-in, cross dissolve, gap, dip-to-black fade-out; V2 one clip; A1/A2 linked audio, crossfade, gain, keys. */
function sample(rate: Rate, df: boolean) {
	const p = project();
	const a = media(p, '/media/A001.mov', true, true, rate);
	const b = media(p, '/media/B002.mov', true, true, rate);
	const m = media(p, '/media/music.wav', false, true, rate);
	p.media[a]!.timecode = { frames: timecodeBase(rate) * 3600 + 12, rate, dropFrame: false };
	p.media[a]!.markers.push(marker(framesToFlicks(40, rate), 0, 'slate', 'take 3', 'rose'));
	const s = sequence(p, 'Edit 1', rate, df);
	const v1 = clip(p, s, 'video', 0, a, 0, 100, 20);
	const v2 = clip(p, s, 'video', 0, b, 100, 80, 50);
	const v3 = clip(p, s, 'video', 0, a, 220, 60, 300);
	clip(p, s, 'video', 1, b, 30, 40, 0);
	transition(p, s, 'video', 0, 'jasper.cross-dissolve', null, v1, 0, 12, 'start-at-cut');
	transition(p, s, 'video', 0, 'jasper.cross-dissolve', v1, v2, 90, 20, 'center');
	transition(p, s, 'video', 0, 'jasper.dip-to-black', v3, null, 266, 14, 'end-at-cut');
	const a1 = clip(p, s, 'audio', 0, a, 0, 100, 20);
	const a2 = clip(p, s, 'audio', 0, b, 100, 80, 50);
	const a3 = clip(p, s, 'audio', 0, a, 220, 60, 300);
	transition(p, s, 'audio', 0, 'jasper.constant-gain', a1, a2, 95, 10, 'center');
	const mu = clip(p, s, 'audio', 1, m, 10, 200, 0);
	link(v1, a1);
	link(v2, a2);
	link(v3, a3);
	const seq = p.sequences[s]!;
	seq.startTimecode = timecodeBase(rate) * 3600;
	seq.markers.push(marker(framesToFlicks(50, rate), framesToFlicks(10, rate), 'Fix this', 'colour', 'mango'));
	a2.volumeDb = { value: -6, keyframes: [] };
	mu.volumeDb = {
		value: 0,
		keyframes: [
			key(framesToFlicks(0, rate), -12),
			key(framesToFlicks(48, rate), 0),
			key(framesToFlicks(150, rate), -3),
		],
	};
	return { p, s };
}

const rt = (p: IProject, s: string, opts = {}) => {
	const bytes = exportAaf(p, s, opts, new Report());
	expect(sniffAaf(bytes)).toBe(true);
	expect(detectFormat(bytes, 'x.aaf')).toBe('aaf');
	const report = new Report();
	const q = importAaf(bytes, { baseDir: '/proj', name: 'rt' }, report);
	return { q, n: q.top[0]!, bytes, report };
};

const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/** A structure with times rounded to frames. */
const framesOf = (st: ReturnType<typeof structure>) =>
	st.map((t) => ({
		clips: t.clips.map((c) => c.map((x) => (typeof x === 'number' ? Math.round(x) : x))),
		transitions: t.transitions.map((c) => c.map((x) => (typeof x === 'number' ? Math.round(x) : x))),
	}));

describe('AAF', () => {
	it('export → import keeps every clip, transition and link, at every rate (property)', () => {
		fc.assert(
			fc.property(arbProject({ ...BASIC, transitions: true, links: true, timecode: true }), (p) => {
				const s = p.top[0]!;
				const q = importAaf(exportAaf(p, s, {}, new Report()), {}, new Report());
				const n = q.top[0]!;
				expect(structure(q, n, 'video')).toEqual(structure(p, s, 'video'));
				// sound slots are in samples: at 29.97 / 59.94 a frame is not a whole number of 48 kHz samples
				expect(framesOf(structure(q, n, 'audio'))).toEqual(structure(p, s, 'audio'));
				expect(links(q, n)).toEqual(links(p, s));
				expect([q.sequences[n]!.rate, q.sequences[n]!.dropFrame]).toEqual([
					p.sequences[s]!.rate,
					p.sequences[s]!.dropFrame,
				]);
			}),
			{ numRuns: Number(process.env.FC_RUNS ?? 60) },
		);
	});

	it('round trips the edit at 25, 29.97 DF, 23.976 and 59.94 DF', () => {
		for (const [rate, df] of [
			[RATE_25, false],
			[RATE_29_97, true],
			[RATE_23_976, false],
			[RATE_59_94, true],
		] as const) {
			const { p, s } = sample(rate, df);
			const { q, n, bytes } = rt(p, s);
			expect(structure(q, n, 'video')).toEqual(structure(p, s, 'video'));
			expect(structure(q, n, 'audio')).toEqual(structure(p, s, 'audio'));
			expect(links(q, n)).toEqual(links(p, s));
			const qs = q.sequences[n]!;
			expect(qs.rate).toEqual(rate);
			expect(qs.dropFrame).toBe(df);
			expect(qs.startTimecode).toBe(timecodeBase(rate) * 3600);
			expect([qs.width, qs.height]).toEqual([1920, 1080]);
			expect(qs.name).toBe('Edit 1');
			expect(qs.markers.map((m) => [m.start, m.duration, m.name, m.comment, m.color])).toEqual([
				[framesToFlicks(50, rate), framesToFlicks(10, rate), 'Fix this', 'colour', 'mango'],
			]);
			expect(close(qs.audio[0]!.clips[1]!.volumeDb!.value, -6)).toBe(true);
			const ks = qs.audio[1]!.clips[0]!.volumeDb!.keyframes;
			const want = p.sequences[s]!.audio[1]!.clips[0]!.volumeDb!.keyframes;
			expect(ks.length).toBe(3);
			ks.forEach((k, i) => {
				expect(Math.abs(k.time - want[i]!.time)).toBeLessThanOrEqual(705_600_000 / 48_000 / 2);
				expect(close(k.value, want[i]!.value)).toBe(true);
			});
			const ma = Object.values(q.media).find((m) => m.path === '/media/A001.mov')!;
			expect(ma.timecode!.frames).toBe(timecodeBase(rate) * 3600 + 12);
			expect(ma.video && ma.audio).toBeTruthy();
			expect(ma.markers.map((m) => [m.name, m.comment])).toEqual([['slate', 'take 3']]);
			expect(Object.values(q.media).find((m) => m.name === 'music.wav')!.video).toBeUndefined();
			// reproducible
			expect(exportAaf(p, s, {}, new Report())).toEqual(bytes);
		}
	});

	it('writes 512-byte sectors on request', () => {
		const { p, s } = sample(RATE_25, false);
		const b512 = exportAaf(p, s, { aafSmallSectors: true }, new Report());
		expect(b512[30] | (b512[31]! << 8)).toBe(9);
		const q = importAaf(b512, {}, new Report());
		expect(structure(q, q.top[0]!, 'video')).toEqual(structure(p, s, 'video'));
		expect(exportAaf(p, s, {}, new Report())[30]).toBe(12);
	});

	it('breaks stereo out to mono tracks', () => {
		const { p, s } = sample(RATE_25, false);
		const { q, n } = rt(p, s, { media: { breakoutToMono: true } });
		const qs = q.sequences[n]!;
		expect(qs.audio.length).toBe(4);
		qs.audio.forEach((t, i) => {
			expect((t.jasper as { channelFormat: string }).channelFormat).toBe('mono');
			for (const c of t.clips) expect(c.channels!.map).toEqual([i % 2]);
		});
		expect(qs.audio[0]!.clips[0]!.source).toEqual(qs.audio[1]!.clips[0]!.source);
		const orig = structure(p, s, 'audio');
		const got = structure(q, n, 'audio');
		expect(got[0]).toEqual(orig[0]);
		expect(got[1]).toEqual(orig[0]);
		expect(got[2]).toEqual(orig[1]);
	});

	it('embeds trimmed audio with handles', () => {
		const { p, s } = sample(RATE_25, false);
		const needs = audioNeeds(p, s, { handles: framesToFlicks(5, RATE_25) });
		expect(needs.length).toBe(3);
		const a = needs.find((x) => x.path === '/media/A001.mov')!;
		expect(a.start).toBe(framesToFlicks(15, RATE_25));
		expect(a.end).toBe(framesToFlicks(365, RATE_25));
		const essence: AudioEssence[] = needs.map((nd, k) => {
			const frames = Math.floor((nd.end - nd.start) / (705_600_000 / 48_000));
			return {
				key: nd.key,
				channel: null,
				start: nd.start,
				frames,
				sampleRate: 48000,
				bits: 16,
				channels: 2,
				data: { embedded: ramp(frames, 2, k) },
				effectsRendered: false,
			};
		});
		const { q, n } = rt(p, s, { media: { essence } });
		const emb = Object.values(q.media).filter((m) => m.embedded);
		expect(emb.length).toBe(3);
		for (const m of emb) {
			const w = parseWav(m.embedded!.bytes)!;
			expect([w.channels, w.sampleRate, w.bits]).toEqual([2, 48000, 16]);
			expect(
				essence.some(
					(e) =>
						'embedded' in e.data &&
						e.data.embedded.length === w.pcm.length &&
						e.data.embedded.every((v, i) => v === w.pcm[i]),
				),
			).toBe(true);
			expect(m.path).toBeNull();
			expect(m.embedded!.fileName.endsWith('.wav')).toBe(true);
		}
		const qs = q.sequences[n]!;
		const orig = p.sequences[s]!;
		for (const [ti, t] of qs.audio.entries())
			for (const [ci, c] of t.clips.entries()) {
				const oc = orig.audio[ti]!.clips[ci]!;
				const need = needs.find((x) => x.mediaId === (oc.source as { mediaId: string }).mediaId)!;
				expect(c.sourceIn).toBe(oc.sourceIn - need.start);
				expect([c.start, c.duration]).toEqual([oc.start, oc.duration]);
			}
		expect(structure(q, n, 'video')).toEqual(structure(p, s, 'video'));
	});

	it('links consolidated per-clip audio files and a video mixdown', () => {
		const { p, s } = sample(RATE_25, false);
		const needs = audioNeeds(p, s, { perClip: true });
		expect(needs.length).toBe(4);
		const essence: AudioEssence[] = needs.flatMap((nd) =>
			[0, 1].map((c) => ({
				key: nd.key,
				channel: c,
				start: nd.start,
				frames: 4800,
				sampleRate: 48000,
				bits: 24 as const,
				channels: 1,
				data: { file: `/out/Clip_${'clip' in nd.key ? nd.key.clip : ''}_${c}.wav` },
				effectsRendered: true,
			})),
		);
		const mix = {
			path: '/out/mixdown.mxf',
			start: 0,
			duration: framesToFlicks(280, RATE_25),
			width: 1920,
			height: 1080,
		};
		const { q, n } = rt(p, s, { media: { essence, breakoutToMono: true, mixdownVideo: mix } });
		const qs = q.sequences[n]!;
		expect(qs.video.filter((t) => t.clips.length).length).toBe(1);
		expect(qs.video[0]!.clips[0]!.duration).toBe(framesToFlicks(280, RATE_25));
		expect(structure(q, n, 'video')[0]!.clips[0]![3]).toBe('/out/mixdown.mxf');
		expect(qs.audio.length).toBe(4);
		for (const t of qs.audio)
			for (const c of t.clips) {
				expect(q.media[(c.source as { mediaId: string }).mediaId]!.path!.startsWith('/out/Clip')).toBe(true);
				expect(c.volumeDb === undefined || (c.volumeDb.value === 0 && !c.volumeDb.keyframes.length)).toBe(
					true,
				);
			}
	});

	it('names uncarried clips and leaves fillers', () => {
		const p = project();
		const s = sequence(p, 'S', RATE_25);
		const g = generator(p, 'Bars', { kind: 'bars-and-tone', toneHz: 1000, toneDb: -20 });
		const a = media(p, '/m/a.mov', true, true, RATE_25);
		clip(p, s, 'video', 0, g, 0, 25, 0);
		clip(p, s, 'video', 0, a, 25, 25, 0);
		const report = new Report();
		const bytes = exportAaf(p, s, {}, report);
		expect(report.mentions('synthetic')).toBe(true);
		const q = importAaf(bytes, {}, new Report());
		const v = q.sequences[q.top[0]!]!.video[0]!;
		expect(v.clips.length).toBe(1);
		expect(v.clips[0]!.start).toBe(framesToFlicks(25, RATE_25));
	});

	it('empty sequences, truncation and corruption never throw anything but InterchangeError', () => {
		const p = project();
		const s = sequence(p, 'Empty', { num: 24, den: 1 });
		for (const small of [false, true]) {
			const q = importAaf(exportAaf(p, s, { aafSmallSectors: small }, new Report()), {}, new Report());
			expect(q.top.length).toBe(1);
		}
		const { p: p2, s: s2 } = sample(RATE_25, false);
		const bytes = exportAaf(p2, s2, { aafSmallSectors: true }, new Report());
		expectOnlyInterchangeErrors((b) => importAaf(b, {}, new Report()), bytes, { runs: 300, truncations: 97 });
	});
});

describe('AAF with external tools', () => {
	it.skipIf(!existsSync(VENV_PYTHON))('is read by pyaaf2 and by OpenTimelineIO’s AAF adapter', () => {
		const { p, s } = sample(RATE_25, false);
		const dir = mkdtempSync(join(tmpdir(), 'aaf-'));
		const file = join(dir, 'x.aaf');
		writeFileSync(file, exportAaf(p, s, {}, new Report()));
		const out = execFileSync(
			VENV_PYTHON,
			[
				'-c',
				`import json,sys,aaf2
with aaf2.open(sys.argv[1], 'r') as f:
    comps = list(f.content.toplevel())
    c = comps[0]
    slots = []
    for sl in c.slots:
        seg = sl.segment
        kind = seg.media_kind
        comps_ = [x.__class__.__name__ for x in seg.components] if hasattr(seg, 'components') else [seg.__class__.__name__]
        slots.append([kind, str(sl.edit_rate), comps_])
    masters = len(list(f.content.mastermobs()))
    print(json.dumps({"name": c.name, "slots": slots, "masters": masters}))`,
				file,
			],
			{ encoding: 'utf8' },
		);
		const r = JSON.parse(out) as { name: string; slots: [string, string, string[]][]; masters: number };
		expect(r.name).toBe('Edit 1');
		expect(r.masters).toBe(3);
		const pic = r.slots.filter((x) => x[0] === 'Picture');
		expect(pic[0]![2].filter((x) => x === 'SourceClip').length).toBe(3);
		expect(pic[0]![2].filter((x) => x === 'Transition').length).toBe(3);
		expect(r.slots.filter((x) => x[0] === 'Sound').length).toBe(2);
		const otio = execFileSync(
			VENV_PYTHON,
			[
				'-c',
				`import json,sys,opentimelineio as otio
t = otio.adapters.read_from_file(sys.argv[1], 'AAF')
print(json.dumps([(c.name, c.source_range.duration.to_frames()) for c in t.find_clips()]))`,
				file,
			],
			{ encoding: 'utf8' },
		);
		const clips = JSON.parse(otio) as [string, number][];
		expect(clips.length).toBeGreaterThanOrEqual(8);
	});

	it.skipIf(!existsSync(VENV_PYTHON))('reads an AAF written by pyaaf2 (third-party dialect)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'aafin-'));
		const file = join(dir, 'foreign.aaf');
		execFileSync(VENV_PYTHON, [join(__dirname, 'fixtures/aaf/make_pyaaf2.py'), file]);
		const q = importAaf(new Uint8Array(readFileSync(file)), {}, new Report());
		const s = q.sequences[q.top[0]!]!;
		expect(s.name).toBe('Foreign Edit');
		const F = framesToFlicks(1, RATE_25);
		expect(
			s.video[0]!.clips.map((c) => [
				c.name,
				c.start / F,
				c.duration / F,
				c.sourceIn / F,
				q.media[(c.source as { mediaId: string }).mediaId]!.path,
			]),
		).toEqual([
			['shot_a.mov', 0, 45, 10, '/shots/shot_a.mov'],
			['shot_b.mov', 45, 55, 105, '/shots/shot_b.mov'],
		]);
		expect(s.video[0]!.transitions.map((x) => [x.start / F, x.duration / F, x.alignment])).toEqual([
			[40, 10, 'center'],
		]);
	});
});

function ramp(frames: number, channels: number, seed: number): Uint8Array {
	const out = new Uint8Array(frames * channels * 2);
	const dv = new DataView(out.buffer);
	for (let i = 0; i < frames; i++)
		for (let c = 0; c < channels; c++)
			dv.setInt16((i * channels + c) * 2, (i * 37 + c * 1000 + seed) % 30000, true);
	return out;
}
