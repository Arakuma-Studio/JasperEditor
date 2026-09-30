// wp-m2-transitions fixtures (ARCHITECTURE §19.11):
// - two steady tones of different pitch for audio crossfade checks (S10 §8 test 7: no gap and no level bump
//   at the cut; a constant level makes a crossfade's gain curve directly measurable with `astats`);
// - two solid-colour clips (red, blue) with audio, so a video dissolve between them is measurable in the
//   Program monitor and in exports (the mix at the cut is purple).
export function fixtures({ h264, aac }) {
	const tone = (hz) => (out) => [
		[
			...['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=6`],
			...['-af', 'volume=0.5', '-ac', '2', '-c:a', 'pcm_s16le', out],
		],
	];
	const solid = (colour, hz) => (out) => [
		[
			...['-f', 'lavfi', '-i', `color=c=${colour}:size=1280x720:rate=30:duration=8`],
			...['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=8`],
			...h264,
			...aac,
			...['-t', '8', '-movflags', '+faststart', out],
		],
	];
	return [
		{ name: 'xfade-tone-440.wav', steps: tone(440) },
		{ name: 'xfade-tone-660.wav', steps: tone(660) },
		{ name: 'xfade-red.mp4', steps: solid('red', 440) },
		{ name: 'xfade-blue.mp4', steps: solid('blue', 660) },
	];
}
