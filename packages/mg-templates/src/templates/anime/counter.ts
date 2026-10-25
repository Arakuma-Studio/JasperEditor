// counter@1 (S11:ATP-003): a number counts from `from` to `to` during the intro, formatted with decimals,
// thousands/decimal separators, prefix and suffix, in tabular numerals; an optional label sits below.
// Metadata and the (pure, deterministic) number formatter — implementation: packages/motion/src/templates/counter.tsx.
import { z } from 'zod';
import { CANVASES } from '../../core.ts';
import type { MgAnimeTemplateDefinition } from '../../types.ts';
import { easeParam, rgbaParam } from './common.ts';

const COUNTER_LIMIT = 1e12;

export const counterParams = z.strictObject({
	from: z.number().min(-COUNTER_LIMIT).max(COUNTER_LIMIT).default(0),
	to: z.number().min(-COUNTER_LIMIT).max(COUNTER_LIMIT).default(1250),
	decimals: z.number().int().min(0).max(6).default(0),
	prefix: z.string().max(16).default(''),
	suffix: z.string().max(16).default(''),
	thousandsSeparator: z.enum(['none', 'comma', 'period', 'space', 'thin', 'apostrophe']).default('comma'),
	decimalSeparator: z.enum(['period', 'comma']).default('period'),
	label: z.string().max(80).default('Subscribers'),
	numberColor: rgbaParam([1, 1, 1, 1]),
	labelColor: rgbaParam([0.82, 0.86, 0.95, 0.9]),
	/** Number size in design pixels (the label is 30 % of it). */
	size: z.number().min(24).max(400).default(180),
	/** Count duration in seconds from the clip start (clamped to the content before the outro). */
	countSeconds: z.number().min(0.1).max(60).default(2),
	ease: easeParam('outExpo'),
});
export type CounterParams = z.output<typeof counterParams>;

const THOUSANDS: Record<CounterParams['thousandsSeparator'], string> = {
	none: '',
	comma: ',',
	period: '.',
	space: ' ',
	thin: ' ',
	apostrophe: '’',
};

/**
 * Formats a counter value: rounded half away from zero to `decimals`, grouped by thousands, with the chosen
 * separators, prefix and suffix. Locale-independent (no `Intl`), so the Player and every render agree.
 */
export function formatCounterValue(
	value: number,
	p: Pick<CounterParams, 'decimals' | 'thousandsSeparator' | 'decimalSeparator' | 'prefix' | 'suffix'>,
): string {
	const decimals = Math.min(6, Math.max(0, Math.round(p.decimals)));
	const v = Number.isFinite(value) ? value : 0;
	const scale = 10 ** decimals;
	const rounded = Math.round(Math.abs(v) * scale) / scale;
	const negative = v < 0 && rounded !== 0;
	const [int = '0', frac = ''] = rounded.toFixed(decimals).split('.');
	const sep = THOUSANDS[p.thousandsSeparator] ?? '';
	let grouped = '';
	for (let i = 0; i < int.length; i++) {
		if (i > 0 && (int.length - i) % 3 === 0) grouped += sep;
		grouped += int[i];
	}
	const dec = p.decimalSeparator === 'comma' ? ',' : '.';
	return `${p.prefix}${negative ? '−' : ''}${grouped}${decimals > 0 ? dec + frac : ''}${p.suffix}`;
}

export const counter: MgAnimeTemplateDefinition<CounterParams> = {
	id: 'counter',
	version: 1,
	name: 'Counter',
	category: 'Counters',
	description:
		'A number counts up (or down) with prefix, suffix, decimals and separators in tabular numerals.',
	renderer: 'anime',
	// 2: drawing clipped to the canvas (preview = hybrid export), exact count of large ranges.
	renderVersion: 2,
	posterAt: 3,
	paramsSchema: counterParams,
	defaults: counterParams.parse({}),
	introFrames: 60,
	outroFrames: 15,
	defaultDurationSeconds: 5,
	canvases: [...CANVASES],
	// C3: one gallery card per common use; the params grouped as in the Essential Graphics panel.
	presets: [
		{ id: 'subscribers', name: 'Subscribers', description: 'Counts up to 1,250 subscribers.', params: {} },
		{
			id: 'percentage',
			name: 'Percentage',
			description: 'Counts up to 100 % with a "Complete" label.',
			params: { to: 100, suffix: '%', label: 'Complete' },
		},
		{
			id: 'money-raised',
			name: 'Money Raised',
			description: 'Counts up to $25,000 with a "Raised" label.',
			params: { to: 25000, prefix: '$', label: 'Raised' },
		},
	],
	ui: {
		groups: [
			{
				id: 'number',
				label: 'Number',
				params: ['from', 'to', 'decimals', 'decimalSeparator', 'thousandsSeparator', 'prefix', 'suffix'],
			},
			{ id: 'label', label: 'Label', params: ['label', 'labelColor'] },
			{ id: 'style', label: 'Style', params: ['numberColor', 'size'] },
			{ id: 'animation', label: 'Animation', params: ['countSeconds', 'ease'] },
		],
		params: {
			decimalSeparator: {
				description: 'Shown when the number has decimals.',
				visibleWhen: { param: 'decimals', in: [1, 2, 3, 4, 5, 6] },
			},
			size: { label: 'Number Size', description: 'Number size in design pixels (the label is 30 % of it).' },
			countSeconds: {
				label: 'Count Duration',
				description:
					'Seconds from the clip start to the final number (clamped to the content before the outro).',
			},
		},
	},
};
