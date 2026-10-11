// Colour spaces (workstream color-mgmt): the source spaces of Interpret Footage ▸ Colour, the sequence working spaces
// and the export output spaces, each = an RGB gamut + a transfer curve + how its signal relates to light ("kind"):
//   'sdr'   display-referred SDR (decoded with the display EOTF; 1.0 = SDR white),
//   'pq'    SMPTE ST 2084, absolute cd/m²,
//   'hlg'   BT.2100 HLG (scene light; the OOTF of a 1000 cd/m² display turns it into display light),
//   'scene' scene-referred (camera log, ACES, scene-linear; 18 % grey = 0.18).
// Auto-detection from stream tags (`spaceFromStreamTags`) follows the ffprobe names of ISO/IEC 23091-2 code points.
import { GAMUTS, type GamutId } from './gamut.ts';
import { LOG_CURVES, type LogCurveId, type LogDomain } from './log.ts';
import type { CurveId } from './transfer.ts';

export type SpaceKind = 'sdr' | 'pq' | 'hlg' | 'scene';

export type ColorSpaceDef = {
	id: string;
	label: string;
	/** Menu group (Interpret Footage, OCIO). */
	group: 'Display' | 'HDR' | 'Scene linear / ACES' | 'Camera log';
	gamut: GamutId;
	curve: CurveId;
	kind: SpaceKind;
	/** ffmpeg tags written for this space (`-color_primaries`, `-color_trc`, `-colorspace`); null = not an output. */
	tags: { primaries: string; trc: string; matrix: string } | null;
};

const LOG_SPACE = (id: string, curve: LogCurveId, gamut: GamutId, gamutLabel?: string): ColorSpaceDef => ({
	id,
	label: `${LOG_CURVES[curve].label} / ${gamutLabel ?? GAMUTS[gamut].label}`,
	group: 'Camera log',
	gamut,
	curve,
	kind: 'scene',
	tags: null,
});

const T709 = { primaries: 'bt709', trc: 'bt709', matrix: 'bt709' };

/** Every colour space, in menu order. Ids are stable (project files, commands, MCP). */
export const COLOR_SPACES: readonly ColorSpaceDef[] = [
	{
		id: 'rec709',
		label: 'Rec. 709',
		group: 'Display',
		gamut: 'bt709',
		curve: 'bt1886',
		kind: 'sdr',
		tags: T709,
	},
	{
		id: 'srgb',
		label: 'sRGB',
		group: 'Display',
		gamut: 'bt709',
		curve: 'srgb',
		kind: 'sdr',
		tags: { primaries: 'bt709', trc: 'iec61966-2-1', matrix: 'bt709' },
	},
	{
		id: 'rec2020',
		label: 'Rec. 2020',
		group: 'Display',
		gamut: 'bt2020',
		curve: 'bt1886',
		kind: 'sdr',
		tags: { primaries: 'bt2020', trc: 'bt709', matrix: 'bt2020nc' },
	},
	{
		id: 'p3d65',
		label: 'P3-D65',
		group: 'Display',
		gamut: 'p3d65',
		curve: 'bt1886',
		kind: 'sdr',
		tags: { primaries: 'smpte432', trc: 'bt709', matrix: 'bt709' },
	},
	{
		id: 'displayp3',
		label: 'Display P3',
		group: 'Display',
		gamut: 'p3d65',
		curve: 'srgb',
		kind: 'sdr',
		tags: { primaries: 'smpte432', trc: 'iec61966-2-1', matrix: 'bt709' },
	},
	{
		id: 'p3dci',
		label: 'DCI-P3 (gamma 2.6)',
		group: 'Display',
		gamut: 'p3dci',
		curve: 'gamma26',
		kind: 'sdr',
		tags: null,
	},
	{
		id: 'gamma22',
		label: 'Gamma 2.2 (Rec. 709 primaries)',
		group: 'Display',
		gamut: 'bt709',
		curve: 'gamma22',
		kind: 'sdr',
		tags: null,
	},
	{
		id: 'rec2100-pq',
		label: 'Rec. 2100 PQ',
		group: 'HDR',
		gamut: 'bt2020',
		curve: 'pq',
		kind: 'pq',
		tags: { primaries: 'bt2020', trc: 'smpte2084', matrix: 'bt2020nc' },
	},
	{
		id: 'rec2100-hlg',
		label: 'Rec. 2100 HLG',
		group: 'HDR',
		gamut: 'bt2020',
		curve: 'hlg',
		kind: 'hlg',
		tags: { primaries: 'bt2020', trc: 'arib-std-b67', matrix: 'bt2020nc' },
	},
	{ id: 'p3d65-pq', label: 'P3-D65 PQ', group: 'HDR', gamut: 'p3d65', curve: 'pq', kind: 'pq', tags: null },
	{
		id: 'linear-rec709',
		label: 'Linear Rec. 709',
		group: 'Scene linear / ACES',
		gamut: 'bt709',
		curve: 'linear',
		kind: 'scene',
		tags: null,
	},
	{
		id: 'linear-rec2020',
		label: 'Linear Rec. 2020',
		group: 'Scene linear / ACES',
		gamut: 'bt2020',
		curve: 'linear',
		kind: 'scene',
		tags: null,
	},
	{
		id: 'linear-p3d65',
		label: 'Linear P3-D65',
		group: 'Scene linear / ACES',
		gamut: 'p3d65',
		curve: 'linear',
		kind: 'scene',
		tags: null,
	},
	{
		id: 'acescg',
		label: 'ACEScg',
		group: 'Scene linear / ACES',
		gamut: 'ap1',
		curve: 'linear',
		kind: 'scene',
		tags: null,
	},
	{
		id: 'aces2065',
		label: 'ACES2065-1',
		group: 'Scene linear / ACES',
		gamut: 'ap0',
		curve: 'linear',
		kind: 'scene',
		tags: null,
	},
	{
		id: 'acescct',
		label: 'ACEScct',
		group: 'Scene linear / ACES',
		gamut: 'ap1',
		curve: 'acescct',
		kind: 'scene',
		tags: null,
	},
	{
		id: 'acescc',
		label: 'ACEScc',
		group: 'Scene linear / ACES',
		gamut: 'ap1',
		curve: 'acescc',
		kind: 'scene',
		tags: null,
	},
	LOG_SPACE('slog3-sgamut3cine', 'slog3', 'sgamut3cine'),
	LOG_SPACE('slog3-sgamut3', 'slog3', 'sgamut3'),
	LOG_SPACE('slog2-sgamut', 'slog2', 'sgamut3', 'Sony S-Gamut'),
	LOG_SPACE('slog-sgamut', 'slog', 'sgamut3', 'Sony S-Gamut'),
	LOG_SPACE('vlog-vgamut', 'vlog', 'vgamut'),
	LOG_SPACE('clog-cinemagamut', 'clog', 'cinemagamut'),
	LOG_SPACE('clog2-cinemagamut', 'clog2', 'cinemagamut'),
	LOG_SPACE('clog3-cinemagamut', 'clog3', 'cinemagamut'),
	LOG_SPACE('logc3-awg3', 'logc3', 'awg3'),
	LOG_SPACE('logc4-awg4', 'logc4', 'awg4'),
	LOG_SPACE('applelog', 'applelog', 'bt2020'),
	LOG_SPACE('dlog-dgamut', 'dlog', 'dgamut'),
	LOG_SPACE('log3g10-rwg', 'log3g10', 'rwg'),
	LOG_SPACE('bmdfilm5-bmdwg5', 'bmdfilm5', 'bmdwg5'),
	LOG_SPACE('davinci-dwg', 'davinci', 'dwg'),
	LOG_SPACE('flog-fgamut', 'flog', 'bt2020', 'F-Gamut'),
	LOG_SPACE('flog2-fgamut', 'flog2', 'bt2020', 'F-Gamut'),
	LOG_SPACE('nlog-bt2020', 'nlog', 'bt2020'),
	// DPX scans: Cineon printing-density log with Rec. 709 primaries.
	LOG_SPACE('cineon-bt709', 'cineon', 'bt709'),
];

const BY_ID = new Map(COLOR_SPACES.map((s) => [s.id, s]));

export function colorSpace(id: string): ColorSpaceDef | undefined {
	return BY_ID.get(id);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** A space by id or label (case and punctuation ignored, e.g. "Rec. 2100 PQ", "rec2100pq", "S-Log3/S-Gamut3.Cine"). */
export function parseColorSpace(s: string): ColorSpaceDef | undefined {
	const n = norm(s);
	if (!n) return undefined;
	return COLOR_SPACES.find((c) => norm(c.id) === n || norm(c.label) === n);
}

/** Log domain of a space's curve (null for non-log curves). */
export function spaceLogDomain(s: ColorSpaceDef): LogDomain | null {
	return s.curve in LOG_CURVES ? LOG_CURVES[s.curve as LogCurveId].domain : null;
}

// ---------------------------------------------------------------- working and output spaces

/** Sequence working colour spaces (Sequence Settings ▸ Colour). */
export const WORKING_SPACE_IDS = [
	'rec709',
	'srgb',
	'rec2020',
	'p3d65',
	'displayp3',
	'rec2100-pq',
	'rec2100-hlg',
] as const;
export type WorkingSpaceId = (typeof WORKING_SPACE_IDS)[number];

/** Export output colour spaces (spaces with tags). */
export const OUTPUT_SPACE_IDS = WORKING_SPACE_IDS;
export type OutputSpaceId = WorkingSpaceId;

export function isWorkingSpaceId(id: unknown): id is WorkingSpaceId {
	return typeof id === 'string' && (WORKING_SPACE_IDS as readonly string[]).includes(id);
}

export function isHdrSpace(s: ColorSpaceDef): boolean {
	return s.kind === 'pq' || s.kind === 'hlg';
}

// ---------------------------------------------------------------- auto detection

export type StreamColorTags = {
	primaries?: string | null;
	transfer?: string | null;
	matrix?: string | null;
};

/**
 * The colour space a stream's tags signal (VUI / `colr` / Matroska Colour, as ffprobe names them). Untagged or
 * BT.601/BT.709-tagged pictures are Rec. 709 (NLE convention: BT.601 primaries are treated as BT.709). Stills
 * (`still`) tagged sRGB or untagged follow the working space's SDR encoding (graphics convention): `rec709` in
 * BT.1886 working spaces, `srgb` in sRGB-curve ones.
 */
export function spaceFromStreamTags(
	tags: StreamColorTags,
	opts: { still?: boolean; workingCurve?: CurveId } = {},
): ColorSpaceDef {
	const p = (tags.primaries ?? '').toLowerCase();
	const t = (tags.transfer ?? '').toLowerCase();
	const pick = (id: string) => BY_ID.get(id)!;
	if (t === 'smpte2084') return pick(p === 'smpte432' ? 'p3d65-pq' : 'rec2100-pq');
	if (t === 'arib-std-b67') return pick('rec2100-hlg');
	if (t === 'linear')
		return pick(p === 'bt2020' ? 'linear-rec2020' : p === 'smpte432' ? 'linear-p3d65' : 'linear-rec709');
	if (p === 'bt2020') return pick('rec2020');
	if (p === 'smpte432') return pick(t === 'iec61966-2-1' ? 'displayp3' : 'p3d65');
	if (p === 'smpte431') return pick('p3dci');
	if (opts.still && (t === 'iec61966-2-1' || t === '' || t === 'unknown' || t === 'unspecified'))
		return pick(opts.workingCurve === 'srgb' ? 'srgb' : 'rec709');
	if (t === 'iec61966-2-1') return pick('srgb');
	if (t === 'gamma22') return pick('gamma22');
	return pick('rec709');
}
