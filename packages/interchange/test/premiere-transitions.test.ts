// Third-party Premiere transitions matched by MatchName (premiere-transitions.ts): Universe "Slide" lands on Smooth
// Slide with its parameters converted, from FCP7 XML and from a decoded parameter list (the .prproj shape).
import { checkInvariants, defaultRegistries, type Sequence } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { importFcp7 } from '../src/fcp7.ts';
import { importTimeline } from '../src/index.ts';
import {
	type PremiereParam,
	premiereTransitionForMatchName,
	premiereTransitionParams,
	UNIVERSE_SLIDE_MATCH_NAME,
} from '../src/premiere-transitions.ts';
import { Report } from '../src/report.ts';
import { framesToFlicks } from '../src/time.ts';
import { Harness } from './support/rich.ts';

/** The parameter list Premiere stores for a Universe Slide instance (names and ranges as the plug-in declares). */
const universeParams = (o: Partial<Record<string, number | boolean>> = {}): PremiereParam[] =>
	Object.entries({
		Input: 4294967293,
		Direction: 3,
		Animation: 16,
		Dolly: 0,
		Reflect: false,
		Reflection: false,
		Bluriness: 10,
		Falloff: 0.1,
		Aspect: 1,
		'#10': false,
		'Motion Blur': 3,
		'Motion Blur Shutter': 360,
		'Edge Smoothing': 0,
		...o,
	}).map(([name, value]) => ({ name, value: value as number | boolean }));

const xml = (effect: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>Main</name>
    <duration>120</duration>
    <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <format><samplecharacteristics><rate><timebase>30</timebase></rate><width>1920</width><height>1080</height></samplecharacteristics></format>
        <track>
          <transitionitem>
            <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
            <start>0</start><end>15</end><alignment>start-black</alignment>
            ${effect}
          </transitionitem>
          <clipitem id="clipitem-1">
            <name>a</name>
            <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
            <start>0</start><end>60</end><in>0</in><out>60</out>
            <file id="file-1"><name>a.mov</name><pathurl>file:///m/a.mov</pathurl><rate><timebase>30</timebase></rate><duration>600</duration>
              <media><video><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video></media>
            </file>
          </clipitem>
        </track>
      </video>
    </media>
  </sequence>
</xmeml>`;

const param = (name: string, value: string, extra = '') =>
	`<parameter authoringApp="PremierePro"><parameterid>${name}</parameterid><name>${name}</name><value>${value}</value>${extra}</parameter>`;

describe('Premiere MatchName transitions', () => {
	it('maps the Universe Slide MatchName to Smooth Slide (case-insensitive); others are not mapped', () => {
		expect(premiereTransitionForMatchName(UNIVERSE_SLIDE_MATCH_NAME)).toBe('jasper.smooth-slide');
		expect(premiereTransitionForMatchName('ae.universe_transitions_slide')).toBe('jasper.smooth-slide');
		expect(premiereTransitionForMatchName('Slide')).toBeNull();
		expect(premiereTransitionForMatchName(null)).toBeNull();
	});

	it('converts the decoded parameters: popups by index, numbers clamped, layer picker ignored', () => {
		const report = new Report();
		const p = premiereTransitionParams(UNIVERSE_SLIDE_MATCH_NAME, universeParams(), report);
		expect(p).toEqual({
			direction: { value: 'down', keyframes: [] },
			animation: { value: 'easeInOutQuad', keyframes: [] },
			dolly: { value: 0, keyframes: [] },
			reflection: { value: false, keyframes: [] },
			blurriness: { value: 10, keyframes: [] },
			falloff: { value: 0.1, keyframes: [] },
			aspect: { value: 1, keyframes: [] },
			motionBlur: { value: 'high', keyframes: [] },
			shutterAngle: { value: 360, keyframes: [] },
			edgeSmoothing: { value: 'none', keyframes: [] },
		});
		expect(report.entries).toEqual([]);
		const q = premiereTransitionParams(
			UNIVERSE_SLIDE_MATCH_NAME,
			universeParams({ Direction: 0, Animation: 17, Dolly: 5, 'Motion Blur': 0, 'Edge Smoothing': 3 }),
			report,
		);
		expect(q.direction!.value).toBe('right');
		expect(q.animation!.value).toBe('easeInOutCubic');
		expect(q.dolly!.value).toBe(1.2);
		expect(q.motionBlur!.value).toBe('off');
		expect(q.edgeSmoothing!.value).toBe('high');
		// Unknown popup index: reported, left at the default (absent).
		const bad = new Report();
		const r = premiereTransitionParams(UNIVERSE_SLIDE_MATCH_NAME, universeParams({ Animation: 40 }), bad);
		expect(r.animation).toBeUndefined();
		expect(bad.mentions('Animation')).toBe(true);
	});

	it('keeps keyframes of numbers (flicks from the span start) and drops those of hold-only settings', () => {
		const report = new Report();
		const p = premiereTransitionParams(
			UNIVERSE_SLIDE_MATCH_NAME,
			[
				{
					name: 'Dolly',
					value: 0,
					keyframes: [
						{ time: 1000, value: 1 },
						{ time: 0, value: 0 },
					],
				},
				{ name: 'Direction', value: 1, keyframes: [{ time: 0, value: 2 }] },
			],
			report,
		);
		expect(p.dolly!.keyframes.map((k) => [k.time, k.value])).toEqual([
			[0, 0],
			[1000, 1],
		]);
		expect(p.direction).toEqual({ value: 'left', keyframes: [] });
		expect(report.mentions('hold-only')).toBe(true);
	});

	it('never throws and only produces valid Smooth Slide values (fuzzed parameter lists)', () => {
		const value = fc.oneof(
			fc.double(),
			fc.integer({ min: -5, max: 30 }),
			fc.boolean(),
			fc.string({ maxLength: 6 }),
			fc.constant(null),
		);
		// wp-note Smooth Slide §2: independently specified target domains.
		const ranges: Record<string, [number, number]> = {
			dolly: [0, 1.2],
			blurriness: [0, 100],
			falloff: [0, 1],
			aspect: [0.01, 20],
			shutterAngle: [90, 720],
		};
		const options: Record<string, readonly string[]> = {
			direction: ['right', 'left', 'up', 'down'],
			animation: [
				'linear',
				...['easeIn', 'easeOut', 'easeInOut'].flatMap((prefix) =>
					['Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo', 'Circ'].map((kind) => prefix + kind),
				),
			],
			motionBlur: ['off', 'low', 'medium', 'high'],
			edgeSmoothing: ['none', 'low', 'medium', 'high'],
		};
		const names = fc.constantFrom(...universeParams().map((p) => p.name), 'Blurriness', 'Unknown', '');
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						name: names,
						value,
						keyframes: fc.option(
							fc.array(fc.record({ time: fc.double(), value: fc.oneof(fc.double(), fc.boolean()) }), {
								maxLength: 3,
							}),
							{ nil: undefined },
						),
					}),
					{ maxLength: 20 },
				),
				(list) => {
					const p = premiereTransitionParams(
						UNIVERSE_SLIDE_MATCH_NAME,
						list as PremiereParam[],
						new Report(),
					);
					for (const [k, v] of Object.entries(p)) {
						if (k === 'reflection') expect(typeof v.value).toBe('boolean');
						else if (options[k]) expect(options[k]).toContain(v.value);
						else {
							expect(ranges[k], k).toBeDefined();
							expect(Number.isFinite(v.value)).toBe(true);
							expect(v.value).toBeGreaterThanOrEqual(ranges[k]![0]);
							expect(v.value).toBeLessThanOrEqual(ranges[k]![1]);
						}
						for (const kf of v.keyframes) expect(Number.isInteger(kf.time) && kf.time >= 0).toBe(true);
					}
				},
			),
		);
	});

	it('FCP7 XML: an effectid of Universe Slide becomes Smooth Slide with params; the name "Slide" alone stays Slide', () => {
		const report = new Report();
		const universe = `<effect><name>Slide</name><effectid>${UNIVERSE_SLIDE_MATCH_NAME}</effectid><effecttype>transition</effecttype><mediatype>video</mediatype>
			${param('Direction', '2')}${param('Animation', '17')}${param('Dolly', '0.4', '<keyframe><when>0</when><value>0</value></keyframe><keyframe><when>10</when><value>0.8</value></keyframe>')}
			${param('Reflection', 'TRUE')}${param('Motion Blur', '2')}${param('Motion Blur Shutter', '180')}${param('Input', '4294967293')}</effect>`;
		const p = importFcp7(xml(universe), {}, report);
		const t = Object.values(p.sequences)[0]!.video[0]!.transitions[0]!;
		expect(t.effectId).toBe('jasper.smooth-slide');
		expect(t.from).toBeNull();
		expect(t.params.direction!.value).toBe('up');
		expect(t.params.animation!.value).toBe('easeInOutCubic');
		expect(t.params.reflection!.value).toBe(true);
		expect(t.params.motionBlur!.value).toBe('medium');
		expect(t.params.shutterAngle!.value).toBe(180);
		expect(t.params.dolly!.keyframes.map((k) => [k.time, k.value])).toEqual([
			[0, 0],
			[framesToFlicks(10, { num: 30, den: 1 }), 0.8],
		]);
		expect(report.warnings).toEqual([]);
		// Into a document (project.importTimeline): a valid one-sided Smooth Slide at the clip's head.
		const imp = importTimeline(new TextEncoder().encode(xml(universe)), {
			format: 'fcp7',
			now: '2026-10-25T00:00:00.000Z',
		});
		const target = new Harness({ preset: 'hd-1080p-30', seed: 77 });
		const r = target.ok([{ type: 'project.importTimeline', fragment: imp }]);
		const seqId = (r.results[0] as { topSequenceIds: string[] }).topSequenceIds[0]!;
		expect(checkInvariants(target.doc, { effects: defaultRegistries().effects })).toEqual([]);
		const tr = Object.values((target.doc.sequences[seqId] as Sequence).transitions)[0]!;
		expect(tr).toMatchObject({ effectId: 'jasper.smooth-slide', outgoingClipId: null, duration: 15 });
		expect(tr.params.direction!.value).toBe('up');
		// Premiere's own Slide (no Universe MatchName) keeps its mapping.
		const own = importFcp7(
			xml(
				'<effect><name>Slide</name><effectid>Slide</effectid><effecttype>transition</effecttype><mediatype>video</mediatype></effect>',
			),
			{},
			new Report(),
		);
		expect(Object.values(own.sequences)[0]!.video[0]!.transitions[0]!.effectId).toBe('jasper.slide');
	});
});
