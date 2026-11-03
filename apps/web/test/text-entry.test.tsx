// Spec 19 TL-085, TL-093, TL-110, TL-111: direct text entry on the Program monitor. happy-dom has no layout, so these
// tests cover what the editor does with text, History, refusals and failures; e2e/text-entry.spec.ts runs it in Chrome.
import { setTemplateEditHold, templateEditHold } from '@jasper/compositions';
import {
	buildRenderSnapshot,
	type Clip,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	TEXT_WARP_EFFECT_ID,
	TITLE_LOOK_EFFECT_ID,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ sceneBoom: false }));

vi.mock('../src/three-d/scene.ts', async (importOriginal) => {
	const m = await importOriginal<typeof import('../src/three-d/scene.ts')>();
	return {
		...m,
		resolveProgramScene: (...a: Parameters<typeof m.resolveProgramScene>) => {
			if (flags.sceneBoom) throw new Error('boom');
			return m.resolveProgramScene(...a);
		},
	};
});

const { beginTextEntry } = await import('../src/text-edit/begin.ts');
const { liveDraft } = await import('../src/text-edit/draft.ts');
const { CHECKPOINT_IDLE_MS, readCheckpoint } = await import('../src/text-edit/checkpoint.ts');
const { textEntryStore } = await import('../src/text-edit/store.ts');
const { TextEntryHost } = await import('../src/text-edit/TextEntryEditor.tsx');
const { textDoubleClick } = await import('../src/text-edit/register.ts');
const { warpStyleCommands, writingModeCommands, verticalDisabledReason } = await import(
	'../src/text-edit/writing.ts'
);
const { templateEditStore, endTemplateEdit } = await import('../src/template-edit/store.ts');
const { monitorStores } = await import('../src/panels/program/monitor-store.ts');

const VIEW = { scale: 0.5, x: 0, y: 0 };

function newSession(document?: ProjectDocument, readOnly = false) {
	const ids = createCounterIdSource(1);
	const doc = document ?? createEmptyProject({ ids, name: 'Text entry', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => 't', registries: defaultRegistries() },
		coalesceWindowMs: 0,
		readOnly,
	});
	session.transport.setMaxFrame(10_000);
	return session;
}

const seqOf = (s: EditorSession) => {
	const st = s.getState();
	return (st.transient ?? st.document).sequences[st.activeSequenceId!]!;
};
const committedClips = (s: EditorSession): Clip[] =>
	Object.values(s.getState().document.sequences[s.getState().activeSequenceId!]!.clips);
const clipOf = (s: EditorSession, id: string) => seqOf(s).clips[id] as Extract<Clip, { kind: 'text' }>;

function addText(s: EditorSession, text: string, extra: Record<string, unknown> = {}): string {
	const r = s.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{ type: 'clip.addText', at: 0, duration: 150, track: 'V1', content: { text, ...extra }, ref: '$t' },
		] as never,
	});
	if (!r.ok) throw new Error(r.errors[0]?.message);
	return r.refs.$t!;
}

const snapshot = (s: EditorSession) => {
	const st = s.getState();
	const doc = st.transient ?? st.document;
	return buildRenderSnapshot(doc, st.activeSequenceId!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
};

function mount(session: EditorSession) {
	const Program = () => {
		useStoreSelector(session.store, (s) => s.transient ?? s.document);
		return (
			<div data-testid="program-viewport">
				<TextEntryHost
					session={session}
					doc={snapshot(session)}
					view={VIEW}
					viewport={{ width: 960, height: 540 }}
					transport={session.transport}
					monitor={monitorStores.program.getState()}
				/>
			</div>
		);
	};
	// StrictMode replays effects, as the app does in development: an entry must survive that.
	return render(
		<StrictMode>
			<Program />
		</StrictMode>,
	);
}

const input = () => screen.getByTestId('text-entry-input');
const value = () => input().getAttribute('data-value');

/** Types what the browser would: the element's text changes, then `input` fires. */
function type(text: string) {
	const el = input();
	act(() => {
		el.textContent = text;
		fireEvent.input(el);
	});
}

function openNew(session: EditorSession) {
	mount(session);
	act(() => {
		beginTextEntry(session, { point: [960, 540], frame: 0 });
	});
}

function openEdit(session: EditorSession, clipId: string) {
	mount(session);
	act(() => {
		beginTextEntry(session, { point: [960, 540], frame: 10, clipId });
	});
}

const press = (key: string, init: Record<string, unknown> = {}) =>
	act(() => {
		fireEvent.keyDown(input(), { key, ...init });
	});

afterEach(() => {
	cleanup();
	sessionStorage.clear();
	flags.sceneBoom = false;
	textEntryStore.setState({ current: null });
	endTemplateEdit();
	setTemplateEditHold(null);
	vi.restoreAllMocks();
});

describe('Type tool (TL-085)', () => {
	it('opens a caret, and the whole entry is one undo step', () => {
		const s = newSession();
		openNew(s);
		expect(committedClips(s)).toHaveLength(0);
		for (const t of ['H', 'He', 'Hel', 'Hello']) type(t);
		expect(committedClips(s)).toHaveLength(0);
		const entries = s.getState().history.entries.length;
		press('Escape');
		expect(screen.queryByTestId('text-entry-input')).toBeNull();
		const [c] = committedClips(s);
		expect(c?.kind).toBe('text');
		expect((c as { content: { text: string } }).content.text).toBe('Hello');
		expect(s.getState().history.entries.length).toBe(entries + 1);
		expect(s.getState().selection.timeline.clips).toEqual([c!.id]);
		expect(s.undo().ok).toBe(true);
		expect(committedClips(s)).toHaveLength(0);
	});

	it('leaves nothing behind for an empty entry, whitespace included', () => {
		const s = newSession();
		openNew(s);
		const entries = s.getState().history.entries.length;
		press('Escape');
		expect(committedClips(s)).toHaveLength(0);
		cleanup();
		openNew(s);
		type('   ');
		press('Escape');
		expect(committedClips(s)).toHaveLength(0);
		expect(s.getState().history.entries.length).toBe(entries);
		expect(s.getState().transient).toBeNull();
	});

	it('leaves nothing behind when everything typed is deleted again', () => {
		const s = newSession();
		openNew(s);
		type('abc');
		type('');
		press('Escape');
		expect(committedClips(s)).toHaveLength(0);
		expect(s.gestureActive).toBe(false);
	});

	it('draws the text as it is typed, without committing it', () => {
		const s = newSession();
		openNew(s);
		type('Live');
		const drawn = Object.values(seqOf(s).clips);
		expect(drawn).toHaveLength(1);
		expect((drawn[0] as { content: { text: string } }).content.text).toBe('Live');
		expect(s.getState().document).not.toBe(s.getState().transient);
	});

	it('Enter is a new line; Ctrl+Enter finishes', () => {
		const s = newSession();
		openNew(s);
		type('one');
		press('Enter');
		expect(value()).toBe('one\n');
		press('Enter', { ctrlKey: true });
		expect(screen.queryByTestId('text-entry-input')).toBeNull();
		expect((committedClips(s)[0] as { content: { text: string } }).content.text).toBe('one\n');
	});

	it('a click away commits', () => {
		const s = newSession();
		openNew(s);
		type('Blurred');
		act(() => {
			fireEvent.blur(input());
		});
		expect((committedClips(s)[0] as { content: { text: string } }).content.text).toBe('Blurred');
	});

	it('starting playback commits', () => {
		const s = newSession();
		openNew(s);
		type('Playing');
		act(() => {
			s.transport.getState();
			s.transport.play();
		});
		return vi.waitFor(() => {
			expect(committedClips(s)).toHaveLength(1);
		});
	});
});

describe('editing a clip (TL-085)', () => {
	it('edits through the plain-text double-click, one undo step', () => {
		const s = newSession();
		const id = addText(s, 'Title');
		mount(s);
		const clip = seqOf(s).clips[id]!;
		act(() => {
			expect(textDoubleClick({ session: s, clip, point: [960, 540], frame: 10 })).toBe(true);
		});
		expect(value()).toBe('Title');
		type('Titles');
		expect(clipOf(s, id).content.text).toBe('Titles');
		expect(
			(s.getState().document.sequences[seqOf(s).id]!.clips[id] as never as { content: { text: string } })
				.content.text,
		).toBe('Title');
		press('Escape');
		expect(clipOf(s, id).content.text).toBe('Titles');
		s.undo();
		expect(clipOf(s, id).content.text).toBe('Title');
	});

	it('changing nothing writes nothing and holds no gesture', () => {
		const s = newSession();
		const id = addText(s, 'Title');
		openEdit(s, id);
		const entries = s.getState().history.entries.length;
		expect(s.gestureActive).toBe(false);
		press('Escape');
		expect(s.getState().history.entries.length).toBe(entries);
	});

	it('emptying a clip removes it, one undo step brings it back', () => {
		const s = newSession();
		const id = addText(s, 'Gone');
		openEdit(s, id);
		type('');
		press('Escape');
		expect(committedClips(s)).toHaveLength(0);
		s.undo();
		expect(clipOf(s, id).content.text).toBe('Gone');
	});

	it('holds the clip at rest while it is edited', () => {
		const s = newSession();
		const id = addText(s, 'Rest');
		openEdit(s, id);
		expect(templateEditHold()).toBe(id);
		press('Escape');
		expect(templateEditHold()).toBeNull();
	});

	it('keeps a look and a warp through the edit', () => {
		const s = newSession();
		const id = addText(s, 'Look');
		s.apply({
			label: 'look',
			origin: 'user',
			commands: [
				{
					type: 'look.apply',
					clipIds: [id],
					look: { name: 'Plain', recipe: { layers: [{ type: 'face' }] } },
				},
				...warpStyleCommands([seqOf(s).clips[id]!], 'arc'),
			] as never,
		});
		openEdit(s, id);
		type('Looks');
		press('Escape');
		const fx = (clipOf(s, id) as { effects: { effectId: string }[] }).effects.map((e) => e.effectId);
		expect(fx).toEqual([TITLE_LOOK_EFFECT_ID, TEXT_WARP_EFFECT_ID]);
		expect(clipOf(s, id).content.text).toBe('Looks');
	});

	it('writes a Source Text key at the playhead when the text is keyed', () => {
		const s = newSession();
		const id = addText(s, 'A');
		const content = clipOf(s, id).content;
		const r = s.apply({
			label: 'keys',
			origin: 'user',
			commands: [
				{
					type: 'param.setAnimated',
					target: ['clip', id, 'text', 'sourceText'],
					animated: true,
					at: { sequenceFrame: 0 },
				},
			] as never,
		});
		expect(r.ok).toBe(true);
		expect(content.text).toBe('A');
		openEdit(s, id);
		type('B');
		press('Escape');
		expect(clipOf(s, id).content.text).toBe('A');
		const keys = clipOf(s, id).sourceTextKeyframes!;
		expect(keys.some((k) => (k.value as { text: string }).text === 'B')).toBe(true);
	});

	it('keeps the typed text when the clip is deleted under the editor', () => {
		const s = newSession();
		const id = addText(s, 'Under');
		openEdit(s, id);
		type('Under mine');
		act(() => {
			s.apply({ label: 'del', origin: 'user', commands: [{ type: 'clip.lift', clipIds: [id] }] as never });
		});
		press('Escape');
		const texts = committedClips(s).map((c) => (c as { content: { text: string } }).content.text);
		expect(texts).toEqual(['Under mine']);
	});
});

describe('refusals', () => {
	it('explains a read-only project and opens nothing', () => {
		const s = newSession(undefined, true);
		mount(s);
		act(() => {
			beginTextEntry(s, { point: [10, 10], frame: 0 });
		});
		expect(textEntryStore.getState().current).toBeNull();
		expect(templateEditStore.getState().current?.kind).toBe('message');
	});

	it('explains a locked track through the double-click', () => {
		const s = newSession();
		const id = addText(s, 'Locked');
		s.apply({
			label: 'lock',
			origin: 'user',
			commands: [
				{ type: 'track.update', trackId: seqOf(s).videoTracks[0]!.id, patch: { locked: true } },
			] as never,
		});
		act(() => {
			beginTextEntry(s, { point: [960, 540], frame: 0, clipId: id });
		});
		expect(textEntryStore.getState().current).toBeNull();
		expect(templateEditStore.getState().current?.kind).toBe('message');
	});

	it('explains text an expression drives', () => {
		const s = newSession();
		const id = addText(s, 'Expr');
		s.apply({
			label: 'expr',
			origin: 'user',
			commands: [
				{
					type: 'expression.set',
					target: ['clip', id, 'text', 'sourceText'],
					text: '"x"',
					enabled: true,
				},
			] as never,
		});
		act(() => {
			beginTextEntry(s, { point: [960, 540], frame: 0, clipId: id });
		});
		expect(textEntryStore.getState().current).toBeNull();
	});

	it('a refused commit keeps the editor and the text, with the reason', () => {
		const s = newSession();
		openNew(s);
		type('Keep me');
		s.store.setState({ readOnly: true });
		press('Escape');
		expect(value()).toBe('Keep me');
		expect(screen.getByRole('alert').textContent).toMatch(/read-only/i);
		s.store.setState({ readOnly: false });
		press('Escape');
		expect(screen.queryByTestId('text-entry-input')).toBeNull();
		expect((committedClips(s)[0] as { content: { text: string } }).content.text).toBe('Keep me');
	});
});

describe('typed text survives (AGENTS §0)', () => {
	it('a render failure commits what was typed', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const s = newSession();
		mount(s);
		act(() => {
			beginTextEntry(s, { point: [960, 540], frame: 0 });
		});
		type('Crash');
		flags.sceneBoom = true;
		type('Crash!');
		expect(screen.queryByTestId('text-entry-input')).toBeNull();
		expect(s.gestureActive).toBe(false);
		expect(committedClips(s).map((c) => (c as { content: { text: string } }).content.text)).toEqual([
			'Crash!',
		]);
		expect(templateEditStore.getState().current?.kind).toBe('message');
	});

	it('the overlay going away commits', async () => {
		const s = newSession();
		const r = mount(s);
		act(() => {
			beginTextEntry(s, { point: [960, 540], frame: 0 });
		});
		type('Unmount');
		r.unmount();
		await Promise.resolve();
		expect(committedClips(s)).toHaveLength(1);
		expect(s.gestureActive).toBe(false);
	});

	it('an unmount whose commit is refused opens a new editor on the text, and the remount shows it', async () => {
		const s = newSession();
		const r = mount(s);
		act(() => {
			beginTextEntry(s, { point: [960, 540], frame: 0 });
		});
		type('Keep me');
		s.store.setState({ readOnly: true });
		r.unmount();
		await act(async () => {
			await Promise.resolve();
		});
		expect(committedClips(s)).toHaveLength(0);
		expect(textEntryStore.getState().current?.recovered?.text).toBe('Keep me');
		expect(s.gestureActive).toBe(false);
		// The overlay comes back (a change of language remounts it): the text is there, and commits once allowed.
		s.store.setState({ readOnly: false });
		mount(s);
		expect(value()).toBe('Keep me');
		press('Escape');
		expect(committedClips(s).map((c) => (c as { content: { text: string } }).content.text)).toEqual([
			'Keep me',
		]);
	});

	it('the page closing commits', () => {
		const s = newSession();
		openNew(s);
		type('Bye');
		act(() => {
			window.dispatchEvent(new Event('pagehide'));
		});
		expect((committedClips(s)[0] as { content: { text: string } }).content.text).toBe('Bye');
	});

	it('takes in composition text the browser has not reported yet', () => {
		const s = newSession();
		openNew(s);
		type('今');
		const el = input();
		act(() => {
			fireEvent.compositionStart(el);
			el.textContent = '今日';
			fireEvent.input(el);
		});
		expect(value()).toBe('今');
		// The window loses focus mid-composition: the blur reads the element.
		act(() => {
			fireEvent.blur(el);
		});
		expect((committedClips(s)[0] as { content: { text: string } }).content.text).toBe('今日');
	});

	it('a finished composition enters the text once', () => {
		const s = newSession();
		openNew(s);
		const el = input();
		act(() => {
			fireEvent.compositionStart(el);
			el.textContent = 'にほんご';
			fireEvent.input(el);
		});
		expect(el.getAttribute('data-mode')).toBe('plain');
		press('Enter', { isComposing: true });
		press('Escape', { isComposing: true });
		expect(screen.queryByTestId('text-entry-input')).not.toBeNull();
		act(() => {
			el.textContent = '日本語';
			fireEvent.compositionEnd(el);
		});
		expect(value()).toBe('日本語');
		expect(s.getState().transient).not.toBeNull();
	});
});

describe('a killed renderer (AGENTS §0)', () => {
	const idle = () =>
		act(async () => {
			await new Promise((r) => setTimeout(r, CHECKPOINT_IDLE_MS + 100));
		});

	it('checkpoints the draft to the tab when typing pauses; the commit clears it', async () => {
		const s = newSession();
		openNew(s);
		type('Half a ti');
		expect(readCheckpoint(s.projectId)).toBeNull();
		await idle();
		expect(readCheckpoint(s.projectId)).toMatchObject({ text: 'Half a ti', clipId: null, point: [960, 540] });
		press('Escape');
		expect(readCheckpoint(s.projectId)).toBeNull();
	});

	it('offers the checkpoint on the next Program monitor of the project; Restore brings the text back', async () => {
		const first = newSession();
		const id = addText(first, 'Old title');
		const before = first.getCommitted();
		openEdit(first, id);
		type('New title, half typed');
		await idle();
		const key = `jasper:text-entry:${first.projectId}`;
		const stored = sessionStorage.getItem(key);
		expect(stored).toBeTruthy();
		// The renderer dies: nothing commits. The reloaded tab opens the project as it was saved, and the storage remains.
		cleanup();
		textEntryStore.setState({ current: null });
		sessionStorage.setItem(key, stored!);
		const s = newSession(before);
		mount(s);
		const offer = screen.getByTestId('text-entry-restore');
		expect(offer.textContent).toContain('New title, half typed');
		fireEvent.click(screen.getByTestId('text-entry-restore-button'));
		expect(screen.queryByTestId('text-entry-restore')).toBeNull();
		expect(value()).toBe('New title, half typed');
		const entries = s.getState().history.entries.length;
		press('Escape');
		expect(clipOf(s, id).content.text).toBe('New title, half typed');
		expect(s.getState().history.entries.length).toBe(entries + 1);
		expect(readCheckpoint(s.projectId)).toBeNull();
	});

	it('Discard drops the checkpoint; one of another sequence or a foreign shape is not offered', () => {
		const s = newSession();
		const key = `jasper:text-entry:${s.projectId}`;
		const cp = {
			v: 1,
			sequenceId: s.getState().activeSequenceId,
			clipId: null,
			point: [10, 10],
			frame: 0,
			text: 'Lost words',
			runs: [],
			savedAt: 'x',
		};
		sessionStorage.setItem(key, JSON.stringify({ ...cp, sequenceId: 'seq_other' }));
		mount(s);
		expect(screen.queryByTestId('text-entry-restore')).toBeNull();
		cleanup();
		sessionStorage.setItem(key, JSON.stringify({ ...cp, point: ['x', 1] }));
		mount(s);
		expect(screen.queryByTestId('text-entry-restore')).toBeNull();
		cleanup();
		sessionStorage.setItem(key, JSON.stringify(cp));
		mount(s);
		expect(screen.getByTestId('text-entry-restore').textContent).toContain('Lost words');
		fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
		expect(screen.queryByTestId('text-entry-restore')).toBeNull();
		expect(sessionStorage.getItem(key)).toBeNull();
	});

	it('reads any stored value without throwing (fuzz)', () => {
		const s = newSession();
		const key = `jasper:text-entry:${s.projectId}`;
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string(),
					fc.json(),
					fc.jsonValue().map((v) => JSON.stringify(v)),
				),
				(raw) => {
					sessionStorage.setItem(key, raw);
					const r = readCheckpoint(s.projectId);
					expect(r === null || (typeof r.text === 'string' && r.text.length > 0)).toBe(true);
				},
			),
			{ numRuns: 300 },
		);
	});
});

describe('keys (TL-085)', () => {
	it('no key leaves the editor', () => {
		const s = newSession();
		openNew(s);
		const seen: string[] = [];
		const onKey = (e: KeyboardEvent) => seen.push(e.key);
		document.addEventListener('keydown', onKey);
		document.addEventListener('keyup', onKey);
		for (const key of [' ', 'j', 'k', 'l', 'Delete', 'ArrowLeft', 'v', 'Tab']) {
			press(key);
			act(() => {
				fireEvent.keyUp(input(), { key });
			});
		}
		document.removeEventListener('keydown', onKey);
		document.removeEventListener('keyup', onKey);
		expect(seen).toEqual([]);
		expect(input().hasAttribute('data-keymap-suspend')).toBe(true);
	});

	it('Ctrl+Z undoes typing, and never reaches History', () => {
		const s = newSession();
		const id = addText(s, 'A');
		openEdit(s, id);
		type('AB');
		type('ABC');
		press('z', { ctrlKey: true });
		expect(value()).toBe('AB');
		press('y', { ctrlKey: true });
		expect(value()).toBe('ABC');
		press('z', { ctrlKey: true });
		press('z', { ctrlKey: true });
		expect(value()).toBe('A');
		press('z', { ctrlKey: true });
		expect(clipOf(s, id)).toBeTruthy();
		expect(value()).toBe('A');
	});
});

describe('run edits in the draft (TL-093)', () => {
	it('runs follow typing and belong to the same undo step', () => {
		const s = newSession();
		const id = addText(s, 'Word up');
		mount(s);
		act(() => {
			beginTextEntry(s, { point: [960, 540], frame: 0, clipId: id });
		});
		const d = liveDraft()!;
		act(() => {
			d.update({ text: 'Word up', runs: [{ from: 5, to: 7, style: { weight: 700 } }] });
		});
		type('Big Word up');
		press('Escape');
		expect(clipOf(s, id).content.runs).toEqual([{ from: 9, to: 11, style: { weight: 700 } }]);
		s.undo();
		expect(clipOf(s, id).content.runs).toBeUndefined();
		expect(clipOf(s, id).content.text).toBe('Word up');
	});
});

describe('orientation and warp commands (TL-110, TL-111)', () => {
	it('sets the writing mode undoably, and writes no field for horizontal', () => {
		const s = newSession();
		const id = addText(s, '縦書き');
		s.apply({
			label: 'v',
			origin: 'user',
			commands: writingModeCommands([seqOf(s).clips[id]!], true) as never,
		});
		expect(clipOf(s, id).content.writingMode).toBe('vertical');
		s.apply({
			label: 'h',
			origin: 'user',
			commands: writingModeCommands([seqOf(s).clips[id]!], false) as never,
		});
		expect('writingMode' in clipOf(s, id).content).toBe(false);
	});

	it('refuses vertical text on a path, with the reason in the UI', () => {
		const clip = { kind: 'text', pathOptions: { maskId: 'm' } } as never;
		expect(verticalDisabledReason([clip])).toMatch(/path/);
	});

	it('puts the warp right after the look, and removes it', () => {
		const s = newSession();
		const id = addText(s, 'Warp');
		const blur = s.apply({
			label: 'fx',
			origin: 'user',
			commands: [
				{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.gaussian-blur' },
				{
					type: 'look.apply',
					clipIds: [id],
					look: { name: 'Plain', recipe: { layers: [{ type: 'face' }] } },
				},
			] as never,
		});
		expect(blur.ok).toBe(true);
		s.apply({
			label: 'w',
			origin: 'user',
			commands: warpStyleCommands([seqOf(s).clips[id]!], 'flag') as never,
		});
		const list = () => (clipOf(s, id) as { effects: { effectId: string }[] }).effects.map((e) => e.effectId);
		expect(list().slice(0, 2)).toEqual([TITLE_LOOK_EFFECT_ID, TEXT_WARP_EFFECT_ID]);
		s.apply({
			label: 'n',
			origin: 'user',
			commands: warpStyleCommands([seqOf(s).clips[id]!], null) as never,
		});
		expect(list()).not.toContain(TEXT_WARP_EFFECT_ID);
	});
});
