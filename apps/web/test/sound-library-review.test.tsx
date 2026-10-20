// Sound Library panel, review fixes (spec 12 §2.7): Recent keeps its order while auditioning, the virtualised list
// after a remount, the selected row always rendered (aria-activedescendant, aria-setsize / posinset), paging that drops
// stale pages and stops when a page adds nothing, the audition stopped on unmount / Esc / Program play, failed lookups
// not cached, Install Starter Kit starting the progress polling, the favourites limit, the Spanish UI (type labels in
// the search, no English left in the strings the panel builds) and the real reason of a refused insert for agents.
import type { SoundEntry, SoundSearchRequest, SoundSearchResponse } from '@jasper/api';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext } from '../src/commands/context.ts';
import { registerCommands, runCommand } from '../src/commands/registry.ts';
import { soundCommands } from '../src/commands/sound.ts';
import { setLanguage } from '../src/i18n/runtime.ts';
import { AuditionPlayer, auditionPlayer, setAuditionPlayer } from '../src/sound/audition.ts';
import { DEFAULT_FILTERS, licenseBadge, searchRequest, soundAccessibleName } from '../src/sound/model.ts';
import { MAX_FAVOURITES, soundLibraryPrefs } from '../src/sound/prefs.ts';
import { fakeSoundEngine, soundEntry, soundId } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => {
	const listeners = new Set<(e: { type: string }) => void>();
	const subscribe = (l: (e: { type: string }) => void) => {
		listeners.add(l);
		return () => listeners.delete(l);
	};
	return { client: null as unknown, status: 'connected', listeners, subscribe };
});
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: mocks.status, subscribe: mocks.subscribe }),
	useEngineOrNull: () => ({ client: mocks.client, status: mocks.status, subscribe: mocks.subscribe }),
}));
/** The engine's `sounds.changed` event (the library changed: the panel searches again with the same filters). */
const soundsChanged = () =>
	act(async () => {
		for (const l of [...mocks.listeners]) l({ type: 'sounds.changed' });
		await new Promise((r) => setTimeout(r, 20));
	});

const { SoundLibraryPanel, clearSoundEntryCache } = await import(
	'../src/panels/soundLibrary/SoundLibraryPanel.tsx'
);

const LIST_HEIGHT = 360;
let restoreHeight: (() => void) | null = null;
/** happy-dom has no layout: the listbox reports a height so the list virtualises. */
function listHasHeight() {
	const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get(this: HTMLElement) {
			return this.getAttribute('role') === 'listbox' ? LIST_HEIGHT : 0;
		},
	});
	restoreHeight = () => {
		if (desc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', desc);
		else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
	};
}

let played: string[] = [];
beforeAll(() => {
	registerCommands(soundCommands);
});
beforeEach(() => {
	localStorage.clear();
	soundLibraryPrefs.reload();
	clearSoundEntryCache();
	toasts.dismissAll();
	toasts.clearLog();
	played = [];
	const audio = {
		currentTime: 0,
		state: 'running',
		destination: {},
		resume: async () => {},
		close: async () => {},
		decodeAudioData: async () => ({ length: 1, numberOfChannels: 2 }),
		createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, onended: null }),
		createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1, setTargetAtTime() {} } }),
		createChannelSplitter: () => ({ connect() {}, disconnect() {} }),
		createAnalyser: () => ({ connect() {}, disconnect() {}, fftSize: 2048, getFloatTimeDomainData() {} }),
	};
	setAuditionPlayer(
		new AuditionPlayer({
			createContext: () => audio as never,
			fetchBytes: async (url) => {
				played.push(url);
				return new ArrayBuffer(4);
			},
			raf: () => 0,
			cancelRaf: () => {},
		}),
	);
});
afterEach(async () => {
	cleanup();
	closeAllDialogs();
	setAuditionPlayer(null);
	restoreHeight?.();
	restoreHeight = null;
	await setLanguage('en');
});
afterAll(() => setLanguage('en'));

function mount(entries: SoundEntry[], engine = fakeSoundEngine(entries)) {
	mocks.client = engine.client;
	const { session, seqId } = makeSession();
	const view = render(
		<SessionProvider session={session}>
			<SoundLibraryPanel instanceId="sl" visible />
			<DialogHost />
		</SessionProvider>,
	);
	return { engine, session, seqId, view };
}

const key = (el: Element, k: string, code: string) => fireEvent.keyDown(el, { key: k, code });

async function chooseOption(trigger: HTMLElement, name: string | RegExp) {
	await act(async () => {
		fireEvent.keyDown(trigger, { key: 'Enter' });
	});
	const option = await screen.findByRole('option', { name });
	await act(async () => {
		fireEvent.keyDown(option, { key: 'Enter' });
	});
}

async function search(q: string) {
	fireEvent.change(screen.getByTestId('sound-search'), { target: { value: q } });
	await act(async () => {
		await new Promise((r) => setTimeout(r, 200));
	});
}

const titled = (prefix: string, n: number, over: Partial<SoundEntry> = {}) =>
	Array.from({ length: n }, (_, i) => soundEntry({ title: `${prefix} ${i + 1}`, ...over }));

describe('Sound Library panel: review fixes', () => {
	it('Recent keeps its order while auditioning: with Auto-play, ↓ three times from A selects D', async () => {
		const entries = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((title) => soundEntry({ title }));
		soundLibraryPrefs.set({ recents: entries.map((e) => e.id), autoPlay: true });
		mount(entries);
		await screen.findAllByRole('option');
		await chooseOption(screen.getByRole('combobox', { name: 'Collection' }), 'Recent');
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		await waitFor(() =>
			expect(within(list).getAllByRole('option')[0]!.getAttribute('aria-label')).toMatch(/^Alpha/),
		);
		list.focus();
		for (let i = 0; i < 3; i++) {
			await act(async () => {
				key(list, 'ArrowDown', 'ArrowDown');
			});
		}
		await waitFor(() => expect(played).toHaveLength(3));
		const sel = within(list)
			.getAllByRole('option')
			.find((o) => o.getAttribute('aria-selected') === 'true')!;
		expect(sel.getAttribute('aria-label')).toMatch(/^Delta/);
		// the auditions were recorded in Recent (most recent first) without re-sorting the list on screen
		expect(soundLibraryPrefs.get().recents[0]).toBe(entries[3]!.id);
		expect(
			within(list)
				.getAllByRole('option')
				.map((o) => o.getAttribute('aria-label')!.split(',')[0]),
		).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
	});

	it('renders the rows of a list mounted again after an empty result (no stale scroll position)', async () => {
		listHasHeight();
		mount([...titled('Hit', 200), ...titled('Crackle', 12, { types: ['zap'] })]);
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		await within(list).findAllByRole('option');
		fireEvent.scroll(list, { target: { scrollTop: 3000 } });
		await search('nothingmatchesthis');
		await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Sounds' })).toBeNull());
		await search('crackle');
		const again = await screen.findByRole('listbox', { name: 'Sounds' });
		await waitFor(() => expect(within(again).getAllByRole('option')).toHaveLength(12));
	});

	it('renders the rows at the scroll position of a list that came back with the same filters', async () => {
		listHasHeight();
		const engine = fakeSoundEngine(titled('Hit', 200));
		const real = engine.client.searchSounds;
		let down = false;
		engine.client.searchSounds = async (req: SoundSearchRequest) => {
			if (down) throw new Error('engine restarting');
			return real(req);
		};
		mount([], engine);
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		await within(list).findAllByRole('option');
		fireEvent.scroll(list, { target: { scrollTop: 3000 } });
		await waitFor(() => expect(within(list).queryByRole('option', { name: /^Hit 5,/ })).toBeNull());
		down = true;
		await soundsChanged();
		await screen.findByText('The search failed');
		down = false;
		await soundsChanged();
		const again = await screen.findByRole('listbox', { name: 'Sounds' });
		// a new element scrolled to its top: its first rows are rendered, not those of the old scroll position
		await waitFor(() => expect(within(again).getByRole('option', { name: /^Hit 5,/ })).toBeTruthy());
	});

	it('always renders the selected row and gives every row its position in the whole result', async () => {
		listHasHeight();
		mount(titled('Hit', 200));
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		await within(list).findAllByRole('option');
		const selectedId = list.getAttribute('aria-activedescendant')!;
		expect(selectedId).toBeTruthy();
		fireEvent.scroll(list, { target: { scrollTop: 3000 } });
		await waitFor(() => expect(within(list).queryByRole('option', { name: /^Hit 50,/ })).toBeNull());
		const active = document.getElementById(list.getAttribute('aria-activedescendant')!);
		expect(active, 'the active descendant is rendered').not.toBeNull();
		expect(active!.getAttribute('aria-selected')).toBe('true');
		expect(active!.getAttribute('aria-posinset')).toBe('1');
		expect(active!.getAttribute('aria-setsize')).toBe('200');
		const row = within(list).getByRole('option', { name: /^Hit 90,/ });
		expect(row.getAttribute('aria-posinset')).toBe('90');
		expect(row.getAttribute('aria-setsize')).toBe('200');
	});

	it('drops a page of an older search, and stops paging when a page adds nothing', async () => {
		listHasHeight();
		const hits = titled('Hit', 250);
		const crackles = titled('Crackle', 12, { types: ['zap'] });
		const engine = fakeSoundEngine([...hits, ...crackles]);
		const real = engine.client.searchSounds;
		const held: { req: SoundSearchRequest; release: () => void }[] = [];
		let hold = true;
		engine.client.searchSounds = (req: SoundSearchRequest) => {
			if (!(req.offset && hold)) return real(req);
			return new Promise<SoundSearchResponse>((resolve) => {
				held.push({ req, release: () => void real(req).then(resolve) });
			});
		};
		mount([], engine);
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		await within(list).findAllByRole('option');
		fireEvent.scroll(list, { target: { scrollTop: 3300 } });
		await waitFor(() => expect(held).toHaveLength(1));
		expect(held[0]!.req.offset).toBe(100);
		await search('crackle');
		const again = await screen.findByRole('listbox', { name: 'Sounds' });
		await waitFor(() => expect(within(again).getAllByRole('option')).toHaveLength(12));
		await act(async () => {
			held[0]!.release();
			await new Promise((r) => setTimeout(r, 20));
		});
		const names = within(again)
			.getAllByRole('option')
			.map((o) => o.getAttribute('aria-label')!);
		expect(names).toHaveLength(12);
		expect(names.every((n) => n.startsWith('Crackle'))).toBe(true);

		// An engine whose total promises more than its pages hold: one extra request, then the list ends.
		cleanup();
		hold = false;
		const short = fakeSoundEngine(titled('Hit', 100));
		const pages: number[] = [];
		const realShort = short.client.searchSounds;
		short.client.searchSounds = async (req: SoundSearchRequest) => {
			pages.push(req.offset ?? 0);
			const r = await realShort({ ...req, offset: 0 });
			return { ...r, total: 300 };
		};
		mount([], short);
		const l2 = await screen.findByRole('listbox', { name: 'Sounds' });
		await within(l2).findAllByRole('option');
		fireEvent.scroll(l2, { target: { scrollTop: 3300 } });
		await act(async () => {
			await new Promise((r) => setTimeout(r, 100));
		});
		expect(pages.filter((o) => o > 0)).toEqual([100]);
	});

	it('stops the audition on Esc, when the Program starts playing, and when the panel closes (also a loop)', async () => {
		const { session, view } = mount([soundEntry({ title: 'Crunch' })]);
		const list = await screen.findByRole('listbox');
		await within(list).findAllByRole('option');
		list.focus();
		await act(async () => {
			key(list, ' ', 'Space');
		});
		await waitFor(() => expect(auditionPlayer().state.phase).toBe('playing'));
		await act(async () => {
			key(list, 'Escape', 'Escape');
		});
		expect(auditionPlayer().state.phase).toBe('idle');
		// plays alone: the Program pauses for an audition, and stops it when it plays
		session.transport.play();
		await act(async () => {
			key(list, ' ', 'Space');
		});
		await waitFor(() => expect(auditionPlayer().state.phase).toBe('playing'));
		expect(session.transport.getState().playing).toBe(false);
		act(() => session.transport.play());
		expect(auditionPlayer().state.phase).toBe('idle');
		// a looped audition stops with the panel
		soundLibraryPrefs.set({ loop: true });
		await act(async () => {
			key(list, ' ', 'Space');
		});
		await waitFor(() => expect(auditionPlayer().state).toMatchObject({ phase: 'playing', loop: true }));
		view.unmount();
		expect(auditionPlayer().state.phase).toBe('idle');
	});

	it('asks the engine again for a sound whose lookup failed (failures are not cached)', async () => {
		const a = soundEntry({ title: 'Alpha' });
		const engine = fakeSoundEngine([a]);
		let fail = true;
		const real = engine.client.getSound;
		engine.client.getSound = async (id: string) => {
			if (fail) throw new Error('engine busy');
			return real(id);
		};
		soundLibraryPrefs.set({ favourites: [a.id] });
		mount([], engine);
		await screen.findAllByRole('option');
		await chooseOption(screen.getByRole('combobox', { name: 'Collection' }), /^Favourites/);
		await screen.findByText(/no longer in the library/);
		fail = false;
		await chooseOption(screen.getByRole('combobox', { name: 'Collection' }), 'All sounds');
		await chooseOption(screen.getByRole('combobox', { name: 'Collection' }), /^Favourites/);
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
	});

	it('Install Starter Kit asks for the status again, so the indexing progress shows and polls', async () => {
		const engine = fakeSoundEngine([]);
		let indexing = false;
		let statusCalls = 0;
		const real = engine.client.soundLibraryStatus;
		engine.client.soundLibraryStatus = async () => {
			statusCalls++;
			const s = await real();
			return {
				...s,
				starter: { status: 'ok' as const, sounds: 60, errors: [] },
				indexing: indexing
					? ({ id: 'job1', kind: 'sound-index', state: 'running', progress: 0.5 } as never)
					: null,
			};
		};
		engine.client.indexSounds = async () => {
			indexing = true;
			return {} as never;
		};
		mount([], engine);
		const install = await screen.findByTestId('sound-install-starter');
		await waitFor(() => expect((install as HTMLButtonElement).disabled).toBe(false));
		const before = statusCalls;
		await act(async () => {
			fireEvent.click(install);
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(statusCalls).toBeGreaterThanOrEqual(before + 2);
		await waitFor(() => expect(screen.getByTestId('sound-status').textContent).toContain('Indexing 50 %'));
	});

	it('refuses the 501st favourite with a message instead of dropping the oldest', async () => {
		const ids = Array.from({ length: MAX_FAVOURITES }, (_, i) => soundId(10_000 + i));
		soundLibraryPrefs.set({ favourites: ids });
		expect(soundLibraryPrefs.toggleFavourite(soundId(99_999))).toBe('full');
		expect(soundLibraryPrefs.get().favourites).toEqual(ids);
		// unstarring still works
		expect(soundLibraryPrefs.toggleFavourite(ids[0]!)).toBe(false);
		soundLibraryPrefs.set({ favourites: ids });
		const e = soundEntry({ title: 'Crunch' });
		mount([e]);
		const list = await screen.findByRole('listbox');
		await within(list).findAllByRole('option');
		list.focus();
		await act(async () => {
			key(list, 'f', 'KeyF');
		});
		expect(soundLibraryPrefs.get().favourites).toEqual(ids);
		expect(toasts.getState().log.some((x) => /Favourites are full/.test(x.title))).toBe(true);
	});

	it('sound.insertAtPlayhead gives agents the real reason of a refusal', async () => {
		const e = soundEntry({ title: 'Crunch' });
		const engine = fakeSoundEngine([e]);
		engine.client.registerSound = async () => {
			throw new Error('disk full');
		};
		const { session } = makeSession();
		const ctx = createCommandContext({
			engine: engine.client as never,
			session,
			capabilities: ['engine'],
			toast: () => {},
		});
		const r = await runCommand('sound.insertAtPlayhead', ctx, { soundId: e.id });
		expect(r.ran).toBe(false);
		expect((r as { error?: Error }).error?.message).toBe('Could not add the sound: disk full');
	});
});

describe('Sound Library in Spanish', () => {
	it('sends a translated type label of the search as its type id ("golpe" → hit)', async () => {
		await setLanguage('es');
		expect(searchRequest({ ...DEFAULT_FILTERS, query: 'golpe' }, { limit: 10, offset: 0 }).q).toBe('hit');
		expect(searchRequest({ ...DEFAULT_FILTERS, query: 'Golpe sordo' }, { limit: 10, offset: 0 }).q).toBe(
			'thump',
		);
		expect(searchRequest({ ...DEFAULT_FILTERS, query: 'transicion' }, { limit: 10, offset: 0 }).q).toBe(
			'transition',
		);
		expect(searchRequest({ ...DEFAULT_FILTERS, query: 'golpes' }, { limit: 10, offset: 0 }).q).toBe('golpes');
		const { engine } = mount([soundEntry({ title: 'Crunch' })]);
		await screen.findAllByRole('option');
		await search('golpe');
		await waitFor(() => expect(engine.calls.search.at(-1)!.q).toBe('hit'));
		const list = await screen.findByRole('listbox');
		expect(within(list).getAllByRole('option')).toHaveLength(1);
		await setLanguage('en');
		expect(searchRequest({ ...DEFAULT_FILTERS, query: 'golpe' }, { limit: 10, offset: 0 }).q).toBe('golpe');
	});

	it('shows no English in the texts the panel builds (badges, names, status, announcements)', async () => {
		await setLanguage('es');
		const entries = [
			soundEntry({ title: 'Crunch', license: 'LicenseRef-JasperEditor' }),
			soundEntry({
				title: 'Zing',
				license: 'LicenseRef-JasperEditor',
				source: { type: 'synth', recipe: 'zap', seed: 1 } as never,
			}),
			soundEntry({ title: 'Mit', license: 'MIT' }),
			soundEntry({
				title: 'Mine',
				license: 'LicenseRef-UserRoyaltyFree',
				source: { type: 'folder', rootId: 'r1', relPath: 'a.wav' } as never,
			}),
		];
		soundLibraryPrefs.set({ favourites: [entries[0]!.id] });
		mount(entries);
		const list = await screen.findByRole('listbox');
		await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(4));
		list.focus();
		await act(async () => {
			key(list, ' ', 'Space');
		});
		await waitFor(() => expect(screen.getByTestId('sound-live').textContent).toMatch(/Crunch/));
		const badges = [...document.querySelectorAll('[data-license-badge]')].map((b) => b.textContent);
		const names = within(list)
			.getAllByRole('option')
			.map((o) => o.getAttribute('aria-label')!);
		const status = screen.getByTestId('sound-status').textContent!;
		const live = screen.getByTestId('sound-live').textContent!;
		const shown = [...badges, ...names, status, live].join('\n');
		expect(badges).toEqual(expect.arrayContaining(['Sintetizado', 'Abierta', 'Suyo']));
		for (const english of [
			/\bSynth\b/,
			/\bYours\??/,
			/\bOpen\b/,
			/\bfavourite\b/,
			/\bPlaying\b/,
			/\bsounds\b/,
		])
			expect(shown, String(english)).not.toMatch(english);
		await act(async () => {
			key(list, 'Escape', 'Escape');
		});
		expect(screen.getByTestId('sound-live').textContent).not.toMatch(/Audition stopped/);
		// the badges of classes the default filter hides, and the accessible name of a favourite
		const userProvided = soundEntry({ license: 'LicenseRef-UserProvided' });
		expect(licenseBadge(userProvided).text).not.toMatch(/Yours/);
		expect(soundAccessibleName(entries[0]!, true)).not.toMatch(/favourite/);
	});
});
