// Custom OpenColorIO configurations (`.ocio`, workstream color-mgmt), read from the published configuration format
// (a YAML document), not from OpenColorIO's source. Ported and extended from EffectCraft
// `crates/effects/src/ocio_config.rs` (MIT OR Apache-2.0, licenses/ported/color-mgmt.md).
//
// Supported: `ocio_profile_version` 1 and 2; `search_path`; `roles`; `colorspaces` and `display_colorspaces` (name,
// aliases, family, isdata, `to_reference`/`from_reference`, `to_scene_reference`/`from_scene_reference`,
// `to_display_reference`/`from_display_reference`; one direction is inverted for the other); `view_transforms` and
// `default_view_transform` (scene ↔ display reference); `displays` (v1 `!<View> {name, colorspace}`, v2
// `{name, view_transform, display_colorspace}`) and `shared_views`. Transforms: Matrix, File (`.cube`, `.3dl`,
// `.spi1d`, `.spi3d`, `.csp`, `.cc`/`.ccc`/`.cdl`; nearest / tetrahedral; inverse: exact for 1D and CDL, iterative
// for 3D), Exponent, ExponentWithLinear, Log, LogAffine, LogCamera, CDL (ASC / noClamp), Range, Group, ColorSpace,
// Allocation (uniform, lg2), ExposureContrast (linear style), FixedFunction (ACES_GamutComp13, XYZ_TO_xyY,
// XYZ_TO_uvY, RGB_TO_HSV) and Builtin (identity, ACES utility, ACEScc/ACEScct/ACEScg, the camera log builtins this
// project has curves for, the display builtins, the ACES 1.3 gamut-compression LMT). Anything else — the ACES output
// transforms (RRT/ODT), looks, context variables, unknown tags — is reported (`unsupported`) and refuses the
// conversion (`OcioError`); it never passes colours through silently (AGENTS.md §4).
import { type GamutId, gamutMatrix, gamutToXyzD65 } from '../cms/gamut.ts';
import { LOG_CURVES, type LogCurveId, signalFromNormalized } from '../cms/log.ts';
import { apply3InPlace, type ColorMatrix, det3, inv3 } from '../cms/matrix.ts';
import {
	accDecode,
	accEncode,
	acescctDecode,
	acescctEncode,
	curveDecode,
	curveEncode,
	hlgEncode,
	pqDecode,
	pqEncode,
} from '../cms/transfer.ts';
import { applyLut, type Lut, type Rgb } from '../lut.ts';
import { lutFormatOf, parseLutFile } from '../lut-formats.ts';
import { applyCdl, type Cdl, invertCdl, parseCdlXml } from './cdl.ts';
import { parseYaml, type Yaml, yGet, yNum, yNums, ySeq, yStr, yTag } from './yaml.ts';

export class OcioError extends Error {
	constructor(
		readonly code: 'E_OCIO_PARSE' | 'E_OCIO_UNKNOWN_SPACE' | 'E_OCIO_UNSUPPORTED' | 'E_OCIO_NO_INTERCHANGE',
		message: string,
	) {
		super(message);
		this.name = 'OcioError';
	}
}

/**
 * A self-contained config: the `.ocio` text and the contents of the files its FileTransforms reference (keyed by the
 * `src` string as written), made by the engine when the config is imported (`missing` = sources not found then).
 */
export type OcioBundle = {
	jasperOcioBundle: 1;
	name: string;
	config: string;
	files: Record<string, string>;
	missing: string[];
};

export function isOcioBundle(v: unknown): v is OcioBundle {
	const b = v as OcioBundle;
	return (
		!!b &&
		typeof b === 'object' &&
		b.jasperOcioBundle === 1 &&
		typeof b.config === 'string' &&
		!!b.files &&
		typeof b.files === 'object' &&
		Array.isArray(b.missing)
	);
}

type FileData = { kind: 'lut'; lut: Lut } | { kind: 'cdl'; list: { id: string; cdl: Cdl }[] };

export type OcioXf =
	| { k: 'matrix'; m: number[]; offset: number[] }
	| { k: 'file'; src: string; data: FileData | null; nearest: boolean; cccid: string }
	| { k: 'exponent'; value: Rgb }
	| { k: 'expLinear'; gamma: Rgb; offset: Rgb }
	| { k: 'log'; base: number }
	| { k: 'logAffine'; base: number; logSlope: Rgb; logOffset: Rgb; linSlope: Rgb; linOffset: Rgb }
	| {
			k: 'logCamera';
			base: number;
			logSlope: Rgb;
			logOffset: Rgb;
			linSlope: Rgb;
			linOffset: Rgb;
			linBreak: Rgb;
			linearSlope: Rgb | null;
	  }
	| { k: 'cdl'; cdl: Cdl; clamp: boolean }
	| {
			k: 'range';
			minIn: number | null;
			maxIn: number | null;
			minOut: number | null;
			maxOut: number | null;
			clamp: boolean;
	  }
	| { k: 'group'; children: OcioXf[] }
	| { k: 'colorspace'; src: string; dst: string }
	| { k: 'allocation'; lg2: boolean; vars: number[] }
	| { k: 'exposure'; exposure: number; contrast: number; gamma: number; pivot: number }
	| { k: 'fixed'; style: string; params: number[] }
	| { k: 'builtin'; style: string }
	| { k: 'inverse'; xf: OcioXf }
	| { k: 'unsupported'; what: string };

const vec3 = (y: Yaml | undefined, d: number): Rgb => {
	const v = yNums(y);
	if (v.length === 0) return [d, d, d];
	if (v.length < 3) return [v[0]!, v[0]!, v[0]!];
	return [v[0]!, v[1]!, v[2]!];
};

function fileData(src: string, files: Record<string, string>): FileData | null {
	const text = files[src];
	if (text === undefined) return null;
	const lower = src.toLowerCase();
	if (/\.(cc|ccc|cdl)$/.test(lower) || text.includes('<ColorCorrection')) {
		const list = parseCdlXml(text);
		return list.length ? { kind: 'cdl', list } : null;
	}
	try {
		return { kind: 'lut', lut: parseLutFile(text, lutFormatOf(src)) };
	} catch {
		return null;
	}
}

function xfFromYaml(y: Yaml, files: Record<string, string>, depth = 0): OcioXf {
	if (depth > 64) return { k: 'unsupported', what: 'transform nesting too deep' };
	const tag = yTag(y) ?? '';
	const body = y.t === 'tag' ? y.v : y;
	const inverse = (yStr(yGet(body, 'direction')) ?? '').toLowerCase() === 'inverse';
	let xf: OcioXf;
	switch (tag) {
		case 'MatrixTransform': {
			const v = yNums(yGet(body, 'matrix'));
			const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
			if (v.length === 16) m.splice(0, 16, ...v);
			else if (v.length === 9)
				for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 4 + c] = v[r * 3 + c]!;
			const o = yNums(yGet(body, 'offset'));
			const offset = [0, 0, 0, 0];
			for (let k = 0; k < Math.min(4, o.length); k++) offset[k] = o[k]!;
			xf = { k: 'matrix', m, offset };
			break;
		}
		case 'FileTransform': {
			const src = yStr(yGet(body, 'src')) ?? '';
			const interp = (yStr(yGet(body, 'interpolation')) ?? 'linear').toLowerCase();
			const cccid = yStr(yGet(body, 'cccid')) ?? yStr(yGet(body, 'ccc_id')) ?? '';
			xf = src.includes('$')
				? { k: 'unsupported', what: `FileTransform with a context variable (${src})` }
				: { k: 'file', src, data: fileData(src, files), nearest: interp === 'nearest', cccid };
			break;
		}
		case 'ExponentTransform':
			xf = { k: 'exponent', value: vec3(yGet(body, 'value'), 1) };
			break;
		case 'ExponentWithLinearTransform':
			xf = { k: 'expLinear', gamma: vec3(yGet(body, 'gamma'), 1), offset: vec3(yGet(body, 'offset'), 0) };
			break;
		case 'LogTransform':
			xf = { k: 'log', base: yNum(yGet(body, 'base')) ?? 2 };
			break;
		case 'LogAffineTransform':
		case 'LogCameraTransform': {
			const common = {
				base: yNum(yGet(body, 'base')) ?? 2,
				logSlope: vec3(yGet(body, 'logSideSlope'), 1),
				logOffset: vec3(yGet(body, 'logSideOffset'), 0),
				linSlope: vec3(yGet(body, 'linSideSlope'), 1),
				linOffset: vec3(yGet(body, 'linSideOffset'), 0),
			};
			if (tag === 'LogAffineTransform') xf = { k: 'logAffine', ...common };
			else {
				const br = yGet(body, 'linSideBreak');
				const ls = yGet(body, 'linearSlope');
				xf = br
					? { k: 'logCamera', ...common, linBreak: vec3(br, 0), linearSlope: ls ? vec3(ls, 1) : null }
					: { k: 'unsupported', what: 'LogCameraTransform without linSideBreak' };
			}
			break;
		}
		case 'CDLTransform':
			xf = {
				k: 'cdl',
				cdl: {
					slope: vec3(yGet(body, 'slope'), 1),
					offset: vec3(yGet(body, 'offset'), 0),
					power: vec3(yGet(body, 'power'), 1),
					sat: yNum(yGet(body, 'sat')) ?? 1,
				},
				clamp: !/noclamp/i.test(yStr(yGet(body, 'style')) ?? ''),
			};
			break;
		case 'RangeTransform':
			xf = {
				k: 'range',
				minIn: yNum(yGet(body, 'min_in_value')) ?? null,
				maxIn: yNum(yGet(body, 'max_in_value')) ?? null,
				minOut: yNum(yGet(body, 'min_out_value')) ?? null,
				maxOut: yNum(yGet(body, 'max_out_value')) ?? null,
				clamp: !/noclamp/i.test(yStr(yGet(body, 'style')) ?? ''),
			};
			break;
		case 'GroupTransform':
			xf = { k: 'group', children: ySeq(yGet(body, 'children')).map((c) => xfFromYaml(c, files, depth + 1)) };
			break;
		case 'ColorSpaceTransform':
			xf = { k: 'colorspace', src: yStr(yGet(body, 'src')) ?? '', dst: yStr(yGet(body, 'dst')) ?? '' };
			break;
		case 'AllocationTransform': {
			const a = (yStr(yGet(body, 'allocation')) ?? 'uniform').toLowerCase();
			xf = { k: 'allocation', lg2: a === 'lg2', vars: yNums(yGet(body, 'vars')) };
			break;
		}
		case 'ExposureContrastTransform': {
			const style = (yStr(yGet(body, 'style')) ?? 'linear').toLowerCase();
			xf = style.startsWith('linear')
				? {
						k: 'exposure',
						exposure: yNum(yGet(body, 'exposure')) ?? 0,
						contrast: yNum(yGet(body, 'contrast')) ?? 1,
						gamma: yNum(yGet(body, 'gamma')) ?? 1,
						pivot: yNum(yGet(body, 'pivot')) ?? 0.18,
					}
				: { k: 'unsupported', what: `ExposureContrastTransform style ${style}` };
			break;
		}
		case 'FixedFunctionTransform': {
			const style = yStr(yGet(body, 'style')) ?? '';
			xf = FIXED_STYLES.has(style.toUpperCase())
				? { k: 'fixed', style: style.toUpperCase(), params: yNums(yGet(body, 'params')) }
				: { k: 'unsupported', what: `FixedFunctionTransform ${style}` };
			break;
		}
		case 'BuiltinTransform': {
			const style = yStr(yGet(body, 'style')) ?? '';
			xf = builtinFn(style)
				? { k: 'builtin', style }
				: { k: 'unsupported', what: `BuiltinTransform "${style}"` };
			break;
		}
		default:
			xf = { k: 'unsupported', what: tag || 'untagged transform' };
	}
	return inverse ? { k: 'inverse', xf } : xf;
}

// ---------------------------------------------------------------- builtins

const FIXED_STYLES = new Set(['ACES_GAMUTCOMP13', 'XYZ_TO_XYY', 'XYZ_TO_UVY', 'RGB_TO_HSV']);

type Fn = (c: Rgb, inverse: boolean) => void;

const matFn =
	(m: ColorMatrix): Fn =>
	(c, inv) =>
		apply3InPlace(inv ? inv3(m) : m, c);

function curveFn(dec: (v: number) => number, enc: (x: number) => number): Fn {
	return (c, inv) => {
		for (let k = 0; k < 3; k++) c[k] = inv ? enc(c[k]!) : dec(c[k]!);
	};
}
const logFn = (id: LogCurveId): Fn => {
	const c = LOG_CURVES[id];
	return curveFn(
		(v) => c.decode(signalFromNormalized(v, 'pc', c.domain)),
		(x) => {
			const s = c.encode(x);
			return c.domain === 'ire' ? (64 + 876 * s) / 1023 : s;
		},
	);
};
const seq =
	(...fns: Fn[]): Fn =>
	(c, inv) => {
		if (inv) for (let i = fns.length - 1; i >= 0; i--) fns[i]!(c, true);
		else for (const f of fns) f(c, false);
	};
const toAp0 = (g: GamutId) => matFn(gamutMatrix(g, 'ap0'));
const camera = (curve: LogCurveId, g: GamutId) => seq(logFn(curve), toAp0(g));

/** CIE XYZ (D65) → display RGB (Bradford-adapted to the display white when it is not D65, the `_BFD` builtins). */
function xyzTo(g: GamutId): ColorMatrix {
	return inv3(gamutToXyzD65(g));
}
const display = (m: ColorMatrix, enc: (x: number) => number, dec: (v: number) => number): Fn =>
	seq(matFn(m), curveFn(enc, dec));
const pq100 = {
	enc: (x: number) => pqEncode(Math.max(0, x) / 100),
	dec: (v: number) => pqDecode(v) * 100,
};

const BUILTINS: Record<string, () => Fn> = {
	IDENTITY: () => () => {},
	'UTILITY - ACES-AP0_TO_CIE-XYZ-D65_BFD': () => matFn(gamutToXyzD65('ap0')),
	'UTILITY - ACES-AP1_TO_CIE-XYZ-D65_BFD': () => matFn(gamutToXyzD65('ap1')),
	'UTILITY - ACES-AP1_TO_LINEAR-REC709_BFD': () => matFn(gamutMatrix('ap1', 'bt709')),
	'CURVE - ACESCCT-LOG_TO_LINEAR': () => curveFn(acescctDecode, acescctEncode),
	'ACESCCT_TO_ACES2065-1': () => seq(curveFn(acescctDecode, acescctEncode), toAp0('ap1')),
	'ACESCC_TO_ACES2065-1': () => seq(curveFn(accDecode, accEncode), toAp0('ap1')),
	'ACESCG_TO_ACES2065-1': () => toAp0('ap1'),
	'ARRI_ALEXA-LOGC-EI800-AWG_TO_ACES2065-1': () => camera('logc3', 'awg3'),
	'ARRI_LOGC4_TO_ACES2065-1': () => camera('logc4', 'awg4'),
	'CANON_CLOG2-CGAMUT_TO_ACES2065-1': () => camera('clog2', 'cinemagamut'),
	'CANON_CLOG3-CGAMUT_TO_ACES2065-1': () => camera('clog3', 'cinemagamut'),
	'PANASONIC_VLOG-VGAMUT_TO_ACES2065-1': () => camera('vlog', 'vgamut'),
	'RED_LOG3G10-RWG_TO_ACES2065-1': () => camera('log3g10', 'rwg'),
	'SONY_SLOG3-SGAMUT3_TO_ACES2065-1': () => camera('slog3', 'sgamut3'),
	'SONY_SLOG3-SGAMUT3.CINE_TO_ACES2065-1': () => camera('slog3', 'sgamut3cine'),
	'APPLE_LOG_TO_ACES2065-1': () => camera('applelog', 'bt2020'),
	'CURVE - ARRI_LOGC4_TO_LINEAR': () => logFn('logc4'),
	'CURVE - APPLE_LOG_TO_LINEAR': () => logFn('applelog'),
	'CURVE - SONY_SLOG3_TO_LINEAR': () => logFn('slog3'),
	'CURVE - PANASONIC_VLOG_TO_LINEAR': () => logFn('vlog'),
	'CURVE - CANON_CLOG2_TO_LINEAR': () => logFn('clog2'),
	'CURVE - CANON_CLOG3_TO_LINEAR': () => logFn('clog3'),
	'CURVE - RED_LOG3G10_TO_LINEAR': () => logFn('log3g10'),
	'CURVE - ST-2084_TO_LINEAR': () => curveFn(pq100.dec, pq100.enc),
	'CURVE - LINEAR_TO_ST-2084': () => curveFn(pq100.enc, pq100.dec),
	'DISPLAY - CIE-XYZ-D65_TO_SRGB': () =>
		display(
			xyzTo('bt709'),
			(x) => curveEncode('srgb', x),
			(v) => curveDecode('srgb', v),
		),
	'DISPLAY - CIE-XYZ-D65_TO_REC.1886-REC.709': () =>
		display(
			xyzTo('bt709'),
			(x) => curveEncode('bt1886', x),
			(v) => curveDecode('bt1886', v),
		),
	'DISPLAY - CIE-XYZ-D65_TO_REC.1886-REC.2020': () =>
		display(
			xyzTo('bt2020'),
			(x) => curveEncode('bt1886', x),
			(v) => curveDecode('bt1886', v),
		),
	'DISPLAY - CIE-XYZ-D65_TO_G2.2-REC.709': () =>
		display(
			xyzTo('bt709'),
			(x) => curveEncode('gamma22', x),
			(v) => curveDecode('gamma22', v),
		),
	'DISPLAY - CIE-XYZ-D65_TO_G2.6-P3-D65': () =>
		display(
			xyzTo('p3d65'),
			(x) => curveEncode('gamma26', x),
			(v) => curveDecode('gamma26', v),
		),
	'DISPLAY - CIE-XYZ-D65_TO_G2.6-P3-DCI-BFD': () =>
		display(
			xyzTo('p3dci'),
			(x) => curveEncode('gamma26', x),
			(v) => curveDecode('gamma26', v),
		),
	'DISPLAY - CIE-XYZ-D65_TO_DISPLAYP3': () =>
		display(
			xyzTo('p3d65'),
			(x) => curveEncode('srgb', x),
			(v) => curveDecode('srgb', v),
		),
	'DISPLAY - CIE-XYZ-D65_TO_ST2084-P3-D65': () => display(xyzTo('p3d65'), pq100.enc, pq100.dec),
	'DISPLAY - CIE-XYZ-D65_TO_REC.2100-PQ': () => display(xyzTo('bt2020'), pq100.enc, pq100.dec),
	'DISPLAY - CIE-XYZ-D65_TO_REC.2100-HLG-1000NIT': () => {
		const m = xyzTo('bt2020');
		const l = [0.2627, 0.678, 0.0593] as const;
		return (c, inv) => {
			if (inv)
				throw new OcioError('E_OCIO_UNSUPPORTED', 'The inverse of the HLG display builtin is not supported');
			apply3InPlace(m, c);
			// display light (1 = 100 cd/m²) → normalised to the 1000 cd/m² peak → inverse OOTF (γ 1.2) → OETF
			for (let k = 0; k < 3; k++) c[k] = Math.max(0, c[k]! / 10);
			const yd = l[0] * c[0] + l[1] * c[1] + l[2] * c[2];
			const g = yd > 1e-12 ? yd ** ((1 - 1.2) / 1.2) : 0;
			for (let k = 0; k < 3; k++) c[k] = hlgEncode(Math.min(1, c[k]! * g));
		};
	},
	'ACES-LMT - ACES 1.3 REFERENCE GAMUT COMPRESSION': () => {
		const toAp1 = gamutMatrix('ap0', 'ap1');
		const back = gamutMatrix('ap1', 'ap0');
		return (c, inv) => {
			if (inv)
				throw new OcioError('E_OCIO_UNSUPPORTED', 'The inverse ACES gamut compression is not supported');
			apply3InPlace(toAp1, c);
			rgc(c, [1.147, 1.264, 1.312], [0.815, 0.803, 0.88], 1.2);
			apply3InPlace(back, c);
		};
	},
};

function builtinFn(style: string): Fn | null {
	const f = BUILTINS[style.trim().toUpperCase()];
	return f ? f() : null;
}

function rgc(c: Rgb, lim: readonly number[], th: readonly number[], pwr: number): void {
	const ach = Math.max(c[0], c[1], c[2]);
	if (!(Math.abs(ach) > 1e-12)) return;
	for (let k = 0; k < 3; k++) {
		const d = (ach - c[k]!) / Math.abs(ach);
		if (d < th[k]!) continue;
		const s = (lim[k]! - th[k]!) / (((1 - th[k]!) / (lim[k]! - th[k]!)) ** -pwr - 1) ** (1 / pwr);
		const x = (d - th[k]!) / s;
		c[k] = ach - (th[k]! + (s * x) / (1 + x ** pwr) ** (1 / pwr)) * Math.abs(ach);
	}
}

// ---------------------------------------------------------------- applying transforms

const logb = (v: number, base: number) => Math.log(Math.max(v, Number.MIN_VALUE)) / Math.log(base);

function invert1d(lut: Lut, c: Rgb): void {
	// Per channel: binary search in the (monotone) table, linear in between.
	const n = lut.size;
	for (let ch = 0; ch < 3; ch++) {
		const y = c[ch]!;
		const at = (i: number) => lut.data[3 * i + ch]!;
		const inc = at(n - 1) >= at(0);
		let lo = 0;
		let hi = n - 1;
		const before = (i: number) => (inc ? at(i) <= y : at(i) >= y);
		if (!before(0)) {
			c[ch] = lut.domainMin[ch]!;
			continue;
		}
		if (before(n - 1)) {
			c[ch] = lut.domainMax[ch]!;
			continue;
		}
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (before(mid)) lo = mid;
			else hi = mid;
		}
		const a = at(lo);
		const b = at(hi);
		const t = b === a ? 0 : (y - a) / (b - a);
		c[ch] = lut.domainMin[ch]! + ((lut.domainMax[ch]! - lut.domainMin[ch]!) * (lo + t)) / (n - 1);
	}
}

function nearestLut(lut: Lut, c: Rgb): void {
	if (lut.shaper) applyLut(lut.shaper, c);
	const s = lut.size - 1;
	const idx = [0, 1, 2].map((k) =>
		Math.round(
			Math.min(1, Math.max(0, (c[k]! - lut.domainMin[k]!) / (lut.domainMax[k]! - lut.domainMin[k]!))) * s,
		),
	);
	if (lut.dimensions === 1) {
		for (let k = 0; k < 3; k++) c[k] = lut.data[3 * idx[k]! + k]!;
		return;
	}
	const o = 3 * (idx[0]! + lut.size * (idx[1]! + lut.size * idx[2]!));
	c[0] = lut.data[o]!;
	c[1] = lut.data[o + 1]!;
	c[2] = lut.data[o + 2]!;
}

/** Resolves ColorSpaceTransform names (config-level, with a cycle guard). */
type SpaceResolver = (src: string, dst: string, c: Rgb, depth: number) => void;

function applyXf(xf: OcioXf, c: Rgb, inverse: boolean, resolve: SpaceResolver, depth: number): void {
	if (depth > 64)
		throw new OcioError('E_OCIO_UNSUPPORTED', 'Colour space references are nested too deeply (cycle?)');
	switch (xf.k) {
		case 'inverse':
			applyXf(xf.xf, c, !inverse, resolve, depth + 1);
			return;
		case 'matrix': {
			const m: ColorMatrix = [
				xf.m[0]!,
				xf.m[1]!,
				xf.m[2]!,
				xf.m[4]!,
				xf.m[5]!,
				xf.m[6]!,
				xf.m[8]!,
				xf.m[9]!,
				xf.m[10]!,
			];
			if (!inverse) {
				apply3InPlace(m, c);
				for (let k = 0; k < 3; k++) c[k] += xf.offset[k]!;
				return;
			}
			if (Math.abs(det3(m)) < 1e-12)
				throw new OcioError('E_OCIO_UNSUPPORTED', 'Inverse of a singular MatrixTransform');
			for (let k = 0; k < 3; k++) c[k] -= xf.offset[k]!;
			apply3InPlace(inv3(m), c);
			return;
		}
		case 'file': {
			if (!xf.data)
				throw new OcioError(
					'E_OCIO_UNSUPPORTED',
					`FileTransform "${xf.src}": the file is missing or unreadable`,
				);
			if (xf.data.kind === 'cdl') {
				const hit = xf.data.list.find((e) => xf.cccid && e.id === xf.cccid) ?? xf.data.list[0]!;
				if (inverse) invertCdl(hit.cdl, c);
				else applyCdl(hit.cdl, c);
				return;
			}
			const lut = xf.data.lut;
			if (!inverse) {
				if (xf.nearest) nearestLut(lut, c);
				else applyLut(lut, c);
				return;
			}
			if (lut.dimensions === 1) {
				invert1d(lut, c);
				return;
			}
			// 3D: damped fixed point from the target (Newton with an identity Jacobian), as EffectCraft.
			const target: Rgb = [c[0], c[1], c[2]];
			const x: Rgb = [c[0], c[1], c[2]];
			const y: Rgb = [0, 0, 0];
			for (let it = 0; it < 40; it++) {
				y[0] = x[0];
				y[1] = x[1];
				y[2] = x[2];
				applyLut(lut, y);
				const e0 = target[0] - y[0];
				const e1 = target[1] - y[1];
				const e2 = target[2] - y[2];
				if (Math.abs(e0) < 1e-7 && Math.abs(e1) < 1e-7 && Math.abs(e2) < 1e-7) break;
				x[0] += e0;
				x[1] += e1;
				x[2] += e2;
			}
			c[0] = x[0];
			c[1] = x[1];
			c[2] = x[2];
			return;
		}
		case 'exponent':
			for (let k = 0; k < 3; k++) {
				const p = inverse ? 1 / Math.max(xf.value[k]!, 1e-9) : xf.value[k]!;
				c[k] = Math.max(0, c[k]!) ** p;
			}
			return;
		case 'expLinear':
			for (let k = 0; k < 3; k++) {
				const g = xf.gamma[k]!;
				const off = xf.offset[k]!;
				if (g <= 1 || off <= 0) {
					c[k] = inverse ? Math.max(0, c[k]!) ** (1 / g) : Math.max(0, c[k]!) ** g;
					continue;
				}
				// moncurve (ACES CTL): forward = encoded → linear
				const xb = off / (g - 1);
				const fs = ((g - 1) / off) * ((off * g) / ((g - 1) * (1 + off))) ** g;
				if (!inverse) {
					const x = c[k]!;
					c[k] = x >= xb ? ((x + off) / (1 + off)) ** g : x * fs;
				} else {
					const y = c[k]!;
					const yb = xb * fs;
					c[k] = y >= yb ? (1 + off) * y ** (1 / g) - off : y / fs;
				}
			}
			return;
		case 'log':
			for (let k = 0; k < 3; k++) c[k] = inverse ? xf.base ** c[k]! : logb(c[k]!, xf.base);
			return;
		case 'logAffine':
			for (let k = 0; k < 3; k++)
				c[k] = inverse
					? (xf.base ** ((c[k]! - xf.logOffset[k]!) / xf.logSlope[k]!) - xf.linOffset[k]!) / xf.linSlope[k]!
					: xf.logSlope[k]! * logb(xf.linSlope[k]! * c[k]! + xf.linOffset[k]!, xf.base) + xf.logOffset[k]!;
			return;
		case 'logCamera':
			for (let k = 0; k < 3; k++) {
				const { base } = xf;
				const ls = xf.logSlope[k]!;
				const lo = xf.logOffset[k]!;
				const ns = xf.linSlope[k]!;
				const no = xf.linOffset[k]!;
				const br = xf.linBreak[k]!;
				const slope = xf.linearSlope?.[k] ?? (ls * ns) / ((ns * br + no) * Math.log(base));
				const logBr = ls * logb(ns * br + no, base) + lo;
				const off = logBr - slope * br;
				if (!inverse) {
					const x = c[k]!;
					c[k] = x <= br ? slope * x + off : ls * logb(ns * x + no, base) + lo;
				} else {
					const y = c[k]!;
					c[k] = y <= logBr ? (y - off) / slope : (base ** ((y - lo) / ls) - no) / ns;
				}
			}
			return;
		case 'cdl':
			if (inverse) invertCdl(xf.cdl, c, xf.clamp);
			else applyCdl(xf.cdl, c, xf.clamp);
			return;
		case 'range': {
			const [a0, a1, b0, b1] = inverse
				? [xf.minOut, xf.maxOut, xf.minIn, xf.maxIn]
				: [xf.minIn, xf.maxIn, xf.minOut, xf.maxOut];
			for (let k = 0; k < 3; k++) {
				let v = c[k]!;
				if (a0 !== null && a1 !== null && b0 !== null && b1 !== null) {
					const s = Math.abs(a1 - a0) > 1e-12 ? (b1 - b0) / (a1 - a0) : 0;
					v = b0 + (v - a0) * s;
				} else if (a0 !== null && b0 !== null) v = v - a0 + b0;
				else if (a1 !== null && b1 !== null) v = v - a1 + b1;
				if (xf.clamp) {
					if (b0 !== null) v = Math.max(b0, v);
					if (b1 !== null) v = Math.min(b1, v);
				}
				c[k] = v;
			}
			return;
		}
		case 'group':
			if (inverse)
				for (let i = xf.children.length - 1; i >= 0; i--)
					applyXf(xf.children[i]!, c, true, resolve, depth + 1);
			else for (const ch of xf.children) applyXf(ch, c, false, resolve, depth + 1);
			return;
		case 'colorspace':
			if (inverse) resolve(xf.dst, xf.src, c, depth + 1);
			else resolve(xf.src, xf.dst, c, depth + 1);
			return;
		case 'allocation': {
			const [mn = 0, mx = 1, off = 0] = xf.vars;
			for (let k = 0; k < 3; k++) {
				if (xf.lg2)
					c[k] = inverse
						? 2 ** (c[k]! * (mx - mn) + mn) - off
						: (Math.log2(Math.max(c[k]! + off, Number.MIN_VALUE)) - mn) / (mx - mn);
				else c[k] = inverse ? c[k]! * (mx - mn) + mn : (c[k]! - mn) / (mx - mn);
			}
			return;
		}
		case 'exposure': {
			const p = Math.max(xf.pivot, 1e-9);
			const g = xf.contrast * xf.gamma;
			const e = 2 ** xf.exposure;
			for (let k = 0; k < 3; k++)
				c[k] = inverse
					? ((Math.max(0, c[k]!) / p) ** (1 / Math.max(g, 1e-9)) * p) / e
					: (Math.max(0, c[k]! * e) / p) ** g * p;
			return;
		}
		case 'fixed':
			applyFixed(xf.style, xf.params, c, inverse);
			return;
		case 'builtin':
			builtinFn(xf.style)!(c, inverse);
			return;
		case 'unsupported':
			throw new OcioError('E_OCIO_UNSUPPORTED', `Unsupported OCIO transform: ${xf.what}`);
	}
}

function applyFixed(style: string, params: number[], c: Rgb, inverse: boolean): void {
	switch (style) {
		case 'ACES_GAMUTCOMP13': {
			if (inverse) throw new OcioError('E_OCIO_UNSUPPORTED', 'Inverse ACES_GamutComp13 is not supported');
			const [lc = 1.147, lm = 1.264, ly = 1.312, tc = 0.815, tm = 0.803, ty = 0.88, pw = 1.2] = params;
			rgc(c, [lc, lm, ly], [tc, tm, ty], pw);
			return;
		}
		case 'XYZ_TO_XYY': {
			if (!inverse) {
				const s = c[0] + c[1] + c[2];
				const y = c[1];
				c[0] = s === 0 ? 0 : c[0] / s;
				c[1] = s === 0 ? 0 : y / s;
				c[2] = y;
			} else {
				const [x, y, Y] = c;
				c[0] = y === 0 ? 0 : (x * Y) / y;
				c[1] = Y;
				c[2] = y === 0 ? 0 : ((1 - x - y) * Y) / y;
			}
			return;
		}
		case 'XYZ_TO_UVY': {
			if (!inverse) {
				const d = c[0] + 15 * c[1] + 3 * c[2];
				const Y = c[1];
				c[0] = d === 0 ? 0 : (4 * c[0]) / d;
				c[1] = d === 0 ? 0 : (9 * Y) / d;
				c[2] = Y;
			} else {
				const [u, v, Y] = c;
				c[0] = v === 0 ? 0 : (9 * u * Y) / (4 * v);
				c[1] = Y;
				c[2] = v === 0 ? 0 : ((12 - 3 * u - 20 * v) * Y) / (4 * v);
			}
			return;
		}
		case 'RGB_TO_HSV': {
			if (!inverse) {
				const [r, g, b] = c;
				const mx = Math.max(r, g, b);
				const mn = Math.min(r, g, b);
				const d = mx - mn;
				let h = 0;
				if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
				c[0] = (((h / 6) % 1) + 1) % 1;
				c[1] = mx === 0 ? 0 : d / mx;
				c[2] = mx;
			} else {
				const [h, s, v] = c;
				const f = (n: number) => {
					const k = (n + h * 6) % 6;
					return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
				};
				c[0] = f(5);
				c[1] = f(3);
				c[2] = f(1);
			}
			return;
		}
	}
	throw new OcioError('E_OCIO_UNSUPPORTED', `FixedFunctionTransform ${style}`);
}

function collectUnsupported(xf: OcioXf | null, out: Set<string>): void {
	if (!xf) return;
	switch (xf.k) {
		case 'unsupported':
			out.add(xf.what);
			break;
		case 'inverse':
			collectUnsupported(xf.xf, out);
			break;
		case 'group':
			for (const c of xf.children) collectUnsupported(c, out);
			break;
		case 'file':
			if (!xf.data) out.add(`FileTransform (missing "${xf.src}")`);
			break;
	}
}

// ---------------------------------------------------------------- the config

export type OcioSpace = {
	name: string;
	aliases: string[];
	family: string;
	description: string;
	isData: boolean;
	/** The reference this space is defined against (v2 `display_colorspaces` use the display reference). */
	reference: 'scene' | 'display';
	toRef: OcioXf | null;
	fromRef: OcioXf | null;
};

export type OcioView = {
	name: string;
	colorspace?: string;
	viewTransform?: string;
	displayColorspace?: string;
};

export class OcioConfig {
	readonly name: string;
	readonly version: number;
	readonly roles: [string, string][];
	readonly spaces: OcioSpace[];
	readonly displays: { name: string; views: OcioView[] }[];
	readonly viewTransforms: { name: string; fromScene: OcioXf | null; toScene: OcioXf | null }[];
	readonly defaultViewTransform: string | null;

	private constructor(
		init: Omit<
			OcioConfig,
			'space' | 'convertFn' | 'unsupported' | 'interchange' | 'viewSpace' | 'spaceNames'
		>,
	) {
		this.name = init.name;
		this.version = init.version;
		this.roles = init.roles;
		this.spaces = init.spaces;
		this.displays = init.displays;
		this.viewTransforms = init.viewTransforms;
		this.defaultViewTransform = init.defaultViewTransform;
	}

	/** Parses config text; FileTransform sources come from `files` (keyed by `src`). Throws `OcioError` (E_OCIO_PARSE). */
	static parse(text: string, files: Record<string, string> = {}): OcioConfig {
		let y: Yaml;
		try {
			y = parseYaml(text);
		} catch (e) {
			throw new OcioError('E_OCIO_PARSE', `Not a readable OCIO config: ${(e as Error).message}`);
		}
		if (y.t !== 'map') throw new OcioError('E_OCIO_PARSE', 'Not an OCIO config (expected a YAML mapping)');
		const version = yNum(yGet(y, 'ocio_profile_version')) ?? 1;
		const rolesY = yGet(y, 'roles');
		const roles: [string, string][] =
			rolesY?.t === 'map'
				? rolesY.v.map(([k, v]) => [k, yStr(v) ?? ''] as [string, string]).filter(([, v]) => !!v)
				: [];
		const spaces: OcioSpace[] = [];
		const xfOf = (cs: Yaml, keys: string[]) => {
			for (const k of keys) {
				const v = yGet(cs, k);
				if (v && v.t !== 'null') return xfFromYaml(v, files);
			}
			return null;
		};
		for (const [list, reference] of [
			['colorspaces', 'scene'],
			['display_colorspaces', 'display'],
		] as const) {
			for (const cs of ySeq(yGet(y, list))) {
				const name = yStr(yGet(cs, 'name'));
				if (!name) continue;
				const ref = (yStr(yGet(cs, 'reference_space')) ?? '').toLowerCase();
				spaces.push({
					name,
					aliases: ySeq(yGet(cs, 'aliases'))
						.map(yStr)
						.filter((s): s is string => !!s),
					family: yStr(yGet(cs, 'family')) ?? '',
					description: yStr(yGet(cs, 'description')) ?? '',
					isData: (yStr(yGet(cs, 'isdata')) ?? '').toLowerCase() === 'true',
					reference: ref === 'display' ? 'display' : ref === 'scene' ? 'scene' : reference,
					toRef: xfOf(cs, ['to_reference', 'to_scene_reference', 'to_display_reference']),
					fromRef: xfOf(cs, ['from_reference', 'from_scene_reference', 'from_display_reference']),
				});
			}
		}
		if (spaces.length === 0) throw new OcioError('E_OCIO_PARSE', 'The config has no colorspaces');
		const viewOf = (v: Yaml): OcioView | null => {
			const name = yStr(yGet(v, 'name'));
			if (!name) return null;
			const view: OcioView = { name };
			const cs = yStr(yGet(v, 'colorspace'));
			const vt = yStr(yGet(v, 'view_transform'));
			const dc = yStr(yGet(v, 'display_colorspace'));
			if (cs) view.colorspace = cs;
			if (vt) view.viewTransform = vt;
			if (dc) view.displayColorspace = dc;
			return view;
		};
		const shared = new Map<string, OcioView>();
		for (const v of ySeq(yGet(y, 'shared_views'))) {
			const view = viewOf(v);
			if (view) shared.set(view.name, view);
		}
		const displaysY = yGet(y, 'displays');
		const displays =
			displaysY?.t === 'map'
				? displaysY.v.map(([name, body]) => {
						const views: OcioView[] = [];
						const list = body.t === 'map' ? ySeq(yGet(body, 'views') ?? body) : ySeq(body);
						for (const v of list) {
							const view = viewOf(v);
							if (view) views.push(view);
						}
						for (const s of body.t === 'map' ? ySeq(yGet(body, 'shared_views')) : []) {
							const sv = shared.get(yStr(s) ?? '');
							if (sv) views.push(sv);
						}
						return { name, views };
					})
				: [];
		const viewTransforms = ySeq(yGet(y, 'view_transforms'))
			.map((vt) => ({
				name: yStr(yGet(vt, 'name')) ?? '',
				fromScene: xfOf(vt, ['from_scene_reference', 'from_reference']),
				toScene: xfOf(vt, ['to_scene_reference', 'to_reference']),
			}))
			.filter((v) => v.name);
		return new OcioConfig({
			name: yStr(yGet(y, 'name')) ?? '',
			version,
			roles,
			spaces,
			displays,
			viewTransforms,
			defaultViewTransform: yStr(yGet(y, 'default_view_transform')) ?? viewTransforms[0]?.name ?? null,
		});
	}

	static fromBundle(b: OcioBundle): OcioConfig {
		return OcioConfig.parse(b.config, b.files);
	}

	spaceNames(): string[] {
		return this.spaces.map((s) => s.name);
	}

	/** A colour space by name, alias or role (case-insensitive). */
	space(name: string): OcioSpace | undefined {
		const n = name.trim().toLowerCase();
		const by = (x: string) =>
			this.spaces.find((s) => s.name.toLowerCase() === x || s.aliases.some((a) => a.toLowerCase() === x));
		return by(n) ?? by((this.roles.find(([r]) => r.toLowerCase() === n)?.[1] ?? '').toLowerCase());
	}

	/** The colour space a display's view shows (v1 views), or null. */
	viewSpace(display: string, view: string): OcioSpace | null {
		const d =
			this.displays.find((x) => x.name.toLowerCase() === display.trim().toLowerCase()) ?? this.displays[0];
		const v = d?.views.find((x) => x.name.toLowerCase() === view.trim().toLowerCase()) ?? d?.views[0];
		const cs = v?.colorspace ?? v?.displayColorspace;
		return cs ? (this.space(cs) ?? null) : null;
	}

	/** Transforms of the config this module cannot apply (for warnings in the UI and refusals). */
	unsupported(): string[] {
		const out = new Set<string>();
		for (const s of this.spaces) {
			collectUnsupported(s.toRef, out);
			collectUnsupported(s.fromRef, out);
		}
		for (const v of this.viewTransforms) {
			collectUnsupported(v.fromScene, out);
			collectUnsupported(v.toScene, out);
		}
		return [...out].sort();
	}

	private toReference(s: OcioSpace, c: Rgb, resolve: SpaceResolver, depth: number): void {
		if (s.toRef) applyXf(s.toRef, c, false, resolve, depth);
		else if (s.fromRef) applyXf(s.fromRef, c, true, resolve, depth);
	}
	private fromReference(s: OcioSpace, c: Rgb, resolve: SpaceResolver, depth: number): void {
		if (s.fromRef) applyXf(s.fromRef, c, false, resolve, depth);
		else if (s.toRef) applyXf(s.toRef, c, true, resolve, depth);
	}
	private viewTransform(c: Rgb, sceneToDisplay: boolean, resolve: SpaceResolver, depth: number): void {
		const vt =
			this.viewTransforms.find((v) => v.name === this.defaultViewTransform) ?? this.viewTransforms[0];
		if (!vt)
			throw new OcioError(
				'E_OCIO_UNSUPPORTED',
				'Converting between a scene-referred and a display-referred space needs a view transform; the config has none',
			);
		if (sceneToDisplay) {
			if (vt.fromScene) applyXf(vt.fromScene, c, false, resolve, depth);
			else if (vt.toScene) applyXf(vt.toScene, c, true, resolve, depth);
		} else if (vt.toScene) applyXf(vt.toScene, c, false, resolve, depth);
		else if (vt.fromScene) applyXf(vt.fromScene, c, true, resolve, depth);
	}

	private convertInPlace(a: OcioSpace, b: OcioSpace, c: Rgb, depth: number): void {
		if (a.isData || b.isData || a.name === b.name) return;
		const resolve: SpaceResolver = (src, dst, x, d) => {
			const s = this.space(src);
			const t = this.space(dst);
			if (!s || !t)
				throw new OcioError(
					'E_OCIO_UNKNOWN_SPACE',
					`ColorSpaceTransform names an unknown space (${!s ? src : dst})`,
				);
			this.convertInPlace(s, t, x, d);
		};
		this.toReference(a, c, resolve, depth + 1);
		if (a.reference !== b.reference) this.viewTransform(c, a.reference === 'scene', resolve, depth + 1);
		this.fromReference(b, c, resolve, depth + 1);
	}

	/**
	 * The conversion from space `a` to space `b` (names, aliases or roles) as an in-place RGB function. Throws
	 * `OcioError` for unknown names and for conversions that use an unsupported transform (checked on a probe colour,
	 * so a config that cannot be applied fails here, not per pixel).
	 */
	convertFn(a: string, b: string): (c: Rgb) => void {
		const sa = this.space(a);
		const sb = this.space(b);
		if (!sa) throw new OcioError('E_OCIO_UNKNOWN_SPACE', `The config has no colour space "${a}"`);
		if (!sb) throw new OcioError('E_OCIO_UNKNOWN_SPACE', `The config has no colour space "${b}"`);
		const fn = (c: Rgb) => this.convertInPlace(sa, sb, c, 0);
		fn([0.18, 0.18, 0.18]);
		return fn;
	}

	/**
	 * The conversion from a config space to ACES2065-1 (scene) or CIE XYZ D65 (display), through the OCIO v2 interchange
	 * roles `aces_interchange` / `cie_xyz_d65_interchange`; how config spaces join this project's colour management.
	 */
	interchange(name: string): { fn: (c: Rgb) => void; space: 'aces2065' | 'xyz-d65' } {
		const s = this.space(name);
		if (!s) throw new OcioError('E_OCIO_UNKNOWN_SPACE', `The config has no colour space "${name}"`);
		const role = s.reference === 'display' ? 'cie_xyz_d65_interchange' : 'aces_interchange';
		const target = this.space(role);
		if (!target)
			throw new OcioError(
				'E_OCIO_NO_INTERCHANGE',
				`The config has no "${role}" role, so its spaces cannot be related to this project's colour spaces (OCIO v2 configs define it; use S_OCIOTransform for conversions inside the config)`,
			);
		return {
			fn: this.convertFn(s.name, target.name),
			space: s.reference === 'display' ? 'xyz-d65' : 'aces2065',
		};
	}
}

/** CIE XYZ (D65) → linear RGB of a gamut (for the display interchange). */
export function xyzD65ToGamut(g: GamutId): ColorMatrix {
	return inv3(gamutToXyzD65(g));
}
