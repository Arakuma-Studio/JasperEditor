// Expression presets (Effect Controls ▸ expression menu ▸ Presets, MCP `list_expression_presets`): the AE
// expressions people reach for most, as editable starting points. `kinds` = property kinds a preset suits
// (empty = any).
import type { PropKind } from './values.ts';

export type ExpressionPreset = {
	id: string;
	label: string;
	category: 'Animation' | 'Loop' | 'Time' | 'Link' | 'Text' | 'Random' | 'Physics';
	description: string;
	text: string;
	kinds: readonly PropKind[];
};

const NUM_VEC: PropKind[] = ['number', 'vec2', 'vec3', 'color'];

export const EXPRESSION_PRESETS: readonly ExpressionPreset[] = [
	{
		id: 'wiggle',
		label: 'Wiggle',
		category: 'Random',
		description: 'Random smooth motion: 2 wiggles per second, 30 units.',
		text: 'wiggle(2, 30)',
		kinds: NUM_VEC,
	},
	{
		id: 'wiggle-slider',
		label: 'Wiggle (Slider controlled)',
		category: 'Random',
		description: 'Wiggle whose frequency and amount come from two Slider Controls on the clip.',
		text: 'wiggle(effect("Slider Control")("Slider"), effect("Slider Control 2")("Slider"))',
		kinds: NUM_VEC,
	},
	{
		id: 'wiggle-x',
		label: 'Wiggle X only',
		category: 'Random',
		description: 'Wiggles the first component and keeps the second.',
		text: 'w = wiggle(2, 30);\n[w[0], value[1]]',
		kinds: ['vec2'],
	},
	{
		id: 'loop-cycle',
		label: 'Loop Out (cycle)',
		category: 'Loop',
		description: 'Repeats the keyframed animation after the last keyframe.',
		text: 'loopOut("cycle")',
		kinds: NUM_VEC,
	},
	{
		id: 'loop-pingpong',
		label: 'Loop Out (ping-pong)',
		category: 'Loop',
		description: 'Plays the keyframes forwards and backwards after the last one.',
		text: 'loopOut("pingpong")',
		kinds: NUM_VEC,
	},
	{
		id: 'loop-offset',
		label: 'Loop Out (offset)',
		category: 'Loop',
		description: 'Repeats the animation, each cycle continuing from where the last ended.',
		text: 'loopOut("offset")',
		kinds: NUM_VEC,
	},
	{
		id: 'loop-continue',
		label: 'Loop Out (continue)',
		category: 'Loop',
		description: 'Keeps moving at the velocity of the last keyframe.',
		text: 'loopOut("continue")',
		kinds: NUM_VEC,
	},
	{
		id: 'loop-in',
		label: 'Loop In (cycle)',
		category: 'Loop',
		description: 'Repeats the animation before the first keyframe.',
		text: 'loopIn("cycle")',
		kinds: NUM_VEC,
	},
	{
		id: 'time-rotate',
		label: 'Rotate over time',
		category: 'Time',
		description: 'Turns 90 degrees per second from the keyframed value.',
		text: 'value + time * 90',
		kinds: ['number'],
	},
	{
		id: 'time-drift',
		label: 'Drift',
		category: 'Time',
		description: 'Moves 100 pixels per second to the right.',
		text: 'value + [time * 100, 0]',
		kinds: ['vec2'],
	},
	{
		id: 'oscillate',
		label: 'Oscillate (sine)',
		category: 'Animation',
		description: 'Swings around the keyframed value: 1 cycle per second, 50 units.',
		text: 'freq = 1;\namp = 50;\nvalue + Math.sin(time * freq * Math.PI * 2) * amp',
		kinds: ['number'],
	},
	{
		id: 'pulse',
		label: 'Pulse',
		category: 'Animation',
		description: 'Scales the value up and down twice a second by 10%.',
		text: 'value * (1 + 0.1 * Math.sin(time * 4 * Math.PI))',
		kinds: ['number', 'vec2'],
	},
	{
		id: 'fade-in-out',
		label: 'Fade in and out',
		category: 'Animation',
		description: 'Opacity ramps over the first and last half second of the clip.',
		text: 'd = 0.5;\nMath.min(linear(time, inPoint, inPoint + d, 0, value), linear(time, outPoint - d, outPoint, value, 0))',
		kinds: ['number'],
	},
	{
		id: 'inertial-bounce',
		label: 'Inertial bounce',
		category: 'Physics',
		description: 'Overshoots and settles after each keyframe (decaying sine on the arrival velocity).',
		text: 'amp = 0.05;\nfreq = 4.0;\ndecay = 8.0;\nn = 0;\nif (numKeys > 0) {\n  n = nearestKey(time).index;\n  if (key(n).time > time) n--;\n}\nif (n == 0) {\n  t = 0;\n} else {\n  t = time - key(n).time;\n}\nif (n > 0 && t < 1) {\n  v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);\n  value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);\n} else {\n  value;\n}',
		kinds: NUM_VEC,
	},
	{
		id: 'overshoot',
		label: 'Overshoot',
		category: 'Physics',
		description:
			'After each keyframe the value swings past it by a share of the change into the key and settles (a damped spring).',
		text: 'amount = 0.15; // overshoot as a share of the change into the keyframe\nfreq = 2.5; // swings per second\ndecay = 6; // how fast it settles\nn = 0;\nif (numKeys > 1) {\n  n = nearestKey(time).index;\n  if (key(n).time > time) n--;\n}\nif (n > 1 && time > key(n).time) {\n  t = time - key(n).time;\n  change = key(n).value - key(n - 1).value;\n  value + change * amount * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);\n} else {\n  value;\n}',
		kinds: NUM_VEC,
	},
	{
		id: 'bounce-back',
		label: 'Bounce',
		category: 'Physics',
		description:
			'The value hits each keyframe and bounces back off it like a ball, losing speed on every bounce (needs speed into the keyframe).',
		text: 'elasticity = 0.6; // share of the speed kept per bounce (0 … 1)\ngravity = 4000; // pull back toward the keyframe (units per second²)\nmaxBounces = 8;\nn = 0;\nif (numKeys > 0) {\n  n = nearestKey(time).index;\n  if (key(n).time > time) n--;\n}\nresult = value;\nif (n > 0 && time > key(n).time) {\n  t = time - key(n).time;\n  v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);\n  speed = length(v);\n  if (speed > 0) {\n    dir = v / speed;\n    s = speed * elasticity;\n    for (b = 0; b < maxBounces; b++) {\n      flight = 2 * s / gravity;\n      if (t < flight) {\n        result = value - dir * (s * t - gravity * t * t / 2);\n        break;\n      }\n      t -= flight;\n      s *= elasticity;\n    }\n  }\n}\nresult;',
		kinds: NUM_VEC,
	},
	{
		id: 'posterize',
		label: 'Posterize time (12 fps)',
		category: 'Time',
		description: 'Steps the animation at 12 frames per second (stop-motion look).',
		text: 'posterizeTime(12);\nvalue',
		kinds: NUM_VEC,
	},
	{
		id: 'random-hold',
		label: 'Random every second',
		category: 'Random',
		description: 'A new random value each second.',
		text: 'seedRandom(Math.floor(time), true);\nrandom(0, 100)',
		kinds: ['number'],
	},
	{
		id: 'link-slider',
		label: 'Link to Slider Control',
		category: 'Link',
		description: 'Reads the first Slider Control of the clip.',
		text: 'effect("Slider Control")("Slider")',
		kinds: ['number'],
	},
	{
		id: 'link-point',
		label: 'Link to Point Control',
		category: 'Link',
		description: 'Reads the first Point Control of the clip.',
		text: 'effect("Point Control")("Point")',
		kinds: ['vec2'],
	},
	{
		id: 'link-color',
		label: 'Link to Color Control',
		category: 'Link',
		description: 'Reads the first Color Control of the clip.',
		text: 'effect("Color Control")("Color")',
		kinds: ['color'],
	},
	{
		id: 'follow-layer',
		label: 'Follow the clip above',
		category: 'Link',
		description: 'Copies the position of the next clip up (layer index − 1), delayed by 5 frames.',
		text: 'delay = 5 * thisComp.frameDuration;\nthisComp.layer(index - 1).transform.position.valueAtTime(time - delay)',
		kinds: ['vec2'],
	},
	{
		id: 'timecode',
		label: 'Timecode',
		category: 'Text',
		description: 'Source Text showing the sequence timecode.',
		text: 'timeToTimecode()',
		kinds: ['string'],
	},
	{
		id: 'counter',
		label: 'Counter',
		category: 'Text',
		description: 'Source Text counting from 0 to 100 over the clip.',
		text: 'Math.round(linear(time, inPoint, outPoint, 0, 100)).toString()',
		kinds: ['string'],
	},
	{
		id: 'clock',
		label: 'Clock (MM:SS)',
		category: 'Text',
		description: 'Source Text with minutes and seconds since the clip started.',
		text: 's = Math.max(0, Math.floor(time - inPoint));\nm = Math.floor(s / 60);\n(m < 10 ? "0" : "") + m + ":" + (s % 60 < 10 ? "0" : "") + (s % 60)',
		kinds: ['string'],
	},
	{
		id: 'checkbox-toggle',
		label: 'On/Off from Checkbox Control',
		category: 'Link',
		description: "Full value when the clip's Checkbox Control is on, 0 when off.",
		text: 'effect("Checkbox Control")("Checkbox") == 1 ? value : 0',
		kinds: ['number'],
	},
];

/** Presets suited to a property kind. */
export function expressionPresetsFor(kind: PropKind): ExpressionPreset[] {
	return EXPRESSION_PRESETS.filter((p) => p.kinds.length === 0 || p.kinds.includes(kind));
}
