// Seed inputs of the parser fuzz targets (test/fuzz-parsers.test.ts): small valid files of every format, made by
// hand or by our own writers, plus a few interesting invalid ones. The mutators start from these.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	BUILTIN_EFFECT_PRESETS,
	CAPTION_FILE_FORMATS,
	parseSrt,
	write3dl,
	writeCaptionFile,
} from '../src/index.ts';

const here = import.meta.dirname;

export const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello <i>world</i>

2
00:00:03,000 --> 00:00:05,000 X1:10 X2:100 Y1:10 Y2:50
Two lines,
second — ünïcode ✓

3
00:01:00,000 --> 00:01:02,000
<font color="#ff0000">Red</font> {\\an8}top
`;

/** SRT plus every other caption format written by our own writers (text formats as strings, STL as bytes). */
export function captionSeeds(): Record<string, (string | Uint8Array)[]> {
	const doc = parseSrt(SRT);
	const out: Record<string, (string | Uint8Array)[]> = {};
	for (const f of CAPTION_FILE_FORMATS) {
		const w = writeCaptionFile(doc, f, { rate: { num: 30000, den: 1001 } });
		out[f] = [w];
	}
	out.srt!.push(SRT, '﻿1\r\n00:00:00,000 --> 00:00:01,000\r\nCRLF\r\n');
	out.vtt!.push(
		'WEBVTT\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:r1 width:40%\n\nNOTE x\n\nc1\n00:01.000 --> 00:02.000 region:r1 line:90% align:start\n<v Ann>Hi <b>there</b>\n\n00:03.000 --> 00:04.000\n<00:03.500>karaoke\n',
	);
	return out;
}

export const CUBE = `TITLE "seed"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;
export const CUBE_1D = 'LUT_1D_SIZE 3\nLUT_1D_INPUT_RANGE 0 1\n0 0 0\n0.5 0.5 0.5\n1 1 1\n';
export const SPI1D = 'Version 1\nFrom 0.0 1.0\nLength 3\nComponents 1\n{\n0\n0.5\n1\n}\n';
export const SPI3D =
	'SPILUT 1.0\n3 3\n2 2 2\n0 0 0 0 0 0\n1 0 0 1 0 0\n0 1 0 0 1 0\n1 1 0 1 1 0\n0 0 1 0 0 1\n1 0 1 1 0 1\n0 1 1 0 1 1\n1 1 1 1 1 1\n';
export const CSP =
	'CSPLUTV100\n3D\n\n2\n0 1\n0 1\n2\n0 1\n0 1\n2\n0 1\n0 1\n\n2 2 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';

export function lutSeeds(): string[] {
	return [CUBE, CUBE_1D, SPI1D, SPI3D, CSP];
}

export function threeDlSeeds(): string[] {
	return [
		'0 512 1023\n0 0 0\n0 0 4095\n0 4095 0\n0 4095 4095\n4095 0 0\n4095 0 4095\n4095 4095 0\n4095 4095 4095\n',
		write3dl({
			kind: '3d',
			size: 2,
			domainMin: [0, 0, 0],
			domainMax: [1, 1, 1],
			data: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]),
		} as never),
	];
}

export const OCIO = `ocio_profile_version: 2
name: Seed   # comment
search_path: "luts"
roles:
  scene_linear: lin
  color_timing: log2
displays:
  sRGB:
    - !<View> {name: Standard, colorspace: gamma22}
colorspaces:
  - !<ColorSpace>
    name: lin
    isdata: false
  - !<ColorSpace>
    name: gamma22
    aliases: [g22]
    to_scene_reference: !<ExponentTransform> {value: [2.2, 2.2, 2.2, 1]}
  - !<ColorSpace>
    name: log2
    from_reference: !<GroupTransform>
      children:
        - !<MatrixTransform> {matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1], offset: [0.1, 0.1, 0.1, 0]}
        - !<LogTransform> {base: 2}
  - !<ColorSpace>
    name: affine
    to_reference: !<LogAffineTransform> {base: 10, logSideSlope: 0.5, linSideOffset: 0.01, direction: inverse}
  - !<ColorSpace>
    name: lut
    to_reference: !<FileTransform> {src: double.cube, interpolation: linear}
  - !<ColorSpace>
    name: cdl
    to_reference: !<CDLTransform> {slope: [1.1, 1, 0.9], offset: [0, 0, 0.01], power: [1, 1, 1], sat: 0.9}
`;
export const OCIO_FILES = { 'double.cube': 'LUT_1D_SIZE 2\n0 0 0\n2 2 2\n' };

export const CDL = `<ColorDecisionList xmlns="urn:ASC:CDL:v1.2"><ColorDecision><ColorCorrection id="a">
<SOPNode><Slope>1.1 1 0.9</Slope><Offset>0 0 0.01</Offset><Power>1 1 1</Power></SOPNode>
<SatNode><Saturation>0.9</Saturation></SatNode></ColorCorrection></ColorDecision></ColorDecisionList>`;

export const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="blue"/></linearGradient></defs>
  <g transform="translate(10 5) rotate(15) scale(1.5)" opacity="0.8">
    <rect x="1" y="2" width="30" height="20" rx="4" fill="url(#g)" stroke="#000" stroke-width="2"/>
    <circle cx="60" cy="30" r="12" style="fill: rgb(0, 128, 255); stroke: none"/>
    <path d="M10 80 C 20 60, 40 60, 50 80 S 80 100, 90 80 Q 100 70 110 80 T 130 80 A 10 15 30 1 0 150 80 Z" fill="none" stroke="green"/>
    <polygon points="160,10 190,40 160,40"/>
    <ellipse cx="170" cy="70" rx="20" ry="8"/><line x1="0" y1="0" x2="10" y2="10" stroke="red"/>
  </g>
</svg>`;

export const SVG_PATHS = [
	'M10 10 L20 20 H30 V40 Z',
	'm0 0 c10 0 10 10 0 10 s-10-10 0-10 q5 5 10 0 t10 0 a5 5 0 1 1 10 0z',
	'M.5.5l1e2-3E1',
];

export const LOTTIE = {
	v: '5.7.4',
	fr: 30,
	ip: 0,
	op: 60,
	w: 200,
	h: 100,
	nm: 'seed',
	assets: [],
	layers: [
		{
			ty: 4,
			nm: 'shape',
			ind: 1,
			ip: 0,
			op: 60,
			st: 0,
			ks: {
				o: { a: 0, k: 100 },
				r: {
					a: 1,
					k: [
						{ t: 0, s: [0], o: { x: [0.3], y: [0] }, i: { x: [0.7], y: [1] } },
						{ t: 60, s: [360] },
					],
				},
				p: { a: 0, k: [100, 50, 0] },
				a: { a: 0, k: [0, 0, 0] },
				s: { a: 0, k: [100, 100, 100] },
			},
			shapes: [
				{
					ty: 'gr',
					it: [
						{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 20] }, r: { a: 0, k: 4 } },
						{ ty: 'el', p: { a: 0, k: [30, 0] }, s: { a: 0, k: [20, 20] } },
						{
							ty: 'sh',
							ks: {
								a: 0,
								k: {
									c: true,
									v: [
										[0, 0],
										[10, 0],
										[10, 10],
									],
									i: [
										[0, 0],
										[0, 0],
										[0, 0],
									],
									o: [
										[0, 0],
										[0, 0],
										[0, 0],
									],
								},
							},
						},
						{ ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 } },
						{ ty: 'st', c: { a: 0, k: [0, 0, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 2 } },
						{
							ty: 'tr',
							p: { a: 0, k: [0, 0] },
							a: { a: 0, k: [0, 0] },
							s: { a: 0, k: [100, 100] },
							r: { a: 0, k: 0 },
							o: { a: 0, k: 100 },
						},
					],
				},
			],
		},
		{ ty: 1, nm: 'solid', ind: 2, ip: 0, op: 60, st: 0, sc: '#336699', sw: 200, sh: 100, ks: {} },
		{ ty: 3, nm: 'null', ind: 3, parent: 1, ip: 0, op: 60, st: 0, ks: {} },
	],
};

export const IMAGE_SEQUENCE_NAMES = [
	'shot_0001.png',
	'shot_0002.png',
	'shot_0003.png',
	'shot_0005.png',
	'render.v2.1001.exr',
	'render.v2.1002.exr',
	'dir/a-01.jpg',
	'dir/a-02.jpg',
	'single.png',
	'IMG_9999.JPG',
];

/** The committed schema fixtures (v1…v5), as parsed JSON. */
export function projectSeeds(): unknown[] {
	return [1, 2, 3, 4, 5].map((v) =>
		JSON.parse(readFileSync(join(here, 'fixtures', `schema-v${v}.jasper`), 'utf8')),
	);
}

export function presetSeeds(): unknown[] {
	return BUILTIN_EFFECT_PRESETS.slice(0, 6).map((p) => structuredClone(p));
}

export const TRANSCRIPT_JSON = readFileSync(join(here, 'fixtures', 'interview.transcript.json'), 'utf8');

/** A glTF 2.0 document with one triangle (embedded buffer as a data URI) and a minimal OBJ. */
export function modelSeeds(): { gltf: Uint8Array; glb: Uint8Array; obj: Uint8Array } {
	const bin = new Uint8Array(44);
	const dv = new DataView(bin.buffer);
	for (const [i, v] of [0, 0, 0, 1, 0, 0, 0, 1, 0].entries()) dv.setFloat32(i * 4, v, true);
	for (const [i, v] of [0, 1, 2].entries()) dv.setUint16(36 + i * 2, v, true);
	const json = (uri?: string) => ({
		asset: { version: '2.0' },
		scene: 0,
		scenes: [{ nodes: [0] }],
		nodes: [{ mesh: 0, translation: [1, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
		materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
			{ bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
		],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: 36 },
			{ buffer: 0, byteOffset: 36, byteLength: 6 },
		],
		buffers: [{ byteLength: 44, ...(uri ? { uri } : {}) }],
	});
	const enc = new TextEncoder();
	const gltf = enc.encode(
		JSON.stringify(json(`data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`)),
	);
	const j = enc.encode(JSON.stringify(json()));
	const jl = Math.ceil(j.length / 4) * 4;
	const glb = new Uint8Array(12 + 8 + jl + 8 + 44);
	const g = new DataView(glb.buffer);
	g.setUint32(0, 0x46546c67, true);
	g.setUint32(4, 2, true);
	g.setUint32(8, glb.length, true);
	g.setUint32(12, jl, true);
	g.setUint32(16, 0x4e4f534a, true);
	glb.fill(0x20, 20, 20 + jl);
	glb.set(j, 20);
	g.setUint32(20 + jl, 44, true);
	g.setUint32(24 + jl, 0x004e4942, true);
	glb.set(bin, 28 + jl);
	const obj = enc.encode(
		'o tri\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nvt 0 0\nf 1/1/1 2/1/1 3/1/1\nf 1 2 3 1\n',
	);
	return { gltf, glb, obj };
}
