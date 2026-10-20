// WP2.4b UI (spec 12 §2.7): the Sound Library's Fill (Enter fills the target cue), Replace banner (Enter swaps, Esc
// leaves), palette strip and "Palette only", In Context toggle; the Cue Seam drop of a sound on a glyph; the cue
// menu's Fill With ▸ (loaded when it opens; resting on an item auditions in context); clip badges; Essential Sound ▸
// Sound Design (Role, Align, Pitch, Layer n of m); Properties "Sound" (credit line as the credits export prints it) and
// "Cue" (edits through soundCue.update).
import type { AudioClip, ClipSfx, Sequence } from '@jasper/project';
import { soundCredits } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import {
	act,
	cleanup,
	createEvent,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCommands } from '../src/commands/registry.ts';
import { soundCommands } from '../src/commands/sound.ts';
import { soundCueCommands } from '../src/commands/sound-cues.ts';
import { soundDesignCommands } from '../src/commands/sound-design.ts';
import {
	type ClipDecorationProps,
	clipDecorations,
	clipMenuExtensions,
	cueMenuExtensions,
	type MenuItemSpec,
} from '../src/extensions/index.ts';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import { createTimelineUiStore } from '../src/panels/timeline/state/ui-store.ts';
import { AuditionPlayer, setAuditionPlayer } from '../src/sound/audition.ts';
import { cancelLibraryMode, requestClipTarget, requestCueFill } from '../src/sound/controller.ts';
import { CueSeam } from '../src/sound/cues/CueSeam.tsx';
import { cuesOf, SEAM_PX } from '../src/sound/cues/model.ts';
import { clipSoundLabel, sfxOf } from '../src/sound/design-model.ts';
import { EssentialSfxSection } from '../src/sound/EssentialSfx.tsx';
import { fillCueWithSound } from '../src/sound/fill.ts';
import { inContextStore, stopInContext } from '../src/sound/in-context.ts';
import { JASPER_SOUND_MIME } from '../src/sound/insert.ts';
import { soundLibraryPrefs } from '../src/sound/prefs.ts';
import { clipBadges } from '../src/sound/register.tsx';
import { CueProperties, SoundSection } from '../src/sound/SoundSection.tsx';
import { fakeSoundEngine, soundEntry } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({ client: null as unknown, status: 'connected' }));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
	useEngineOrNull: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
	createEditorEngineClient: () => mocks.client,
}));

const { SoundLibraryPanel } = await import('../src/panels/soundLibrary/SoundLibraryPanel.tsx');

type SfxClip = AudioClip & { sfx?: ClipSfx };

beforeAll(() => {
	registerCommands([...soundCommands, ...soundCueCommands, ...soundDesignCommands]);
});
beforeEach(() => {
	localStorage.clear();
	soundLibraryPrefs.reload();
	soundLibraryPrefs.set({ auditionOnSwap: false });
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
	cleanup();
	closeAllDialogs();
	stopInContext({ returnToAnchor: false });
	cancelLibraryMode();
	setAuditionPlayer(null);
});

function setup() {
	const entries = [
		soundEntry({ title: 'Crunch', peakSec: 0.25, durationSec: 1 }),
		soundEntry({ title: 'Thud', peakSec: 0.2, durationSec: 0.8 }),
		soundEntry({ title: 'Smack', peakSec: 0.3, durationSec: 1.1 }),
	];
	const engine = fakeSoundEngine(entries);
	mocks.client = engine.client;
	const { session, seqId } = makeSession();
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
	const cueId = (
		apply([
			{
				type: 'soundCue.add',
				cues: [{ frame: 90, kind: 'land', weight: 'hero', types: ['hit'], source: 'user' }],
			},
		]).results[0] as { cueIds: string[] }
	).cueIds[0]!;
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const labels = () => session.getState().history.entries.map((e) => e.label);
	return { entries, engine, session, seqId, apply, cueId, seq, labels };
}

function mountPanel(s: ReturnType<typeof setup>) {
	render(
		<SessionProvider session={s.session}>
			<SoundLibraryPanel instanceId="sl" visible />
			<DialogHost />
		</SessionProvider>,
	);
}

const key = (el: Element, k: string, code: string, extra: Partial<KeyboardEventInit> = {}) =>
	fireEvent.keyDown(el, { key: k, code, ...extra });

describe('Sound Library: Fill, Replace, palette, In Context', () => {
	it('Enter fills the cue being filled (one undo step "Fill Cue …"); the Fill chip goes away', async () => {
		const s = setup();
		requestCueFill({
			sequenceId: s.seqId,
			cueId: s.cueId,
			types: ['hit'],
			label: 'Hero Land cue at 00:00:03:00',
		});
		mountPanel(s);
		expect(await screen.findByTestId('sound-fill-chip')).toBeTruthy();
		const list = await screen.findByRole('listbox');
		await within(list).findAllByRole('option');
		list.focus();
		key(list, 'Enter', 'Enter');
		await waitFor(() => expect(s.labels().at(-1)).toMatch(/^Fill Cue /));
		const cue = cuesOf(s.seq())[0]!;
		expect(cue.placedClipIds).toHaveLength(1);
		const clip = s.seq().clips[cue.placedClipIds![0]!] as SfxClip;
		expect(clip.sfx).toMatchObject({ cueId: s.cueId, role: 'hero' });
		// its variation ring: the chosen sound first, then the two other results
		expect(clip.sfx!.alternatives).toHaveLength(3);
		expect(clip.sfx!.alternatives![0]).toBe(clip.sfx!.soundId);
		await waitFor(() => expect(screen.queryByTestId('sound-fill-chip')).toBeNull());
	});

	it('Replace mode: banner "Replacing … · Enter to swap · Esc to cancel"; Enter swaps the clip; Esc leaves', async () => {
		const s = setup();
		const r = await fillCueWithSound(s.session, s.engine.client as never, s.entries[0]!, {
			sequenceId: s.seqId,
			cueId: s.cueId,
		});
		const clip = s.seq().clips[r.clipId]!;
		requestClipTarget({
			kind: 'replace',
			sequenceId: s.seqId,
			clipId: r.clipId,
			soundId: s.entries[0]!.id,
			title: 'Crunch',
			label: clipSoundLabel(s.session.getCommitted(), s.seq(), clip),
		});
		mountPanel(s);
		const banner = await screen.findByTestId('sound-replace-banner');
		expect(banner.textContent).toMatch(
			/^Replacing Crunch on A4 at 00:00:03:00 · Enter to swap · Esc to cancel/,
		);
		// results are ranked by similarity to the replaced sound
		await waitFor(() => expect(s.engine.calls.search.at(-1)?.similarTo).toBe(s.entries[0]!.id));
		expect(screen.getByTestId('sound-similar-chip')).toBeTruthy();
		const list = await screen.findByRole('listbox');
		const options = await within(list).findAllByRole('option');
		list.focus();
		fireEvent.click(options.find((o) => !o.getAttribute('aria-label')!.startsWith('Crunch'))!);
		key(list, 'Enter', 'Enter');
		await waitFor(() => expect(s.labels().at(-1)).toMatch(/^Swap Sound /));
		expect(sfxOf(s.seq().clips[r.clipId])!.soundId).not.toBe(s.entries[0]!.id);
		await waitFor(() => expect(screen.queryByTestId('sound-replace-banner')).toBeNull());
		// Esc leaves a mode
		requestClipTarget({
			kind: 'replace',
			sequenceId: s.seqId,
			clipId: r.clipId,
			soundId: null,
			title: 'x',
			label: 'x',
		});
		await screen.findByTestId('sound-replace-banner');
		key(list, 'Escape', 'Escape');
		await waitFor(() => expect(screen.queryByTestId('sound-replace-banner')).toBeNull());
	});

	it('palette strip and "Palette only"; the In Context toggle; Shift+Space plays in context without history', async () => {
		const s = setup();
		s.apply([{ type: 'soundDesign.setPalette', soundIds: [s.entries[1]!.id] }]);
		mountPanel(s);
		const strip = await screen.findByTestId('sound-palette-strip');
		await waitFor(() => expect(strip.textContent).toContain('Thud'));
		fireEvent.click(screen.getByTestId('sound-palette-only'));
		const list = await screen.findByRole('listbox');
		await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
		expect(within(list).getAllByRole('option')[0]!.getAttribute('aria-label')).toMatch(/^Thud/);
		const toggle = screen.getByTestId('sound-in-context');
		expect(toggle.getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		expect(soundLibraryPrefs.get().inContext).toBe(true);
		const n = s.labels().length;
		s.session.select('cues', [s.cueId], 'replace');
		list.focus();
		key(list, ' ', 'Space', { shiftKey: true });
		await waitFor(() => expect(inContextStore.getState().active).toBe(true));
		expect(s.session.getState().transient).not.toBeNull();
		expect(s.labels()).toHaveLength(n);
		expect((await screen.findByTestId('sound-live')).textContent).toBe('Playing Thud in context');
		stopInContext();
		expect(s.session.getState().transient).toBeNull();
	});
});

describe('Cue Seam drop and cue menu', () => {
	it('a library sound dropped on a cue glyph highlights it, then fills it (sound.fillCue)', async () => {
		const s = setup();
		const run = vi.fn();
		const layout = computeLayout({
			height: 400,
			dividerRatio: 0.5,
			videoTracks: s.seq().videoTracks,
			audioTracks: s.seq().audioTracks,
			heights: {},
			scrollYVideo: 0,
			scrollYAudio: 0,
			dividerPx: SEAM_PX,
		});
		render(
			<SessionProvider session={s.session}>
				<CueSeam
					session={s.session}
					seq={s.seq()}
					layout={layout}
					viewport={{ scrollFrame: 0, pxPerFrame: 10, width: 1000 }}
					media={{}}
					ui={createTimelineUiStore()}
					instanceId="t1"
					snapping={false}
					run={run}
					openMenu={() => {}}
					toast={() => {}}
					reveal={() => {}}
				/>
			</SessionProvider>,
		);
		const lane = screen.getByTestId('cue-seam');
		const payload = JSON.stringify({ type: 'jasper/sound', soundId: s.entries[2]!.id });
		const dataTransfer = {
			types: [JASPER_SOUND_MIME],
			getData: (t: string) => (t === JASPER_SOUND_MIME ? payload : ''),
			dropEffect: 'none',
		};
		// jsdom has no DragEvent: the pointer position is set on the event
		const drag = (type: 'dragOver' | 'drop', clientX: number) => {
			const ev = createEvent[type](lane, { dataTransfer });
			Object.defineProperty(ev, 'clientX', { value: clientX });
			fireEvent(lane, ev);
		};
		drag('dragOver', 900);
		const glyph = lane.querySelector(`[data-cue-id="${s.cueId}"]`)!;
		expect(glyph.getAttribute('data-drop-target')).toBe('true');
		drag('drop', 900);
		expect(run).toHaveBeenCalledWith('sound.fillCue', { cueId: s.cueId, soundId: s.entries[2]!.id });
		expect(glyph.getAttribute('data-drop-target')).toBeNull();
		// not over a cue: no drop target
		drag('dragOver', 100);
		expect(lane.querySelector('[data-drop-target]')).toBeNull();
	});

	it('Fill With ▸ loads the 5 best sounds; resting on one auditions in context (In Context on); Fill / Add Layer entries', async () => {
		const s = setup();
		soundLibraryPrefs.set({ inContext: true });
		s.session.select('cues', [s.cueId], 'replace');
		const run = vi.fn();
		const items = cueMenuExtensions.list().flatMap((e) =>
			e.items({
				session: s.session,
				sequenceId: s.seqId,
				cueId: s.cueId,
				selection: [s.cueId],
				runCommand: run,
			}),
		);
		const fillWith = items.find((i) => i.kind === 'submenu' && i.label === 'Fill With') as Extract<
			MenuItemSpec,
			{ kind: 'submenu' }
		>;
		expect(fillWith.items[0]).toMatchObject({ label: 'Searching sounds…', disabled: true });
		const loaded = (await fillWith.load!()) as Extract<MenuItemSpec, { kind: 'item' }>[];
		expect(loaded).toHaveLength(3);
		expect(loaded[0]!.label).toMatch(/ · Hit · /);
		loaded[0]!.onHighlight!();
		await waitFor(() => expect(inContextStore.getState().active).toBe(true), { timeout: 2000 });
		expect(s.labels().at(-1)).toBe('setup');
		loaded[0]!.onUnhighlight!();
		expect(inContextStore.getState().active).toBe(false);
		loaded[1]!.run();
		expect(run).toHaveBeenCalledWith('sound.fillCue', expect.objectContaining({ cueId: s.cueId }));
		const addLayer = items.find((i) => i.kind === 'item' && i.label === 'Add Layer…') as {
			disabled?: boolean;
		};
		expect(addLayer.disabled).toBe(true); // unfilled cue
		expect(items.some((i) => i.kind === 'item' && i.label === 'Fill from Library…')).toBe(true);
	});
});

describe('clip menu, badges, Essential Sound, Properties', () => {
	async function filled() {
		const s = setup();
		const r = await fillCueWithSound(s.session, s.engine.client as never, s.entries[0]!, {
			sequenceId: s.seqId,
			cueId: s.cueId,
		});
		s.session.select('timeline', [r.clipId], 'replace');
		return { ...s, clipId: r.clipId };
	}

	it('the clip menu lists the library-sound entries (and Detect Peak / Add to Sound Library… for project audio)', async () => {
		const s = await filled();
		const run = vi.fn();
		const clip = s.seq().clips[s.clipId]!;
		const items = clipMenuExtensions
			.list()
			.flatMap((e) => e.items({ session: s.session, clip, selection: [s.clipId], runCommand: run }));
		const labels = items.map((i) => (i.kind === 'separator' ? '—' : i.label));
		for (const l of [
			'Swap Sound…',
			'Next Variation',
			'Previous Variation',
			'Align Peak to Playhead',
			'Align Peak to Nearest Cue',
			'Set Peak at Playhead',
			'Find Similar Sounds',
			'Reveal in Sound Library',
			'Add to Palette',
			'Role',
			'Add Layer…',
			'Show Licence…',
		])
			expect(labels).toContain(l);
		expect(labels).not.toContain('Detect Peak');
		const swap = items.find((i) => i.kind === 'item' && i.label === 'Swap Sound…') as { run(): void };
		swap.run();
		expect(run).toHaveBeenCalledWith('sound.swap', { clipId: s.clipId });
	});

	it('badges: type glyph, H for hero, chain for layers, licence dot; hidden below the full width', async () => {
		const s = await filled();
		const clip = s.seq().clips[s.clipId]!;
		expect(clipBadges(s.seq(), clip, { width: 120, licenceWarning: false })).toEqual({
			type: 'sfx',
			auto: null,
			hero: true,
			layer: false,
			warn: false,
			shareAlike: false,
		});
		expect(clipBadges(s.seq(), clip, { width: 50, licenceWarning: true })).toEqual({
			type: 'sfx',
			auto: null,
			hero: false,
			layer: false,
			warn: true,
			shareAlike: false,
		});
		// a CC BY-SA sound: the "SA" badge (spec 12 P6-E13), at any width
		expect(
			clipBadges(s.seq(), clip, { width: 50, licenceWarning: false, license: 'CC-BY-SA-4.0' }).shareAlike,
		).toBe(true);
		const deco = clipDecorations.list().find((d) => d.id === 'sound.badges')!;
		expect(deco.appliesTo(clip)).toBe(true);
		const Badge = deco.badge!;
		const props: ClipDecorationProps = {
			clip,
			x: 0,
			w: 200,
			height: 40,
			viewportWidth: 1000,
			scrollFrame: 0,
			pxPerFrame: 4,
			rate: s.seq().settings.frameRate,
			selected: false,
			trackLocked: false,
		};
		render(
			<SessionProvider session={s.session}>
				<Badge {...props} />
			</SessionProvider>,
		);
		expect(screen.getByRole('button', { name: 'Audio type SFX: open Essential Sound' })).toBeTruthy();
		expect(screen.getByRole('img', { name: 'Hero sound' })).toBeTruthy();
	});

	it('Essential Sound ▸ Sound Design: Role, Align, Pitch ± as undoable commands; "Layer n of m"', async () => {
		const s = await filled();
		const view = () => (
			<SessionProvider session={s.session}>
				<EssentialSfxSection
					session={s.session}
					seq={s.seq()}
					clips={[s.seq().clips[s.clipId] as AudioClip]}
				/>
			</SessionProvider>
		);
		const r = render(view());
		const rerender = () => r.rerender(view());
		within(screen.getByTestId('essential-role')).getByRole('radio', { name: 'Layer' }).click();
		rerender();
		expect(sfxOf(s.seq().clips[s.clipId])!.role).toBe('layer');
		expect(s.labels().at(-1)).toBe('Sound Role');
		within(screen.getByTestId('essential-align')).getByRole('radio', { name: 'Start' }).click();
		rerender();
		expect(sfxOf(s.seq().clips[s.clipId])!.placement.align).toBe('start');
		expect(s.labels().at(-1)).toBe('Sound Align');
		const rate0 = (s.seq().clips[s.clipId] as AudioClip).speed.rate;
		fireEvent.click(screen.getByTestId('essential-pitch-up'));
		rerender();
		expect((s.seq().clips[s.clipId] as AudioClip).speed.rate).toBeCloseTo(rate0 * 2 ** (1 / 12), 4);
		expect(screen.getByTestId('essential-pitch').textContent).toBe('+1 st');
		s.session.undo();
		rerender();
		expect((s.seq().clips[s.clipId] as AudioClip).speed.rate).toBeCloseTo(rate0, 6);
	});

	it('Essential Sound ▸ Pitch shows a fractional varispeed shift; Reset gives back the exact variation (WP6.5b)', async () => {
		const s = await filled();
		const view = () => (
			<SessionProvider session={s.session}>
				<EssentialSfxSection
					session={s.session}
					seq={s.seq()}
					clips={[s.seq().clips[s.clipId] as AudioClip]}
				/>
			</SessionProvider>
		);
		const r = render(view());
		const rerender = () => r.rerender(view());
		const clip = () => s.seq().clips[s.clipId] as AudioClip;
		const rate0 = clip().speed.rate;
		const mediaId = clip().mediaId;
		const res = s.session.apply({
			label: 'Sound Pitch',
			origin: 'user',
			sequenceId: s.seqId,
			commands: [{ type: 'soundDesign.swap', clipId: s.clipId, mediaId, pitchSt: 2.5 }],
		});
		expect(res.ok).toBe(true);
		rerender();
		expect(screen.getByTestId('essential-pitch').textContent).toBe('+2.5 st');
		fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
		rerender();
		expect(clip().speed.rate).toBe(rate0);
		expect(screen.getByTestId('essential-pitch').textContent).toBe('0 st');
	});

	it('Role / Align are one Tab stop each; arrow keys, Home and End move and choose (WP6.5a item 4)', async () => {
		const s = await filled();
		const view = () => (
			<SessionProvider session={s.session}>
				<EssentialSfxSection
					session={s.session}
					seq={s.seq()}
					clips={[s.seq().clips[s.clipId] as AudioClip]}
				/>
			</SessionProvider>
		);
		const r = render(view());
		const rerender = () => r.rerender(view());
		const radios = () => within(screen.getByTestId('essential-role')).getAllByRole('radio');
		const role = () => sfxOf(s.seq().clips[s.clipId])!.role;
		const order = ['hero', 'support', 'layer'];
		const start = order.indexOf(role());
		expect(start).toBeGreaterThanOrEqual(0);
		// roving tabindex: only the checked option is a Tab stop
		expect(radios().map((b) => b.tabIndex)).toEqual(order.map((_, i) => (i === start ? 0 : -1)));
		const key = (k: string) => {
			const target = document.activeElement as HTMLElement;
			const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
			act(() => {
				target.dispatchEvent(ev);
			});
			rerender();
			return ev.defaultPrevented;
		};
		act(() => radios()[start]!.focus());
		expect(key('ArrowRight')).toBe(true);
		const next = order[(start + 1) % 3]!;
		expect(role()).toBe(next);
		expect(s.labels().at(-1)).toBe('Sound Role');
		expect(document.activeElement?.getAttribute('data-value')).toBe(next);
		expect(
			radios()
				.find((b) => b.tabIndex === 0)
				?.getAttribute('data-value'),
		).toBe(next);
		expect(key('End')).toBe(true);
		expect(role()).toBe('layer');
		expect(key('ArrowDown')).toBe(true); // wraps
		expect(role()).toBe('hero');
		expect(key('ArrowLeft')).toBe(true); // wraps back
		expect(role()).toBe('layer');
		expect(key('Home')).toBe(true);
		expect(role()).toBe('hero');
		expect(key('a')).toBe(false); // other keys are left to the keymap
		// Align: the same keys
		const align = () => sfxOf(s.seq().clips[s.clipId])!.placement.align;
		const aligns = within(screen.getByTestId('essential-align')).getAllByRole('radio');
		expect(aligns.filter((b) => b.tabIndex === 0)).toHaveLength(1);
		act(() => aligns.find((b) => b.tabIndex === 0)!.focus());
		const before = align();
		expect(key('ArrowRight')).toBe(true);
		expect(align()).not.toBe(before);
		expect(s.labels().at(-1)).toBe('Sound Align');
		s.session.undo();
		rerender();
		expect(align()).toBe(before);
	});

	it('Properties: Sound shows the credit line exactly as the credits export; Cue edits through soundCue.update', async () => {
		const s = await filled();
		const clip = s.seq().clips[s.clipId]!;
		render(
			<SessionProvider session={s.session}>
				<SoundSection session={s.session} clips={[clip]} frame={0} sequenceId={s.seqId} />
			</SessionProvider>,
		);
		const credits = soundCredits(s.session.getCommitted(), s.seqId);
		expect(screen.getByTestId('sound-section-credit').textContent).toBe(credits.text.split('\n').at(-1));
		expect(screen.getByTestId('sound-section-cue').textContent).toBe('Hero Land cue at 00:00:03:00');
		cleanup();
		s.session.select('cues', [s.cueId], 'replace');
		render(
			<SessionProvider session={s.session}>
				<CueProperties session={s.session} sequenceId={s.seqId} />
			</SessionProvider>,
		);
		expect(screen.getByTestId('cue-section-timecode').textContent).toBe('00:00:03:00');
		fireEvent.change(screen.getByTestId('cue-section-role'), { target: { value: 'support' } });
		expect(cuesOf(s.seq())[0]!.weight).toBe('support');
		expect(s.labels().at(-1)).toBe('Cue Role');
		const frame = screen.getByTestId('cue-section-frame');
		fireEvent.change(frame, { target: { value: '100' } });
		act(() => {
			fireEvent.blur(frame);
		});
		expect(cuesOf(s.seq())[0]!.frame).toBe(100);
		// the filling clip moved with it
		expect(within(screen.getByTestId('cue-section-clips')).getAllByRole('button')).toHaveLength(1);
	});
});
