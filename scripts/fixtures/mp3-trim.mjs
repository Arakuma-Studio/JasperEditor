// MP3 sound effect fixture (clip loudness measurement), original work generated here and never committed:
// - pop-trim.mp3: 0.7 s of stereo 48 kHz MP3 (libmp3lame, LGPL; 128 kb/s CBR with its LAME header, so decoders trim the
//   encoder delay): a quiet 220 Hz hum for the first 0.2 s, then at 0.25 s a 1 kHz "pop" that decays over ~0.2 s — the
//   shape of a short SFX whose clips are trimmed past their lead-in, like the video team's `197. pop.mp3`.
// An FFmpeg without libmp3lame skips it with a notice.
import { spawnSync } from 'node:child_process';

const hasEncoder = (ff, name) =>
	new RegExp(`^\\s*A\\S*\\s+${name}\\s`, 'm').test(
		spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '',
	);

const HUM = '0.05*sin(2*PI*220*t)*lt(t,0.2)';
const POP = '0.6*exp(-(t-0.25)*15)*sin(2*PI*1000*(t-0.25))*gte(t,0.25)';

/** @param {import('./types.ts').FixtureContext} ctx */
export function fixtures({ ffmpeg }) {
	if (!hasEncoder(ffmpeg, 'libmp3lame')) {
		console.log('skip   pop-trim.mp3 (this FFmpeg has no libmp3lame encoder)');
		return [];
	}
	return [
		{
			name: 'pop-trim.mp3',
			steps: (file) => [
				[
					...['-f', 'lavfi', '-i', `aevalsrc='${HUM}+${POP}|${HUM}+0.8*(${POP})':s=48000:d=0.7`],
					...['-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '48000', '-f', 'mp3', file],
				],
			],
		},
	];
}
