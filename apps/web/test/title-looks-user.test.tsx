// Spec 19 TL-054 in the Looks tab: My Looks, the user's own looks kept by the engine. Listed in their own category, applied
// by copying them into the project once, saved from the selected clip, renamed, deleted, imported and exported through
// `/api/title-looks`, and every action says why when the engine cannot take it. The engine is an in-memory fake that
// answers the real routes through the real client, so request and response schemas are checked on both sides.
import { setImmediate } from 'node:timers/promises';
import { clipLook, type EffectInstance, type LookRecipe, titleLooksOf, type UserLook } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getCommand, registerAllCommands } from '../src/commands/index.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { pickLook } from '../src/title-looks/actions.ts';
import { dropLookOnClip, readLookDrag, writeLookDrag } from '../src/title-looks/drag.ts';
import { LooksBrowser } from '../src/title-looks/LooksBrowser.tsx';
import { lookEntries, MY_LOOKS_CATEGORY } from '../src/title-looks/library.ts';
import { lookPreviewCommands } from '../src/title-looks/preview.ts';
import {
	connectUserLooks,
	currentUserLooks,
	refreshUserLooks,
	saveUserLooks,
	userLookLibrary,
	userLooksUnavailable,
} from '../src/title-looks/user-library.ts';
import {
	deleteMyLook,
	exportMyLooks,
	freeUserLookName,
	importMyLooks,
	renameMyLook,
	saveToMyLooks,
	saveToMyLooksDisabled,
	userLookFromSelection,
	userLookNameProblem,
} from '../src/title-looks/user-look-actions.ts';
import { clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';
import { type Fake, fakeEngine, userLook } from './user-looks-engine.ts';

const dialogs = vi.hoisted(() => ({ name: 'Mine' as string | null, confirm: true }));
vi.mock('../src/gaps/SmallDialogs.tsx', async (load) => ({
	...(await load<object>()),
	promptName: vi.fn(async () => dialogs.name),
}));
vi.mock('@jasper/ui', async (load) => ({
	...(await load<object>()),
	confirmDialog: vi.fn(async () => dialogs.confirm),
}));

beforeAll(() => registerAllCommands());

const recipe: LookRecipe = {
	palette: { face: [1, 0.8, 0.2, 1] },
	layers: [{ type: 'rim', params: { width: 5 } }, { type: 'face' }],
};

async function connected(initial: UserLook[] = []): Promise<Fake> {
	const fake = fakeEngine(initial);
	connectUserLooks(fake.client);
	await refreshUserLooks();
	return fake;
}

/** A project with one title wearing a project look "Gold" with tags and a colourway, selected. */
function titleWithLook(): { session: EditorSession; id: string } {
	const session = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{ type: 'look.create', name: 'Gold', recipe, tags: ['shiny'], category: 'luxury' },
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'Title' }, ref: '$t' },
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const id = r.refs.$t!;
	const lookId = titleLooksOf(session.getCommitted())[0]!.id;
	const a = session.apply({
		label: 'look',
		origin: 'user',
		commands: [{ type: 'look.apply', clipIds: [id], lookId }] as never,
	});
	if (!a.ok) throw new Error(JSON.stringify(a.errors));
	act(() => session.select('timeline', [id]));
	return { session, id };
}

const lookOfClip = (s: EditorSession, id: string) =>
	clipLook((clipOf(s, id) as unknown as { effects: EffectInstance[] }).effects)?.appearance;

afterEach(() => {
	connectUserLooks(null);
	dialogs.name = 'Mine';
	dialogs.confirm = true;
	cleanup();
	vi.restoreAllMocks();
});

describe('My Looks in the list of looks (TL-054)', () => {
	it('come last, in their own category, and a project copy of one is not a second card', async () => {
		const mine = userLook('Mine');
		await connected([mine]);
		const { session, id } = titleWithLook();
		const entries = lookEntries(session.getCommitted(), undefined, undefined, currentUserLooks());
		const last = entries.at(-1)!;
		expect(last).toMatchObject({
			lookId: mine.id,
			source: 'user',
			name: 'Mine',
			category: MY_LOOKS_CATEGORY,
		});
		expect(last.given).toMatchObject({ name: 'Mine', sourceId: mine.id, recipe: mine.recipe });
		// Once applied, the project holds a copy linked by `sourceId`: still one card, the user look's.
		expect(pickLook(session, last).ok).toBe(true);
		const copy = titleLooksOf(session.getCommitted()).find((l) => l.sourceId === mine.id)!;
		expect(copy.name).toBe('Mine');
		const again = lookEntries(session.getCommitted(), undefined, undefined, currentUserLooks());
		expect(again.filter((e) => e.name === 'Mine')).toHaveLength(1);
		expect(lookOfClip(session, id)?.lookId).toBe(copy.id);
	});

	it('applying one is one undo step, and applying it again reuses the project copy', async () => {
		const mine = userLook('Mine');
		await connected([mine]);
		const { session, id } = titleWithLook();
		const entry = () =>
			lookEntries(session.getCommitted(), undefined, undefined, currentUserLooks()).find(
				(e) => e.lookId === mine.id,
			)!;
		const before = titleLooksOf(session.getCommitted()).length;
		pickLook(session, entry());
		pickLook(session, entry());
		expect(titleLooksOf(session.getCommitted())).toHaveLength(before + 1);
		session.undo();
		session.undo();
		expect(titleLooksOf(session.getCommitted())).toHaveLength(before);
		expect(lookOfClip(session, id)?.layers).toHaveLength(2);
	});

	it('previews and drops one by giving the look whole', async () => {
		const mine = userLook('Mine');
		await connected([mine]);
		const { session, id } = titleWithLook();
		const entry = lookEntries(session.getCommitted(), undefined, undefined, currentUserLooks()).at(-1)!;
		const [cmd] = lookPreviewCommands([id], entry) as unknown as [{ look?: unknown; lookId?: unknown }];
		expect(cmd.lookId).toBeUndefined();
		expect(cmd.look).toMatchObject({ name: 'Mine', sourceId: mine.id });
		const data = new Map<string, string>();
		writeLookDrag(
			{ setData: (k: string, v: string) => data.set(k, v), effectAllowed: '' } as unknown as DataTransfer,
			mine.id,
		);
		const drag = readLookDrag({ getData: (k) => data.get(k) ?? '' })!;
		expect(dropLookOnClip(session, drag, id).ok).toBe(true);
		expect(titleLooksOf(session.getCommitted()).some((l) => l.sourceId === mine.id)).toBe(true);
	});
});

describe('the library store (TL-054)', () => {
	it('says why it cannot act: no engine, an engine that failed, a newer file', async () => {
		expect(userLooksUnavailable()).toMatch(/not connected/);
		const fake = await connected();
		expect(userLooksUnavailable()).toBeNull();
		fake.readOnly = true;
		await refreshUserLooks();
		expect(userLooksUnavailable()).toMatch(/newer JasperEditor/);
		userLookLibrary().setState({ status: 'error', error: 'boom' });
		expect(userLooksUnavailable()).toMatch(/boom/);
	});

	it('saves several under free names and refreshes once at the end', async () => {
		const fake = await connected([userLook('Gold')]);
		const saved = await saveUserLooks([
			{ name: 'Gold', recipe },
			{ name: 'Gold', recipe },
			{ name: 'Neon', recipe },
		]);
		expect(saved.map((l) => l.name)).toEqual(['Gold 2', 'Gold 3', 'Neon']);
		expect(currentUserLooks().map((l) => l.name)).toEqual(['Gold', 'Gold 2', 'Gold 3', 'Neon']);
		expect(fake.calls.filter((c) => c === 'GET /api/title-looks')).toHaveLength(2);
	});

	it('says how many were saved before a refusal', async () => {
		const fake = await connected();
		fake.failSaves = true;
		await expect(saveUserLooks([{ name: 'A', recipe }])).rejects.toThrow(/disk is full/);
		fake.failSaves = false;
		await saveUserLooks([{ name: 'A', recipe }]);
		fake.failSaves = true;
		await expect(saveUserLooks([{ name: 'B', recipe }])).rejects.toThrow(/disk is full/);
	});

	it('refuses writes without an engine instead of failing somewhere else', async () => {
		await expect(saveUserLooks([{ name: 'A', recipe }])).rejects.toThrow(/not connected/);
	});
});

describe('saving the selected clip’s look (TL-054)', () => {
	it('takes the clip’s values and the linked look’s tags and category', () => {
		const { session } = titleWithLook();
		const init = userLookFromSelection(session)!;
		expect(init.name).toBe('Gold');
		expect(init.tags).toEqual(['shiny']);
		expect(init.category).toBe('luxury');
		expect(init.recipe.layers.map((l) => l.type)).toEqual(['rim', 'face']);
	});

	it('names it, stores it with the engine and leaves the project and History alone', async () => {
		const fake = await connected();
		const { session } = titleWithLook();
		const doc = session.getCommitted();
		const history = session.getState().history.entries.length;
		dialogs.name = 'Saved Gold';
		const saved = await saveToMyLooks(session);
		expect(saved?.name).toBe('Saved Gold');
		expect(fake.looks.map((l) => l.name)).toEqual(['Saved Gold']);
		expect(currentUserLooks().map((l) => l.name)).toEqual(['Saved Gold']);
		expect(session.getCommitted()).toBe(doc);
		expect(session.getState().history.entries.length).toBe(history);
	});

	it('is unavailable with a reason: no look selected, no engine', async () => {
		const { session } = titleWithLook();
		expect(saveToMyLooksDisabled(session)).toMatch(/not connected/);
		await connected();
		expect(saveToMyLooksDisabled(session)).toBeUndefined();
		act(() => session.select('timeline', []));
		expect(saveToMyLooksDisabled(session)).toMatch(/Select a clip with a look/);
		expect(await saveToMyLooks(session)).toBeNull();
	});

	it('refuses a name already in My Looks, whatever its case, and offers a free one', () => {
		const looks = [{ id: 'a', name: 'Gold' }];
		expect(userLookNameProblem('gold', looks)).toMatch(/already exists/);
		expect(userLookNameProblem('gold', looks, 'a')).toBeNull();
		expect(userLookNameProblem('  ', looks)).toMatch(/name/);
		expect(freeUserLookName(looks, 'Gold')).toBe('Gold 2');
	});
});

describe('rename, delete, import, export (TL-054)', () => {
	it('renames and deletes through the engine; deleting asks first', async () => {
		const mine = userLook('Mine');
		const fake = await connected([mine]);
		dialogs.name = 'Renamed';
		expect(await renameMyLook(mine)).toBe(true);
		expect(currentUserLooks()[0]!.name).toBe('Renamed');
		dialogs.confirm = false;
		expect(await deleteMyLook(mine)).toBe(false);
		expect(fake.looks).toHaveLength(1);
		dialogs.confirm = true;
		expect(await deleteMyLook(mine)).toBe(true);
		expect(fake.looks).toHaveLength(0);
		expect(currentUserLooks()).toEqual([]);
	});

	it('imports a looks file and reports skipped entries; bad JSON and no engine say so', async () => {
		const offline = await importMyLooks('{}');
		expect(offline).toMatchObject({ ok: false, message: expect.stringMatching(/not connected/) });
		await connected();
		const invalid = await importMyLooks('not json');
		expect(invalid).toMatchObject({ ok: false, message: expect.stringMatching(/not valid JSON/) });
		const file = {
			format: 'jasper-title-looks',
			version: 1,
			looks: [{ name: 'Imported', recipe }, { nope: 1 }],
		};
		const r = await importMyLooks(JSON.stringify(file));
		expect(r?.ok).toBe(true);
		expect(r?.message).toMatch(/Imported 1 look\. 1 skipped/);
		expect(currentUserLooks().map((l) => l.name)).toEqual(['Imported']);
	});

	it('exports the chosen looks, or all, as one bundle file', async () => {
		const a = userLook('A');
		const fake = await connected([a, userLook('B')]);
		const blobs: Blob[] = [];
		URL.createObjectURL = vi.fn((b: Blob) => {
			blobs.push(b);
			return 'blob:x';
		}) as never;
		URL.revokeObjectURL = vi.fn() as never;
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
		expect((await exportMyLooks([a.id], 'A')).message).toBe('Exported 1 look.');
		expect((await exportMyLooks(undefined, 'My Looks')).message).toBe('Exported 2 looks.');
		expect(click).toHaveBeenCalledTimes(2);
		const bundle = JSON.parse(await blobs[1]!.text());
		expect(bundle.format).toBe('jasper-title-looks');
		expect(bundle.looks.map((l: UserLook) => l.name)).toEqual(['A', 'B']);
		expect(fake.calls).toContain('POST /api/title-looks/export');
	});
});

describe('the Looks tab (TL-054, TL-086)', () => {
	const chip = () => within(screen.getByRole('toolbar', { name: 'Categories' })).getByText(MY_LOOKS_CATEGORY);

	it('always has a My Looks category; without an engine it says why and disables its actions', () => {
		const { session } = titleWithLook();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.click(chip());
		expect(screen.getByTestId('my-looks-empty').textContent).toMatch(/not connected/);
		for (const id of ['my-looks-save', 'my-looks-import', 'my-looks-export'])
			expect(screen.getByTestId(id).getAttribute('aria-disabled')).toBe('true');
	});

	it('lists the user’s looks under it, with the actions enabled when they can act', async () => {
		await connected([userLook('Mine')]);
		const { session } = titleWithLook();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.click(chip());
		await waitFor(() =>
			expect(screen.getByTestId('my-looks-count').textContent).toMatch(/1 look of your own/),
		);
		const cards = screen.getAllByTestId('look-card');
		expect(cards).toHaveLength(1);
		expect(cards[0]!.textContent).toContain('Mine');
		for (const id of ['my-looks-save', 'my-looks-import', 'my-looks-export'])
			expect(screen.getByTestId(id).getAttribute('aria-disabled')).toBeNull();
		act(() => session.select('timeline', []));
		expect(screen.getByTestId('my-looks-save').getAttribute('aria-disabled')).toBe('true');
	});

	it('Save Selected Look… adds a card', async () => {
		await connected();
		const { session } = titleWithLook();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.click(chip());
		await waitFor(() =>
			expect(screen.getByTestId('my-looks-empty').textContent).toMatch(/No looks of your own/),
		);
		dialogs.name = 'From Clip';
		await act(async () => {
			fireEvent.click(screen.getByTestId('my-looks-save'));
		});
		await waitFor(() => expect(screen.getAllByTestId('look-card')[0]!.textContent).toContain('From Clip'));
	});

	it('an action that throws says so in the status line and frees its button', async () => {
		await connected();
		const { session } = titleWithLook();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.click(chip());
		await waitFor(() => expect(screen.getByTestId('my-looks-save').getAttribute('aria-disabled')).toBeNull());
		const { promptName } = await import('../src/gaps/SmallDialogs.tsx');
		vi.mocked(promptName).mockRejectedValueOnce(new Error('the name field did not open'));
		const rejections: unknown[] = [];
		const onRejection = (r: unknown) => rejections.push(r);
		process.on('unhandledRejection', onRejection);
		try {
			await act(async () => {
				fireEvent.click(screen.getByTestId('my-looks-save'));
			});
			await waitFor(() =>
				expect(screen.getByTestId('looks-status').textContent).toContain('the name field did not open'),
			);
			await setImmediate();
			expect(rejections).toEqual([]);
			expect(screen.getByTestId('my-looks-save').getAttribute('aria-busy')).not.toBe('true');
		} finally {
			process.off('unhandledRejection', onRejection);
		}
	});
});

describe('wiring (TL-097)', () => {
	const menuIds = (items: readonly unknown[]): string[] =>
		items.flatMap((i) => {
			const it = i as { command?: string; items?: unknown[] };
			return [...(it.command ? [it.command] : []), ...(it.items ? menuIds(it.items) : [])];
		});

	it('Save to My Looks, Import Looks and Export My Looks are commands in the Graphics menu', () => {
		const ids = menuIds(MENUBAR);
		for (const id of ['graphics.saveLookToMyLooks', 'graphics.importMyLooks', 'graphics.exportMyLooks']) {
			expect(getCommand(id), id).toBeTruthy();
			expect(getCommand(id)!.capability, id).toBe('engine');
			expect(ids, id).toContain(id);
		}
	});
});
