// Workstream `time` fixtures (docs/wp-notes/time.md):
// - vfr-code.mp4: variable-frame-rate "phone" footage, 640×360, 64 frames carrying the 6-bit frame code of
//   frame-code.mp4 (white boxes 40 + 70·b px, b = bit), frame n at n/30 + 0.01·(n mod 3) s (frame gaps 43.3, 43.3 and
//   13.3 ms), H.264 with real per-frame timestamps;
// - gray-ramp.mkv: 32 lossless (FFV1) 30 fps frames, 160×90, frame n uniformly grey at 8·n — Frame Blending checks.
export function fixtures({ h264 }) {
	const bits = [0, 1, 2, 3, 4, 5]
		.map(
			(b) =>
				`,drawbox=x=${40 + 70 * b}:y=40:w=60:h=60:color=white:t=fill:enable='eq(mod(floor(n/${1 << b}),2),1)'`,
		)
		.join('');
	return [
		{
			name: 'vfr-code.mp4',
			steps: (out) => [
				[
					...[
						'-f',
						'lavfi',
						'-i',
						`color=c=0x204080:size=640x360:rate=30:duration=3,format=rgb24,drawbox=x=30:y=30:w=440:h=80:color=black:t=fill${bits}`,
					],
					...[
						'-vf',
						"settb=AVTB,setpts='(N/30+0.01*mod(N\\,3))/TB',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
					],
					...[
						'-frames:v',
						'64',
						'-fps_mode',
						'passthrough',
						'-enc_time_base',
						'1:90000',
						'-video_track_timescale',
						'90000',
					],
					...h264,
					...['-movflags', '+faststart', '-f', 'mp4', out],
				],
			],
		},
		{
			name: 'gray-ramp.mkv',
			steps: (out) => [
				[
					...['-f', 'lavfi', '-i', 'nullsrc=size=160x90:rate=30:duration=2'],
					...['-vf', "geq=lum='8*N':cb=128:cr=128,format=yuv444p"],
					...['-frames:v', '32', '-c:v', 'ffv1', '-f', 'matroska', out],
				],
			],
		},
	];
}
