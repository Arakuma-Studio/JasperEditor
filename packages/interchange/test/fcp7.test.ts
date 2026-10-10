import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportFcp7, importFcp7 } from '../src/fcp7.ts';
import { detectFormat } from '../src/formats.ts';
import type { IProject } from '../src/model.ts';
import { Report } from '../src/report.ts';
import { framesToFlicks } from '../src/time.ts';
import { arbProject, BASIC, type Features } from './support/arbitraries.ts';
import { canonical } from './support/canonical.ts';
import { expectOnlyInterchangeErrors, VENV_PYTHON } from './support/fuzz.ts';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures/fcp7', n), 'utf8');
const r24 = { num: 24000, den: 1001 };
const f24 = (n: number) => framesToFlicks(n, r24);

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
	clipMarkers: true,
	transitions: true,
	links: true,
	labels: true,
	disabled: true,
	generators: true,
	nested: true,
	audioOnlyMedia: true,
	timecode: true,
};

function seqByName(p: IProject, name: string) {
	return Object.values(p.sequences).find((s) => s.name === name)!;
}

describe('FCP7 XML', () => {
	it('reads a Premiere Pro document: bins, master clips, ticks, nests, generators, filters, links', () => {
		const text = fixture('premiere-lighthouse.xml');
		expect(detectFormat(new TextEncoder().encode(text), 'x.xml')).toBe('fcp7');
		const report = new Report();
		const p = importFcp7(text, { baseDir: '/proj' }, report);
		expect(p.name).toBe('Lighthouse');
		expect(p.top.length).toBe(2);
		const s = seqByName(p, 'Main Edit');
		expect(s.rate).toEqual(r24);
		expect(s.startTimecode).toBe(86400);
		const bin = p.root.find((e) => e.type === 'bin');
		expect(bin && bin.type === 'bin' && bin.name).toBe('Footage');
		const tower = Object.values(p.media).find((m) => m.name === 'tower.mov')!;
		expect(tower.path).toBe('/Volumes/Shoot/tower wide.mov');
		expect(tower.video!.width).toBe(3840);
		expect(tower.timecode!.frames).toBe(86400);
		expect(tower.label).toBe('mango');
		expect(bin!.type === 'bin' && bin!.children).toContainEqual({ type: 'media', id: tower.id });
		const [c1, c2] = s.video[0]!.clips;
		expect([c1!.start, c1!.duration, c1!.label]).toEqual([0, f24(48), 'cerulean']);
		expect([c2!.start, c2!.duration, c2!.sourceIn]).toEqual([f24(48), f24(72), f24(100)]);
		expect(p.media[(c2!.source as { mediaId: string }).mediaId]!.path).toBe('/proj/media/waves.mov');
		const t = s.video[0]!.transitions[0]!;
		expect([t.start, t.duration, t.from, t.to, t.alignment, t.effectId]).toEqual([
			f24(36),
			f24(24),
			c1!.id,
			c2!.id,
			'center',
			'jasper.cross-dissolve',
		]);
		expect(c2!.transform!.scale.keyframes.map((k) => [k.time, k.value])).toEqual([
			[f24(100), 100],
			[f24(160), 150],
		]);
		expect(c2!.transform!.rotation.value).toBe(-12.5);
		expect(c2!.transform!.position.value).toEqual([960 + 480, 540 - 108]);
		expect(c2!.opacity!.value).toBe(50);
		expect(c2!.blendMode).toBe('screen');
		expect(c2!.effects.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur', 'jasper.crop']);
		expect((c2!.effects[1]!.params.left as { value: number }).value).toBe(10);
		expect(report.mentions('Mystery Glow Pro')).toBe(true);
		expect(c2!.markers.map((m) => [m.name, m.start])).toEqual([['wave peak', f24(130)]]);
		const v2 = s.video[1]!;
		expect(v2.locked).toBe(true);
		const nest = seqByName(p, 'Titles Nest');
		expect(v2.clips[0]!.source).toEqual({ type: 'sequence', sequenceId: nest.id });
		const g = p.media[(v2.clips[1]!.source as { mediaId: string }).mediaId]!;
		expect(g.generator).toEqual({ kind: 'color', color: [1, 0, 0, 1] });
		expect(nest.video[0]!.clips[0]!.speed).toBe(2);
		expect(nest.video[0]!.clips[0]!.source).toEqual(c2!.source);
		const a1 = s.audio[0]!.clips[0]!;
		expect(a1.volumeDb!.keyframes.map((k) => k.value)).toEqual([0, -6.020599913]);
		expect(a1.pan!.value).toBe(-50);
		expect(a1.link).toBe(c1!.link);
		expect(a1.link).toBeTruthy();
		const music = s.audio[1]!.clips[0]!;
		expect(music.enabled).toBe(false);
		expect(p.media[(music.source as { mediaId: string }).mediaId]!.video).toBeUndefined();
		expect(s.audio[1]!.transitions[0]!.effectId).toBe('jasper.constant-power');
		expect(s.audio[1]!.transitions[0]!.from).toBeNull();
		expect(s.markers.map((m) => [m.name, m.start, m.color])).toEqual([['Check sky', f24(30), 'rose']]);
	});

	it('reads a DaVinci Resolve document (no ticks, timecode strings, ids with spaces)', () => {
		const p = importFcp7(fixture('resolve-timeline.xml'), {}, new Report());
		const s = Object.values(p.sequences)[0]!;
		const r25 = { num: 25, den: 1 };
		expect(s.startTimecode).toBe(90000);
		const [a, b] = s.video[0]!.clips;
		expect([a!.start, a!.duration, a!.sourceIn]).toEqual([
			0,
			framesToFlicks(125, r25),
			framesToFlicks(25, r25),
		]);
		expect(b!.speed).toBe(2);
		const m = p.media[(a!.source as { mediaId: string }).mediaId]!;
		expect(m.timecode!.frames).toBe(900000);
		expect(m.path).toBe('/Users/editor/Media/A001.mov');
		expect(s.audio[0]!.clips[0]!.source).toEqual(a!.source);
		expect(a!.transform!.scale.value).toBe(110);
	});

	it('export → import is the identity on what FCP7 XML carries, at every rate', () => {
		fc.assert(
			fc.property(arbProject(FEATURES), (p) => {
				const report = new Report();
				const text = exportFcp7(p, p.top[0]!, {}, report);
				const back = importFcp7(text, {}, new Report());
				expect(canonical(back, { onlyTop: true, dropDefaults: true })).toEqual(
					canonical(p, { onlyTop: true, dropDefaults: true }),
				);
			}),
			{ numRuns: Number(process.env.FC_RUNS ?? 120) },
		);
	});

	it('writes ticks, file URLs, version 5 and bins', () => {
		const p = fc.sample(arbProject({ ...FEATURES, rates: [{ rate: r24, dropFrame: false }] }), {
			seed: 3,
			numRuns: 1,
		})[0]!;
		p.root = [{ type: 'bin', name: 'Edits', label: 'violet', children: p.root }];
		const text = exportFcp7(p, p.top[0]!, { xmemlVersion: 5 }, new Report());
		expect(
			text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">'),
		).toBe(true);
		expect(text).toContain('<pproTicksIn>');
		expect(text).toContain('file://localhost/media/');
		expect(text).toContain('<bin>');
		const back = importFcp7(text, {}, new Report());
		const bin = back.root.find((e) => e.type === 'bin');
		expect(bin && bin.type === 'bin' && bin.name).toBe('Edits');
	});

	it('names every clip it cannot carry', () => {
		const p = fc.sample(arbProject(BASIC), { seed: 5, numRuns: 1 })[0]!;
		const s = p.sequences[p.top[0]!]!;
		s.video[0]!.clips.push({
			id: 'adj',
			name: 'Grade',
			start: framesToFlicks(9000, s.rate),
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
		exportFcp7(p, p.top[0]!, {}, report);
		const e = report.entries.filter((x) => x.subject?.id === 'adj');
		expect(e).toHaveLength(1);
		expect(e[0]!.message).toMatch(/adjustment layer "Grade" at frame 9000/);
		expect(e[0]!.instead).toMatch(/without media/);
	});

	it('only ever throws InterchangeError on corrupt input', () => {
		const seed = new TextEncoder().encode(fixture('premiere-lighthouse.xml'));
		expectOnlyInterchangeErrors((b) => importFcp7(new TextDecoder().decode(b), {}, new Report()), seed, {
			runs: 300,
		});
		const nested = `<xmeml>${'<bin><children>'.repeat(3000)}${'</children></bin>'.repeat(3000)}</xmeml>`;
		expectOnlyInterchangeErrors(
			(b) => importFcp7(new TextDecoder().decode(b), {}, new Report()),
			new TextEncoder().encode(nested),
			{
				runs: 10,
				truncations: 4,
			},
		);
	});

	it.skipIf(!existsSync(VENV_PYTHON))('is read by OpenTimelineIO’s fcp_xml adapter', () => {
		const p = fc.sample(arbProject({ ...BASIC, transitions: true, links: true }), {
			seed: 11,
			numRuns: 1,
		})[0]!;
		const dir = mkdtempSync(join(tmpdir(), 'fcp7-'));
		const file = join(dir, 'x.xml');
		writeFileSync(file, exportFcp7(p, p.top[0]!, {}, new Report()));
		const out = execFileSync(
			VENV_PYTHON,
			[
				'-c',
				`import json,sys,opentimelineio as otio
t = otio.adapters.read_from_file(sys.argv[1], 'fcp_xml')
t = t if isinstance(t, otio.schema.Timeline) else next(iter(t.find_children(descended_from_type=otio.schema.Timeline) if hasattr(t,'find_children') else t))
clips = [(c.name, c.range_in_parent().start_time.to_frames(), c.source_range.duration.to_frames()) for c in t.find_clips()]
print(json.dumps(clips))`,
				file,
			],
			{ encoding: 'utf8' },
		);
		const clips = JSON.parse(out) as [string, number, number][];
		const s = p.sequences[p.top[0]!]!;
		const F = framesToFlicks(1, s.rate);
		const ours = [...s.video, ...s.audio].flatMap((t) =>
			t.clips.map((c) => [c.name, c.start / F, c.duration / F]),
		);
		for (const c of ours) expect(clips).toContainEqual(c);
	});
});
