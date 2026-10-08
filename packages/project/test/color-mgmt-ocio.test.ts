// color-mgmt: custom OCIO configs — YAML subset, spaces/roles/displays, every supported transform, interchange
// roles, refusals of unsupported transforms, hostile input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyCdl,
	gamutMatrix,
	invertCdl,
	logEncode,
	OcioConfig,
	OcioError,
	parseCdlXml,
	parseYaml,
	type Rgb,
	yGet,
	yNums,
	ySeq,
	yStr,
	yTag,
} from '../src/index.ts';

const CONFIG = `
ocio_profile_version: 2

name: Test Config   # a comment
search_path: "luts:other"
roles:
  scene_linear: lin
  color_timing: "log2"

displays:
  sRGB:
    - !<View> {name: Standard, colorspace: gamma22}
    - !<View> {name: Raw, colorspace: raw}

colorspaces:
  - !<ColorSpace>
    name: lin
    family: ""
    description: |
      The reference.
      Linear.
    isdata: false

  - !<ColorSpace>
    name: gamma22
    aliases: [g22, "gamma 2.2"]
    to_scene_reference: !<ExponentTransform> {value: [2.2, 2.2, 2.2, 1]}

  - !<ColorSpace>
    name: half
    from_reference: !<MatrixTransform> {matrix: [0.5, 0, 0, 0,
                                                0, 0.5, 0, 0,
                                                0, 0, 0.5, 0,
                                                0, 0, 0, 1], offset: [0.1, 0.1, 0.1, 0]}

  - !<ColorSpace>
    name: log2
    from_reference: !<GroupTransform>
      children:
        - !<MatrixTransform> {matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]}
        - !<LogTransform> {base: 2}

  - !<ColorSpace>
    name: affine
    to_reference: !<LogAffineTransform> {base: 10, logSideSlope: 0.5, logSideOffset: 0.2, linSideSlope: 2, linSideOffset: 0.01, direction: inverse}

  - !<ColorSpace>
    name: lut
    to_reference: !<FileTransform> {src: double.cube, interpolation: linear}

  - !<ColorSpace>
    name: raw
    isdata: true

  - !<ColorSpace>
    name: weird
    to_reference: !<ExposureContrastTransform> {exposure: 1, style: video}
`;

const FILES = { 'double.cube': 'LUT_1D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n2 2 2\n' };
const run = (fn: (c: Rgb) => void, c: Rgb): Rgb => {
	const o: Rgb = [c[0], c[1], c[2]];
	fn(o);
	return o;
};
const close = (a: readonly number[], b: readonly number[], tol: number) => {
	for (let k = 0; k < 3; k++) expect(Math.abs(a[k]! - b[k]!), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
};

describe('YAML subset', () => {
	it('block and flow collections, tags, quotes, sequences at the key indent', () => {
		const y = parseYaml("a: 1\nb:\n  - x\n  - {k: [1, 2], s: 'q: r'}\nc: !<T> {v: 3}\nd:\n- 4\n- 5\n");
		expect(yStr(yGet(y, 'a'))).toBe('1');
		expect(ySeq(yGet(y, 'b'))).toHaveLength(2);
		expect(yNums(yGet(ySeq(yGet(y, 'b'))[1], 'k'))).toEqual([1, 2]);
		expect(yStr(yGet(ySeq(yGet(y, 'b'))[1], 's'))).toBe('q: r');
		expect(yTag(yGet(y, 'c'))).toBe('T');
		expect(yStr(yGet(yGet(y, 'c'), 'v'))).toBe('3');
		expect(ySeq(yGet(y, 'd'))).toHaveLength(2);
	});
	it('never throws on random text except the size limits (fuzz)', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 300 }), (t) => {
				try {
					parseYaml(t);
					return true;
				} catch (e) {
					return e instanceof RangeError;
				}
			}),
			{ numRuns: 3000 },
		);
		expect(() => parseYaml(`a: ${'['.repeat(1000)}`)).toThrow(RangeError);
	});
});

describe('OCIO config (EffectCraft test, ported)', () => {
	const c = OcioConfig.parse(CONFIG, FILES);
	it('parses spaces, roles, aliases and displays', () => {
		expect(c.name).toBe('Test Config');
		expect(c.spaceNames()).toEqual(['lin', 'gamma22', 'half', 'log2', 'affine', 'lut', 'raw', 'weird']);
		expect(c.space('scene_linear')?.name).toBe('lin');
		expect(c.space('G22')?.name).toBe('gamma22');
		expect(c.space('gamma 2.2')?.name).toBe('gamma22');
		expect(c.viewSpace('sRGB', 'Standard')?.name).toBe('gamma22');
	});
	it('converts through the reference with every transform and its inverse', () => {
		const g = run(c.convertFn('gamma22', 'lin'), [0.5, 0.25, 1]);
		close(g, [0.5 ** 2.2, 0.25 ** 2.2, 1], 1e-12);
		close(run(c.convertFn('lin', 'gamma22'), g), [0.5, 0.25, 1], 1e-12);
		const h = run(c.convertFn('lin', 'half'), [0.4, 0.6, 1]);
		close(h, [0.3, 0.4, 0.6], 1e-12);
		close(run(c.convertFn('half', 'lin'), h), [0.4, 0.6, 1], 1e-12);
		close(run(c.convertFn('lin', 'log2'), [0.5, 2, 4]), [0, 2, 3], 1e-12);
		close(run(c.convertFn('log2', 'lin'), [0, 2, 3]), [0.5, 2, 4], 1e-12);
		const a = run(c.convertFn('lin', 'affine'), [0.18, 0.5, 1]);
		close(
			a,
			[0.18, 0.5, 1].map((v) => 0.5 * Math.log10(2 * v + 0.01) + 0.2),
			1e-12,
		);
		close(run(c.convertFn('affine', 'lin'), a), [0.18, 0.5, 1], 1e-12);
		close(run(c.convertFn('lut', 'lin'), [0.25, 0.5, 0]), [0.5, 1, 0], 1e-6);
		close(run(c.convertFn('lin', 'lut'), [0.5, 1, 0]), [0.25, 0.5, 0], 1e-6); // exact 1D inverse
		expect(run(c.convertFn('raw', 'gamma22'), [0.3, 0.3, 0.3])).toEqual([0.3, 0.3, 0.3]);
	});
	it('refuses unsupported transforms and unknown names instead of passing colours through', () => {
		expect(c.unsupported()).toEqual(['ExposureContrastTransform style video']);
		expect(() => c.convertFn('weird', 'lin')).toThrow(OcioError);
		expect(() => c.convertFn('nope', 'lin')).toThrow(/no colour space "nope"/);
		expect(() => OcioConfig.parse('just: text\n')).toThrow(OcioError);
		expect(() => OcioConfig.parse(CONFIG, {}).convertFn('lut', 'lin')).toThrow(/missing or unreadable/);
	});
});

const ACES_LIKE = `ocio_profile_version: 2.1
name: aces-like
roles:
  aces_interchange: ACES2065-1
  cie_xyz_d65_interchange: CIE-XYZ-D65
  scene_linear: ACEScg
default_view_transform: Un-tone-mapped
view_transforms:
  - !<ViewTransform>
    name: Un-tone-mapped
    from_scene_reference: !<BuiltinTransform> {style: "UTILITY - ACES-AP0_to_CIE-XYZ-D65_BFD"}
displays:
  sRGB - Display:
    - !<View> {name: Un-tone-mapped, view_transform: Un-tone-mapped, display_colorspace: sRGB - Display}
colorspaces:
  - !<ColorSpace>
    name: ACES2065-1
  - !<ColorSpace>
    name: ACEScg
    to_scene_reference: !<BuiltinTransform> {style: ACEScg_to_ACES2065-1}
  - !<ColorSpace>
    name: ACEScct
    to_scene_reference: !<BuiltinTransform> {style: ACEScct_to_ACES2065-1}
  - !<ColorSpace>
    name: S-Log3 S-Gamut3.Cine
    to_scene_reference: !<BuiltinTransform> {style: SONY_SLOG3-SGAMUT3.CINE_to_ACES2065-1}
  - !<ColorSpace>
    name: Camera Look
    to_scene_reference: !<GroupTransform>
      children:
        - !<BuiltinTransform> {style: ACEScct_to_ACES2065-1, direction: inverse}
        - !<CDLTransform> {slope: [1.1, 1, 0.9], offset: [0.01, 0, -0.01], power: [1, 1, 1], sat: 0.9, direction: inverse}
        - !<BuiltinTransform> {style: ACEScct_to_ACES2065-1}
  - !<ColorSpace>
    name: Camera LogCam
    to_scene_reference: !<LogCameraTransform> {base: 10, logSideSlope: 0.25, logSideOffset: 0.4, linSideSlope: 5, linSideOffset: 0.05, linSideBreak: 0.01, direction: inverse}
  - !<ColorSpace>
    name: Linear Rec.709 alias
    to_scene_reference: !<ColorSpaceTransform> {src: Lin709, dst: ACES2065-1}
  - !<ColorSpace>
    name: Lin709
    to_scene_reference: !<MatrixTransform> {matrix: [0.4396329819, 0.3829886982, 0.1773783199, 0, 0.0897764430, 0.8134394287, 0.0967841283, 0, 0.0175411704, 0.1115465533, 0.8709122763, 0, 0, 0, 0, 1]}
  - !<ColorSpace>
    name: Output
    to_scene_reference: !<BuiltinTransform> {style: "ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-VIDEO_1.0"}
display_colorspaces:
  - !<ColorSpace>
    name: CIE-XYZ-D65
  - !<ColorSpace>
    name: sRGB - Display
    from_display_reference: !<BuiltinTransform> {style: "DISPLAY - CIE-XYZ-D65_to_sRGB"}
`;

describe('OCIO v2 config with builtins, view transforms and interchange roles', () => {
	const c = OcioConfig.parse(ACES_LIKE);
	it('camera builtins land on ACES2065-1 exactly like our own S-Log3 / S-Gamut3.Cine decode', () => {
		const grey = logEncode('slog3', 0.18);
		const ap0 = run(c.convertFn('S-Log3 S-Gamut3.Cine', 'ACES2065-1'), [grey, grey, grey]);
		close(ap0, [0.18, 0.18, 0.18], 1e-9);
		const red = run(c.convertFn('S-Log3 S-Gamut3.Cine', 'ACEScg'), [0.6, grey, grey]);
		const own = [0.6, grey, grey].map((v) =>
			v >= 171.2102946929 / 1023 ? 10 ** ((v * 1023 - 420) / 261.5) * 0.19 - 0.01 : 0,
		) as Rgb;
		const m = gamutMatrix('sgamut3cine', 'ap1');
		close(
			red,
			[
				m[0] * own[0] + m[1] * own[1] + m[2] * own[2],
				m[3] * own[0] + m[4] * own[1] + m[5] * own[2],
				m[6] * own[0] + m[7] * own[1] + m[8] * own[2],
			],
			1e-9,
		);
	});
	it('ACEScct round trip, CDL group, LogCamera, ColorSpaceTransform', () => {
		const cct = run(c.convertFn('ACEScg', 'ACEScct'), [0.18, 0.5, 2]);
		close(run(c.convertFn('ACEScct', 'ACEScg'), cct), [0.18, 0.5, 2], 1e-9);
		const look = run(c.convertFn('ACEScct', 'Camera Look'), [0.4, 0.5, 0.6]);
		close(run(c.convertFn('Camera Look', 'ACEScct'), look), [0.4, 0.5, 0.6], 1e-6);
		const lc = run(c.convertFn('ACES2065-1', 'Camera LogCam'), [0.001, 0.18, 1]);
		close(run(c.convertFn('Camera LogCam', 'ACES2065-1'), lc), [0.001, 0.18, 1], 1e-9);
		const v = run(c.convertFn('Linear Rec.709 alias', 'Lin709'), [0.2, 0.4, 0.6]);
		close(v, [0.2, 0.4, 0.6], 1e-7);
	});
	it('scene → display goes through the default view transform', () => {
		const s = run(c.convertFn('ACES2065-1', 'sRGB - Display'), [0.18, 0.18, 0.18]);
		// ACES white → D65 (Bradford) keeps a neutral neutral: sRGB-encoded 0.18
		close(s, [0.461356, 0.461356, 0.461356], 2e-4);
	});
	it('interchange roles relate config spaces to ACES2065-1 / XYZ', () => {
		const i = c.interchange('ACEScct');
		expect(i.space).toBe('aces2065');
		const d = c.interchange('sRGB - Display');
		expect(d.space).toBe('xyz-d65');
		expect(() => OcioConfig.parse(CONFIG, FILES).interchange('lin')).toThrow(/aces_interchange/);
	});
	it('the ACES output transform is refused, never passed through', () => {
		expect(c.unsupported()).toContain(
			'BuiltinTransform "ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-VIDEO_1.0"',
		);
		expect(() => c.convertFn('Output', 'ACES2065-1')).toThrow(OcioError);
	});
});

describe('ASC CDL', () => {
	it('parses .ccc collections and inverts exactly inside the range', () => {
		const xml = `<ColorCorrectionCollection><ColorCorrection id="a"><SOPNode><Slope>1.2 1 0.8</Slope><Offset>0.01 0 -0.02</Offset><Power>1.1 1 0.9</Power></SOPNode><SatNode><Saturation>0.8</Saturation></SatNode></ColorCorrection><ColorCorrection id='b'/></ColorCorrectionCollection>`;
		const list = parseCdlXml(xml);
		expect(list.map((e) => e.id)).toEqual(['a', 'b']);
		const cdl = list[0]!.cdl;
		expect(cdl.sat).toBe(0.8);
		const c: Rgb = [0.3, 0.5, 0.6];
		applyCdl(cdl, c);
		invertCdl(cdl, c);
		close(c, [0.3, 0.5, 0.6], 1e-9);
		expect(parseCdlXml('<garbage')).toEqual([]);
		expect(parseCdlXml('<ColorCorrection>')).toEqual([
			{ id: '', cdl: { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 } },
		]);
	});
});

describe('config parser on hostile input (fuzz)', () => {
	it('mutated configs either parse or throw OcioError', () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: ACES_LIKE.length }), fc.string({ maxLength: 12 }), (pos, ins) => {
				const t = ACES_LIKE.slice(0, pos) + ins + ACES_LIKE.slice(pos);
				try {
					const c = OcioConfig.parse(t);
					for (const s of c.spaceNames().slice(0, 4))
						try {
							c.convertFn(s, c.spaceNames()[0]!)([0.5, 0.5, 0.5]);
						} catch (e) {
							if (!(e instanceof OcioError)) return false;
						}
					return true;
				} catch (e) {
					return e instanceof OcioError;
				}
			}),
			{ numRuns: 600 },
		);
	});
});
