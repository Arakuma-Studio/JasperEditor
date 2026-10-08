// Workstream `time` fixtures (docs/wp-notes/time.md):
// - vfr-code.mp4: variable-frame-rate "phone" footage, 640×360, 64 frames carrying the 6-bit frame code of
//   frame-code.mp4 (white boxes 40 + 70·b px, b = bit), frame n at n/30 + 0.01·(n mod 3) s (frame gaps 43.3, 43.3 and
//   13.3 ms), H.264 with real per-frame timestamps;
// - gray-ramp.mkv: 32 lossless (FFV1) 30 fps frames, 160×90, frame n uniformly grey at 8·n — Frame Blending checks;
// - scenes.mp4: 320×180 30 fps shots with hard cuts at frames 45, 75, 120 and 198 and the false-positive guards of
//   Scene Edit Detection: moving test pattern, bars, a Mandelbrot zoom with a one-frame white flash at frame 95, a
//   0.4 s cross dissolve (frames 153–164) between a cellular automaton and moving gradients, and a 12 px/frame pan.
//   Every random source is pinned (cellauto seed; gradients colours, end points and seed): with the defaults each
//   regeneration made different footage. The gradient colours are a random instance whose green straddles the 64
//   histogram bin edge, which made hard-binned scene detection report a false cut at the end of the dissolve.
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
		{
			name: 'scenes.mp4',
			steps: (out) => [
				[
					...['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1.5'],
					...['-f', 'lavfi', '-i', 'smptehdbars=s=320x180:r=30:d=1'],
					...['-f', 'lavfi', '-i', 'mandelbrot=s=320x180:r=30,trim=end_frame=45'],
					...['-f', 'lavfi', '-i', 'cellauto=s=320x180:r=30:rule=110:seed=7,trim=end_frame=45'],
					...['-f', 'lavfi', '-i', 'gradients=s=320x180:r=30:speed=0.03:d=1.5:c0=0x433bfd:c1=0xb24d88:x0=40:y0=0:x1=300:y1=180:seed=1'],
					...['-f', 'lavfi', '-i', 'testsrc2=s=960x180:r=30:d=1'],
					...[
						'-filter_complex',
						[
							'[0:v]format=yuv420p,setsar=1[a]',
							'[1:v]format=yuv420p,setsar=1[b]',
							"[2:v]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,20)',format=yuv420p,setsar=1[c]",
							'[3:v]format=yuv420p,setsar=1[d]',
							'[4:v]format=yuv420p,setsar=1[e]',
							'[d][e]xfade=transition=fade:duration=0.4:offset=1.1[de]',
							"[5:v]crop=320:180:'min(n*12,640)':0,format=yuv420p,setsar=1[f]",
							'[a][b][c][de][f]concat=n=5:v=1:a=0,settb=1/30,setpts=N[out]',
						].join(';'),
					],
					...['-map', '[out]', '-fps_mode', 'passthrough'],
					...h264,
					...['-movflags', '+faststart', '-f', 'mp4', out],
				],
			],
		},
	];
}
