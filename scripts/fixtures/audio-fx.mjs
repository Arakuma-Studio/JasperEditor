// audio-fx fixtures (docs/wp-notes/audio-fx.md):
// - music-beat.wav: 32 s of synthetic "music" at 120 BPM (a decaying 55 Hz kick on every beat, an off-beat 1.32 kHz
//   tick, a pad that changes chord every 4 s) for Remix (beat tracking, re-cutting on beats);
// - voice-hum.wav: 12 s of "speech" bursts (180/360/2400 Hz partials, 1.8 s on, 1.2 s off) with steady noise and a
//   60 Hz hum, for Essential Sound Repair (DeNoise, DeHum) and Ducking triggers.
export function fixtures() {
	const music =
		'0.6*sin(2*PI*55*t)*exp(-12*mod(t\\,0.5))' +
		'+0.15*sin(2*PI*(220+110*floor(mod(t/4\\,4)))*t)' +
		'+0.1*sin(2*PI*1320*t)*exp(-30*mod(t+0.25\\,0.5))';
	const voice =
		'(0.3*sin(2*PI*180*t)+0.2*sin(2*PI*360*t)+0.1*sin(2*PI*2400*t))*lt(mod(t\\,3)\\,1.8)' +
		'+0.03*(random(0)-0.5)+0.05*sin(2*PI*60*t)';
	const wav = (expr, seconds, channels) => (out) => [
		[
			...['-f', 'lavfi', '-i', `aevalsrc=${expr}:s=48000:d=${seconds}`],
			...['-ac', String(channels), '-c:a', 'pcm_s16le', out],
		],
	];
	return [
		{ name: 'music-beat.wav', steps: wav(music, 32, 2) },
		{ name: 'voice-hum.wav', steps: wav(voice, 12, 1) },
	];
}
