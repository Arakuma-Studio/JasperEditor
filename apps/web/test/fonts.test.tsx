// wp fonts: the editor side of the user font library — missing-font detection, the font menu (sections, missing
// marks, picking a library family registers it in one undoable step), and the Player's font resolution matching the
// engine's (PostScript names reach library faces).
import type { FontCatalog } from '@jasper/api';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { missingProjectFonts, projectFontStatus } from '../src/fonts/actions.ts';
import { FontPicker } from '../src/fonts/FontPicker.tsx';
import { fontsStore } from '../src/fonts/store.ts';
import { buildProgramDoc } from '../src/panels/program/render-doc.ts';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

const catalog: FontCatalog = {
	fonts: [
		{
			family: 'Source Sans 3',
			source: 'bundled',
			weights: [400],
			styles: ['normal'],
			files: [{ weight: 400, style: 'normal', subset: 'latin', url: '/fonts/source-sans-3/a.woff2' }],
		},
		{
			family: 'Inter',
			source: 'bundled',
			weights: [400],
			styles: ['normal'],
			files: [{ weight: 400, style: 'normal', subset: 'latin', url: '/fonts/inter/a.woff2' }],
		},
		{
			family: 'Pixel 12x10',
			source: 'custom',
			weights: [400],
			styles: ['normal'],
			files: [
				{
					weight: 400,
					style: 'normal',
					url: '/fonts/library/f0123456789abcdef01234567.ttf',
					postscriptName: 'Pixel12x10',
					fontId: 'f0123456789abcdef01234567',
				},
			],
		},
	],
};

beforeEach(() => fontsStore().setState({ status: 'ready', catalog, library: null, error: null }));
afterEach(() => {
	cleanup();
	fontsStore().setState({ status: 'offline', catalog: null, library: null, error: null });
});

function textProject(families: string[]) {
	const session = makeSession();
	const ids: string[] = [];
	for (const [i, family] of families.entries()) {
		const r = session.apply({
			label: 'text',
			origin: 'user',
			commands: [
				{ type: 'font.add', family, ref: '$f' },
				{
					type: 'clip.addText',
					at: i * 30,
					duration: 30,
					track: 'V1',
					content: { text: `T${i}`, style: { fontId: '$f' } },
					ref: '$t',
				},
			] as never,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		ids.push(r.refs.$t!);
	}
	return { session, ids };
}

describe('project font status', () => {
	it('a font named by its PostScript name is available; an unknown one used by text is missing', () => {
		const { session } = textProject(['Pixel12x10', 'Minion Pro', 'Inter']);
		const doc = session.getCommitted();
		const status = projectFontStatus(doc, catalog);
		expect(status.map((s) => [s.font.family, s.available, s.source])).toEqual(
			expect.arrayContaining([
				['Pixel12x10', true, 'custom'],
				['Minion Pro', false, null],
				['Inter', true, 'bundled'],
			]),
		);
		expect(missingProjectFonts(doc, catalog).map((s) => [s.font.family, s.use.clips])).toEqual([
			['Minion Pro', 1],
		]);
		// unknown catalog: nothing is called missing yet
		expect(missingProjectFonts(doc, null)).toEqual([]);
	});

	it("the Player resolves library fonts like the engine's exports (PostScript name → the library face)", () => {
		const { session } = textProject(['Pixel12x10', 'Minion Pro']);
		const doc = session.getCommitted();
		const player = buildProgramDoc(
			{
				doc,
				sequenceId: Object.keys(doc.sequences)[0]!,
				media: {},
				fontCatalog: catalog,
			} as never,
			null,
		);
		const urls = Object.fromEntries(player.fonts.map((f) => [f.family, f.url]));
		expect(urls.Pixel12x10).toBe('/fonts/library/f0123456789abcdef01234567.ttf');
		expect(urls['Minion Pro']).toBeUndefined();
	});
});

describe('font menu', () => {
	it('lists project, installed and bundled fonts, marks missing ones, and hands catalog families to onPickFamily', () => {
		const onPickFamily = vi.fn();
		const onPickFont = vi.fn();
		const docFonts = {
			fnt_a: { id: 'fnt_a', family: 'Minion Pro' },
			fnt_b: { id: 'fnt_b', family: 'Inter' },
		};
		renderWithSession(
			makeSession(),
			<FontPicker
				value="fnt_a"
				docFonts={docFonts}
				onPickFont={onPickFont}
				onPickFamily={onPickFamily}
				onResolveFonts={() => {}}
				data-testid="picker"
			/>,
		);
		const trigger = screen.getByTestId('picker');
		expect(trigger.getAttribute('data-missing')).toBe('true');
		act(() => {
			fireEvent.click(trigger);
		});
		const menu = screen.getByTestId('font-picker');
		const project = within(menu).getByLabelText('Project Fonts');
		const minion = within(project)
			.getAllByRole('button')
			.find((b) => b.getAttribute('data-font-family') === 'Minion Pro')!;
		expect(minion.getAttribute('data-missing')).toBe('true');
		expect(within(menu).getByLabelText('My Fonts').textContent).toContain('Pixel 12x10');
		// Inter is in the project, so it is not listed again under the bundled fonts
		expect(within(menu).getByLabelText('Bundled Fonts').textContent).not.toContain('Inter');
		expect(within(menu).getByText('Resolve Fonts…')).toBeTruthy();
		const pixel = within(menu)
			.getAllByRole('button')
			.find((b) => b.getAttribute('data-font-family') === 'Pixel 12x10')!;
		act(() => {
			fireEvent.click(pixel);
		});
		expect(onPickFamily).toHaveBeenCalledWith('Pixel 12x10');
		expect(onPickFont).not.toHaveBeenCalled();
	});

	it('search filters the menu', () => {
		renderWithSession(
			makeSession(),
			<FontPicker
				value={null}
				docFonts={{}}
				onPickFont={() => {}}
				onPickFamily={() => {}}
				data-testid="picker"
			/>,
		);
		act(() => {
			fireEvent.click(screen.getByTestId('picker'));
		});
		fireEvent.change(screen.getByLabelText('Search fonts'), { target: { value: 'pix' } });
		const menu = screen.getByTestId('font-picker');
		expect(within(menu).queryByText('Inter')).toBeNull();
		expect(within(menu).getByText('Pixel 12x10')).toBeTruthy();
	});

	it('Properties ▸ Text: picking an installed family registers it and sets it in one undo step', () => {
		const { session, ids } = textProject(['Inter']);
		act(() => session.select('timeline', [ids[0]!]));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const before = session.getState().history.entries.length;
		act(() => {
			fireEvent.click(screen.getByTestId('prop-text.fontId'));
		});
		const pixel = within(screen.getByTestId('font-picker'))
			.getAllByRole('button')
			.find((b) => b.getAttribute('data-font-family') === 'Pixel 12x10')!;
		act(() => {
			fireEvent.click(pixel);
		});
		const doc = session.getCommitted();
		const fontId = (clipOf(session, ids[0]!) as unknown as { content: { style: { fontId: string } } }).content
			.style.fontId;
		expect(doc.fonts[fontId]?.family).toBe('Pixel 12x10');
		expect(session.getState().history.entries.length).toBe(before + 1);
		act(() => {
			session.undo();
		});
		const undone = (clipOf(session, ids[0]!) as unknown as { content: { style: { fontId: string } } }).content
			.style.fontId;
		expect(session.getCommitted().fonts[undone]?.family).toBe('Inter');
	});
});
