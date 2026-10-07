// wp interchange UI: File ▸ Import routes timeline documents to the engine and adds the fragment in one transaction
// (offline media as placeholders, then Link Media); File ▸ Export ▸ <format> builds the engine request, follows the
// job and shows the report; the menus carry the entries.
import type { EngineJob, InterchangeExportResult } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import { importTimeline } from '@jasper/interchange';
import { checkInvariants, defaultRegistries } from '@jasper/project';
import { DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { getCommand } from '../src/commands/registry.ts';
import { InterchangeExportDialog, offlineMedia, relinkCommand } from '../src/interchange/dialogs.tsx';
import { isTimelineFileName, isTimelineXmlHead } from '../src/interchange/formats.ts';
import { importTimelineFiles } from '../src/interchange/import.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { makeSession } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(cleanup);

const EDL = `TITLE: Cut 1
FCM: NON-DROP FRAME

001  A001     V     C        01:00:00:00 01:00:02:00 00:00:00:00 00:00:02:00
* FROM CLIP NAME: A001.mov
* SOURCE FILE: /footage/A001.mov
002  B002     V     C        02:00:01:00 02:00:03:00 00:00:02:00 00:00:04:00
* FROM CLIP NAME: B002.mov
`;

type Call = { method: string; url: string; body: unknown };

/** An engine whose import route runs @jasper/interchange (no media found) and whose export job succeeds. */
function fakeEngine(calls: Call[], result?: InterchangeExportResult) {
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		calls.push({ method: init?.method ?? 'GET', url, body });
		const json = (v: unknown, status = 200) =>
			new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
		if (url.endsWith('/api/interchange/import')) {
			const bytes = Uint8Array.from(atob(body.file.contentBase64), (c) => c.charCodeAt(0));
			const r = importTimeline(bytes, { fileName: body.file.name, rate: { num: 30, den: 1 } });
			return json({ format: r.format, fragment: r, missing: r.missing, warnings: r.warnings, extracted: [] });
		}
		if (url.endsWith('/api/interchange/prerender-plan')) return json({ mode: 'unsupported', clips: [] });
		const job = (state: string): EngineJob =>
			({
				id: 'job_ix1',
				kind: 'interchange-export',
				state,
				title: 'Export',
				priority: 'user',
				cpuSlots: 0,
				progress: state === 'succeeded' ? 1 : 0.5,
				stage: state === 'succeeded' ? 'Done' : 'Writing',
				createdAt: '2026-10-07T00:00:00.000Z',
				origin: { type: 'user' },
				...(state === 'succeeded' ? { result, finishedAt: '2026-10-07T00:00:01.000Z' } : {}),
			}) as unknown as EngineJob;
		if (url.endsWith('/api/interchange/export')) return json(job('running'), 202);
		if (url.includes('/api/jobs/job_ix1')) return json(job('succeeded'));
		return json({}, 404);
	};
	return new EngineClient({ fetch: fetchImpl as typeof fetch });
}

describe('interchange UI', () => {
	it('recognises timeline documents by extension and FCP7 XML by content', () => {
		for (const n of ['a.fcpxml', 'b.otio', 'c.EDL', 'd.aaf', 'e.omf', 'f.ale'])
			expect(isTimelineFileName(n)).toBe(true);
		expect(isTimelineFileName('clip.mov')).toBe(false);
		expect(isTimelineFileName('subs.xml')).toBe(false);
		expect(isTimelineXmlHead('<?xml version="1.0"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">')).toBe(true);
		expect(isTimelineXmlHead('<tt xmlns="http://www.w3.org/ns/ttml">')).toBe(false);
	});

	it('imports an EDL as one undoable transaction with offline placeholders, then links one', async () => {
		const { session } = makeSession();
		const calls: Call[] = [];
		const engine = fakeEngine(calls);
		const before = Object.keys(session.getCommitted().sequences).length;
		const file = new File([EDL], 'Cut 1.edl');
		const r = await importTimelineFiles(session, engine, { files: [file], paths: [] }, null);
		expect(r.failed).toEqual([]);
		expect(r.reports.length).toBe(1);
		expect(r.reports[0]!.format).toBe('edl');
		expect(r.reports[0]!.missing.map((m) => m.name).sort()).toEqual(['A001.mov', 'B002.mov']);
		const doc = session.getCommitted();
		expect(Object.keys(doc.sequences).length).toBe(before + 1);
		expect(checkInvariants(doc, { effects: defaultRegistries().effects })).toEqual([]);
		const offline = offlineMedia(session);
		expect(offline.length).toBe(2);
		// Link Media is offered (File menu and Project panel)
		const ctx = createCommandContext({
			engine,
			session,
			focus: { panel: 'project', instanceId: 'p' },
			toast: () => {},
		});
		expect(getCommand('project.linkMedia')!.when!(ctx)).toBe(true);
		// relink one placeholder to a registered file
		const a = offline.find((m) => m.originalName === 'A001.mov')!;
		const reg = {
			mediaKey: 'mk_a001',
			fingerprint: 'sha256-partial:abc',
			originalName: 'A001.mov',
			sizeBytes: 1000,
			container: 'mov',
			kind: 'video' as const,
			probe: a.probe,
			locators: [{ type: 'path' as const, path: '/new/A001.mov', relativeToProject: null }],
			browserPlayable: 'yes' as const,
		};
		const t = session.apply({
			label: 'Link Media',
			origin: 'user',
			commands: [relinkCommand(a.id, reg, false) as never],
		});
		expect(t.ok).toBe(true);
		const linked = session.getCommitted().media[a.id]!;
		expect(linked.fingerprint).toBe('sha256-partial:abc');
		expect(linked.locators[0]).toEqual({ type: 'engine-store', engineId: 'local', key: 'mk_a001' });
		expect(offlineMedia(session).map((m) => m.originalName)).toEqual(['B002.mov']);
		// one undo removes the whole import
		session.undo();
		session.undo();
		expect(Object.keys(session.getCommitted().sequences).length).toBe(before);
	});

	it('the export dialog sends the options, follows the job and shows the report', async () => {
		const { session, seqId } = makeSession();
		const calls: Call[] = [];
		const result: InterchangeExportResult = {
			format: 'edl',
			files: [
				{
					name: 'Sequence 01.edl',
					downloadUrl: '/renders/job_ix1/interchange/Sequence%2001.edl',
					byteSize: 120,
					role: 'document',
				},
			],
			prerendered: [],
			warnings: [
				{
					level: 'warning',
					message: 'text clip "Title" at frame 0 has no equivalent in this format',
					count: 1,
					instead: 'nothing',
				},
			],
		};
		const engine = fakeEngine(calls, result);
		render(<DialogHost />);
		let closed: unknown = null;
		render(
			<InterchangeExportDialog
				session={session}
				engine={engine}
				sequenceId={seqId}
				format="edl"
				close={(r) => (closed = r)}
			/>,
		);
		expect(await screen.findByTestId('interchange-export-dialog')).toBeTruthy();
		fireEvent.click(screen.getByLabelText('32-character reel names'));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Export' }));
		});
		await waitFor(() => expect(closed).not.toBeNull());
		const req = calls.find((c) => c.url.endsWith('/api/interchange/export'))!.body as {
			format: string;
			sequenceId: string;
			options: { edl: { reelLength: number; videoTrack: number }; prerender: string };
		};
		expect(req.format).toBe('edl');
		expect(req.sequenceId).toBe(seqId);
		expect(req.options.edl.reelLength).toBe(32);
		expect(req.options.edl.videoTrack).toBe(0);
		expect(req.options.prerender).toBe('unsupported');
		expect(await screen.findByTestId('interchange-report')).toBeTruthy();
		expect(screen.getByTestId('interchange-report-warnings').textContent).toContain('text clip "Title"');
		expect(screen.getByText('Sequence 01.edl').getAttribute('href')).toContain(
			'/renders/job_ix1/interchange/',
		);
	});

	it('the File menu has the timeline exports and Link Media', () => {
		const file = MENUBAR.find((m) => m.id === 'file')!;
		const exp = file.items.find((i) => i.type === 'submenu' && i.label === 'Export') as {
			items: { type: string; command?: string; label?: string; args?: { format: string } }[];
		};
		const timeline = exp.items.filter((i) => i.command === 'file.exportTimeline');
		expect(timeline.map((i) => [i.label, i.args!.format])).toEqual([
			['Final Cut Pro XML…', 'fcp7'],
			['FCPXML…', 'fcpxml'],
			['OpenTimelineIO…', 'otio'],
			['EDL…', 'edl'],
			['AAF…', 'aaf'],
			['OMF…', 'omf'],
			['Avid ALE…', 'ale'],
		]);
		expect(file.items.some((i) => i.type === 'command' && i.command === 'project.linkMedia')).toBe(true);
		expect(getCommand('file.exportTimeline')).toBeTruthy();
		void runCommand;
	});
});
