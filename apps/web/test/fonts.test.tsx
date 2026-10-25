// wp fonts: missing-font detection, searchable Properties selection of an installed family in one undoable step,
// and the Player's font resolution matching the
// engine's (PostScript names reach library faces).
import type { FontCatalog } from '@jasper/api';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { missingProjectFonts } from '../src/fonts/actions.ts';
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
	it('only used unavailable families are missing; an unknown catalog waits for resolution', () => {
		const { session } = textProject(['Pixel12x10', 'Minion Pro', 'Inter']);
		const extra = session.apply({
			label: 'unused',
			origin: 'user',
			commands: [{ type: 'font.add', family: 'Unused family' }],
		});
		if (!extra.ok) throw new Error(JSON.stringify(extra.errors));
		const doc = session.getCommitted();
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
	it('Properties ▸ Text: search and pick an installed family in one undo step', () => {
		const { session, ids } = textProject(['Inter']);
		act(() => session.select('timeline', [ids[0]!]));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const before = session.getState().history.entries.length;
		act(() => {
			fireEvent.click(screen.getByTestId('prop-text.fontId'));
		});
		fireEvent.change(screen.getByRole('searchbox', { name: 'Search fonts' }), { target: { value: 'pix' } });
		expect(within(screen.getByTestId('font-picker')).queryByRole('button', { name: 'Inter' })).toBeNull();
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
