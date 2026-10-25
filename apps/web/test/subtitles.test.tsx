// spec 13 AS-040 / AS-022 / AS-032 / AS-020: Create Subtitles (the command it builds, live dry-run counts, the font
// notice, one History entry), the Subtitles tab (a virtualised list of a 2,000-subtitle group, inline edit) and the
// Select ▸ Subtitle Group / Same Template helpers.
import { BUILTIN_SUBTITLE_TEMPLATES, captionOf, FLICKS_PER_SECOND, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fontsStore } from '../src/fonts/store.ts';
import { CreateSubtitlesDialog, parseRule } from '../src/subtitles/CreateSubtitlesDialog.tsx';
import { DEFAULT_CREATE_OPTIONS, generateCommand, previewGeneration } from '../src/subtitles/model.ts';
import { SAME_TEMPLATE_HELPER, SUBTITLE_GROUP_HELPER } from '../src/subtitles/register.ts';
import { SubtitlesTab, visibleRows } from '../src/subtitles/SubtitlesTab.tsx';
import { makeSession, renderWithSession } from './inspector-helpers.tsx';

// the rendered preview frame (a Remotion Thumbnail) is not what these tests look at
vi.mock('../src/panels/program/FrameView.tsx', () => ({
	FrameView: (p: { testId: string; frame: number }) => <div data-testid={p.testId} data-frame={p.frame} />,
}));

afterEach(() => cleanup());

function asset() {
	return {
		kind: 'video',
		fingerprint: `q1:${'7'.repeat(64)}`,
		originalName: 'talk.mp4',
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 4000 * FLICKS_PER_SECOND,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'h264',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
				{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_talk' }],
		derivation: null,
		importedAt: '2026-10-25T00:00:00.000Z',
	};
}

/** A session with a transcribed clip on V1/A1: `words` words of 0.4 s, back to back. */
function talk(words = 12): EditorSession {
	const session = makeSession();
	const ok = (commands: unknown[]) => {
		const r = session.apply({ label: 'setup', origin: 'user', commands: commands as never });
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const mediaId = (ok([{ type: 'media.register', asset: asset() }]).results[0] as { mediaId: string }).mediaId;
	ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1', audio: ['A1'] }, mode: 'overwrite' }]);
	const s = (x: number) => Math.round(x * FLICKS_PER_SECOND);
	ok([
		{
			type: 'transcript.create',
			mediaId,
			language: 'es',
			origin: 'manual',
			words: Array.from({ length: words }, (_, i) => ({ text: `p${i}`, start: s(i * 0.4), end: s(i * 0.4 + 0.38) })),
		},
	]);
	return session;
}
const seqOf = (s: EditorSession) => Object.values(s.getCommitted().sequences)[0] as Sequence;

describe('Create Subtitles (AS-040)', () => {
	it('builds one captions.generate command from the choices', () => {
		const tpl = BUILTIN_SUBTITLE_TEMPLATES.find((t) => t.id === 'builtin:pixel-pop')!;
		const cmd = generateCommand(
			{ ...DEFAULT_CREATE_OPTIONS, rules: { maxWords: 2 }, text: { case: 'upper' }, language: 'es', nest: true },
			{ sequenceId: 'seq_1', source: { kind: 'media', mediaId: 'med_1' }, range: { start: 0, end: 90 }, template: tpl },
		);
		expect(cmd).toEqual({
			type: 'captions.generate',
			sequenceId: 'seq_1',
			source: { mediaId: 'med_1' },
			template: 'builtin:pixel-pop',
			rules: { maxWords: 2 },
			text: { case: 'upper' },
			language: 'es',
			nest: true,
		});
		expect(parseRule('off', { min: 1, max: 20, nullable: true })).toEqual({ ok: true, value: null });
		expect(parseRule('99', { min: 1, max: 20 })).toEqual({ ok: false });
		expect(parseRule('', { min: 1, max: 20 })).toEqual({ ok: true, value: undefined });
	});
	it('previews the counts on a copy of the document and creates in one History entry', async () => {
		const session = talk(12);
		const before = session.getCommitted();
		const p = previewGeneration(before, generateCommand(DEFAULT_CREATE_OPTIONS, { sequenceId: seqOf(session).id, source: { kind: 'sequence' }, range: null, template: BUILTIN_SUBTITLE_TEMPLATES[0]! }));
		expect(p.ok && p.stats.count).toBe(4);
		expect(session.getCommitted()).toBe(before);
		const close = vi.fn();
		renderWithSession(session, <CreateSubtitlesDialog session={session} sequenceId={seqOf(session).id} close={close} />);
		await waitFor(() => expect(screen.getByTestId('subtitles-count').textContent).toBe('4'));
		// font notice: Pixel12x10 is not in the (empty) font catalogue
		expect(screen.getByTestId('subtitles-font-notice')).toBeTruthy();
		fireEvent.change(screen.getByTestId('subtitles-rule-maxWords'), { target: { value: '1' } });
		await waitFor(() => expect(screen.getByTestId('subtitles-count').textContent).toBe('12'));
		const entries = session.getState().history.entries.length;
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		});
		expect(close).toHaveBeenCalledWith(true);
		const h = session.getState().history.entries;
		expect(h.length).toBe(entries + 1);
		expect(h[h.length - 1]!.label).toBe('Create Subtitles');
		const subs = Object.values(seqOf(session).clips).filter((c) => captionOf(c));
		expect(subs).toHaveLength(12);
		session.undo();
		expect(Object.values(seqOf(session).clips).filter((c) => captionOf(c))).toHaveLength(0);
	});
	it('hides the font notice when the family is installed', async () => {
		fontsStore().setState({
			status: 'ready',
			catalog: { fonts: [{ family: 'Pixel12x10', source: 'custom', weights: [500], styles: ['normal'], files: [{ weight: 500, style: 'normal', url: '/fonts/library/x.ttf' }] as never }] },
		});
		const session = talk(4);
		renderWithSession(session, <CreateSubtitlesDialog session={session} sequenceId={seqOf(session).id} close={() => {}} />);
		await waitFor(() => expect(screen.getByTestId('subtitles-count')).toBeTruthy());
		expect(screen.queryByTestId('subtitles-font-notice')).toBeNull();
		fontsStore().setState({ status: 'offline', catalog: null });
	});
});

describe('Subtitles tab (AS-040)', () => {
	it('draws only a window of a 2,000-subtitle group; an inline edit is one History entry', () => {
		expect(visibleRows(2000, 0, 300)).toEqual([0, 18]);
		expect(visibleRows(2000, 30_000, 300)).toEqual([992, 1018]);
		const session = talk(2000);
		const r = session.apply({
			label: 'Create Subtitles',
			origin: 'user',
			commands: [{ type: 'captions.generate', rules: { maxWords: 1 }, cutAware: false }],
		});
		expect(r.ok).toBe(true);
		renderWithSession(session, <SubtitlesTab session={session} seq={seqOf(session)} />);
		const list = screen.getByTestId('subtitles.list');
		expect(list.getAttribute('data-rows')).toBe('2000');
		const rows = screen.getAllByTestId('subtitles.row');
		expect(rows.length).toBeLessThan(60);
		const first = screen.getAllByTestId('subtitles.rowText')[0] as HTMLTextAreaElement;
		const n = session.getState().history.entries.length;
		fireEvent.change(first, { target: { value: 'hola' } });
		fireEvent.blur(first);
		expect(session.getState().history.entries.length).toBe(n + 1);
		const c = Object.values(seqOf(session).clips).find((x) => captionOf(x) && x.start === 0)!;
		expect(c.kind === 'text' && c.content.text).toBe('hola');
	});
});

describe('Select ▸ Subtitle Group / Same Template (AS-032)', () => {
	it('selects the primary subtitle\'s group, and every subtitle of groups with its template', () => {
		const session = talk(8);
		const ok = (cmd: unknown) => {
			const r = session.apply({ label: 'g', origin: 'user', commands: [cmd as never] });
			if (!r.ok) throw new Error(JSON.stringify(r.errors));
			return r.results[0] as { clipIds: string[] };
		};
		const a = ok({ type: 'captions.generate', template: 'builtin:minimal', rules: { maxWords: 2 }, cutAware: false });
		const b = ok({ type: 'captions.generate', template: 'builtin:minimal', rules: { maxWords: 4 }, cutAware: false, trackId: 'new' });
		const c = ok({ type: 'captions.generate', template: 'builtin:bold-pop', cutAware: false, trackId: 'new' });
		const seq = seqOf(session);
		const doc = session.getCommitted();
		const primary = seq.clips[a.clipIds[0]!]!;
		const input = { doc, seq, selected: [primary], primary };
		expect(SUBTITLE_GROUP_HELPER.select(input).sort()).toEqual([...a.clipIds].sort());
		expect(SAME_TEMPLATE_HELPER.select(input).sort()).toEqual([...a.clipIds, ...b.clipIds].sort());
		expect(SAME_TEMPLATE_HELPER.select(input)).not.toContain(c.clipIds[0]);
		expect(SUBTITLE_GROUP_HELPER.unavailable?.({ ...input, primary: null })).toBeTruthy();
	});
});
