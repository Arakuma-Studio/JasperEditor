// Phase 2 verification (spec 12 §2.7 "Audition", P2-R7): the In Context audition never changes the document or
// History and always ends — and gives back the gesture slot and the playhead — on every exit path: the keys that
// toggle it in the Sound Library (Shift+Space / Space stop it, Esc stops it without leaving Fill mode), another
// audition or swap window replacing it, the session closing, the sequence switching, an agent transaction arriving,
// the Program never playing (no player attached), an error while it starts, and the panel closing.
import type { SoundEntry } from '@jasper/api';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBridge } from '../src/agent-bridge/bridge.ts';
import {
	type CommandCtx,
	createCommandContext,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { __setCatalogForTests } from '../src/i18n/runtime.ts';
import { installKeyboardDispatcher } from '../src/shell/keymap/dispatcher.ts';
import { AuditionPlayer, setAuditionPlayer } from '../src/sound/audition.ts';
import {
	cancelLibraryMode,
	clipSoundTarget,
	cueFillTarget,
	requestClipTarget,
	requestCueFill,
} from '../src/sound/controller.ts';
import { fillCueWithSound } from '../src/sound/fill.ts';
import { auditionInContext, inContextStore, stopInContext } from '../src/sound/in-context.ts';
import { soundLibraryPrefs } from '../src/sound/prefs.ts';
import { cycleVariation, resetVariationRun } from '../src/sound/swap.ts';
import { fakeSoundEngine, soundEntry } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({ client: null as unknown, status: 'connected' }));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
	useEngineOrNull: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
	createEditorEngineClient: () => mocks.client,
}));

const { SoundLibraryPanel } = await import('../src/panels/soundLibrary/SoundLibraryPanel.tsx');

beforeAll(() => registerAllCommands());
beforeEach(() => {
	localStorage.clear();
	soundLibraryPrefs.reload();
	soundLibraryPrefs.set({ auditionOnSwap: false, inContext: false, preRollSec: 2 });
	setAuditionPlayer(
		new AuditionPlayer({
			createContext: () => null,
			fetchBytes: async () => new ArrayBuffer(4),
			raf: () => 0,
			cancelRaf: () => {},
		}),
	);
});
afterEach(() => {
	vi.useRealTimers();
	cleanup();
	closeAllDialogs();
	stopInContext({ returnToAnchor: false });
	cancelLibraryMode();
	requestCueFill(null);
	resetVariationRun();
	setAuditionPlayer(null);
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function entries(): SoundEntry[] {
	return [
		soundEntry({ title: 'Crunch', peakSec: 0.25, durationSec: 1 }),
		soundEntry({ title: 'Thud', peakSec: 0.2, durationSec: 0.8 }),
		soundEntry({ title: 'Smack', peakSec: 0.3, durationSec: 1.1 }),
	];
}

function harness() {
	const list = entries();
	const { session, seqId } = makeSession();
	const fake = fakeSoundEngine(list);
	mocks.client = fake.client;
	const toasts: ToastRequest[] = [];
	const ctx: CommandCtx = createCommandContext({
		engine: fake.client as never,
		session,
		focus: { panel: 'timeline', instanceId: 'x' },
		capabilities: ['engine'],
		toast: (r) => toasts.push(r),
	});
	const apply = (commands: unknown[]) => {
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const addCue = (frame: number) =>
		(
			apply([
				{
					type: 'soundCue.add',
					cues: [{ frame, kind: 'land', weight: 'hero', types: ['hit'], source: 'user' }],
				},
			]).results[0] as { cueIds: string[] }
		).cueIds[0]!;
	const labels = () => session.getState().history.entries.map((e) => e.label);
	return { list, session, seqId, fake, engine: fake.client as never, ctx, toasts, apply, addCue, labels };
}

/** A registerSound that waits until `release()` (the engine is slow). */
function slowRegister(h: ReturnType<typeof harness>) {
	const original = h.fake.client.registerSound;
	let release: () => void = () => undefined;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	h.fake.client.registerSound = async (id: string) => {
		await gate;
		return original(id);
	};
	return () => release();
}

describe('In Context: the playhead and the gesture come back', () => {
	it('an audition replacing another one anchors on the original playhead and returns there', async () => {
		const h = harness();
		h.session.transport.seek(100);
		expect((await auditionInContext(h.session, h.engine, h.list[0]!)).ok).toBe(true);
		expect(h.session.transport.getState().frame).toBe(40); // 2 s pre-roll
		h.session.transport.reportFrame(70); // the Program plays on
		// a second candidate (hover in Fill With ▸ / the Library with In Context on: no key or pointer press)
		expect((await auditionInContext(h.session, h.engine, h.list[1]!)).ok).toBe(true);
		expect(h.session.transport.getState().frame).toBe(40);
		stopInContext();
		expect(h.session.transport.getState().frame).toBe(100);
		expect(h.session.gestureActive).toBe(false);
	});

	it('variation presses that arrive while a step registers: the swap window returns to where the playhead was', async () => {
		const h = harness();
		soundLibraryPrefs.set({ auditionOnSwap: true });
		const cueId = h.addCue(90);
		const r = await fillCueWithSound(h.session, h.engine, h.list[0]!, {
			sequenceId: h.seqId,
			cueId,
			alternatives: h.list.slice(1).map((e) => e.id),
		});
		h.session.select('timeline', [r.clipId], 'replace');
		h.session.transport.seek(10);
		const n = h.labels().length;
		// two presses before the first step has registered its sound: summed into a second step
		const first = cycleVariation(h.session, h.engine, 1, () => undefined);
		const second = cycleVariation(h.session, h.engine, 1, () => undefined);
		await Promise.all([first, second]);
		expect(h.labels()).toHaveLength(n + 1);
		expect(h.labels().at(-1)).toBe('Swap Sound ×2');
		expect(inContextStore.getState().active).toBe(true);
		stopInContext();
		expect(h.session.transport.getState().frame).toBe(10);
	});

	it('closing the project ends the audition (no "Auditioning" chip left for the next project)', async () => {
		const h = harness();
		expect((await auditionInContext(h.session, h.engine, h.list[0]!)).ok).toBe(true);
		expect(inContextStore.getState().active).toBe(true);
		await h.session.close();
		expect(inContextStore.getState()).toMatchObject({ active: false, loading: false });
	});

	it('an audition still registering when the project closes never starts', async () => {
		const h = harness();
		const release = slowRegister(h);
		const p = auditionInContext(h.session, h.engine, h.list[0]!);
		expect(inContextStore.getState().loading).toBe(true);
		await h.session.close();
		expect(inContextStore.getState().loading).toBe(false);
		release();
		const r = await p;
		expect(r.ok).toBe(false);
		expect(inContextStore.getState()).toMatchObject({ active: false, loading: false });
		expect(h.session.gestureActive).toBe(false);
		expect(h.session.transport.getState().playing).toBe(false);
	});

	it('switching to another sequence ends the audition', async () => {
		const h = harness();
		const other = (
			h.session.apply({
				label: 'seq',
				origin: 'user',
				commands: [{ type: 'sequence.create', name: 'Other', preset: 'hd-1080p-30', ref: '$s' } as never],
			}) as { refs: Record<string, string> }
		).refs.$s!;
		expect((await auditionInContext(h.session, h.engine, h.list[0]!)).ok).toBe(true);
		h.session.openSequence(other);
		expect(inContextStore.getState().active).toBe(false);
		expect(h.session.gestureActive).toBe(false);
		expect(h.session.getState().transient).toBeNull();
	});

	it('an agent transaction arriving ends the audition and applies at once (not queued behind it)', async () => {
		const h = harness();
		const bridge = new AgentBridge(h.session, null).start();
		try {
			expect((await auditionInContext(h.session, h.engine, h.list[0]!)).ok).toBe(true);
			const before = h.labels().length;
			const p = bridge.api().transact({
				label: 'Marker',
				origin: { agent: 'bot' },
				commands: [{ type: 'marker.add', frame: 3 }],
			});
			const settled = await Promise.race([p.then(() => 'done'), tick().then(() => 'queued')]);
			expect(settled).toBe('done');
			expect((await p).ok).toBe(true);
			expect(inContextStore.getState().active).toBe(false);
			expect(h.session.gestureActive).toBe(false);
			// only the agent's entry: the audition left nothing behind
			expect(h.labels()).toHaveLength(before + 1);
			expect(h.labels().at(-1)).toBe('Agent: Marker');
		} finally {
			bridge.dispose();
		}
	});

	it('with no Program playing it (no player moves the frames) the audition still ends after its window', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const h = harness();
		const doc = h.session.getCommitted();
		h.session.transport.seek(100);
		expect((await auditionInContext(h.session, h.engine, h.list[0]!)).ok).toBe(true);
		expect(h.session.gestureActive).toBe(true);
		// the frames never move: well past the window (2 s pre-roll + 1 s sound + 1 s) it gives the gesture back
		vi.advanceTimersByTime(30_000);
		expect(inContextStore.getState().active).toBe(false);
		expect(h.session.gestureActive).toBe(false);
		expect(h.session.transport.getState()).toMatchObject({ playing: false, frame: 100 });
		expect(h.session.getCommitted()).toBe(doc);
	});

	it('a Program player that throws when asked to play: an error result, the gesture cancelled, nothing stuck', async () => {
		const h = harness();
		const doc = h.session.getCommitted();
		h.session.transport.attachPlayer({
			seekTo: () => undefined,
			play: () => {
				throw new Error('audio device lost');
			},
			pause: () => undefined,
		});
		const r = await auditionInContext(h.session, h.engine, h.list[0]!);
		expect(r).toMatchObject({ ok: false, message: 'audio device lost' });
		expect(h.session.gestureActive).toBe(false);
		expect(h.session.getState().transient).toBeNull();
		expect(h.session.getCommitted()).toBe(doc);
		expect(inContextStore.getState()).toMatchObject({ active: false, loading: false });
	});

	it('a superseded audition is not reported as a failure (agents and toasts)', async () => {
		const h = harness();
		const release = slowRegister(h);
		const a = runCommand('soundLibrary.auditionInContext', h.ctx, { soundId: h.list[0]!.id });
		await tick();
		const b = runCommand('soundLibrary.auditionInContext', h.ctx, { soundId: h.list[1]!.id });
		await tick();
		release();
		expect((await a).ran).toBe(true);
		expect((await b).ran).toBe(true);
		expect(h.toasts.filter((t) => t.kind === 'error' || t.kind === 'warning')).toEqual([]);
		expect(inContextStore.getState()).toMatchObject({ active: true, soundId: h.list[1]!.id });
	});
});

describe('In Context in the Sound Library: keys toggle it', () => {
	function mount(h: ReturnType<typeof harness>) {
		render(
			<SessionProvider session={h.session}>
				<SoundLibraryPanel instanceId="sl" visible />
				<DialogHost />
			</SessionProvider>,
		);
	}
	const key = (el: Element, k: string, code: string, extra: Partial<KeyboardEventInit> = {}) =>
		fireEvent.keyDown(el, { key: k, code, ...extra });

	async function playing(h: ReturnType<typeof harness>) {
		mount(h);
		const list = await screen.findByRole('listbox');
		await within(list).findAllByRole('option');
		list.focus();
		fireEvent.click(within(list).getAllByRole('option')[0]!);
		key(list, ' ', 'Space', { shiftKey: true });
		await waitFor(() => expect(inContextStore.getState().active).toBe(true));
		await tick(); // the audition listens for the next key from here
		return list;
	}

	it('Shift+Space while it plays stops it (and does not start it again)', async () => {
		const h = harness();
		h.session.transport.seek(100);
		const list = await playing(h);
		key(list, ' ', 'Space', { shiftKey: true });
		await tick();
		await tick();
		expect(inContextStore.getState()).toMatchObject({ active: false, loading: false });
		expect(h.session.gestureActive).toBe(false);
		expect(h.session.transport.getState()).toMatchObject({ playing: false, frame: 100 });
	});

	it('Space with "In Context by default" on stops it too', async () => {
		const h = harness();
		soundLibraryPrefs.set({ inContext: true });
		const list = await playing(h);
		key(list, ' ', 'Space');
		await tick();
		await tick();
		expect(inContextStore.getState()).toMatchObject({ active: false, loading: false });
	});

	it('Esc stops it and stays in Fill mode (a second Esc leaves the mode)', async () => {
		const h = harness();
		const cueId = h.addCue(90);
		requestCueFill({ sequenceId: h.seqId, cueId, types: ['hit'], label: 'Hero Land cue at 00:00:03:00' });
		const list = await playing(h);
		key(list, 'Escape', 'Escape');
		await tick();
		expect(inContextStore.getState().active).toBe(false);
		expect(cueFillTarget()?.cueId).toBe(cueId);
		key(list, 'Escape', 'Escape');
		await waitFor(() => expect(cueFillTarget()).toBeNull());
	});

	it('closing the panel ends an audition it started', async () => {
		const h = harness();
		await playing(h);
		cleanup();
		expect(inContextStore.getState().active).toBe(false);
		expect(h.session.gestureActive).toBe(false);
	});
});

describe('Fill With ▸ hover auditions on the cue whose menu it is', () => {
	it('with several cues selected (another one last) and Fill mode on a third cue', async () => {
		const { cueMenuExtensions } = await import('../src/extensions/index.ts');
		const { alignedFrameOf } = await import('../src/sound/design-model.ts');
		const h = harness();
		soundLibraryPrefs.set({ inContext: true });
		const a = h.addCue(90);
		const b = h.addCue(200);
		const c = h.addCue(300);
		h.session.select('cues', [a, b], 'replace');
		requestCueFill({ sequenceId: h.seqId, cueId: c, types: ['hit'], label: 'c' });
		const items = cueMenuExtensions.list().flatMap((e) =>
			e.items({
				session: h.session,
				sequenceId: h.seqId,
				cueId: a,
				selection: [a, b],
				runCommand: () => {},
			}),
		);
		const fillWith = items.find((i) => i.kind === 'submenu' && i.label === 'Fill With') as {
			load(): Promise<{ onHighlight(): void; onUnhighlight(): void }[]>;
		};
		const loaded = await fillWith.load();
		loaded[0]!.onHighlight();
		await waitFor(() => expect(inContextStore.getState().active).toBe(true), { timeout: 2000 });
		const st = h.session.getState();
		const drawn = st.transient!.sequences[h.seqId]!;
		const placed = Object.values(drawn.clips).find((x) => x.kind === 'audio')!;
		expect(Math.floor(alignedFrameOf(st.transient!, drawn, placed)!)).toBe(90);
		loaded[0]!.onUnhighlight();
		expect(h.session.transport.getState().frame).toBe(90);
	});
});

describe('Sound Library row menu in Spanish', () => {
	it('the Enter entry names its action in the language of the UI ("Insert at Playhead" too)', async () => {
		const h = harness();
		__setCatalogForTests('es', {
			'Insert at Playhead': 'Insertar en el cabezal',
			'Fill Cue': 'Rellenar señal',
		});
		try {
			render(
				<SessionProvider session={h.session}>
					<SoundLibraryPanel instanceId="sl" visible />
				</SessionProvider>,
			);
			const list = await screen.findByRole('listbox');
			const option = (await within(list).findAllByRole('option'))[0]!;
			act(() => {
				fireEvent.contextMenu(option);
			});
			expect(screen.getByRole('menuitem', { name: /Insertar en el cabezal/ })).toBeTruthy();
		} finally {
			__setCatalogForTests('en', null);
		}
	});
});

describe('In Context: more exit paths and races (gap tests)', () => {
	it('the user stopping the transport ends it and returns to the anchor; nothing written', async () => {
		const h = harness();
		const cueId = h.addCue(150);
		h.session.select('cues', [cueId], 'replace');
		const doc = h.session.getCommitted();
		const n = h.labels().length;
		expect((await auditionInContext(h.session, h.engine, h.list[0]!)).ok).toBe(true);
		h.session.transport.reportFrame(120);
		h.session.transport.pause();
		expect(inContextStore.getState().active).toBe(false);
		expect(h.session.gestureActive).toBe(false);
		expect(h.session.transport.getState().frame).toBe(150);
		expect(h.session.getCommitted()).toBe(doc);
		expect(h.labels()).toHaveLength(n);
	});

	it('started while a drag holds the gesture: refused, the drag is untouched', async () => {
		const h = harness();
		const drag = h.session.beginGesture('Move Cue');
		const r = await auditionInContext(h.session, h.engine, h.list[0]!);
		expect(r).toMatchObject({ ok: false, message: 'Finish the current edit first' });
		expect(drag.active).toBe(true);
		expect(inContextStore.getState()).toMatchObject({ active: false, loading: false });
		drag.cancel();
	});

	it('a drag beginning while the sound registers wins: the audition gives up, the drag keeps its gesture', async () => {
		const h = harness();
		const release = slowRegister(h);
		const p = auditionInContext(h.session, h.engine, h.list[0]!);
		const drag = h.session.beginGesture('Move Cue');
		release();
		expect(await p).toMatchObject({ ok: false });
		expect(drag.active).toBe(true);
		expect(inContextStore.getState()).toMatchObject({ active: false, loading: false });
		drag.cancel();
	});

	it('two quick Shift+Space presses on the same sound (the second while it registers) leave nothing playing', async () => {
		const h = harness();
		const release = slowRegister(h);
		const a = runCommand('soundLibrary.auditionInContext', h.ctx, { soundId: h.list[0]!.id });
		await tick();
		expect(inContextStore.getState().loading).toBe(true);
		stopInContext(); // what the panel's toggle does for the same sound while it loads
		release();
		expect((await a).ran).toBe(true);
		expect(inContextStore.getState()).toMatchObject({ active: false, loading: false });
		expect(h.session.gestureActive).toBe(false);
		expect(h.toasts).toEqual([]);
	});

	it('Replace mode: the muted clip is never muted in the committed document, on any exit', async () => {
		const h = harness();
		const cueId = h.addCue(90);
		const r = await fillCueWithSound(h.session, h.engine, h.list[0]!, { sequenceId: h.seqId, cueId });
		h.session.select('cues', [], 'replace');
		h.session.select('timeline', [r.clipId], 'replace');
		await runCommand('sound.swap', h.ctx);
		for (const end of [
			() => stopInContext(),
			() => h.session.transport.pause(),
			() => h.session.openSequence(h.seqId),
		]) {
			expect((await auditionInContext(h.session, h.engine, h.list[1]!)).ok).toBe(true);
			expect(h.session.getState().transient!.sequences[h.seqId]!.clips[r.clipId]!.enabled).toBe(false);
			end();
			stopInContext();
			expect(h.session.getCommitted().sequences[h.seqId]!.clips[r.clipId]!.enabled).toBe(true);
			expect(h.session.getState().transient).toBeNull();
		}
	});
});

describe('Sound Library modes follow their target', () => {
	function mount(session: ReturnType<typeof harness>['session']) {
		return render(
			<SessionProvider session={session}>
				<SoundLibraryPanel instanceId="sl" visible />
			</SessionProvider>,
		);
	}

	it('Replace mode ends when its clip is deleted (Enter then inserts instead of failing to swap)', async () => {
		const h = harness();
		const cueId = h.addCue(90);
		const r = await fillCueWithSound(h.session, h.engine, h.list[0]!, { sequenceId: h.seqId, cueId });
		requestClipTarget({
			kind: 'replace',
			sequenceId: h.seqId,
			clipId: r.clipId,
			soundId: null,
			title: 'x',
			label: 'x',
		});
		mount(h.session);
		await screen.findByTestId('sound-replace-banner');
		act(() => {
			h.apply([{ type: 'clip.lift', clipIds: [r.clipId] }]);
		});
		await waitFor(() => expect(screen.queryByTestId('sound-replace-banner')).toBeNull());
		expect(clipSoundTarget()).toBeNull();
	});

	it('Fill mode ends when its cue is removed (undo of the cue)', async () => {
		const h = harness();
		const cueId = h.addCue(90);
		requestCueFill({ sequenceId: h.seqId, cueId, types: ['hit'], label: 'Hero Land cue at 00:00:03:00' });
		mount(h.session);
		await screen.findByTestId('sound-fill-chip');
		act(() => {
			h.session.undo();
		});
		await waitFor(() => expect(screen.queryByTestId('sound-fill-chip')).toBeNull());
		expect(cueFillTarget()).toBeNull();
	});

	it('another project: a mode of the previous one does not carry over', async () => {
		const h = harness();
		const cueId = h.addCue(90);
		requestCueFill({ sequenceId: h.seqId, cueId, types: ['hit'], label: 'x' });
		const other = harness();
		mount(other.session);
		await waitFor(() => expect(cueFillTarget()).toBeNull());
		expect(screen.queryByTestId('sound-fill-chip')).toBeNull();
	});
});

describe('Hover audition with In Context on', () => {
	it('resting on a row plays it in context (as documented), leaving the row stops it', async () => {
		const h = harness();
		soundLibraryPrefs.set({ inContext: true, auditionOnHover: true });
		h.session.transport.seek(100);
		render(
			<SessionProvider session={h.session}>
				<SoundLibraryPanel instanceId="sl" visible />
			</SessionProvider>,
		);
		const list = await screen.findByRole('listbox');
		const option = (await within(list).findAllByRole('option'))[0]!;
		fireEvent.mouseEnter(option);
		await waitFor(() => expect(inContextStore.getState().active).toBe(true), { timeout: 3000 });
		expect(h.session.getState().transient).not.toBeNull();
		fireEvent.mouseLeave(option);
		expect(inContextStore.getState().active).toBe(false);
		expect(h.session.transport.getState()).toMatchObject({ playing: false, frame: 100 });
	});
});

describe('a key pressed while it plays runs its own command too (Phase 2 verification)', () => {
	// Before: the keymap dispatcher (window, capture, installed at start-up) resolved the key while the audition still
	// held the session gesture, so Ctrl+Z was disabled and only ended the audition; the user had to press it again.
	it('Ctrl+Z ends the audition and undoes the last edit in the same press', async () => {
		const h = harness();
		h.addCue(150);
		expect(h.labels()).toEqual(['setup']);
		const off = installKeyboardDispatcher(window, {
			getCtx: () => h.ctx,
			getFocusKind: () => 'timeline',
			platform: 'linux',
			runtime: 'web',
			run: (c, ctx, args) => void runCommand(c.id, ctx, args),
		});
		try {
			h.session.transport.seek(100);
			expect((await auditionInContext(h.session, h.engine, h.list[0]!)).ok).toBe(true);
			await tick(); // the audition listens for the next key from here
			expect(h.session.gestureActive).toBe(true);
			document.body.dispatchEvent(
				new KeyboardEvent('keydown', {
					code: 'KeyZ',
					key: 'z',
					ctrlKey: true,
					cancelable: true,
					bubbles: true,
				}),
			);
			await waitFor(() => expect(inContextStore.getState().active).toBe(false));
			expect(h.session.gestureActive).toBe(false);
			// the cue the setup added is gone: undone, not only the audition stopped
			await waitFor(() => expect(h.session.getState().history.canUndo).toBe(false));
			expect(h.session.getState().history.canRedo).toBe(true);
			const seq = h.session.getState().document.sequences[h.seqId]!;
			expect(Object.keys((seq.soundDesign as { cues?: object } | undefined)?.cues ?? {})).toHaveLength(0);
		} finally {
			off();
		}
	});
});
