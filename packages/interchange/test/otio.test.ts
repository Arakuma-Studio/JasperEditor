import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportOtio, importOtio } from '../src/otio.ts';
import { Report } from '../src/report.ts';
import { framesToFlicks } from '../src/time.ts';
import { arbProject, BASIC, type Features } from './support/arbitraries.ts';
import { canonical } from './support/canonical.ts';
import { expectOnlyInterchangeErrors, VENV_PYTHON } from './support/fuzz.ts';

const ALL: Features = {
	...BASIC,
	videoTracks: 3,
	audioTracks: 3,
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

const enc = (s: string) => new TextEncoder().encode(s);

describe('OTIO', () => {
	it('export → import is the identity on the whole model, at every rate', () => {
		fc.assert(
			fc.property(arbProject(ALL), (p) => {
				const text = exportOtio(p, p.top[0]!, {}, new Report());
				const back = importOtio(text, {}, new Report());
				expect(canonical(back)).toEqual(canonical(p));
				expect(back.root.map((e) => e.type)).toEqual(p.root.map((e) => e.type));
			}),
			{ numRuns: Number(process.env.FC_RUNS ?? 150) },
		);
	});

	it('writes frame values at the exact rate and reads foreign rounded rates exactly', () => {
		const p = fc.sample(
			arbProject({ ...BASIC, rates: [{ rate: { num: 24000, den: 1001 }, dropFrame: false }] }),
			1,
		)[0]!;
		const text = exportOtio(p, p.top[0]!, {}, new Report());
		const j = JSON.parse(text);
		expect(j.OTIO_SCHEMA).toBe('Timeline.1');
		expect(j.global_start_time.rate).toBeCloseTo(23.976023976, 8);
		// A clip written by another tool at "23.976" with 48 frames.
		const foreign = {
			OTIO_SCHEMA: 'Timeline.1',
			name: 'Foreign',
			global_start_time: { OTIO_SCHEMA: 'RationalTime.1', rate: 23.976, value: 86400 },
			tracks: {
				OTIO_SCHEMA: 'Stack.1',
				children: [
					{
						OTIO_SCHEMA: 'Track.1',
						kind: 'Video',
						children: [
							{
								OTIO_SCHEMA: 'Gap.1',
								source_range: tr(24, 23.976, 0),
							},
							{
								OTIO_SCHEMA: 'Clip.2',
								name: 'A',
								source_range: tr(48, 23.976, 86400 + 10),
								media_references: {
									DEFAULT_MEDIA: {
										OTIO_SCHEMA: 'ExternalReference.1',
										target_url: 'file:///media/A%20001.mov',
										available_range: tr(1000, 23.976, 86400),
									},
								},
								active_media_reference_key: 'DEFAULT_MEDIA',
							},
						],
					},
				],
			},
		};
		const back = importOtio(JSON.stringify(foreign), {}, new Report());
		const s = Object.values(back.sequences)[0]!;
		const r = { num: 24000, den: 1001 };
		expect(s.rate).toEqual(r);
		expect(s.startTimecode).toBe(86400);
		const c = s.video[0]!.clips[0]!;
		expect(c.start).toBe(framesToFlicks(24, r));
		expect(c.duration).toBe(framesToFlicks(48, r));
		expect(c.sourceIn).toBe(framesToFlicks(10, r));
		const m = back.media[(c.source as { mediaId: string }).mediaId]!;
		expect(m.path).toBe('/media/A 001.mov');
		expect(m.timecode?.frames).toBe(86400);
	});

	it('reads transitions, generators, missing references, freeze frames and collections', () => {
		const doc = {
			OTIO_SCHEMA: 'SerializableCollection.1',
			name: 'Two',
			children: [
				timeline('One', [
					clip('A', 0, 48, { OTIO_SCHEMA: 'MissingReference.1', name: 'gone.mov' }),
					{
						OTIO_SCHEMA: 'Transition.1',
						name: 'Dip to Black',
						transition_type: 'Custom_Transition',
						in_offset: rt(6, 25),
						out_offset: rt(6, 25),
					},
					clip(
						'B',
						100,
						48,
						{
							OTIO_SCHEMA: 'GeneratorReference.1',
							name: 'red',
							generator_kind: 'SolidColor',
							parameters: { color: [1, 0, 0, 1] },
						},
						[{ OTIO_SCHEMA: 'FreezeFrame.1', effect_name: 'FreezeFrame', time_scalar: 0 }],
					),
				]),
				timeline('Two', [clip('C', 0, 10, null, [{ OTIO_SCHEMA: 'LinearTimeWarp.1', time_scalar: -2 }])]),
			],
		};
		const report = new Report();
		const p = importOtio(JSON.stringify(doc), {}, report);
		expect(p.top.length).toBe(2);
		const one = p.sequences[p.top[0]!]!;
		const t = one.video[0]!;
		expect(t.transitions).toHaveLength(1);
		expect(t.transitions[0]!.effectId).toBe('jasper.dip-to-black');
		expect(t.transitions[0]!.alignment).toBe('center');
		expect(t.transitions[0]!.from).toBe(t.clips[0]!.id);
		expect(t.transitions[0]!.to).toBe(t.clips[1]!.id);
		const a = p.media[(t.clips[0]!.source as { mediaId: string }).mediaId]!;
		expect(a.offline).toBe(true);
		const b = p.media[(t.clips[1]!.source as { mediaId: string }).mediaId]!;
		expect(b.generator).toEqual({ kind: 'color', color: [1, 0, 0, 1] });
		expect(t.clips[1]!.hold).toBe(t.clips[1]!.sourceIn);
		const two = p.sequences[p.top[1]!]!;
		expect(two.video[0]!.clips[0]!.speed).toBe(2);
		expect(two.video[0]!.clips[0]!.reverse).toBe(true);
	});

	it('reports clips without media and carries them in metadata', () => {
		const p = fc.sample(arbProject(BASIC), 1)[0]!;
		const seq = p.sequences[p.top[0]!]!;
		seq.video[0]!.clips.push({
			id: 'title',
			name: 'Title',
			start: framesToFlicks(5000, seq.rate),
			duration: framesToFlicks(48, seq.rate),
			sourceIn: 0,
			speed: 1,
			reverse: false,
			enabled: true,
			source: { type: 'none', what: 'text clip' },
			markers: [],
			effects: [],
			jasper: { kind: 'text', content: { text: 'Hello' } },
		});
		const report = new Report();
		const text = exportOtio(p, p.top[0]!, {}, report);
		const w = report.entries.filter((e) => e.subject?.id === 'title');
		expect(w).toHaveLength(1);
		expect(w[0]!.level).toBe('warning');
		expect(w[0]!.instead).toMatch(/missing media reference/);
		const back = importOtio(text, {}, new Report());
		const title = back.sequences[back.top[0]!]!.video[0]!.clips.find((c) => c.name === 'Title')!;
		expect(title.source).toEqual({ type: 'none', what: 'text clip' });
		expect(title.jasper).toEqual({ kind: 'text', content: { text: 'Hello' } });
	});

	it('writes media paths relative to a folder when asked', () => {
		const p = fc.sample(arbProject(BASIC), 1)[0]!;
		const text = exportOtio(p, p.top[0]!, { relativeTo: '/media/sub' }, new Report());
		expect(text).toContain('"target_url": "../');
		const back = importOtio(text, { baseDir: '/media/sub' }, new Report());
		for (const m of Object.values(back.media)) if (m.path) expect(m.path.startsWith('/media/')).toBe(true);
	});

	it('only ever throws InterchangeError on corrupt input', () => {
		const p = fc.sample(arbProject(ALL), 1)[0]!;
		const seed = enc(exportOtio(p, p.top[0]!, {}, new Report()));
		expectOnlyInterchangeErrors((b) => importOtio(new TextDecoder().decode(b), {}, new Report()), seed, {
			runs: 200,
		});
		let deep =
			'{"OTIO_SCHEMA":"Timeline.1","tracks":{"OTIO_SCHEMA":"Stack.1","children":[{"OTIO_SCHEMA":"Track.1","children":[';
		for (let i = 0; i < 200; i++)
			deep +=
				'{"OTIO_SCHEMA":"Stack.1","source_range":null,"children":[{"OTIO_SCHEMA":"Track.1","children":[';
		deep += `${']}]}'.repeat(200)}]}]}}`;
		expectOnlyInterchangeErrors((b) => importOtio(new TextDecoder().decode(b), {}, new Report()), enc(deep), {
			runs: 20,
			truncations: 8,
		});
	});

	it.skipIf(!existsSync(VENV_PYTHON))('is read by the opentimelineio Python package', () => {
		const p = fc.sample(arbProject(ALL), { seed: 7, numRuns: 1 })[0]!;
		const dir = mkdtempSync(join(tmpdir(), 'otio-'));
		const file = join(dir, 'x.otio');
		writeFileSync(file, exportOtio(p, p.top[0]!, {}, new Report()));
		const out = execFileSync(
			VENV_PYTHON,
			[
				'-c',
				`import json,sys,opentimelineio as otio
t = otio.adapters.read_from_file(sys.argv[1])
clips = [c for c in t.find_clips()]
print(json.dumps({"tracks": len(t.tracks), "clips": len(clips), "dur": t.duration().to_frames(), "rate": t.duration().rate}))`,
				file,
			],
			{ encoding: 'utf8' },
		);
		const r = JSON.parse(out);
		const s = p.sequences[p.top[0]!]!;
		expect(r.tracks).toBe(s.video.length + s.audio.length);
		const ours = [...s.video, ...s.audio].reduce(
			(n, t) => n + t.clips.filter((c) => c.source.type !== 'sequence').length,
			0,
		);
		expect(r.clips).toBeGreaterThanOrEqual(ours);
		expect(r.rate).toBeCloseTo(s.rate.num / s.rate.den, 6);
	});
});

function rt(v: number, rate: number) {
	return { OTIO_SCHEMA: 'RationalTime.1', rate, value: v };
}
function tr(d: number, rate: number, start: number) {
	return { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start, rate), duration: rt(d, rate) };
}
function clip(name: string, start: number, d: number, ref: unknown, effects: unknown[] = []) {
	return {
		OTIO_SCHEMA: 'Clip.1',
		name,
		source_range: tr(d, 25, start),
		media_reference: ref,
		effects,
	};
}
function timeline(name: string, children: unknown[]) {
	return {
		OTIO_SCHEMA: 'Timeline.1',
		name,
		tracks: { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children }] },
	};
}
