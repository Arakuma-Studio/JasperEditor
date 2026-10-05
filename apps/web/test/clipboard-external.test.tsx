// External clipboard content (wp-clipboard-2, S01:CLB-010): files and image data from the paste event, the async
// Clipboard API (Edit ▸ Paste) and the desktop bridge are told apart; image data is uploaded as "Pasted image
// <time>" and placed at the playhead on the lowest targeted tracks with the Timeline or Program focused (one
// "Import 1 file" step), files keep their names (desktop paths register in place), plain text becomes a 5 s
// centred text clip on the lowest targeted video track (one "Paste Text" step); text fields keep their paste.
import { EngineClient } from '@jasper/engine-client';
import {
	buildClipsPayload,
	type Clip,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	encodeClipboardHtml,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installClipboardEvents } from '../src/clipboard/events.ts';
import {
	clipboardMemory,
	externalContentOf,
	pasteSourceOf,
	readClipboardEvent,
	readSystemClipboard,
	withDesktopFiles,
	writeClipboard,
} from '../src/clipboard/system.ts';
import {
	type CommandCtx,
	createCommandContext,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { ClientJobStore } from '../src/import/client-jobs.ts';
import type { ImportPrompts } from '../src/import/prompts.ts';
import { EngineImportService } from '../src/import/service.ts';
import { createUnloadGuard } from '../src/import/unload-guard.ts';
import { registerImportService } from '../src/state/services.ts';
import { registered, ScriptedEngine } from './wp2e/helpers.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

beforeAll(() => registerAllCommands());
beforeEach(() => clipboardMemory.clear());
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	delete (window as { jasperDesktop?: unknown }).jasperDesktop;
});

function project(seed: number) {
	const ids = createCounterIdSource(seed);
	const doc = createEmptyProject({ ids, name: `P${seed}`, preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-01T00:00:00.000Z', registries: defaultRegistries() },
		coalesceWindowMs: 0,
	});
	const seqId = Object.keys(doc.sequences)[0]!;
	session.openSequence(seqId);
	const toasts: ToastRequest[] = [];
	const ctxFor = (panel: CommandCtx['focus']['panel']) =>
		createCommandContext({
			engine,
			session,
			focus: { panel, instanceId: panel ?? 'x' },
			toast: (r) => toasts.push(r),
		});
	const seq = () => session.getCommitted().sequences[seqId]!;
	const history = () => session.getState().history.entries.map((e) => e.label);
	return { session, seqId, ctxFor, seq, toasts, history };
}

/** An import service over a scripted engine that registers every upload as an image (or a video by extension). */
function importService(session: EditorSession) {
	const scripted = new ScriptedEngine();
	scripted.media = new (class extends Map<string, ReturnType<typeof registered>> {
		override get(name: string) {
			return registered(name, /\.(png|jpg|webp)$/.test(name) ? { kind: 'image' } : { seconds: 2 });
		}
	})();
	const prompts: ImportPrompts = {
		duplicates: async () => 'import-again',
		clipMismatch: async () => 'keep',
		failures: () => undefined,
	};
	const service = new EngineImportService({
		engine: scripted.client(),
		session,
		prompts,
		jobs: new ClientJobStore(),
		unloadGuard: createUnloadGuard(new EventTarget()),
		desktop: null,
	});
	const off = registerImportService(service);
	return { scripted, service, off };
}

const png = (name = 'image.png') =>
	new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

describe('telling external content apart (CLB-010)', () => {
	it('splits image data, named files, desktop paths and text', () => {
		const data = {
			html: null,
			text: 'ignored when files are there',
			files: 3,
			blobs: [png(), png('holiday.png'), new File(['x'], 'clip.mp4', { type: 'video/mp4' })],
		};
		const c = externalContentOf(data, () => null);
		expect(c.images.map((f) => f.name)).toEqual(['image.png']);
		expect(c.files.map((f) => f.name)).toEqual(['holiday.png', 'clip.mp4']);
		expect(c.text).toBeNull();
		// Desktop: Files with a path register in place, image data stays data.
		const desk = externalContentOf({ ...data, paths: ['/m/a.mov'] }, (f) =>
			f.name === 'image.png' ? '' : `/m/${f.name}`,
		);
		expect(desk.paths).toEqual(['/m/a.mov', '/m/holiday.png', '/m/clip.mp4']);
		expect(desk.images).toHaveLength(1);
		expect(externalContentOf({ html: '<b>Hi</b>', text: 'Hi', files: 0 }, () => null)).toEqual({
			files: [],
			paths: [],
			images: [],
			text: 'Hi',
		});
		expect(externalContentOf({ html: null, text: '  \n ', files: 0 }).text).toBeNull();
	});

	it('foreign files win over our in-memory copy; JasperEditor HTML is still a payload', () => {
		const p = project(30);
		p.session.apply({
			label: 's',
			origin: 'user',
			commands: [
				{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'A' }, ref: '$a' },
			],
		});
		const id = Object.keys(p.seq().clips)[0]!;
		p.session.select('timeline', [id]);
		void runCommand('edit.copy', p.ctxFor('timeline'));
		const stored = clipboardMemory.get()!;
		stored.systemWritten = true;
		// Same text as our copy but a file: foreign.
		expect(
			pasteSourceOf({ html: null, text: stored.text, files: 1, blobs: [png()] }, () => null),
		).toMatchObject({
			kind: 'external',
			content: { images: [expect.any(File)] },
		});
		expect(
			pasteSourceOf({ html: encodeClipboardHtml(stored.json, stored.text), text: stored.text, files: 0 }),
		).toMatchObject({ kind: 'payload', from: 'system' });
	});

	it('reads the files of a paste event while it is dispatched (files, else file items)', () => {
		const file = png();
		const e = new Event('paste') as ClipboardEvent;
		Object.defineProperty(e, 'clipboardData', {
			value: { getData: () => '', files: [], items: [{ kind: 'file', getAsFile: () => file }] },
		});
		expect(readClipboardEvent(e)).toEqual({ html: null, text: null, files: 1, blobs: [file] });
	});

	it('Edit ▸ Paste reads image data through the async Clipboard API and file paths through the desktop', async () => {
		const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
		vi.stubGlobal('navigator', {
			clipboard: {
				read: async () => [
					{
						types: ['image/png', 'text/plain'],
						getType: async (t: string) => (t === 'image/png' ? blob : new Blob(['caption'])),
					},
				],
			},
		});
		const web = await readSystemClipboard();
		expect(web).toMatchObject({ text: 'caption', files: 1 });
		expect(web!.blobs![0]).toMatchObject({ name: 'image.png', type: 'image/png' });
		(window as { jasperDesktop?: unknown }).jasperDesktop = {
			runtime: 'desktop',
			clipboard: { write: async () => true, read: async () => null, readFiles: async () => ['/m/a.mov'] },
		};
		const desk = await readSystemClipboard();
		expect(desk).toMatchObject({ paths: ['/m/a.mov'], files: 2 });
	});
});

describe('pasting text (CLB-010)', () => {
	it('Timeline focus: a 5 s centred text clip at the playhead on the lowest targeted video track, one undo step', async () => {
		const p = project(31);
		p.session.setView(p.seqId, { targeting: { video: [p.seq().videoTracks[1]!.id], audio: [] } });
		p.session.transport.seek(45);
		await runCommand('edit.paste', p.ctxFor('timeline'), {
			clipboard: { html: null, text: 'Hello\r\nWorld  \r\n', files: 0 },
		});
		const clips = Object.values(p.seq().clips) as Extract<Clip, { kind: 'text' }>[];
		expect(clips).toHaveLength(1);
		const t = clips[0]!;
		expect(t.kind).toBe('text');
		expect(t.content.text).toBe('Hello\nWorld');
		expect([t.trackId, t.start, t.duration]).toEqual([p.seq().videoTracks[1]!.id, 45, 150]);
		expect(p.session.getState().selection.timeline.clips).toEqual([t.id]);
		expect(p.history()).toEqual(['Paste Text']);
		p.session.undo();
		expect(Object.keys(p.seq().clips)).toHaveLength(0);
		await runCommand('edit.paste', p.ctxFor('timeline'), {
			clipboard: { html: null, text: 'x'.repeat(5010), files: 0 },
		});
		expect((Object.values(p.seq().clips)[0] as Extract<Clip, { kind: 'text' }>).content.text).toHaveLength(
			5000,
		);
	});

	it('Program focus pastes text too; the Project panel and Paste Insert explain instead of changing anything', async () => {
		const p = project(32);
		await runCommand('edit.paste', p.ctxFor('program'), {
			clipboard: { html: null, text: 'Title', files: 0 },
		});
		expect(Object.keys(p.seq().clips)).toHaveLength(1);
		await runCommand('edit.paste', p.ctxFor('project'), {
			clipboard: { html: null, text: 'Title', files: 0 },
		});
		expect(p.toasts.at(-1)?.kind).toBe('info');
		await runCommand('edit.pasteInsert', p.ctxFor('timeline'), {
			clipboard: { html: null, text: 'Title', files: 0 },
		});
		expect(p.toasts.at(-1)?.kind).toBe('info');
		expect(Object.keys(p.seq().clips)).toHaveLength(1);
		expect(p.history()).toEqual(['Paste Text']);
	});
});

describe('pasting images and files (CLB-010, LIFE-010)', () => {
	it('image data becomes "Pasted image <time>", uploaded and placed at the playhead in one step', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 9, 1, 14, 3, 22));
		const p = project(34);
		const { scripted, off } = importService(p.session);
		try {
			p.session.setView(p.seqId, {
				targeting: { video: [p.seq().videoTracks[2]!.id], audio: [p.seq().audioTracks[1]!.id] },
			});
			p.session.transport.seek(30);
			await runCommand('edit.paste', p.ctxFor('timeline'), {
				clipboard: { html: null, text: null, files: 1, blobs: [png()] },
			});
			const upload = scripted.requests.find((r) => r.path === '/api/uploads')!;
			expect((upload.body as { fileName: string }).fileName).toBe('Pasted image 2026-10-01 14.03.22.png');
			const doc = p.session.getCommitted();
			const items = Object.values(doc.items).filter((i) => i.kind === 'media');
			expect(items.map((i) => i.name)).toEqual(['Pasted image 2026-10-01 14.03.22']);
			const clips = Object.values(p.seq().clips);
			expect(clips).toHaveLength(1);
			expect([clips[0]!.trackId, clips[0]!.start]).toEqual([p.seq().videoTracks[2]!.id, 30]);
			expect(p.history()).toEqual(['Import 1 file']);
			p.session.undo();
			expect(Object.keys(p.session.getCommitted().media)).toHaveLength(0);
		} finally {
			off();
		}
	});

	it('files keep their names; with the Project panel focused they are imported, not placed', async () => {
		const p = project(35);
		const { off } = importService(p.session);
		try {
			const mp4 = new File([new Uint8Array(8)], 'clip.mp4', { type: 'video/mp4' });
			await runCommand('edit.paste', p.ctxFor('project'), {
				clipboard: { html: null, text: null, files: 1, blobs: [mp4] },
			});
			const items = Object.values(p.session.getCommitted().items).filter((i) => i.kind === 'media');
			expect(items.map((i) => i.name)).toEqual(['clip.mp4']);
			expect(Object.keys(p.seq().clips)).toHaveLength(0);
			// The Timeline places video and its audio on the lowest targeted tracks.
			await runCommand('edit.paste', p.ctxFor('timeline'), {
				clipboard: { html: null, text: null, files: 1, blobs: [mp4] },
			});
			const clips = Object.values(p.seq().clips);
			expect(clips.map((c) => [c.kind, c.trackId]).sort()).toEqual(
				[
					['audio', p.seq().audioTracks[0]!.id],
					['video', p.seq().videoTracks[0]!.id],
				].sort(),
			);
		} finally {
			off();
		}
	});

	it('reports a failed import instead of throwing', async () => {
		const p = project(36);
		const off = registerImportService({
			importFiles: async () => {
				throw new Error('engine offline');
			},
			placeItems: async () => ({ clipIds: [] }),
			readDataTransfer: () => null,
		});
		try {
			await runCommand('edit.paste', p.ctxFor('timeline'), {
				clipboard: { html: null, text: null, files: 1, blobs: [png()] },
			});
			expect(p.toasts.at(-1)).toMatchObject({
				kind: 'error',
				detail: 'engine offline',
			});
		} finally {
			off();
		}
	});
});

describe('text fields keep their paste (CLB-010)', () => {
	it('a paste event inside an input never runs Edit ▸ Paste; outside it does, with the files', () => {
		const run = vi.fn();
		const off = installClipboardEvents(window, run);
		try {
			const input = document.createElement('input');
			document.body.append(input);
			const inField = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(inField, 'clipboardData', { value: { getData: () => 'x', files: [png()] } });
			input.dispatchEvent(inField);
			expect(run).not.toHaveBeenCalled();
			expect(inField.defaultPrevented).toBe(false);
			const outside = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(outside, 'clipboardData', { value: { getData: () => '', files: [png()] } });
			document.body.dispatchEvent(outside);
			expect(run).toHaveBeenCalledWith('edit.paste', {
				clipboard: { html: null, text: null, files: 1, blobs: [expect.any(File)] },
			});
			input.remove();
		} finally {
			off();
		}
	});
});

describe('desktop transport (CLB-002 defect fix, CLB-010 file lists)', () => {
	function payload() {
		const p = project(50);
		const r = p.session.apply({
			label: 's',
			origin: 'user',
			commands: [
				{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'A' }, ref: '$a' },
			],
		});
		if (!r.ok) throw new Error('setup');
		return buildClipsPayload(p.session.getCommitted(), p.seqId, [r.refs.$a!]);
	}
	function desktop(write: (d: unknown) => Promise<boolean>, readFiles = async () => [] as string[]) {
		const bridge = { write: vi.fn(write), read: async () => null, readFiles: vi.fn(readFiles) };
		(window as { jasperDesktop?: unknown }).jasperDesktop = { runtime: 'desktop', clipboard: bridge };
		return bridge;
	}

	it('writes all formats in one Electron write without a racing web write; falls back to the web when it fails', async () => {
		const exec = vi.fn(() => false);
		const doc = document as unknown as { execCommand: unknown };
		const original = doc.execCommand;
		doc.execCommand = exec;
		try {
			const ok = desktop(async () => true);
			const stored = writeClipboard(payload());
			expect(ok.write).toHaveBeenCalledWith({ json: stored.json, html: expect.any(String), text: 'A' });
			expect(exec).not.toHaveBeenCalled();
			await vi.waitFor(() => expect(stored.systemWritten).toBe(true));
			desktop(async () => false);
			writeClipboard(payload());
			await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('copy'));
		} finally {
			doc.execCommand = original;
		}
	});

	it('answers a native copy event at once and writes the Electron clipboard after it', () => {
		vi.useFakeTimers();
		const bridge = desktop(async () => true);
		const data = new Map<string, string>();
		const e = new Event('copy', { cancelable: true }) as ClipboardEvent;
		Object.defineProperty(e, 'clipboardData', {
			value: { setData: (t: string, v: string) => data.set(t, v) },
		});
		writeClipboard(payload(), { event: e });
		expect([...data.keys()].sort()).toEqual(['text/html', 'text/plain']);
		expect(e.defaultPrevented).toBe(true);
		expect(bridge.write).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(bridge.write).toHaveBeenCalledTimes(1);
	});

	it('completes a paste event without files with the file manager list, never JasperEditor content', async () => {
		const bridge = desktop(
			async () => true,
			async () => ['/m/a.mov'],
		);
		expect(await withDesktopFiles({ html: null, text: '/m/a.mov', files: 0 })).toEqual({
			html: null,
			text: '/m/a.mov',
			files: 1,
			paths: ['/m/a.mov'],
		});
		const ours = { html: encodeClipboardHtml(JSON.stringify(payload()), 'A'), text: 'A', files: 0 };
		expect(await withDesktopFiles(ours)).toBe(ours);
		const withFiles = { html: null, text: null, files: 1, blobs: [png()] };
		expect(await withDesktopFiles(withFiles)).toBe(withFiles);
		expect(bridge.readFiles).toHaveBeenCalledTimes(1);
		delete (window as { jasperDesktop?: unknown }).jasperDesktop;
		const plain = { html: null, text: 'x', files: 0 };
		expect(await withDesktopFiles(plain)).toBe(plain);
	});
});
