import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportEdl, exportEdlPerTrack, importEdl } from '../src/edl.ts';
import { detectFormat } from '../src/formats.ts';
import { Report } from '../src/report.ts';
import { framesToFlicks } from '../src/time.ts';
import { arbProject, BASIC } from './support/arbitraries.ts';
import { expectOnlyInterchangeErrors, VENV_PYTHON } from './support/fuzz.ts';
import { clip, media, project, sequence } from './support/ir.ts';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures/edl', n), 'utf8');
const r2997 = { num: 30000, den: 1001 };

describe('CMX 3600 EDL', () => {
	it('reads a Premiere drop-frame list: dissolves, M2, LOC, fade from black, source files', () => {
		const text = fixture('premiere-2997df.edl');
		expect(detectFormat(new TextEncoder().encode(text), 'x.edl')).toBe('edl');
		const report = new Report();
		const p = importEdl(text, {}, report);
		const s = p.sequences[p.top[0]!]!;
		expect(s.rate).toEqual(r2997);
		expect(s.dropFrame).toBe(true);
		// S02 A.1: 01;00;00;00 = 107892 frames at 29.97 DF; each frame is 23543520 flicks.
		expect(s.startTimecode).toBe(107_892);
		const v = s.video[0]!.clips;
		expect(v.map((c) => [c.name, c.start])).toEqual([
			['Harbour A.mov', 0],
			['Gulls Wide.mov', 3_531_528_000],
			['Boat.mov', 7_063_056_000],
			['Sunset.mov', 8_475_667_200],
		]);
		expect(v[2]!.speed).toBe(2);
		const a = s.audio.map((t) => t.clips.length);
		expect(a).toEqual([1, 1]);
		expect(s.audio[0]!.clips[0]!.link).toBe(v[0]!.link);
		const tr = s.video[0]!.transitions;
		expect(tr.map((x) => [x.effectId, x.from !== null, x.to !== null])).toEqual([
			['jasper.cross-dissolve', true, true],
			['jasper.cross-dissolve', false, true],
		]);
		expect(s.markers.map((m) => [m.name, m.color])).toEqual([['Check grade', 'rose']]);
		expect(p.media[(v[1]!.source as { mediaId: string }).mediaId]!.path).toBe(
			'/Volumes/Shoot/Gulls Wide.mov',
		);
	});

	it('reads Resolve (CLIP NAME, ASC CDL, absolute source timecode) and Avid (keys, wipes, AUD) lists', () => {
		const report = new Report();
		const p = importEdl(fixture('resolve-25.edl'), { rate: { num: 25, den: 1 } }, report);
		const s = p.sequences[p.top[0]!]!;
		expect(s.rate).toEqual({ num: 25, den: 1 });
		const c = s.video[0]!.clips[0]!;
		expect(c.name).toBe('A001C003_220101_R1AB.mov');
		const m = p.media[(c.source as { mediaId: string }).mediaId]!;
		expect(m.timecode!.frames).toBe(10 * 3600 * 25);
		expect(c.sourceIn).toBe(framesToFlicks(25, { num: 25, den: 1 }));
		expect(report.mentions('ASC CDL')).toBe(true);
		const k = importEdl(fixture('avid-key.edl'), { rate: { num: 24, den: 1 } }, new Report());
		const ks = k.sequences[k.top[0]!]!;
		expect(ks.video.length).toBe(2);
		expect(ks.video[1]!.clips[0]!.name).toBe('FG_REEL');
		expect(ks.audio.length).toBeGreaterThanOrEqual(3);
	});

	it('drop-frame timecode at minute boundaries (29.97 and 59.94)', () => {
		// SMPTE skipped labels and the tenth-minute exception (S02 Appendix A.1).
		for (const { rate, cuts } of [
			{
				rate: r2997,
				cuts: [
					[1799, '00;00;59;29', '00;01;00;02'],
					[17981, '00;09;59;29', '00;10;00;00'],
				],
			},
			{
				rate: { num: 60000, den: 1001 },
				cuts: [
					[3599, '00;00;59;59', '00;01;00;04'],
					[35963, '00;09;59;59', '00;10;00;00'],
				],
			},
		] as const) {
			const p = project();
			const m = media(p, '/media/card.mov', true, false, rate);
			const sid = sequence(p, 'Drop-frame cuts', rate, true);
			for (const [frame] of cuts) clip(p, sid, 'video', 0, m, frame, 1, 0);
			const text = exportEdl(p, sid, {}, new Report());
			expect(text).toContain('FCM: DROP FRAME');
			const recordTimes = text
				.split('\n')
				.filter((line) => /^\d{3}\s/.test(line))
				.map((line) => line.trim().split(/\s+/).slice(-2));
			expect(recordTimes).toEqual(cuts.map(([, start, end]) => [start, end]));
		}
	});

	it('writes one list per video track, extended reels and names uncarried clips', () => {
		const p = fc.sample(arbProject({ ...BASIC, videoTracks: 2, audioTracks: 1, clips: 3 }), {
			seed: 9,
			numRuns: 1,
		})[0]!;
		const s = p.sequences[p.top[0]!]!;
		s.video[1]!.clips.push({
			id: 'adj',
			name: 'Grade',
			start: framesToFlicks(5000, s.rate),
			duration: framesToFlicks(10, s.rate),
			sourceIn: 0,
			speed: 1,
			reverse: false,
			enabled: true,
			source: { type: 'none', what: 'adjustment layer' },
			markers: [],
			effects: [],
		});
		const report = new Report();
		const lists = exportEdlPerTrack(p, p.top[0]!, { edl: { reelLength: 32, reelMode: 'file-name' } }, report);
		expect(lists.map((l) => l.suffix)).toEqual(
			s.video.map((t, i) => (t.clips.length ? `V${i + 1}` : null)).filter(Boolean),
		);
		const e = report.entries.filter((x) => x.subject?.id === 'adj');
		expect(e).toHaveLength(1);
		expect(e[0]!.instead).toMatch(/reel/);
		const strict = exportEdl(p, p.top[0]!, { edl: { reelLength: 8 } }, new Report());
		for (const l of strict.split('\n').filter((x) => /^\d{3} /.test(x)))
			expect(l.split(/\s+/)[1]!.length).toBeLessThanOrEqual(8);
	});

	it('only ever throws InterchangeError on corrupt input', () => {
		const seed = new TextEncoder().encode(fixture('premiere-2997df.edl'));
		expectOnlyInterchangeErrors(
			(b) => importEdl(new TextDecoder('latin1').decode(b), {}, new Report()),
			seed,
			{ runs: 300 },
		);
	});

	it.skipIf(!existsSync(VENV_PYTHON))('is read by OpenTimelineIO’s cmx_3600 adapter', () => {
		const p = fc.sample(
			arbProject({
				...BASIC,
				videoTracks: 1,
				audioTracks: 0,
				transitions: true,
				rates: [{ rate: { num: 25, den: 1 }, dropFrame: false }],
			}),
			{ seed: 21, numRuns: 1 },
		)[0]!;
		const dir = mkdtempSync(join(tmpdir(), 'edl-'));
		const file = join(dir, 'x.edl');
		writeFileSync(file, exportEdl(p, p.top[0]!, {}, new Report()));
		const out = execFileSync(
			VENV_PYTHON,
			[
				'-c',
				`import json,sys,opentimelineio as otio
t = otio.adapters.read_from_file(sys.argv[1], 'cmx_3600', rate=25)
print(json.dumps([(c.name, c.range_in_parent().start_time.to_frames(), c.source_range.duration.to_frames()) for c in t.find_clips()]))`,
				file,
			],
			{ encoding: 'utf8' },
		);
		const clips = JSON.parse(out) as [string, number, number][];
		const s = p.sequences[p.top[0]!]!;
		const ours = s.video[0]!.clips;
		expect(clips.length).toBeGreaterThanOrEqual(ours.length);
		for (const c of ours) expect(clips.some(([n]) => n === c.name)).toBe(true);
	});
});
