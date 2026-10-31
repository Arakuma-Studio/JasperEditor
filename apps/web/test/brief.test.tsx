// Spec 18 AF-BRF-005 / AF-BRF-006 in the editor: the brief form model (target length parsing, the sequence a brief
// implies, project names), Home ▸ Describe your video's start (brief + custom frame in one undo step, files imported,
// Connect an AI Agent… only without a connected agent, failures notified), the Describe dialog, and Sequence ▸ Brief…
// (save = one undo step, notes listed newest first, Remove undoable from the toast, read-only).
import type { AgentPresence } from '@jasper/api';
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	readAgentNotes,
	readSequenceBrief,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIEF_DIALOG, registerBriefDialog } from '../src/brief/BriefDialog.tsx';
import {
	EMPTY_BRIEF_FORM,
	formatDuration,
	formOfBrief,
	parseDuration,
	projectNameFrom,
	sequenceShapeFor,
} from '../src/brief/model.ts';
import { DescribeVideoDialog } from '../src/home/DescribeVideoDialog.tsx';
import { runStart, startShape, stashStart, takeStart } from '../src/home/start-brief.ts';

afterEach(() => {
	closeAllDialogs();
	cleanup();
});

function session(opts: { readOnly?: boolean; preset?: string } = {}) {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'Brief', preset: opts.preset ?? 'hd-1080p-30' });
	const s = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-31T10:00:00.000Z', registries: defaultRegistries() },
		readOnly: opts.readOnly,
	});
	return { s, seqId: Object.keys(doc.sequences)[0]! };
}

describe('brief form model', () => {
	it('parses target lengths in seconds, clock and minute forms, within 1 s … 10 h', () => {
		expect(parseDuration('45')).toBe(45);
		expect(parseDuration('45 s')).toBe(45);
		expect(parseDuration('12.5sec')).toBe(12.5);
		expect(parseDuration('1:30')).toBe(90);
		expect(parseDuration('1:02:03')).toBe(3723);
		expect(parseDuration('2 min')).toBe(120);
		expect(parseDuration('1h')).toBe(3600);
		for (const bad of ['', 'abc', '0', '0.4', '11h', '1:75', '-3', 'NaN'])
			expect(parseDuration(bad)).toBeNull();
		expect(formatDuration(45)).toBe('45 s');
		expect(formatDuration(90)).toBe('1:30');
		expect(formatDuration(3723)).toBe('1:02:03');
		for (const n of [1, 45, 59.5, 90, 3723, 36_000]) expect(parseDuration(formatDuration(n))).toBe(n);
	});

	it('infers the sequence: vertical and square presets, a 1080×1350 frame for 4:5, the Home default otherwise', () => {
		expect(sequenceShapeFor(null)).toMatchObject({ preset: 'hd-1080p-29.97', settings: null });
		expect(sequenceShapeFor('16:9')).toMatchObject({ preset: 'hd-1080p-29.97', settings: null });
		expect(sequenceShapeFor('9:16')).toMatchObject({ preset: 'vertical-1080x1920-30', settings: null });
		expect(sequenceShapeFor('1:1')).toMatchObject({ preset: 'square-1080-30', settings: null });
		expect(sequenceShapeFor('4:5')).toMatchObject({
			preset: 'hd-1080p-30',
			settings: { width: 1080, height: 1350 },
		});
		expect(startShape({ ...EMPTY_BRIEF_FORM, platform: 'tiktok' }).preset).toBe('vertical-1080x1920-30');
		expect(startShape({ ...EMPTY_BRIEF_FORM, platform: 'linkedin' }).preset).toBe('square-1080-30');
		expect(startShape({ ...EMPTY_BRIEF_FORM, platform: 'tiktok', aspect: '16:9' }).preset).toBe(
			'hd-1080p-29.97',
		);
	});

	it('names the project from the first line of the description', () => {
		expect(projectNameFrom('')).toBe('Untitled Project');
		expect(projectNameFrom('\n  Launch teaser  \nmore')).toBe('Launch teaser');
		const long = projectNameFrom(
			'A forty-five second vertical teaser of the founder interview for Instagram Reels',
		);
		expect(long.length).toBeLessThanOrEqual(61);
		expect(long.endsWith('…')).toBe(true);
	});

	it('round-trips a stored brief through the form', () => {
		expect(formOfBrief({ text: 'x', platform: 'youtube', targetDurationSec: 90 })).toEqual({
			text: 'x',
			platform: 'youtube',
			aspect: null,
			duration: '1:30',
		});
	});
});

describe('Home ▸ Describe your video: the start in the editor (AF-BRF-005)', () => {
	const presence = (names: string[]): AgentPresence => ({
		agents: names.map((name) => ({ name, lastSeenAt: '2026-10-31T10:00:00.000Z' })),
		windowSec: 900,
	});

	it('sets the brief and the 4:5 frame in one undo step, imports the files, and offers Connect without an agent', async () => {
		const { s, seqId } = session();
		const files = [new File(['x'], 'a.mp4'), new File(['y'], 'b.wav')];
		const form = { text: 'A portrait teaser', platform: null, aspect: '4:5' as const, duration: '30' };
		stashStart(s.projectId, { form, settings: startShape(form).settings, files, paths: [] });
		const start = takeStart(s.projectId)!;
		expect(takeStart(s.projectId)).toBeNull();
		const importFiles = vi.fn(async () => ({
			mediaIds: ['med_1', 'med_2'],
			clipIds: [],
			failed: [],
			registered: [],
		}));
		const openConnectAgent = vi.fn();
		const notify = vi.fn();
		const depth = s.getState().history.index;
		const out = await runStart(s, start, {
			importFiles,
			presence: async () => presence([]),
			openConnectAgent,
			notify,
		});
		expect(out).toEqual({ briefSet: true, imported: 2, failed: 0, agentConnected: false });
		expect(importFiles).toHaveBeenCalledWith({ files });
		expect(openConnectAgent).toHaveBeenCalledTimes(1);
		const seq = s.getCommitted().sequences[seqId]!;
		expect(readSequenceBrief(seq)).toEqual({
			text: 'A portrait teaser',
			aspect: '4:5',
			targetDurationSec: 30,
		});
		expect([seq.settings.width, seq.settings.height]).toEqual([1080, 1350]);
		expect(s.getState().history.index).toBe(depth + 1);
		expect(s.undo().ok).toBe(true);
		const back = s.getCommitted().sequences[seqId]!;
		expect(readSequenceBrief(back)).toBeNull();
		expect(back.settings.width).toBe(1920);
	});

	it('with a connected agent, says so instead of opening Connect; an engine that cannot say counts as none', async () => {
		const { s } = session();
		const notify = vi.fn();
		const openConnectAgent = vi.fn();
		const start = { form: { ...EMPTY_BRIEF_FORM, text: 'x' }, settings: null, files: [], paths: [] };
		const deps = { importFiles: vi.fn(), openConnectAgent, notify };
		const a = await runStart(s, start, { ...deps, presence: async () => presence(['claude-code']) });
		expect(a.agentConnected).toBe(true);
		expect(openConnectAgent).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'success', message: 'Brief saved for claude-code' }),
		);
		expect(deps.importFiles).not.toHaveBeenCalled();
		const b = await runStart(s, start, {
			...deps,
			presence: async () => {
				throw new Error('offline');
			},
		});
		expect(b.agentConnected).toBe(false);
		expect(openConnectAgent).toHaveBeenCalledTimes(1);
	});

	it('reports an import failure and a read-only project without throwing', async () => {
		const { s } = session();
		const notify = vi.fn();
		const out = await runStart(
			s,
			{
				form: { ...EMPTY_BRIEF_FORM, text: 'x' },
				settings: null,
				files: [new File(['x'], 'a.mp4')],
				paths: [],
			},
			{
				importFiles: async () => {
					throw new Error('disk full');
				},
				presence: async () => presence(['a']),
				openConnectAgent: () => undefined,
				notify,
			},
		);
		expect(out).toMatchObject({ briefSet: true, failed: 1 });
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', detail: 'disk full' }));
		const ro = session({ readOnly: true });
		const n2 = vi.fn();
		const r = await runStart(
			ro.s,
			{ form: { ...EMPTY_BRIEF_FORM, text: 'x' }, settings: null, files: [], paths: [] },
			{ importFiles: vi.fn(), presence: async () => null, openConnectAgent: vi.fn(), notify: n2 },
		);
		expect(r.briefSet).toBe(false);
		expect(n2).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'error', message: 'The brief was not saved' }),
		);
	});
});

describe('the Describe your video dialog', () => {
	it('needs a description, shows the inferred sequence, takes dropped and picked files, and returns the form', () => {
		const onCreate = vi.fn();
		render(<DescribeVideoDialog onCancel={() => undefined} onCreate={onCreate} />);
		const create = screen.getByTestId('describe-video-create');
		expect((create as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByTestId('describe-text'), { target: { value: 'A TikTok teaser' } });
		fireEvent.change(screen.getByTestId('describe-platform'), { target: { value: 'tiktok' } });
		expect(screen.getByTestId('describe-sequence').textContent).toContain('Vertical 1080×1920 30 fps');
		fireEvent.change(screen.getByTestId('describe-duration'), { target: { value: 'soon' } });
		expect((create as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByTestId('describe-duration-problem')).toBeTruthy();
		fireEvent.change(screen.getByTestId('describe-duration'), { target: { value: '0:45' } });
		const a = new File(['a'], 'take1.mp4');
		const b = new File(['bb'], 'take2.mp4');
		fireEvent.drop(screen.getByTestId('describe-drop'), {
			dataTransfer: { files: [a, a], types: ['Files'] },
		});
		fireEvent.change(screen.getByTestId('describe-file-input'), { target: { files: [b] } });
		expect(within(screen.getByTestId('describe-files')).getAllByRole('listitem')).toHaveLength(2);
		expect((create as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(create);
		expect(onCreate).toHaveBeenCalledWith({
			form: { text: 'A TikTok teaser', platform: 'tiktok', aspect: null, duration: '0:45' },
			files: [a, b],
			paths: [],
		});
	});
});

describe('Sequence ▸ Brief… (AF-BRF-006)', () => {
	function openBrief(s: EditorSession, seqId: string) {
		registerBriefDialog();
		render(<DialogHost />);
		act(() => void openDialog(BRIEF_DIALOG, { session: s, sequenceId: seqId }));
	}

	it('saves the brief in one undo step and removes notes, newest first, with Undo in the toast', async () => {
		const { s, seqId } = session();
		const add = (text: string) =>
			s.apply({
				label: 'n',
				origin: { agent: 'codex' },
				commands: [{ type: 'project.addAgentNote', text }] as never[],
			});
		add('first note');
		add('second note');
		openBrief(s, seqId);
		const dialog = await screen.findByTestId('brief-dialog');
		const notes = within(dialog).getAllByTestId('brief-note');
		expect(notes.map((n) => n.textContent)).toEqual([
			expect.stringContaining('second note'),
			expect.stringContaining('first note'),
		]);
		expect(notes[0]!.textContent).toContain('codex');
		fireEvent.click(within(notes[0]!).getByTestId('brief-note-remove'));
		await waitFor(() => expect(within(dialog).getAllByTestId('brief-note')).toHaveLength(1));
		expect(readAgentNotes(s.getCommitted()).map((n) => n.text)).toEqual(['first note']);
		expect(s.getState().history.entries.at(s.getState().history.index - 1)?.label).toBe('Remove Agent Note');
		expect(s.undo().ok).toBe(true);
		await waitFor(() => expect(within(dialog).getAllByTestId('brief-note')).toHaveLength(2));
		fireEvent.change(within(dialog).getByTestId('brief-text'), { target: { value: 'A launch video' } });
		fireEvent.change(within(dialog).getByTestId('brief-platform'), { target: { value: 'youtube-shorts' } });
		expect(within(dialog).getByTestId('brief-frame-note').textContent).toContain('9:16');
		const depth = s.getState().history.index;
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(readSequenceBrief(s.getCommitted().sequences[seqId])).toEqual({
				text: 'A launch video',
				platform: 'youtube-shorts',
			}),
		);
		expect(s.getState().history.index).toBe(depth + 1);
	});

	it('read-only: shows the brief and notes without editing', async () => {
		const ids = createCounterIdSource(1);
		const doc = createEmptyProject({ ids, name: 'RO', preset: 'hd-1080p-30' });
		const seqId = Object.keys(doc.sequences)[0]!;
		(doc.sequences[seqId] as { brief?: unknown }).brief = { text: 'Stored brief' };
		doc.agentNotes = {
			entries: [{ id: 'agn_0000000000000001', at: '2026-10-31T10:00:00.000Z', author: 'a', text: 'kept' }],
		};
		const s = new EditorSession({
			projectId: doc.projectId,
			document: doc,
			ctx: { ids, now: () => '2026-10-31T10:00:00.000Z', registries: defaultRegistries() },
			readOnly: true,
		});
		openBrief(s, seqId);
		const dialog = await screen.findByTestId('brief-dialog');
		expect((within(dialog).getByTestId('brief-text') as HTMLTextAreaElement).value).toBe('Stored brief');
		expect((within(dialog).getByTestId('brief-text') as HTMLTextAreaElement).disabled).toBe(true);
		expect((within(dialog).getByTestId('brief-note-remove') as HTMLButtonElement).disabled).toBe(true);
	});
});
