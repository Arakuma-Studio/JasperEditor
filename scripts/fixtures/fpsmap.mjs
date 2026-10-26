// Frame-rate conform fixtures (docs/wp-notes/fps-conform.md), loaded by scripts/make-fixtures.mjs:
//   rate-code-<rate>.mp4   640×360, 36 s at 23.976 / 24 / 25 / 29.97 / 30 / 60 fps, H.264 4:2:0, BT.709 tagged.
//                          Source frame n carries a 12-bit code (bit b = white 40×40 box at x = 20 + 50·b, y = 20, on a
//                          black strip), so every exported frame tells which source frame it shows. Under the code: 8
//                          flat colour patches (rows y 90–210) and an 8-step grey wedge including 0 and 255 (y 220–340)
//                          to tell matrix (BT.601 vs 709), range (limited vs full) and transfer differences apart.
//   rate-code-2997-sd601.mp4  the 29.97 fps picture encoded with the BT.601 matrix and no colour tags (what untagged
//                          SD sources, e.g. the lavfi-made talking clip of e2e/apply-style.spec.ts, look like).
export const FPSMAP_SIZE = { width: 640, height: 360 };
export const FPSMAP_BITS = 12;
export const FPSMAP_SECONDS = 36;
/** Centre of code bit `b` in source pixels. */
export const fpsmapBitCentre = (b) => ({ x: 40 + 50 * b, y: 40 });
/** Patch colours (sRGB-coded 8-bit R'G'B' before the Y'CbCr encode), row 1 then the grey wedge. */
export const FPSMAP_PATCHES = [
	[200, 40, 40],
	[40, 200, 40],
	[40, 40, 200],
	[40, 200, 200],
	[200, 40, 200],
	[200, 200, 40],
	[230, 150, 110],
	[128, 128, 128],
	[0, 0, 0],
	[32, 32, 32],
	[64, 64, 64],
	[96, 96, 96],
	[160, 160, 160],
	[192, 192, 192],
	[224, 224, 224],
	[255, 255, 255],
];
/** Patch `i`'s rectangle in source pixels (inset 12 px from its painted edges, so chroma subsampling does not reach). */
export function fpsmapPatchRect(i) {
	const col = i % 8;
	const row = Math.floor(i / 8);
	return { x: 20 + 76 * col + 12, y: 90 + 130 * row + 12, w: 70 - 24, h: 120 - 24 };
}
export const FPSMAP_RATES = [
	{ id: '23976', rate: '24000/1001' },
	{ id: '24', rate: '24' },
	{ id: '25', rate: '25' },
	{ id: '2997', rate: '30000/1001' },
	{ id: '30', rate: '30' },
	{ id: '60', rate: '60' },
];

const hex = ([r, g, b]) => `0x${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function picture(rate) {
	const bits = Array.from(
		{ length: FPSMAP_BITS },
		(_, b) =>
			`,drawbox=x=${20 + 50 * b}:y=20:w=40:h=40:color=white:t=fill:enable='eq(mod(floor(n/${2 ** b}),2),1)'`,
	).join('');
	const patches = FPSMAP_PATCHES.map((c, i) => {
		const col = i % 8;
		const row = Math.floor(i / 8);
		return `,drawbox=x=${20 + 76 * col}:y=${90 + 130 * row}:w=70:h=120:color=${hex(c)}:t=fill`;
	}).join('');
	return `color=c=0x204080:size=${FPSMAP_SIZE.width}x${FPSMAP_SIZE.height}:rate=${rate}:duration=${FPSMAP_SECONDS},format=rgb24,drawbox=x=10:y=10:w=610:h=60:color=black:t=fill${bits}${patches}`;
}

const BT709_TAGS = [
	...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
];

export function fixtures({ h264 }) {
	const out = FPSMAP_RATES.map(({ id, rate }) => ({
		name: `rate-code-${id}.mp4`,
		steps: (file) => [
			[
				...['-f', 'lavfi', '-i', `${picture(rate)},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`],
				...h264,
				...BT709_TAGS,
				...['-an', '-movflags', '+faststart', '-f', 'mp4', file],
			],
		],
	}));
	out.push({
		name: 'rate-code-2997-sd601.mp4',
		steps: (file) => [
			[
				...[
					'-f',
					'lavfi',
					'-i',
					`${picture('30000/1001')},scale=out_color_matrix=bt601:out_range=tv,format=yuv420p`,
				],
				...h264,
				...['-an', '-movflags', '+faststart', '-f', 'mp4', file],
			],
		],
	});
	return out;
}
