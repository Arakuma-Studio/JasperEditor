// Premiere port: Premiere's audio transitions (Constant Power / Constant Gain / Exponential Fade / Custom Fade with
// FadeShapeType, FadeShapeValue and CrossfadeSymmetry) and off-centre crossfades through FCP7 XML and the IR.
import {
	CONSTANT_GAIN,
	CONSTANT_POWER,
	CUSTOM_FADE,
	EXPONENTIAL_FADE,
	type Sequence,
	type Transition,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportAaf } from '../src/aaf/index.ts';
import { exportEdl } from '../src/edl.ts';
import { exportFcp7, importFcp7 } from '../src/fcp7.ts';
import { toJasper } from '../src/jasper-import.ts';
import { premiereAudioTransition, premiereFadeShapeOf } from '../src/premiere-audio-fades.ts';
import { Report } from '../src/report.ts';

const anim = (value: string | number) => ({ value, keyframes: [] as never[] });
const where = { name: 'x' };

describe('premiereAudioTransition (the fade shape fields seen in Premiere 2025 projects)', () => {
	it('Constant Power with its own shape (Cosine @ 19, symmetrical) stays Constant Power', () => {
		const r = new Report();
		expect(
			premiereAudioTransition(CONSTANT_POWER, { type: '1', value: '19', symmetry: '0' }, r, where),
		).toEqual({
			effectId: CONSTANT_POWER,
			params: {},
		});
		expect(premiereAudioTransition(CONSTANT_GAIN, { type: 0, value: 0 }, r, where).effectId).toBe(
			CONSTANT_GAIN,
		);
		expect(r.entries).toEqual([]);
	});
	it('Custom Fade Cosine @ 12 / 13 / 30, symmetrical', () => {
		for (const v of ['12', '13', '30']) {
			const r = new Report();
			expect(premiereAudioTransition(CUSTOM_FADE, { type: '1', value: v, symmetry: '0' }, r, where)).toEqual({
				effectId: CUSTOM_FADE,
				params: { fadeShape: anim('cosine'), fadeValue: anim(Number(v)), symmetry: anim('symmetric') },
			});
			expect(r.entries).toEqual([]);
		}
	});
	it('a fixed transition with another shape becomes a Custom Fade; Exponential Fade keeps its curve; bad data is reported', () => {
		const r = new Report();
		expect(premiereAudioTransition(CONSTANT_POWER, { type: '1', value: '30' }, r, where)).toEqual({
			effectId: CUSTOM_FADE,
			params: { fadeShape: anim('cosine'), fadeValue: anim(30) },
		});
		expect(premiereAudioTransition(EXPONENTIAL_FADE, { type: '1', value: '30' }, r, where)).toEqual({
			effectId: EXPONENTIAL_FADE,
			params: {},
		});
		expect(r.entries.map((e) => e.level)).toEqual(['info', 'info']);
		const bad = new Report();
		expect(
			premiereAudioTransition(CUSTOM_FADE, { type: '7', value: 'abc', symmetry: '9' }, bad, where),
		).toEqual({
			effectId: CUSTOM_FADE,
			params: {},
		});
		expect(bad.entries.filter((e) => e.level === 'warning')).toHaveLength(3);
		const clamped = new Report();
		expect(premiereAudioTransition(CUSTOM_FADE, { value: 400 }, clamped, where).params.fadeValue).toEqual(
			anim(100),
		);
	});
	it('never throws and only produces readable Custom Fade params (fuzz)', () => {
		const any = fc.oneof(fc.string(), fc.double(), fc.integer({ min: -3, max: 3 }), fc.constant(undefined));
		fc.assert(
			fc.property(
				fc.constantFrom(CONSTANT_POWER, CONSTANT_GAIN, EXPONENTIAL_FADE, CUSTOM_FADE),
				any,
				any,
				any,
				(id, type, value, symmetry) => {
					const r = premiereAudioTransition(id, { type, value, symmetry }, new Report(), where);
					const p = r.params as Record<string, { value: unknown }>;
					if (p.fadeShape) expect(['linear', 'cosine']).toContain(p.fadeShape.value);
					if (p.fadeValue) {
						expect(Number.isFinite(p.fadeValue.value)).toBe(true);
						expect(Math.abs(p.fadeValue.value as number)).toBeLessThanOrEqual(100);
					}
					if (p.symmetry) expect(['symmetric', 'asymmetric']).toContain(p.symmetry.value);
				},
			),
		);
	});
	it('premiereFadeShapeOf writes the fields back', () => {
		expect(
			premiereFadeShapeOf({ fadeShape: anim('linear'), fadeValue: anim(-7), symmetry: anim('asymmetric') }),
		).toEqual({
			FadeShapeType: 0,
			FadeShapeValue: -7,
			CrossfadeSymmetry: 1,
		});
		expect(premiereFadeShapeOf({})).toEqual({ FadeShapeType: 1, FadeShapeValue: 19, CrossfadeSymmetry: 0 });
	});
});

/** A 30 fps FCP7 document: two audio clips cut at frame 60 with one transition item [start, end). */
function xml(effect: string, start: number, end: number, extra = ''): string {
	const file = (id: string) =>
		`<file id="${id}"><name>${id}.wav</name><pathurl>file:///m/${id}.wav</pathurl><duration>600</duration>` +
		'<media><audio><samplecharacteristics><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>';
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4"><sequence id="sequence-1"><name>S</name><rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
<media><audio><track>
<clipitem id="a"><name>a</name><rate><timebase>30</timebase></rate><start>0</start><end>60</end><in>100</in><out>160</out>${file('fa')}</clipitem>
<transitionitem><rate><timebase>30</timebase></rate><start>${start}</start><end>${end}</end><alignment>center</alignment>
<effect>${effect}<effecttype>transition</effecttype><mediatype>audio</mediatype>${extra}</effect></transitionitem>
<clipitem id="b"><name>b</name><rate><timebase>30</timebase></rate><start>60</start><end>120</end><in>100</in><out>160</out>${file('fb')}</clipitem>
</track></audio></media></sequence></xmeml>`;
}

function imported(text: string): { t: Transition; seq: Sequence; report: Report } {
	const report = new Report();
	const frag = toJasper(importFcp7(text, { baseDir: '/m' }, report), {}, report);
	const seq = frag.sequences.find((s) => Object.keys(s.transitions).length > 0)!;
	return { t: Object.values(seq.transitions)[0]!, seq, report };
}

const param = (id: string, v: string | number) =>
	`<parameter><parameterid>${id}</parameterid><value>${v}</value></parameter>`;

describe('FCP7 XML (Premiere dialect) audio transitions', () => {
	it('maps the names, the effect ids and the Spanish display names', () => {
		const cases: [string, string][] = [
			['<name>Constant Power</name><effectid>KGAudioTransCrossFade3dB</effectid>', CONSTANT_POWER],
			['<name>Cross Fade (0dB)</name><effectid>KGAudioTransCrossFade0dB</effectid>', CONSTANT_GAIN],
			['<name>Constant Gain</name>', CONSTANT_GAIN],
			['<name>Exponential Fade</name>', EXPONENTIAL_FADE],
			['<name>Potencia constante</name><effectid>Constant Power</effectid>', CONSTANT_POWER],
			['<name>Fundido personalizado</name><effectid>Custom Fade</effectid>', CUSTOM_FADE],
			['<name>Some Localised Name</name><effectid>KGAudioTransCrossFade0dB</effectid>', CONSTANT_GAIN],
		];
		for (const [effect, id] of cases) {
			const { t, report } = imported(xml(effect, 50, 70));
			expect(t.effectId).toBe(id);
			expect(report.entries.filter((e) => e.level === 'warning')).toEqual([]);
		}
	});

	it('reads the Custom Fade shape and keeps an off-centre span (Custom Start) instead of re-centring it', () => {
		const { t, seq, report } = imported(
			xml(
				'<name>Fundido personalizado</name><effectid>Custom Fade</effectid>',
				56,
				76,
				param('FadeShapeType', 1) + param('FadeShapeValue', 30) + param('CrossfadeSymmetry', 0),
			),
		);
		expect(t).toMatchObject({ effectId: CUSTOM_FADE, duration: 20, alignment: 'center', cutPosition: 0.2 });
		expect(t.params).toEqual({ fadeShape: anim('cosine'), fadeValue: anim(30), symmetry: anim('symmetric') });
		expect(report.entries.filter((e) => e.level === 'warning')).toEqual([]);
		expect(seq.clips[t.outgoingClipId!]).toBeTruthy();
		// at-cut spans keep their alignments, a centred one has no cut position
		expect(imported(xml('<name>Constant Power</name>', 60, 80)).t).toMatchObject({
			alignment: 'start-at-cut',
		});
		expect(imported(xml('<name>Constant Power</name>', 40, 60)).t).toMatchObject({ alignment: 'end-at-cut' });
		expect(imported(xml('<name>Constant Power</name>', 50, 70)).t.cutPosition).toBeUndefined();
	});

	it('writes and reads back a Custom Fade (asymmetrical, off-centre) through FCP7 XML', () => {
		const first = imported(
			xml(
				'<name>Custom Fade</name>',
				48,
				78,
				param('FadeShapeType', 0) +
					param('FadeShapeValue', -12.5) +
					param('CrossfadeSymmetry', 1) +
					param('outFadeShape', 'cosine') +
					param('outFadeValue', 40),
			),
		);
		expect(first.t.params).toEqual({
			fadeShape: anim('linear'),
			fadeValue: anim(-12.5),
			symmetry: anim('asymmetric'),
			outFadeShape: anim('cosine'),
			outFadeValue: anim(40),
		});
		expect(first.t.cutPosition).toBe(0.4);
		// IR → XML → IR
		const report = new Report();
		const p = importFcp7(xml('<name>Custom Fade</name>', 48, 78, ''), { baseDir: '/m' }, report);
		const tr = p.sequences[Object.keys(p.sequences)[0]!]!.audio[0]!.transitions[0]!;
		tr.params = first.t.params;
		const text = exportFcp7(p, p.top[0]!, {}, new Report());
		expect(text).toContain('<parameterid>FadeShapeValue</parameterid>');
		const again = imported(text);
		expect(again.t.effectId).toBe(CUSTOM_FADE);
		expect(again.t.params).toEqual(first.t.params);
		expect(again.t.cutPosition).toBe(0.4);
	});

	it('EDL and AAF say that a Custom Fade’s shape is not carried (never dropped silently)', () => {
		const p = importFcp7(
			xml('<name>Custom Fade</name>', 48, 78, param('FadeShapeType', 0) + param('FadeShapeValue', 30)),
			{ baseDir: '/m' },
			new Report(),
		);
		const sid = p.top[0]!;
		for (const write of [(r: Report) => exportEdl(p, sid, {}, r), (r: Report) => exportAaf(p, sid, {}, r)]) {
			const r = new Report();
			write(r);
			expect(
				r.entries.some(
					(e) => e.level === 'warning' && e.message.includes('parameters of transition "Custom Fade"'),
				),
			).toBe(true);
		}
	});
});
