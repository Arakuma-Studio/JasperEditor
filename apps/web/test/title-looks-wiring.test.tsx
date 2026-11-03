// Spec 19 TL-097 / TL-098: every action has a command and a menu entry, no default shortcut was added, and a title-art
// proposal shows its options and says Compare.
import type { ProposalItem } from '@jasper/project';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCommand } from '../src/commands/registry.ts';
import { DEFAULT_KEYMAP } from '../src/commands/keymap-defaults.ts';
import { titleLookCommands } from '../src/commands/title-looks.ts';
import { isVisualProposal, TitleArtDetails, titleArtOptions } from '../src/proposals/title-art.tsx';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { makeSession } from './inspector-helpers.tsx';

afterEach(() => cleanup());

const recipe = { palette: { face: [1, 0, 0, 1] }, layers: [{ type: 'face' }] };
const option = (name: string, face: number[]) => ({
	label: `Gold, ${name}`,
	commands: [
		{ type: 'clip.addText', ref: '$t' },
		{ type: 'look.apply', clipIds: ['$t'], look: { name: 'Gold', recipe } },
		{ type: 'look.setColorway', clipIds: ['$t'], palette: { face } },
	],
	meta: { text: 'Big Game\nSecond line', lookName: 'Gold', colorwayName: name, seed: 1, clipRef: '$t' },
});
const item = {
	id: 'title',
	label: 'Gold, Red',
	...option('Red', [1, 0, 0, 1]),
	alternatives: [option('Blue', [0, 0, 1, 1]), option('Green', [0, 1, 0, 1])],
} as unknown as ProposalItem;

describe('wiring (TL-097)', () => {
	const flat = (items: readonly { type: string; items?: unknown; command?: string }[]): string[] =>
		items.flatMap((i) =>
			i.type === 'submenu' ? flat(i.items as never) : i.type === 'command' ? [i.command!] : [],
		);
	const graphics = MENUBAR.find((m) => m.id === 'graphics')!;

	it('every look command is in the Graphics menu, and every menu entry is a command', () => {
		const inMenu = new Set(flat(graphics.items as never));
		for (const c of titleLookCommands) if (c.id !== 'graphics.addGenerator') expect(inMenu.has(c.id), c.id).toBe(true);
		for (const id of inMenu) if (id.startsWith('graphics.')) expect(!!getCommand(id) || id, id).toBeTruthy();
	});

	it('the Add Layer menu lists every layer type', async () => {
		const { TITLE_LAYER_TYPES } = await import('@jasper/project');
		const entries = flat(graphics.items as never).filter((c) => c === 'graphics.addLookLayer');
		expect(entries.length).toBe(TITLE_LAYER_TYPES.filter((l) => !l.type.startsWith('generator:')).length);
	});

	it('claims no default shortcut, so nothing can collide', () => {
		const ids = new Set(titleLookCommands.map((c) => c.id));
		expect(DEFAULT_KEYMAP.filter((b) => ids.has(b.command))).toEqual([]);
	});

	it('every look command says why it is unavailable', () => {
		const ctx = { session: null } as never;
		for (const c of titleLookCommands) expect(c.when?.(ctx), c.id).toBe(false);
		for (const c of titleLookCommands) expect(typeof c.disabledReason?.(ctx), c.id).toBe('string');
	});

	it('Next Colourway on a look without colourways says so instead of doing nothing', async () => {
		const session = makeSession();
		const toast = vi.fn();
		const r = session.apply({
			label: 's',
			origin: 'user',
			commands: [
				{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'x' }, ref: '$t' },
				{ type: 'look.apply', clipIds: ['$t'], look: { name: 'G', recipe } },
			] as never,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		session.select('timeline', [r.refs.$t!]);
		await titleLookCommands.find((c) => c.id === 'graphics.nextColorway')!.run({ session, ui: { toast } } as never);
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: 'This look has no colourways yet.' }));
	});
});

describe('title-art review (TL-098)', () => {
	it('is a visual proposal, others are not', () => {
		expect(isVisualProposal('title-art')).toBe(true);
		expect(isVisualProposal('sound-design')).toBe(false);
		expect(isVisualProposal(undefined)).toBe(false);
	});

	it('reads each option\'s look, colours and first line of text from its commands', () => {
		const doc = makeSession().getCommitted();
		const options = titleArtOptions(doc, item);
		expect(options.map((o) => o.label)).toEqual(['Gold, Red', 'Gold, Blue', 'Gold, Green']);
		expect(options[0]!.request).toMatchObject({ text: 'Big Game', palette: { face: [1, 0, 0, 1] } });
		expect(options[1]!.request).toMatchObject({ palette: { face: [0, 0, 1, 1] } });
	});

	it('an option it cannot read shows no picture and raises nothing', () => {
		const doc = makeSession().getCommitted();
		const broken = { ...item, meta: { nope: 1 }, commands: [{ type: 'x' }], alternatives: [] } as unknown as ProposalItem;
		expect(titleArtOptions(doc, broken)[0]!.request).toBeNull();
		render(<TitleArtDetails doc={doc} item={broken} selected={0} disabled={false} onSelect={() => {}} />);
		expect(screen.queryByTestId('title-art-details')).toBeNull();
	});

	it('choosing an option selects that alternate', () => {
		const doc = makeSession().getCommitted();
		const onSelect = vi.fn();
		render(<TitleArtDetails doc={doc} item={item} selected={0} disabled={false} onSelect={onSelect} />);
		fireEvent.click(screen.getByTestId('title-art-option-2'));
		expect(onSelect).toHaveBeenCalledWith(2);
		expect(screen.getByTestId('title-art-option-0').getAttribute('aria-pressed')).toBe('true');
	});
});
