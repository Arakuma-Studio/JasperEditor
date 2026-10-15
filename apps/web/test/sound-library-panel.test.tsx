// Sound Library panel (spec 12 §2.7, P1-R7): results as an accessible listbox, type chips with facet counts, keyboard
// operation through the panel's keymap scope (arrows, Space audition, Enter insert peak-aligned, F favourite, L loop,
// Ctrl+F search), Refine and licence filters reaching the engine search, the empty state, and the credits dialog.
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCommands } from '../src/commands/registry.ts';
import { soundCommands } from '../src/commands/sound.ts';
import { AuditionPlayer, setAuditionPlayer } from '../src/sound/audition.ts';
import { SOUND_CREDITS_DIALOG } from '../src/sound/dialogs.tsx';
import { soundLibraryPrefs } from '../src/sound/prefs.ts';
import { fakeSoundEngine, soundEntry } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({ client: null as unknown, status: 'connected' }));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
	useEngineOrNull: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
}));

const { SoundLibraryPanel } = await import('../src/panels/soundLibrary/SoundLibraryPanel.tsx');

let played: string[] = [];
beforeAll(() => {
	registerCommands(soundCommands);
});
beforeEach(() => {
	localStorage.clear();
	soundLibraryPrefs.reload();
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
afterEach(() => {
	cleanup();
	closeAllDialogs();
	setAuditionPlayer(null);
});

function mount(
	entries = [
		soundEntry({ title: 'Crunch', peakSec: 0.2325, durationSec: 1.3 }),
		soundEntry({ title: 'Swoosh', types: ['whoosh'] }),
	],
) {
	const engine = fakeSoundEngine(entries);
	mocks.client = engine.client;
	const { session, seqId } = makeSession();
	session.transport.seek(45);
	render(
		<SessionProvider session={session}>
			<SoundLibraryPanel instanceId="sl" visible />
			<DialogHost />
		</SessionProvider>,
	);
	return { engine, session, seqId, entries };
}

const key = (el: Element, k: string, code: string, extra: Partial<KeyboardEventInit> = {}) =>
	fireEvent.keyDown(el, { key: k, code, ...extra });

describe('SoundLibraryPanel', () => {
	it('lists results as a listbox with descriptor-rich names, type chips with counts and a status line', async () => {
		mount();
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		const options = await within(list).findAllByRole('option');
		expect(options).toHaveLength(2);
		const crunch = options.find((o) => o.getAttribute('aria-label')!.startsWith('Crunch'))!;
		expect(crunch.getAttribute('aria-label')).toMatch(
			/^Crunch, Hit, 1\.3 s, peak at 233 ms, punchy, dark, heavy/,
		);
		expect(options[0]!.getAttribute('aria-selected')).toBe('true');
		expect(document.querySelector('[data-type-chip="hit"]')!.textContent).toContain('1');
		expect(document.querySelector('[data-type-chip="whoosh"]')).toBeTruthy();
		expect(screen.getByTestId('sound-status').textContent).toContain('2 sounds');
		expect(document.querySelector('[data-license-badge="CC0"]')).toBeTruthy();
	});

	it('is operated by keyboard: arrows select, Space auditions (aria-live), F stars, L loops, Enter inserts peak-aligned', async () => {
		const { session, seqId, engine } = mount();
		const list = await screen.findByRole('listbox');
		await within(list).findAllByRole('option');
		list.focus();
		key(list, 'ArrowDown', 'ArrowDown');
		await waitFor(() =>
			expect(within(list).getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true'),
		);
		expect(list.getAttribute('aria-activedescendant')).toBe(within(list).getAllByRole('option')[1]!.id);
		key(list, 'ArrowUp', 'ArrowUp');
		await waitFor(() =>
			expect(within(list).getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true'),
		);
		fireEvent.click(within(list).getByRole('option', { name: /^Crunch/ }));
		await waitFor(() =>
			expect(
				within(list)
					.getByRole('option', { name: /^Crunch/ })
					.getAttribute('aria-selected'),
			).toBe('true'),
		);
		await act(async () => {
			key(list, ' ', 'Space');
		});
		await waitFor(() => expect(screen.getByTestId('sound-live').textContent).toBe('Playing Crunch'));
		expect(played).toHaveLength(1);
		expect(session.getState().history.entries).toHaveLength(0);
		key(list, 'f', 'KeyF');
		await waitFor(() => expect(soundLibraryPrefs.get().favourites).toHaveLength(1));
		key(list, 'l', 'KeyL');
		expect(soundLibraryPrefs.get().loop).toBe(true);
		await act(async () => {
			key(list, 'Enter', 'Enter');
		});
		await waitFor(() => expect(Object.keys(session.getCommitted().sequences[seqId]!.clips)).toHaveLength(1));
		const clip = Object.values(session.getCommitted().sequences[seqId]!.clips)[0]!;
		// peak 0.2325 s = 6.98 frames at 30 fps: the clip starts 6 frames before the playhead (≤ 1 frame late)
		expect(clip.start).toBe(45 - 6);
		expect(engine.calls.register).toHaveLength(1);
		expect(session.getState().history.entries).toHaveLength(1);
	});

	it('sends type chips, Refine pills and the licence filter to the engine search; Ctrl+F focuses the search', async () => {
		const { engine } = mount();
		await screen.findAllByRole('option');
		fireEvent.click(document.querySelector('[data-type-chip="whoosh"]')!);
		await waitFor(() => expect(engine.calls.search.at(-1)!.types).toEqual(['whoosh']));
		fireEvent.click(screen.getByTestId('sound-refine-toggle'));
		fireEvent.click(document.querySelector('[data-refine="length:short"]')!);
		await waitFor(() => expect(engine.calls.search.at(-1)!.length).toBe('short'));
		expect(engine.calls.search.at(-1)!.license).toBe('commercial-safe');
		fireEvent.click(screen.getByTestId('sound-commercial-safe'));
		await waitFor(() => expect(engine.calls.search.at(-1)!.license).toBe('any'));
		const panel = document.querySelector('[data-panel-kind="soundLibrary"]')!;
		key(screen.getByRole('button', { name: 'Clear filters' }), 'f', 'KeyF', { ctrlKey: true });
		expect(document.activeElement).toBe(screen.getByTestId('sound-search'));
		expect(panel).toBeTruthy();
	});

	it('shows the empty state with Install Starter Kit and Add a Folder…', async () => {
		mount([]);
		await screen.findByTestId('sound-empty');
		expect(screen.getByText('No sounds yet')).toBeTruthy();
		expect(screen.getByTestId('sound-install-starter')).toBeTruthy();
		expect(screen.getByTestId('sound-add-folder')).toBeTruthy();
	});

	it('exports credits of the sounds the sequence uses (all / attribution only; md, txt, csv)', async () => {
		const by = soundEntry({ title: 'Whoosh BY', types: ['whoosh'], license: 'CC-BY-4.0', author: 'Ann' });
		const { session, seqId } = mount([soundEntry({ title: 'Crunch' }), by]);
		const list = await screen.findByRole('listbox');
		const opts = await within(list).findAllByRole('option');
		// insert both (double-click)
		await act(async () => {
			fireEvent.doubleClick(opts[0]!);
		});
		await waitFor(() => expect(Object.keys(session.getCommitted().sequences[seqId]!.clips)).toHaveLength(1));
		await act(async () => {
			fireEvent.doubleClick(within(list).getAllByRole('option')[1]!);
		});
		await waitFor(() => expect(Object.keys(session.getCommitted().sequences[seqId]!.clips)).toHaveLength(2));
		await act(async () => {
			void openDialog(SOUND_CREDITS_DIALOG, { session, sequenceId: seqId });
		});
		const preview = (await screen.findByTestId('sound-credits-preview')) as HTMLTextAreaElement;
		expect(preview.value).toContain('## Sound credits');
		expect(preview.value).toContain('Whoosh BY');
		expect(preview.value).toContain('Crunch');
	});
});
