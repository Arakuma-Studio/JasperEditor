// Takes in the Sound Library panel (spec 12 P6-E9) and the Material Refine pill (P6-E10): a multi-hit recording's row
// has a disclosure listing its clean takes as rows of their own (→ opens, ← closes, by mouse too); a take auditions its
// own audio, inserts its own copy and drags like any sound; a cut take is never listed. Material pills show the
// materials the results name and reach the engine search.
import type { SoundEntry, SoundTake } from '@jasper/api';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCommands } from '../src/commands/registry.ts';
import { soundCommands } from '../src/commands/sound.ts';
import { AuditionPlayer } from '../src/sound/audition.ts';
import { soundLibraryPrefs } from '../src/sound/prefs.ts';
import { fakeSoundEngine, mockAuditionPlayer, soundEntry } from './sound-helpers.ts';
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
let restoreAudition = () => {};
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
	restoreAudition = mockAuditionPlayer(
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
	restoreAudition();
});

function take(rec: SoundEntry, index: number, flags: SoundTake['flags'] = []): SoundTake {
	return {
		index,
		startSec: 0.2 + index * 0.5,
		endSec: 0.36 + index * 0.5,
		headDb: -40,
		tailDb: -45,
		flags,
		strokes: 2,
		descriptors: {
			...rec.descriptors,
			durationSec: 0.16,
			peakSec: 0.006,
			onsetSec: 0.005,
			headQuietSec: 0.004,
		},
		judge: { ok: true, score: 1, reasons: [], type: 'key' },
	};
}

function mount() {
	const rec = soundEntry({
		title: 'Keyboard typing run',
		types: ['key'],
		durationSec: 4.6,
		judge: { ok: false, score: 0.3, reasons: ['too-long', 'multi-hit'], type: 'key' },
	});
	rec.takes = [take(rec, 1), take(rec, 2), take(rec, 3), take(rec, 4, ['tail-cut'])];
	const wood = soundEntry({ title: 'Wooden block hit', materials: ['wood'] });
	const engine = fakeSoundEngine([rec, wood]);
	mocks.client = engine.client;
	const { session, seqId } = makeSession();
	session.transport.seek(45);
	render(
		<SessionProvider session={session}>
			<SoundLibraryPanel instanceId="sl" visible />
			<DialogHost />
		</SessionProvider>,
	);
	return { engine, session, seqId, rec };
}

const key = (el: Element, k: string, code: string) => fireEvent.keyDown(el, { key: k, code });
const selectedOption = (list: HTMLElement) =>
	within(list)
		.getAllByRole('option')
		.find((o) => o.getAttribute('aria-selected') === 'true');

describe('Sound Library takes', () => {
	it('a recording row shows its clean takes; → opens and moves into them, ← goes back and closes', async () => {
		const { rec } = mount();
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		await within(list).findAllByRole('option');
		const toggle = document.querySelector(`[data-takes-toggle="${rec.id}"]`)!;
		expect(toggle.textContent).toContain('3 takes');
		const recRow = within(list).getByRole('option', { name: /^Keyboard typing run/ });
		expect(recRow.getAttribute('aria-label')).toContain('3 takes (→ shows them)');
		list.focus();
		fireEvent.click(recRow);
		key(list, 'ArrowRight', 'ArrowRight');
		await waitFor(() => expect(document.querySelectorAll('[data-take]')).toHaveLength(3));
		expect([...document.querySelectorAll('[data-take]')].map((r) => r.getAttribute('data-take'))).toEqual([
			'1',
			'2',
			'3',
		]);
		expect(document.querySelector(`[data-sound-id="${rec.id}~t4"]`)).toBeNull();
		expect(recRow.getAttribute('aria-label')).toContain('3 takes shown below');
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		key(list, 'ArrowRight', 'ArrowRight');
		await waitFor(() => expect(selectedOption(list)!.getAttribute('data-sound-id')).toBe(`${rec.id}~t1`));
		expect(selectedOption(list)!.textContent).toContain('Take 1');
		expect(selectedOption(list)!.getAttribute('aria-label')).toContain('take 1 of its recording');
		key(list, 'ArrowDown', 'ArrowDown');
		await waitFor(() => expect(selectedOption(list)!.getAttribute('data-sound-id')).toBe(`${rec.id}~t2`));
		key(list, 'ArrowLeft', 'ArrowLeft');
		await waitFor(() => expect(selectedOption(list)!.getAttribute('data-sound-id')).toBe(rec.id));
		key(list, 'ArrowLeft', 'ArrowLeft');
		await waitFor(() => expect(document.querySelectorAll('[data-take]')).toHaveLength(0));
		// the mouse opens it too
		fireEvent.click(toggle);
		await waitFor(() => expect(document.querySelectorAll('[data-take]')).toHaveLength(3));
	});

	it('a take auditions its own audio and inserts its own copy (one undo step)', async () => {
		const { rec, engine, session, seqId } = mount();
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		await within(list).findAllByRole('option');
		fireEvent.click(document.querySelector(`[data-takes-toggle="${rec.id}"]`)!);
		await waitFor(() => expect(document.querySelectorAll('[data-take]')).toHaveLength(3));
		const t2 = document.querySelector(`[data-sound-id="${rec.id}~t2"]`)!;
		fireEvent.click(t2);
		list.focus();
		await act(async () => {
			key(list, ' ', 'Space');
		});
		await waitFor(() => expect(played.at(-1)).toBe(`/api/sounds/${rec.id}~t2/audio`));
		await act(async () => {
			key(list, 'Enter', 'Enter');
		});
		await waitFor(() => expect(Object.keys(session.getCommitted().sequences[seqId]!.clips)).toHaveLength(1));
		expect(engine.calls.register).toEqual([`${rec.id}~t2`]);
		expect(session.getState().history.entries).toHaveLength(1);
	});

	it('Material pills list the materials the results name and reach the engine search', async () => {
		const { engine } = mount();
		await screen.findByRole('listbox', { name: 'Sounds' });
		fireEvent.click(screen.getByTestId('sound-refine-toggle'));
		const pill = await waitFor(() => {
			const el = document.querySelector('[data-refine="material:wood"]');
			if (!el) throw new Error('no pill');
			return el;
		});
		expect(pill.textContent).toContain('Wood');
		expect(pill.textContent).toContain('1');
		expect(document.querySelector('[data-refine="material:glass"]')).toBeNull();
		fireEvent.click(pill);
		await waitFor(() => expect(engine.calls.search.at(-1)?.material).toBe('wood'));
		const list = await screen.findByRole('listbox', { name: 'Sounds' });
		await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
	});
});
