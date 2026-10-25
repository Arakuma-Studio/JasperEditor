// "Add another" and the spreadsheet bulk import in the web app (docs/wp-notes/social-comments.md "Add another &
// bulk import"): the UI command, the timeline clip menu, Properties ▸ Template, the Motion Templates panel and the
// import dialog (preview with filled values and left-out rows, one undo step).
import { EngineClient } from '@jasper/engine-client';
import { createMgRegistry, mgRegistry } from '@jasper/mg-templates';
import {
	type Clip,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	TABLE_MAX_CHARS,
} from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SOCIAL_BULK_TEST_TEMPLATE } from '../../../packages/mg-templates/test/fixtures/social-bulk-template.ts';
import { createCommandContext, registerCommands, runCommand } from '../src/commands/index.ts';
import { mgCommands } from '../src/commands/mg.ts';
import { clipMenuExtensions } from '../src/extensions/index.ts';
import {
	addAnotherDisabledReason,
	addAnotherMotionGraphics,
} from '../src/panels/motionTemplates/add-another.ts';
import { MG_BULK_IMPORT_DIALOG } from '../src/panels/motionTemplates/BulkImportDialog.tsx';
import { buildBulkImport } from '../src/panels/motionTemplates/bulk-import.ts';
import { MotionTemplatesPanel } from '../src/panels/motionTemplates/MotionTemplatesPanel.tsx';
import { MgTemplateSection } from '../src/panels/motionTemplates/TemplateSection.tsx';
import { EngineProvider } from '../src/state/engine.tsx';

const T = SOCIAL_BULK_TEST_TEMPLATE;
const registry = createMgRegistry([...mgRegistry.definitions(), T]);

function fakeEngine() {
	const json = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });
	return new EngineClient({
		fetch: (async (url: string) => {
			if (url === '/health') return json({ ok: true, version: '0.1.0', apiVersion: 1 });
			if (url === '/api/motion-graphics/templates')
				return json({ templates: registry.catalogJson(), renderer: { status: 'ready', version: '0.1.0' } });
			return json({ code: 'NOT_IMPLEMENTED', message: 'later', retryable: false }, 501);
		}) as unknown as typeof fetch,
	});
}

async function openSession() {
	const ids = createCounterIdSource(7);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'Bulk', preset: 'hd-1080p-30' });
	store.put(doc);
	return EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => 't', registries: defaultRegistries(registry) },
	});
}

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;
const mgClips = (s: EditorSession) =>
	Object.values(Object.values(s.getCommitted().sequences)[0]!.clips)
		.filter((c): c is MgClip => c.kind === 'motion-graphic')
		.sort((a, b) => a.start - b.start);
const trackLabel = (s: EditorSession, c: Clip) => {
	const seq = Object.values(s.getCommitted().sequences)[0]!;
	return `V${seq.videoTracks.findIndex((t) => t.id === c.trackId) + 1}`;
};

function addComment(s: EditorSession, params: Record<string, unknown> = {}): string {
	const r = s.apply({
		label: 'Add',
		origin: 'user',
		commands: [
			{
				type: 'clip.addMotionGraphic',
				at: 30,
				duration: 150,
				track: 'V2',
				template: { id: T.id, version: 1 },
				params: { variant: 'x-post', theme: 'dark', text: 'Keep ==this== text', ...params },
				fill: { seed: 11 },
				ref: '$c',
			},
		],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const id = r.refs.$c!;
	s.select('timeline', [id], 'replace');
	return id;
}

let unregister: (() => void) | undefined;
afterEach(() => {
	unregister?.();
	unregister = undefined;
	act(() => closeAllDialogs());
	cleanup();
});

describe('Add another', () => {
	it('mg.addAnother copies the selected comment after itself with a new identity and stats; one undo step', async () => {
		unregister = registerCommands(mgCommands);
		const s = await openSession();
		const src = addComment(s);
		const before = s.getCommitted();
		const ctx = createCommandContext({ engine: fakeEngine(), session: s });
		expect(await runCommand('mg.addAnother', ctx, { seed: 5 })).toEqual({ ran: true });
		const [a, b] = mgClips(s);
		expect(a!.id).toBe(src);
		expect(b).toMatchObject({ start: 180, duration: 150 });
		expect(trackLabel(s, b!)).toBe('V2');
		expect(b!.params).toMatchObject({ variant: 'x-post', theme: 'dark', text: 'Keep ==this== text' });
		expect(b!.params.displayName).not.toBe(a!.params.displayName);
		expect(b!.params.likes).not.toBe(a!.params.likes);
		expect(s.getState().selection.timeline.clips).toEqual([b!.id]);
		expect(s.getState().history.entries.at(-1)?.label).toBe('Add Another');
		s.undo();
		expect(s.getCommitted()).toBe(before);
		s.redo();
		expect(mgClips(s)).toHaveLength(2);
		await s.close();
	});

	it('copies every selected motion graphic, skips other clips, refuses without one', async () => {
		const s = await openSession();
		const src = addComment(s);
		const solid = s.apply({
			label: 'Solid',
			origin: 'user',
			commands: [{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 0, 1], ref: '$s' }],
		});
		const solidId = solid.ok ? solid.refs.$s! : '';
		s.select('timeline', [solidId], 'replace');
		expect(addAnotherDisabledReason(s)).toBe('Select a motion-graphic clip');
		expect(addAnotherMotionGraphics(s)).toEqual({ ok: false, message: 'Select a motion-graphic clip' });
		s.select('timeline', [solidId, src], 'replace');
		expect(addAnotherDisabledReason(s)).toBeUndefined();
		const r = addAnotherMotionGraphics(s, { seed: 1 });
		expect(r.ok && r.clipIds).toHaveLength(1);
		await s.close();
	});

	it('is in the timeline clip menu of motion-graphic clips only', async () => {
		const s = await openSession();
		const src = addComment(s);
		const ext = clipMenuExtensions.list().find((e) => e.id === 'mg-add-another')!;
		const clip = s.getCommitted().sequences[s.getState().activeSequenceId!]!.clips[src]!;
		const items = ext.items({ session: s, clip, selection: [src] });
		expect(items.map((i) => (i.kind === 'item' ? i.label : i.kind))).toEqual(['Add Another']);
		act(() => (items[0] as { run(): void }).run());
		expect(mgClips(s)).toHaveLength(2);
		const other = { ...clip, kind: 'solid' } as unknown as Clip;
		expect(ext.items({ session: s, clip: other, selection: [] })).toEqual([]);
		await s.close();
	});

	it('Properties ▸ Template has Add Another and Import Spreadsheet…', async () => {
		const s = await openSession();
		const src = addComment(s);
		const clip = s.getCommitted().sequences[s.getState().activeSequenceId!]!.clips[src]!;
		render(
			<MgTemplateSection session={s} clips={[clip]} frame={0} sequenceId={s.getState().activeSequenceId!} />,
		);
		fireEvent.click(screen.getByTestId('mg-template-add-another'));
		expect(mgClips(s)).toHaveLength(2);
		expect(screen.getByTestId('mg-template-bulk-import')).toBeTruthy();
		await s.close();
	});

	it('the Motion Templates panel offers Add Another for the selection', async () => {
		const s = await openSession();
		addComment(s);
		render(
			<EngineProvider client={fakeEngine()}>
				<SessionProvider session={s}>
					<MotionTemplatesPanel instanceId="mgt-1" visible />
				</SessionProvider>
			</EngineProvider>,
		);
		const button = screen.getByTestId('motion-templates-add-another') as HTMLButtonElement;
		expect(button.disabled).toBe(false);
		fireEvent.click(button);
		expect(mgClips(s)).toHaveLength(2);
		act(() => s.select('timeline', [], 'replace'));
		expect((screen.getByTestId('motion-templates-add-another') as HTMLButtonElement).disabled).toBe(true);
		await s.close();
	});
});

const TSV = [
	['User', 'Comment', 'Likes', 'Verified', 'Image URL'],
	['luna.park', 'First ==great== one', '1.2K', 'yes', 'https://example.com/a.png'],
	['bo', 'Second', 'lots', '', ''],
	['', 'Third', '', 'no', ''],
]
	.map((r) => r.join('\t'))
	.join('\n');

describe('bulk import dialog', () => {
	async function openImport(props: Record<string, unknown> = {}) {
		const s = await openSession();
		s.transport.seek(60);
		render(<DialogHost />);
		act(
			() =>
				void openDialog(MG_BULK_IMPORT_DIALOG, {
					session: s,
					template: { id: T.id, version: 1, preset: 'instagram-post' },
					...props,
				}),
		);
		await screen.findByTestId('mg-bulk-import');
		return s;
	}

	it('previews every row (filled values marked, bad rows left out) and inserts the valid rows as one undo step', async () => {
		const s = await openImport();
		expect((screen.getByTestId('mg-bulk-template') as HTMLSelectElement).value).toBe(
			`${T.id}@1:instagram-post`,
		);
		fireEvent.change(screen.getByTestId('mg-bulk-text'), { target: { value: TSV } });
		const columns = screen.getByTestId('mg-bulk-columns');
		expect(
			within(columns)
				.getByText(/Image URL/)
				.getAttribute('data-column-kind'),
		).toBe('ignored');
		const table = screen.getByTestId('mg-bulk-preview');
		const rows = within(table).getAllByRole('row').slice(1);
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.getAttribute('data-included'))).toEqual(['true', 'false', 'true']);
		expect(within(rows[1]!).getByTestId('mg-bulk-row-error').textContent).toContain(
			'Likes: "lots" is not a number',
		);
		// row 3 has no User: its handle is filled at random (marked), its text is the row's
		expect(rows[2]!.querySelectorAll('[data-filled]').length).toBeGreaterThan(0);
		expect(rows[0]!.textContent).toContain('luna.park');
		expect(rows[0]!.textContent).toContain('1200');
		expect(screen.getByTestId('mg-bulk-summary').textContent).toMatch(
			/2 of 3 rows will be added from 00:00:02:00; 1 with errors/,
		);
		const before = s.getCommitted();
		fireEvent.click(screen.getByTestId('mg-bulk-insert'));
		await waitFor(() => expect(screen.queryByTestId('mg-bulk-import')).toBeNull());
		const clips = mgClips(s);
		expect(clips.map((c) => [c.start, c.duration])).toEqual([
			[60, 150],
			[210, 150],
		]);
		expect(clips[0]!.params).toMatchObject({
			variant: 'instagram-post',
			handle: 'luna.park',
			text: 'First ==great== one',
			likes: 1200,
			verified: true,
		});
		expect(clips[1]!.params).toMatchObject({ variant: 'instagram-post', text: 'Third', verified: false });
		expect(s.getState().selection.timeline.clips.sort()).toEqual(clips.map((c) => c.id).sort());
		expect(s.getState().history.entries.at(-1)?.label).toBe('Import 2 Motion Graphics');
		s.undo();
		expect(s.getCommitted()).toBe(before);
		await s.close();
	});

	it('the preview equals what is inserted, and New Random Values changes the filled values only', async () => {
		const s = await openImport();
		fireEvent.change(screen.getByTestId('mg-bulk-text'), { target: { value: 'Comment\nOne\nTwo' } });
		const cellsOf = () =>
			within(screen.getByTestId('mg-bulk-preview'))
				.getAllByRole('row')
				.slice(1)
				.map((r) => [...r.querySelectorAll('[data-filled]')].map((c) => c.textContent));
		const first = cellsOf();
		fireEvent.click(screen.getByTestId('mg-bulk-reroll'));
		expect(cellsOf()).not.toEqual(first);
		const shown = cellsOf();
		fireEvent.click(screen.getByTestId('mg-bulk-insert'));
		await waitFor(() => expect(mgClips(s)).toHaveLength(2));
		// the filled handles shown in the preview are the ones stored
		for (const [i, c] of mgClips(s).entries()) expect(shown[i]).toContain(String(c.params.handle));
		await s.close();
	});

	it('reads a chosen CSV file, refuses a file over the cap and shows parse errors', async () => {
		await openImport({ template: { id: T.id, version: 1 } });
		const input = screen.getByTestId('mg-bulk-file-input') as HTMLInputElement;
		const csv = 'variant,User,Comment\r\nyoutube-comment,@yt_user,"Hello, ""quoted""\nworld"\r\n';
		fireEvent.change(input, { target: { files: [new File([csv], 'comments.csv', { type: 'text/csv' })] } });
		await waitFor(() => expect((screen.getByTestId('mg-bulk-text') as HTMLTextAreaElement).value).toBe(csv));
		const row = within(screen.getByTestId('mg-bulk-preview')).getAllByRole('row')[1]!;
		expect(row.textContent).toContain('yt_user');
		expect(row.textContent).toContain('Hello, "quoted"');
		const big = new File(['x'], 'big.csv');
		Object.defineProperty(big, 'size', { value: TABLE_MAX_CHARS + 1 });
		fireEvent.change(input, { target: { files: [big] } });
		expect((await screen.findByTestId('mg-bulk-file-error')).textContent).toContain('big.csv is too large');
		fireEvent.change(screen.getByTestId('mg-bulk-text'), { target: { value: 'nothing,here\n1,2' } });
		expect(screen.getByTestId('mg-bulk-error').textContent).toContain('The first row must name the columns');
		expect((screen.getByTestId('mg-bulk-insert') as HTMLButtonElement).disabled).toBe(true);
	});

	it('works for templates without a fill hook (counter presets) and with an explicit delimiter', async () => {
		const s = await openImport({ template: { id: 'counter', version: 1, preset: 'percentage' } });
		fireEvent.change(screen.getByTestId('mg-bulk-delimiter'), { target: { value: ';' } });
		const def = mgRegistry.getDefinition('counter', 1)!;
		const numeric = Object.entries(def.defaults).find(([, v]) => typeof v === 'number')![0];
		fireEvent.change(screen.getByTestId('mg-bulk-text'), {
			target: { value: `${numeric};duration\n42;2s\n7;` },
		});
		fireEvent.click(screen.getByTestId('mg-bulk-insert'));
		await waitFor(() => expect(mgClips(s)).toHaveLength(2));
		const clips = mgClips(s);
		expect(clips.map((c) => c.params[numeric])).toEqual([42, 7]);
		expect(clips[0]!.duration).toBe(60);
		expect(clips[1]!.start).toBe(120);
		await s.close();
	});

	it('mg.bulkImport opens the dialog with the requested template; read-only projects cannot insert', async () => {
		unregister = registerCommands(mgCommands);
		const s = await openSession();
		render(<DialogHost />);
		const ctx = createCommandContext({
			engine: fakeEngine(),
			session: s,
			openDialog: (kind, props) => void openDialog(kind, props),
		});
		await act(async () => {
			await runCommand('mg.bulkImport', ctx, { templateId: T.id, version: 1, preset: 'x-post' });
		});
		expect(((await screen.findByTestId('mg-bulk-template')) as HTMLSelectElement).value).toBe(
			`${T.id}@1:x-post`,
		);
		act(() => s.store.setState({ readOnly: true }));
		fireEvent.change(screen.getByTestId('mg-bulk-text'), { target: { value: 'Comment\nhi' } });
		expect((screen.getByTestId('mg-bulk-insert') as HTMLButtonElement).disabled).toBe(true);
		await s.close();
	});

	it("a gallery card's context menu imports a spreadsheet as that card (template + preset)", async () => {
		const s = await openSession();
		render(
			<>
				<DialogHost />
				<EngineProvider client={fakeEngine()}>
					<SessionProvider session={s}>
						<MotionTemplatesPanel instanceId="mgt-2" visible />
					</SessionProvider>
				</EngineProvider>
			</>,
		);
		const card = await screen.findByRole('listitem', { name: /^Percentage · Counter/ });
		fireEvent.contextMenu(card);
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Import Spreadsheet as This…' }));
		expect(((await screen.findByTestId('mg-bulk-template')) as HTMLSelectElement).value).toBe(
			'counter@1:percentage',
		);
		act(() => closeAllDialogs());
		fireEvent.click(screen.getByTestId('motion-templates-bulk-import'));
		expect(await screen.findByTestId('mg-bulk-import')).toBeTruthy();
		await s.close();
	});

	it('buildBulkImport never throws on hostile text', async () => {
		const s = await openSession();
		const info = registry.get(T.id, 1)!;
		for (const text of ['"', '﻿', '\t\t\n\t', 'Comment\n"unclosed', 'a'.repeat(5000), 'Comment\n\u0000‮']) {
			const m = buildBulkImport({
				text,
				delimiter: 'auto',
				info,
				rate: { num: 30, den: 1 },
				media: {},
				seed: 1,
				startAt: 0,
			});
			expect(typeof m.ok).toBe('boolean');
		}
		await s.close();
	});
});
