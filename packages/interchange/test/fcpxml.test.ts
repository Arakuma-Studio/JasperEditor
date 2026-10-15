import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportFcpxml, fmtTime, importFcpxml, parseTime } from '../src/fcpxml.ts';
import { detectFormat } from '../src/formats.ts';
import { Report } from '../src/report.ts';
import { framesToFlicks } from '../src/time.ts';
import { arbProject, BASIC, type Features } from './support/arbitraries.ts';
import { expectOnlyInterchangeErrors, VENV_PYTHON } from './support/fuzz.ts';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures/fcpxml', n), 'utf8');

const FEATURES: Features = {
	...BASIC,
	videoTracks: 3,
	audioTracks: 2,
	clips: 5,
	transform: true,
	opacity: true,
	audioLevels: true,
	pan: true,
	keyframes: true,
	speed: true,
	reverse: true,
	hold: true,
	markers: true,
	disabled: true,
	nested: true,
	audioOnlyMedia: true,
	timecode: true,
};

describe('FCPXML', () => {
	it('rational frame times and whole seconds have exact wire values', () => {
		expect(parseTime('1001/24000s')).toBe(29_429_400);
		expect(fmtTime(706_305_600_000, { num: 24000, den: 1001 })).toBe('1001s');
	});

	it('reads a Final Cut Pro document: assets, timecode, transform, levels, compound clips, captions, titles', () => {
		const text = fixture('fcp-harbour.fcpxml');
		expect(detectFormat(new TextEncoder().encode(text), 'x.fcpxml')).toBe('fcpxml');
		const report = new Report();
		const p = importFcpxml(text, {}, report);
		const s = p.sequences[p.top[0]!]!;
		const r = { num: 30000, den: 1001 };
		expect(s.name).toBe('Harbour Cut');
		expect(s.rate).toEqual(r);
		expect(s.dropFrame).toBe(true);
		expect(s.startTimecode).toBe(107892);
		const [a, comp] = s.video[0]!.clips;
		expect(a!.start).toBe(0);
		expect(a!.duration).toBe(framesToFlicks(150, r));
		expect(a!.sourceIn).toBe(706_305_600);
		const m = p.media[(a!.source as { mediaId: string }).mediaId]!;
		expect(m.path).toBe('/Volumes/Shoot/Harbour A.mov');
		expect(m.video).toMatchObject({ width: 3840, height: 2160 });
		expect(m.timecode!.frames).toBe(107892);
		expect(a!.transform!.scale.value).toBe(120);
		expect(a!.transform!.rotation.value).toBe(15);
		expect(a!.transform!.position.value).toEqual([960 + 108, 540 + 54]);
		expect(a!.opacity!.value).toBe(80);
		expect(a!.effects.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur']);
		const a1 = s.audio[0]!.clips[0]!;
		expect(a1.link).toBe(a!.link);
		expect(a1.volumeDb!.keyframes.map((k) => [k.value, k.interpolation])).toEqual([
			[-20, 'linear'],
			[-6, 'bezier'],
		]);
		const gulls = s.audio[0]!.clips.find((c) => c.name === 'Gulls') ?? s.audio[1]!.clips[0]!;
		expect(gulls.name).toBe('Gulls');
		expect(gulls.sourceIn).toBe(705_600_000 * 10);
		expect(s.markers.map((x) => [x.name, x.type ?? 'comment'])).toEqual([
			['Boat enters', 'comment'],
			['Chapter 2', 'chapter'],
		]);
		expect(s.video[0]!.transitions[0]!.effectId).toBe('jasper.cross-dissolve');
		expect(s.video[0]!.transitions[0]!.alignment).toBe('center');
		expect(comp!.source.type).toBe('sequence');
		expect(comp!.speed).toBe(2);
		expect(report.mentions('Opening Title')).toBe(true);
		expect(s.captions).toEqual([
			{
				name: 'Captions (en)',
				language: 'en',
				enabled: true,
				cues: [{ start: 0, duration: framesToFlicks(60, r), text: 'Morning at the harbour' }],
			},
		]);
	});

	it('reads a DaVinci Resolve document (connected clips with blend modes)', () => {
		const p = importFcpxml(fixture('resolve-timeline.fcpxml'), {}, new Report());
		const s = p.sequences[p.top[0]!]!;
		expect(s.startTimecode).toBe(90000);
		expect(s.video[0]!.clips[0]!.sourceIn).toBe(705_600_000);
		const b = s.video[1]!.clips[0]!;
		expect(b.start).toBe(705_600_000);
		expect(b.blendMode).toBe('screen');
		expect(b.opacity!.value).toBe(50);
	});

	it('writes every version, roles and captions', () => {
		const p = fc.sample(arbProject(FEATURES), { seed: 2, numRuns: 1 })[0]!;
		const s = p.sequences[p.top[0]!]!;
		s.captions = [
			{
				name: 'Captions (fr)',
				language: 'fr',
				enabled: true,
				cues: [{ start: 0, duration: framesToFlicks(24, s.rate), text: 'Bonjour' }],
			},
		];
		for (const v of ['1.9', '1.10', '1.11'] as const) {
			const text = exportFcpxml(p, p.top[0]!, { fcpxmlVersion: v }, new Report());
			expect(text).toContain(`<fcpxml version="${v}">`);
			expect(text).toContain('iTT?captionFormat=ITT.fr');
			const back = importFcpxml(text, {}, new Report());
			expect(back.sequences[back.top[0]!]!.captions![0]!.cues[0]!.text).toBe('Bonjour');
		}
	});

	it('names every clip it cannot carry', () => {
		const p = fc.sample(arbProject(BASIC), { seed: 5, numRuns: 1 })[0]!;
		const s = p.sequences[p.top[0]!]!;
		s.video[0]!.clips.push({
			id: 'txt',
			name: 'Title',
			start: framesToFlicks(9000, s.rate),
			duration: framesToFlicks(10, s.rate),
			sourceIn: 0,
			speed: 1,
			reverse: false,
			enabled: true,
			source: { type: 'none', what: 'text clip' },
			markers: [],
			effects: [],
		});
		const report = new Report();
		exportFcpxml(p, p.top[0]!, {}, report);
		const e = report.entries.filter((x) => x.subject?.id === 'txt');
		expect(e).toHaveLength(1);
		expect(e[0]).toMatchObject({ level: 'warning', subject: { id: 'txt' } });
	});

	it('only ever throws InterchangeError on corrupt input', () => {
		const seed = new TextEncoder().encode(fixture('fcp-harbour.fcpxml'));
		expectOnlyInterchangeErrors((b) => importFcpxml(new TextDecoder().decode(b), {}, new Report()), seed, {
			runs: 300,
		});
	});

	it.skipIf(!existsSync(VENV_PYTHON))('is read by OpenTimelineIO’s fcpx_xml adapter', () => {
		const p = fc.sample(arbProject({ ...BASIC, transitions: true }), { seed: 13, numRuns: 1 })[0]!;
		const dir = mkdtempSync(join(tmpdir(), 'fcpxml-'));
		const file = join(dir, 'x.fcpxml');
		writeFileSync(file, exportFcpxml(p, p.top[0]!, {}, new Report()));
		const out = execFileSync(
			VENV_PYTHON,
			[
				'-c',
				`import json,sys,opentimelineio as otio
t = otio.adapters.read_from_file(sys.argv[1], 'fcpx_xml')
if isinstance(t, otio.schema.SerializableCollection):
    t = [x for x in t if isinstance(x, otio.schema.Timeline)][0]
print(json.dumps([(c.name, c.source_range.duration.to_frames()) for c in t.find_clips()]))`,
				file,
			],
			{ encoding: 'utf8' },
		);
		const clips = JSON.parse(out) as [string, number][];
		const s = p.sequences[p.top[0]!]!;
		const F = framesToFlicks(1, s.rate);
		for (const c of s.video[0]!.clips) expect(clips).toContainEqual([c.name, c.duration / F]);
	});
});
