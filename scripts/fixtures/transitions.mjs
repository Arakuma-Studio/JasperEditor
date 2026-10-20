// Two solid-colour clips (red, blue) with audio make a video dissolve measurable in the Program monitor
// and in exports (the mix at the cut is purple).
export function fixtures({ h264, aac }) {
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
		{ name: 'xfade-red.mp4', steps: solid('red', 440) },
		{ name: 'xfade-blue.mp4', steps: solid('blue', 660) },
	];
}
