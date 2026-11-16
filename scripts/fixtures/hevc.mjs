// HEVC fixtures (browser-drawn layers of HEVC footage), original work generated here and never committed:
// - vfr-code-hevc.mp4: vfr-code.mp4 (scripts/fixtures/time.mjs) as phone HEVC footage: 640×360, 64 frames with the
//   6-bit frame code, frame n at n/30 + 0.01·(n mod 3) s, HEVC Main 8-bit with real per-frame timestamps;
// - frame-code-hevc.mp4: 640×360 30 fps constant-rate HEVC, the same 64 coded frames.
// Headless Chromium has no HEVC decoder (Chrome decodes HEVC only through platform hardware decoders), so the render
// browser reads these through FFmpeg. Encoders: libkvazaar (BSD-3-Clause, in the LGPL build) or hevc_nvenc when it
// works on this machine — never libx265 (GPL). Without either the fixtures are skipped with a notice.
import { spawnSync } from 'node:child_process';

const encoders = (ff) => spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
const listed = (list, name) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, 'm').test(list);

/** An NVENC encoder is listed by builds that have it, also on machines without an NVIDIA GPU: try one frame. */
const nvencWorks = (ff) =>
	spawnSync(
		ff,
		[
			...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.04'],
			...['-frames:v', '1', '-c:v', 'hevc_nvenc', '-f', 'null', '-'],
		],
		{ encoding: 'utf8' },
	).status === 0;

/** @param {string} ff @returns {string[] | null} */
function hevcArgs(ff) {
	const list = encoders(ff);
	if (listed(list, 'libkvazaar'))
		return ['-c:v', 'libkvazaar', '-kvazaar-params', 'preset=fast,qp=16,period=32'];
	if (listed(list, 'hevc_nvenc') && nvencWorks(ff))
		return ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'constqp', '-qp', '16', '-g', '30', '-bf', '2'];
	return null;
}

const code = (rate) =>
	`color=c=0x204080:size=640x360:rate=${rate}:duration=3,format=rgb24,drawbox=x=30:y=30:w=440:h=80:color=black:t=fill${[
		0, 1, 2, 3, 4, 5,
	]
		.map(
			(b) =>
				`,drawbox=x=${40 + 70 * b}:y=40:w=60:h=60:color=white:t=fill:enable='eq(mod(floor(n/${1 << b}),2),1)'`,
		)
		.join('')}`;
const bt709 = [
	'-colorspace',
	'bt709',
	'-color_primaries',
	'bt709',
	'-color_trc',
	'bt709',
	'-color_range',
	'tv',
];
const tags = ['-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', ...bt709, '-movflags', '+faststart', '-f', 'mp4'];

/** @param {import('./types.ts').FixtureContext} ctx */
export function fixtures({ ffmpeg }) {
	const hevc = hevcArgs(ffmpeg);
	if (!hevc) {
		console.log(
			'skip   vfr-code-hevc.mp4, frame-code-hevc.mp4 (this FFmpeg has no LGPL HEVC encoder: libkvazaar or a working hevc_nvenc; JASPER_FFMPEG=vendor/ffmpeg-lgpl/<platform>/ffmpeg has libkvazaar)',
		);
		return [];
	}
	/** @type {import('./types.ts').Fixture[]} */
	return [
		{
			name: 'vfr-code-hevc.mp4',
			steps: (out) => [
				[
					...['-f', 'lavfi', '-i', code(30)],
					...[
						'-vf',
						"settb=AVTB,setpts='(N/30+0.01*mod(N\\,3))/TB',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
					],
					...['-frames:v', '64', '-fps_mode', 'passthrough', '-enc_time_base', '1:90000'],
					...['-video_track_timescale', '90000'],
					...hevc,
					...tags,
					out,
				],
			],
		},
		{
			name: 'frame-code-hevc.mp4',
			steps: (out) => [
				[
					...['-f', 'lavfi', '-i', code(30)],
					...['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-frames:v', '64'],
					...hevc,
					...tags,
					out,
				],
			],
		},
	];
}
