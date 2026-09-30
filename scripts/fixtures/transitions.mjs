// wp-m2-transitions fixtures (ARCHITECTURE §19.11): two steady tones of different pitch for audio crossfade
// checks (S10 §8 test 7: no gap and no level bump at the cut). A constant level makes a crossfade's
// gain curve directly measurable with `astats` / Web Audio.
export function fixtures() {
	const tone = (hz) => (out) => [
		[
			...['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=6`],
			...['-af', 'volume=0.5', '-ac', '2', '-c:a', 'pcm_s16le', out],
		],
	];
	return [
		{ name: 'xfade-tone-440.wav', steps: tone(440) },
		{ name: 'xfade-tone-660.wav', steps: tone(660) },
	];
}
