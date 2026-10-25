// Legacy audio fixtures (pp-wma-preview), original work generated here and never committed:
// - legacy-wma.wma: 4 s of stereo 44.1 kHz WMA v2 (ASF), FFmpeg's native LGPL `wmav2` encoder — a 440 Hz tone with a
//   syllable envelope on the left, a steady 660 Hz tone on the right and a 3 kHz click at 1 s on both (alignment);
// - legacy-ac3.mkv: 2 s 640×360 H.264 test pattern with 5.1 48 kHz AC-3 audio (native `ac3` encoder) — a video whose
//   picture the browser decodes and whose audio it does not.
// Neither format plays in Chromium / Electron, so the engine makes their playback audio. Encoders missing from the
// FFmpeg in use skip their fixture with a notice.
import { spawnSync } from 'node:child_process';

const hasEncoder = (ff, name) =>
	new RegExp(`^\\s*A\\S*\\s+${name}\\s`, 'm').test(
		spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '',
	);

const CLICK = '0.7*exp(-((t-1)*2000)^2)*sin(2*PI*3000*t)';

/** @param {import('./types.ts').FixtureContext} ctx */
export function fixtures({ ffmpeg, h264 }) {
	/** @type {import('./types.ts').Fixture[]} */
	const out = [];
	if (hasEncoder(ffmpeg, 'wmav2'))
		out.push({
			name: 'legacy-wma.wma',
			steps: (file) => [
				[
					'-f',
					'lavfi',
					'-i',
					`aevalsrc='0.45*sin(2*PI*440*t)*abs(sin(2*PI*1.3*t))+${CLICK}|0.35*sin(2*PI*660*t)+${CLICK}':s=44100:d=4`,
					...['-c:a', 'wmav2', '-b:a', '160k', '-f', 'asf', file],
				],
			],
		});
	else console.log('skip   legacy-wma.wma (this FFmpeg has no wmav2 encoder)');
	if (hasEncoder(ffmpeg, 'ac3'))
		out.push({
			name: 'legacy-ac3.mkv',
			steps: (file) => [
				[
					...['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2'],
					...['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*330*t)*(0.5+0.5*sin(2*PI*2*t))':s=48000:d=2"],
					...h264,
					...['-filter:a', 'pan=5.1|FL=c0|FR=c0|FC=0.5*c0|LFE=0*c0|BL=0.5*c0|BR=0.5*c0'],
					...['-c:a', 'ac3', '-b:a', '384k', '-t', '2', '-f', 'matroska', file],
				],
			],
		});
	else console.log('skip   legacy-ac3.mkv (this FFmpeg has no ac3 encoder)');
	return out;
}
