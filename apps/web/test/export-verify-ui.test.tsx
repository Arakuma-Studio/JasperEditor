// spec 18 AF-VER-004/005 in the editor: the export-finished toast's Verify belongs to its project (it is dismissed when
// that project closes, so it never acts on a closed session); the Export dialog remembers the platform preset per
// sequence (validated on load, reset where none was chosen) and judges the frame size the preset writes.
import type { ExportSettings, RenderPlan } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportMode } from '../src/export/ExportMode.tsx';
import { exportMode } from '../src/export/mode.ts';
import { loadExportChoice, saveExportChoice, validateExport } from '../src/export/settings.ts';
import { notices, useSessionNotices } from '../src/home/notices.tsx';
import { EngineProvider } from '../src/state/engine.tsx';
import { memorySession, ScriptedEngine } from './wp2e/helpers.ts';

afterEach(() => {
	cleanup();
	for (const n of notices.getAll()) notices.dismiss(n.id);
	exportMode.close();
	localStorage.clear();
});

describe('export toast Verify belongs to its project', () => {
	it('notices pushed for a session are dismissed when that session closes', async () => {
		const a = (await memorySession()).session;
		const b = (await memorySession()).session;
		const { result, rerender, unmount } = renderHook(({ s }) => useSessionNotices(s), {
			initialProps: { s: a as EditorSession },
		});
		act(() => {
			result.current.push({ kind: 'success', message: 'Export finished: a.mp4', durationMs: null });
		});
		notices.push({ kind: 'info', message: 'unrelated', durationMs: null });
		expect(notices.getAll().map((n) => n.message)).toEqual(['Export finished: a.mp4', 'unrelated']);
		// another project opens: the first project's toast (and its Verify) goes
		rerender({ s: b });
		expect(notices.getAll().map((n) => n.message)).toEqual(['unrelated']);
		act(() => {
			result.current.push({ kind: 'success', message: 'Export finished: b.mp4', durationMs: null });
		});
		unmount();
		expect(notices.getAll().map((n) => n.message)).toEqual(['unrelated']);
	});
});

describe('Export dialog platform preset', () => {
	it('is remembered per sequence, validated on load, reset where none was chosen', () => {
		saveExportChoice('prj_1', 'seq_a', { range: 'entire', engine: 'auto', platform: 'tiktok' });
		expect(loadExportChoice('prj_1', 'seq_a')?.platform).toBe('tiktok');
		localStorage.setItem(
			'jasper.export.prj_1.seq_b',
			JSON.stringify({ range: 'entire', platform: 'myspace' }),
		);
		expect(loadExportChoice('prj_1', 'seq_b')?.platform).toBeUndefined();
	});

	async function setup() {
		const { session } = await memorySession();
		const first = Object.keys(session.getCommitted().sequences)[0]!;
		const r = session.apply({
			label: 'Setup',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', sequenceId: first, at: 0, duration: 60, track: 'V1', color: [0, 0, 1, 1] },
				{ type: 'sequence.create', name: 'Odd', preset: 'hd-1080p-30', ref: '$s' },
			] as never,
		});
		if (!r.ok) throw new Error(r.errors[0]!.message);
		const second = r.refs.$s!;
		const r2 = session.apply({
			label: 'Second',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', sequenceId: second, at: 0, duration: 60, track: 'V1', color: [0, 1, 0, 1] },
			] as never,
		});
		if (!r2.ok) throw new Error(r2.errors[0]!.message);
		const engine = new ScriptedEngine();
		const planned: ExportSettings[] = [];
		engine.on((q) => {
			if (q.path === '/api/exports/plan') {
				const s = (q.body as { settings: ExportSettings }).settings;
				planned.push(s);
				return {
					body: {
						planId: 'pln_1',
						documentRevision: 0,
						path: 'native',
						segments: [],
						audio: { mode: 'native-mix' },
						blockers: [],
						warnings: [],
						estimate: { seconds: 1, bytes: 1 },
					} satisfies RenderPlan,
				};
			}
			return undefined;
		});
		const wrap = (children: ReactNode) => (
			<EngineProvider client={engine.client()}>
				<MemoryRouter initialEntries={['/']}>
					<SessionProvider session={session}>{children}</SessionProvider>
				</MemoryRouter>
			</EngineProvider>
		);
		return { session, first, second, wrap, planned };
	}

	it('switching sequences loads that sequence’s preset or resets it', async () => {
		const { session, first, second, wrap } = await setup();
		saveExportChoice(session.projectId, second, { range: 'entire', engine: 'auto', platform: 'x' });
		render(wrap(<ExportMode sequenceId={first} />));
		const preset = () => (screen.getByTestId('export-preset') as HTMLSelectElement).value;
		fireEvent.change(screen.getByTestId('export-preset'), { target: { value: 'youtube' } });
		expect(preset()).toBe('youtube');
		fireEvent.change(screen.getByTestId('export-source'), { target: { value: second } });
		expect(preset()).toBe('x');
		fireEvent.change(screen.getByTestId('export-source'), { target: { value: first } });
		expect(preset()).toBe('');
	});

	it('an odd-sized sequence is judged by the size the platform preset writes', async () => {
		const { session, second } = await setup();
		const seq = session.getCommitted().sequences[second]!;
		// invariants keep sizes even; a sequence read from elsewhere may still be odd
		const odd = { ...seq, settings: { ...seq.settings, width: 1081, height: 607 } };
		const range = { start: 0, end: 60 };
		expect(validateExport(odd, range).join(' ')).toMatch(/even width and height/);
		expect(validateExport(odd, range, 'video', 'youtube')).toEqual([]);
		// a preset that refuses the shape is reported by the preset, not as an odd size
		expect(validateExport(odd, range, 'video', 'tiktok')).toEqual([]);
	});
});
