// Spec 19 TL-098 / TL-102: Review shows the rendered check `title_propose` stored with a title proposal's first option
// (`meta.check`): each row's status, measured against expected, its timecode and its fix's label; "pending" when the
// renders outlived the call; and, for an alternate, that it carries no rows.
import { type ProposalItem, type TitleCheckRow, titleArtCheck } from '@jasper/project';
import { cleanup, render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { TitleArtDetails } from '../src/proposals/title-art.tsx';
import { checkCountsText, checkValueText, sortedCheckRows } from '../src/proposals/title-art-check.tsx';
import { makeSession } from './inspector-helpers.tsx';

afterEach(() => cleanup());

const at = { frame: 45, sec: 1.5, timecode: '00:00:01:15' };
const ROWS: TitleCheckRow[] = [
	{
		id: 'safe-area',
		kind: 'format',
		status: 'pass',
		measured: { bounds: { x: 200, y: 300, w: 880, h: 120 }, overTitleSafePx: 0, overActionSafePx: 0 },
		expected: { titleSafe: { x: 128, y: 72, w: 1024, h: 576 } },
		at,
		message: 'Inside the title-safe area.',
	},
	{
		id: 'contrast',
		kind: 'judgement',
		status: 'fail',
		measured: { median: 1.13, worst: 1.02 },
		expected: { minRatio: 3, standard: 'WCAG AA, large text' },
		at,
		message: 'White on a white sky: the title does not stand out.',
		fix: { label: 'Add a dark rim' },
	},
	{
		id: 'read-time',
		kind: 'judgement',
		status: 'warn',
		measured: { sec: 1.2 },
		expected: { minSec: 1.5 },
		at: null,
		message: 'Short for its words.',
	},
];

const recipe = { palette: { face: [1, 0, 0, 1] }, layers: [{ type: 'face' }] };
const option = (name: string, check?: unknown) => ({
	label: `Gold, ${name}`,
	commands: [
		{ type: 'clip.addText', ref: '$t' },
		{ type: 'look.apply', clipIds: ['$t'], look: { name: 'Gold', recipe } },
	],
	meta: {
		text: 'Big Game',
		lookName: 'Gold',
		colorwayName: name,
		seed: 1,
		clipRef: '$t',
		...(check !== undefined ? { check } : {}),
	},
});
const stored = (o: { pending?: boolean; rows?: TitleCheckRow[] } = {}) => {
	const rows = o.rows ?? ROWS;
	const count = (s: TitleCheckRow['status']) => rows.filter((r) => r.status === s).length;
	return titleArtCheck({
		revision: 3,
		verified: false,
		counts: {
			pass: count('pass'),
			warn: count('warn'),
			fail: count('fail'),
			unverified: count('unverified'),
		},
		rows,
		notChecked: ['taste', 'the animation'],
		...(o.pending ? { pending: true } : {}),
	});
};
const itemWith = (check: unknown) =>
	({
		id: 'title',
		...option('Red', check),
		alternatives: [option('Blue'), option('Green')],
	}) as unknown as ProposalItem;

function show(item: ProposalItem, selected = 0) {
	const doc = makeSession().getCommitted();
	render(<TitleArtDetails doc={doc} item={item} selected={selected} disabled={false} onSelect={() => {}} />);
}

describe('a title proposal’s check rows in Review (TL-098)', () => {
	it('shows each row with its status, measured against expected, timecode and fix, the failures first', () => {
		show(itemWith(stored()));
		const check = screen.getByTestId('title-art-check');
		expect(check.getAttribute('data-verified')).toBe('false');
		expect(check.textContent).toContain('1 fail · 1 warn · 1 pass');
		const rows = within(check).getAllByTestId('title-art-check-row');
		expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['fail', 'warn', 'pass']);
		const contrast = rows[0]!;
		expect(contrast.textContent).toContain('Fail');
		expect(contrast.textContent).toContain('Contrast');
		expect(contrast.textContent).toContain('White on a white sky');
		expect(within(contrast).getByTestId('title-art-check-values').textContent).toBe(
			'Measured median 1.13; worst 1.02 · expected minRatio 3; standard WCAG AA, large text',
		);
		expect(within(contrast).getByTestId('title-art-check-at').textContent).toBe('00:00:01:15');
		expect(within(contrast).getByTestId('title-art-check-fix').textContent).toBe('Fix: Add a dark rim');
		// A row measured at no frame has no timecode; a row with no fix has no fix line.
		expect(within(rows[1]!).queryByTestId('title-art-check-at')).toBeNull();
		expect(within(rows[1]!).queryByTestId('title-art-check-fix')).toBeNull();
		expect(screen.getByTestId('title-art-check-not-checked').textContent).toContain('taste · the animation');
		expect(screen.queryByTestId('title-art-check-pending')).toBeNull();
	});

	it('says the check is pending when the renders outlived the call', () => {
		show(itemWith(stored({ pending: true, rows: [ROWS[2]!] })));
		expect(screen.getByTestId('title-art-check-pending').textContent).toMatch(/^Pending/);
		expect(screen.getAllByTestId('title-art-check-row')).toHaveLength(1);
	});

	it('an alternate carries no rows, and says so', () => {
		show(itemWith(stored()), 2);
		expect(screen.queryByTestId('title-art-check')).toBeNull();
		expect(screen.queryAllByTestId('title-art-check-row')).toHaveLength(0);
		expect(screen.getByTestId('title-art-check-alternate').textContent).toContain('only the first option');
	});

	it('an unreadable check hides nothing else: the posters stay and no rows show', () => {
		show(itemWith({ rows: 'nope' }));
		expect(screen.getByTestId('title-art-details')).toBeTruthy();
		expect(screen.getByTestId('title-art-option-0')).toBeTruthy();
		expect(screen.queryByTestId('title-art-check')).toBeNull();
	});

	it('shows the rows even when no poster can be drawn', () => {
		const item = { ...itemWith(stored()), commands: [{ type: 'x' }] } as unknown as ProposalItem;
		show({
			...item,
			meta: { ...(item.meta as object), lookName: 'Gone', lookId: 'look.gone' },
		} as ProposalItem);
		expect(screen.getAllByTestId('title-art-check-row')).toHaveLength(3);
	});

	it('says how many rows were left out to fit the proposal', () => {
		const many: TitleCheckRow[] = Array.from({ length: 200 }, (_, i) => ({
			...ROWS[0]!,
			id: `lint-pass-${i}`,
			message: 'x'.repeat(400),
		}));
		const check = stored({ rows: [ROWS[1]!, ...many] });
		expect(check.omitted).toBeGreaterThan(0);
		show(itemWith(check));
		expect(screen.getByTestId('title-art-check-omitted').textContent).toContain(String(check.omitted));
		expect(screen.getAllByTestId('title-art-check-row')[0]!.getAttribute('data-status')).toBe('fail');
	});
});

describe('check values as text', () => {
	it('rounds numbers, names nested values and cuts long ones', () => {
		expect(checkValueText(null)).toBe('—');
		expect(checkValueText(1 / 3)).toBe('0.33');
		expect(checkValueText(Number.NaN)).toBe('—');
		expect(checkValueText({ drawn: false })).toBe('drawn no');
		expect(checkValueText({ bounds: { x: 1, y: 2 }, overPx: 3 })).toBe('bounds x 1, y 2; overPx 3');
		expect(checkValueText({ frames: [{ frame: 1, ratio: 2.345 }] })).toBe('frames [frame 1, ratio 2.35]');
		expect(checkValueText([1, 2, 3, 4, 5, 6])).toBe('[1, 2, 3, 4, …]');
		expect(checkValueText('x'.repeat(500))).toHaveLength(200);
	});

	it('reads only the first keys of a wide object, as it does items of a list', () => {
		let reads = 0;
		const wide = new Proxy(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])), {
			get(target, key) {
				reads++;
				return Reflect.get(target, key);
			},
		});
		expect(checkValueText(wide)).toBe('k0 0; k1 1; k2 2; k3 3; k4 4; k5 5; k6 6; k7 7; …');
		expect(reads).toBeLessThanOrEqual(8);
		expect(checkValueText({ a: { b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7, i: 8, j: 9 } })).toBe(
			'a b 1, c 2, d 3, e 4, f 5, g 6, h 7, i 8, …',
		);
	});

	it('never throws and stays short on any JSON an agent stores', () => {
		fc.assert(
			fc.property(fc.jsonValue({ maxDepth: 8 }), (v) => {
				const s = checkValueText(v);
				expect(typeof s).toBe('string');
				expect(s.length).toBeLessThanOrEqual(200);
			}),
			{ numRuns: 300 },
		);
	});

	it('orders rows by what needs attention and counts only what is there', () => {
		const rows = sortedCheckRows(stored().rows);
		expect(rows.map((r) => r.status)).toEqual(['fail', 'warn', 'pass']);
		expect(checkCountsText({ pass: 2, warn: 0, fail: 0, unverified: 1 })).toBe('1 not checked · 2 pass');
	});
});
