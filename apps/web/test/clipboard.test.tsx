// Clipboard in the web app (wp-clipboard, S01 §20, S03:XF-050/FX-012/EC-023): the Edit/Timeline commands per
// focused panel against real sessions (paste at the playhead with the selection following and the playhead at
// the end, Paste Insert, cross-project paste through the system clipboard data, read-only), the paste-source rules,
// the Paste Attributes dialog through the dialog host, the Program monitor layer menu, and the dispatcher's native
// paste (Ctrl/Cmd+V waits for the browser's paste event; text fields keep theirs).
import { EngineClient } from '@jasper/engine-client';
import {
	buildClipsPayload,
	type Clip,
	type ClipboardPayload,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	encodeClipboardHtml,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	pasteAttributeOptions,
	removeAttributeOptions,
	toPasteAttributes,
} from '../src/clipboard/attributes.ts';
import { clipboardMemory, pasteSourceOf, writeClipboard } from '../src/clipboard/system.ts';
import {
	type CommandCtx,
	createCommandContext,
	getCommand,
	isCommandEnabled,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { programLayerMenu } from '../src/panels/program/layer-menu.ts';
import { inspectorFocus } from '../src/panels/properties/lib/focus.ts';
import { awaitNativePaste, installKeyboardDispatcher } from '../src/shell/keymap/dispatcher.ts';
import { videoAsset } from './timeline-helpers.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

beforeAll(() => registerAllCommands());
beforeEach(() => {
	clipboardMemory.clear();
	inspectorFocus.reset();
});
afterEach(() => {
	cleanup();
	closeAllDialogs();
});

function project(seed: number) {
	const ids = createSeededIdSource(seed);
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
	const apply = (commands: unknown[]) => {
		const r = session.apply({ label: 'setup', origin: 'user', commands: commands as never });
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const seq = () => session.getCommitted().sequences[seqId]!;
	const history = () => session.getState().history.entries.map((e) => e.label);
	return { session, seqId, ctxFor, apply, seq, toasts, history };
}

const text = (at: number, track = 'V2', ref?: string) => ({
	type: 'clip.addText',
	at,
	duration: 30,
	track,
	content: { text: `T${at}` },
	textAnimation: { in: { preset: 'fade' } },
	...(ref ? { ref } : {}),
});

describe('timeline copy / paste (CLB-003/004, SEL-006)', () => {
	it('copies the selection and pastes it at the playhead on the targeted track, selecting the copies', async () => {
		const p = project(1);
		const r = p.apply([text(0, 'V2', '$a'), text(30, 'V2', '$b')]);
		p.session.select('timeline', [r.refs.$a!, r.refs.$b!]);
		const ctx = p.ctxFor('timeline');
		expect((await runCommand('edit.copy', ctx)).ran).toBe(true);
		expect(clipboardMemory.get()?.payload.kind).toBe('clips');
		expect(clipboardMemory.get()?.text).toBe('T0\nT30');
		// Target V3 (lowest targeted video track) and paste at frame 100.
		p.session.setView(p.seqId, {
			targeting: { video: [p.seq().videoTracks[2]!.id], audio: [p.seq().audioTracks[0]!.id] },
		});
		p.session.transport.seek(100);
		expect((await runCommand('edit.paste', ctx, { clipboard: null })).ran).toBe(true);
		const sel = p.session.getState().selection.timeline.clips;
		expect(sel).toHaveLength(2);
		expect(sel.map((id) => [p.seq().clips[id]!.trackId, p.seq().clips[id]!.start])).toEqual([
			[p.seq().videoTracks[2]!.id, 100],
			[p.seq().videoTracks[2]!.id, 130],
		]);
		expect(p.session.transport.getState().frame).toBe(160);
		expect(p.history().at(-1)).toBe('Paste');
		p.session.undo();
		expect(Object.keys(p.seq().clips)).toHaveLength(2);
		p.session.redo();
		expect(p.session.getState().selection.timeline.clips).toEqual(sel);
	});

	it('Paste Insert ripples, Cut leaves a gap, and read-only sessions only copy', async () => {
		const p = project(2);
		const r = p.apply([text(0, 'V1', '$a'), text(30, 'V1', '$b')]);
		p.session.select('timeline', [r.refs.$a!]);
		const ctx = p.ctxFor('timeline');
		await runCommand('timeline.cut', ctx);
		expect(Object.values(p.seq().clips).map((c) => c.start)).toEqual([30]);
		p.session.transport.seek(30);
		await runCommand('timeline.pasteInsert', ctx, { clipboard: null });
		const starts = Object.values(p.seq().clips)
			.map((c) => c.start)
			.sort((x, y) => x - y);
		expect(starts).toEqual([30, 60]);
		expect(p.history().slice(-2)).toEqual(['Cut', 'Paste Insert']);
		const ro = new EditorSession({
			projectId: 'prj_0000000000000000',
			document: p.session.getCommitted(),
			ctx: p.session.ctx,
			readOnly: true,
		});
		const roCtx = createCommandContext({
			engine,
			session: ro,
			focus: { panel: 'timeline', instanceId: 'x' },
		});
		ro.select('timeline', [Object.keys(p.seq().clips)[0]!]);
		expect(isCommandEnabled(getCommand('edit.copy')!, roCtx)).toBe(true);
		expect(isCommandEnabled(getCommand('edit.paste')!, roCtx)).toBe(false);
		expect(getCommand('edit.paste')!.disabledReason!(roCtx)).toBe('The project is open read-only');
		expect(getCommand('edit.cut')!.disabledReason!(roCtx)).toBe('The project is open read-only');
	});

	it('Duplicate selects the copies, and Redo restores that selection (defect fix, SEL-008)', async () => {
		const p = project(13);
		const r = p.apply([text(0, 'V1', '$a')]);
		p.session.select('timeline', [r.refs.$a!]);
		await runCommand('timeline.duplicate', p.ctxFor('timeline'));
		const copies = p.session.getState().selection.timeline.clips;
		expect(copies).toHaveLength(1);
		expect(copies[0]).not.toBe(r.refs.$a);
		p.session.undo();
		expect(p.session.getState().selection.timeline.clips).toEqual([r.refs.$a]);
		p.session.redo();
		expect(p.session.getState().selection.timeline.clips).toEqual(copies);
	});

	it('pastes into another project from the system clipboard data, resolving media (CLB-008)', async () => {
		const a = project(3);
		const reg = a.apply([{ type: 'media.register', asset: videoAsset(10) }]);
		const mediaId = (reg.results[0] as { mediaId: string }).mediaId;
		const placed = a.apply([
			{
				type: 'clip.place',
				source: { mediaId },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
			},
		]);
		a.session.select('timeline', (placed.results[0] as { clipIds: string[] }).clipIds);
		await runCommand('edit.copy', a.ctxFor('program'));
		const stored = clipboardMemory.get()!;
		// Another tab: its memory is empty, the paste event carries the HTML written by the copy.
		clipboardMemory.clear();
		const b = project(4);
		const html = encodeClipboardHtml(stored.json, stored.text);
		await runCommand('edit.paste', b.ctxFor('timeline'), {
			clipboard: { html, text: stored.text, files: 0 },
		});
		const clips = Object.values(b.seq().clips) as (Clip & { mediaId: string })[];
		expect(clips.map((c) => c.kind).sort()).toEqual(['audio', 'video']);
		const media = b.session.getCommitted().media[clips[0]!.mediaId]!;
		expect(media.fingerprint).toBe(a.session.getCommitted().media[mediaId]!.fingerprint);
		expect(media.id).not.toBe(mediaId);
		expect(clips[0]!.linkId).toBe(clips[1]!.linkId);
	});
});

describe('paste source rules (CLB-002/009)', () => {
	function payload(): ClipboardPayload {
		const p = project(5);
		const r = p.apply([text(0, 'V1', '$a')]);
		return buildClipsPayload(p.session.getCommitted(), p.seqId, [r.refs.$a!]);
	}

	it('prefers JasperEditor content on the system clipboard, rejects newer versions, detects foreign content', () => {
		const pl = payload();
		const json = JSON.stringify(pl);
		expect(pasteSourceOf({ html: encodeClipboardHtml(json, 'x'), text: 'x', files: 0 })).toMatchObject({
			kind: 'payload',
			from: 'system',
		});
		const v2 = encodeClipboardHtml(JSON.stringify({ ...pl, version: 2 }), 'x');
		expect(pasteSourceOf({ html: v2, text: 'x', files: 0 })).toMatchObject({ kind: 'error' });
		expect(pasteSourceOf(null)).toEqual({ kind: 'empty' });
		const stored = writeClipboard(pl);
		// Same text as our copy (the HTML was lost): still ours.
		expect(pasteSourceOf({ html: null, text: stored.text, files: 0 })).toMatchObject({ from: 'memory' });
		stored.systemWritten = true;
		expect(pasteSourceOf({ html: null, text: 'something else', files: 0 })).toEqual({
			kind: 'external',
			content: { files: [], paths: [], images: [], text: 'something else' },
		});
		// Our copy never reached the system clipboard: the in-memory copy wins over older foreign content.
		stored.systemWritten = false;
		expect(pasteSourceOf({ html: null, text: 'something else', files: 0 })).toMatchObject({ from: 'memory' });
	});
});

describe('Effect Controls and Project panel clipboard (CLB-006/007)', () => {
	it('copies selected keyframes and pastes them at the playhead onto the primary clip', async () => {
		const p = project(6);
		const r = p.apply([
			{ type: 'clip.addSolid', at: 0, duration: 100, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
			{ type: 'keyframe.add', target: ['clip', '$s', 'opacity'], at: { frames: 0 }, value: 0, ref: '$k1' },
			{ type: 'keyframe.add', target: ['clip', '$s', 'opacity'], at: { frames: 10 }, value: 100, ref: '$k2' },
		]);
		const s = r.refs.$s!;
		p.session.select('timeline', [s]);
		p.session.selectKeyframes({ clipOrTrackId: s, keyframeIds: [r.refs.$k1!, r.refs.$k2!] });
		const ctx = p.ctxFor('effectControls');
		await runCommand('edit.copy', ctx);
		expect(clipboardMemory.get()?.payload.kind).toBe('keyframes');
		p.session.transport.seek(50);
		await runCommand('edit.paste', ctx, { clipboard: null });
		const op = (p.seq().clips[s] as Extract<Clip, { kind: 'solid' }>).opacity.keyframes;
		expect(op.map((k) => Math.round(k.time / (705_600_000 / 30)))).toEqual([0, 10, 50, 60]);
		expect(p.session.getState().selection.keyframes?.keyframeIds).toHaveLength(2);
		expect(p.history().at(-1)).toBe('Paste Keyframes');
	});

	it('copies an effect selected in Effect Controls and pastes it onto every selected clip (EC-032)', async () => {
		const p = project(7);
		const r = p.apply([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'clip.addSolid', at: 40, duration: 30, track: 'V1', color: [0, 1, 0, 1], ref: '$b' },
			{ type: 'clip.addSolid', at: 80, duration: 30, track: 'V1', color: [0, 0, 1, 1], ref: '$c' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.gaussian-blur', ref: '$fx' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.black-white' },
		]);
		p.session.select('timeline', [r.refs.$a!]);
		inspectorFocus.set({ source: 'effectControls', effectInstanceId: r.refs.$fx!, clipIds: [r.refs.$a!] });
		const ctx = p.ctxFor('effectControls');
		await runCommand('edit.copy', ctx);
		expect(clipboardMemory.get()?.payload.effects?.effects.map((e) => e.effectId)).toEqual([
			'jasper.gaussian-blur',
		]);
		p.session.select('timeline', [r.refs.$b!, r.refs.$c!]);
		await runCommand('edit.paste', ctx, { clipboard: null });
		for (const id of [r.refs.$b!, r.refs.$c!])
			expect(
				(p.seq().clips[id] as { effects: { effectId: string }[] }).effects.map((e) => e.effectId),
			).toEqual(['jasper.gaussian-blur']);
		expect(p.history().at(-1)).toBe('Paste Effects');
	});

	it('copies project items and pastes them into the selected bin, selecting the copies', async () => {
		const p = project(8);
		const r = p.apply([
			{ type: 'bin.create', name: 'Target', ref: '$bin' },
			{ type: 'media.register', asset: videoAsset(5), itemRef: '$item' },
		]);
		const ctx = p.ctxFor('project');
		p.session.select('project', [r.refs.$item!]);
		await runCommand('edit.copy', ctx);
		p.session.select('project', [r.refs.$bin!]);
		await runCommand('edit.paste', ctx, { clipboard: null });
		const doc = p.session.getCommitted();
		const bin = doc.items[r.refs.$bin!] as { children: string[] };
		expect(bin.children).toHaveLength(1);
		expect(p.session.getState().selection.project.items).toEqual(bin.children);
		expect(Object.keys(doc.media)).toHaveLength(1); // same file: the media is shared
		expect(p.history().at(-1)).toBe('Paste');
		// Clips do not paste into the Project panel.
		const t = p.apply([text(0, 'V1', '$t')]);
		writeClipboard(buildClipsPayload(p.session.getCommitted(), p.seqId, [t.refs.$t!]));
		await runCommand('edit.paste', ctx, { clipboard: null });
		expect(p.toasts.at(-1)?.message).toBe('Paste clips, effects and keyframes in the Timeline');
	});
});

describe('Paste Attributes dialog (CLB-005, FX-012)', () => {
	it('lists the copied attributes, disables what no target takes, and pastes the checked ones', async () => {
		const p = project(9);
		const r = p.apply([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'clip.addSolid', at: 40, duration: 60, track: 'V1', color: [0, 1, 0, 1], ref: '$b' },
			{ type: 'param.set', target: ['clip', '$a', 'opacity'], value: 25 },
			{ type: 'param.set', target: ['clip', '$a', 'transform', 'rotation'], value: 45 },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.gaussian-blur' },
		]);
		const doc = p.session.getCommitted();
		const pl = buildClipsPayload(doc, p.seqId, [r.refs.$a!]);
		const opts = pasteAttributeOptions(pl, [p.seq().clips[r.refs.$b!]!], defaultRegistries().effects);
		expect(opts.map((o) => [o.key.startsWith('fx:') ? 'fx' : o.key, o.label, o.available])).toEqual([
			['motion', 'Motion', true],
			['opacity', 'Opacity', true],
			['fx', 'Gaussian Blur', true],
		]);
		expect(
			removeAttributeOptions([p.seq().clips[r.refs.$a!]!], defaultRegistries().effects).map((o) => o.key),
		).toEqual(['motion', 'opacity', 'fx:jasper.gaussian-blur']);
		expect(toPasteAttributes(['motion', 'fx:fx_1'])).toEqual({ motion: true, effects: ['fx_1'] });

		p.session.select('timeline', [r.refs.$a!]);
		const ctx = p.ctxFor('timeline');
		await runCommand('edit.copy', ctx);
		p.session.select('timeline', [r.refs.$b!]);
		render(<DialogHost />);
		const done = runCommand('edit.pasteAttributes', ctx, { clipboard: null });
		const dialog = await screen.findByTestId('paste-attributes-dialog');
		expect(dialog.textContent).toContain('Scale Attribute Times');
		// Uncheck Motion: only Opacity and the blur are pasted.
		fireEvent.click(dialog.querySelector('[data-attr="motion"] button')!);
		fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
		await act(async () => {
			await done;
		});
		const B = p.seq().clips[r.refs.$b!] as Extract<Clip, { kind: 'solid' }>;
		expect(B.opacity.value).toBe(25);
		expect(B.transform.rotation.value).toBe(0);
		expect(B.effects.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur']);
		expect(p.history().at(-1)).toBe('Paste Attributes');
	});

	it('Remove Attributes resets the checked attributes in one step', async () => {
		const p = project(10);
		const r = p.apply([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'param.set', target: ['clip', '$a', 'opacity'], value: 25 },
		]);
		p.session.select('timeline', [r.refs.$a!]);
		render(<DialogHost />);
		const done = runCommand('timeline.removeAttributes', p.ctxFor('timeline'));
		await screen.findByTestId('remove-attributes-dialog');
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		await act(async () => {
			await done;
		});
		expect((p.seq().clips[r.refs.$a!] as Extract<Clip, { kind: 'solid' }>).opacity.value).toBe(100);
		expect(p.history().at(-1)).toBe('Remove Attributes');
	});
});

describe('Program monitor layer menu (XF-050)', () => {
	it('offers Cut / Copy / Paste / Paste Attributes… on a layer and Paste on empty frame', () => {
		const p = project(11);
		const r = p.apply([text(0, 'V1', '$a')]);
		p.session.select('timeline', [r.refs.$a!]);
		const ctx = p.ctxFor('program');
		const run = vi.fn();
		const items = programLayerMenu(ctx, p.seq().clips[r.refs.$a!]!, run);
		const labels = items.map((i) => (i.kind === 'item' ? i.label : '—'));
		expect(labels.slice(0, 4)).toEqual(['Cut', 'Copy', 'Paste', 'Paste Attributes…']);
		expect(labels).toContain('Duplicate');
		const first = items[1]!;
		if (first.kind === 'item') first.run();
		expect(run).toHaveBeenCalledWith('edit.copy');
		const empty = programLayerMenu(ctx, null, run);
		expect(empty.map((i) => (i.kind === 'item' ? i.label : ''))).toEqual(['Paste']);
	});
});

describe('keyboard: native paste (CLB-002) and text fields', () => {
	it('runs the paste command with the data of the paste event that follows the chord', async () => {
		const run = vi.fn();
		awaitNativePaste(window, run);
		const e = new Event('paste', { cancelable: true }) as ClipboardEvent;
		Object.defineProperty(e, 'clipboardData', {
			value: { getData: (t: string) => (t === 'text/html' ? '<b>x</b>' : 'x'), files: [] },
		});
		window.dispatchEvent(e);
		expect(run).toHaveBeenCalledWith({ html: '<b>x</b>', text: 'x', files: 0 });
		expect(e.defaultPrevented).toBe(true);
		// Without a paste event it still runs, without data.
		const late = vi.fn();
		awaitNativePaste(window, late);
		await waitFor(() => expect(late).toHaveBeenCalledWith(null));
	});

	it('Ctrl+V on the timeline is left to the browser (no preventDefault); in a text field it is never taken', async () => {
		const p = project(12);
		const t = p.apply([text(0, 'V1', '$t')]);
		p.session.select('timeline', [t.refs.$t!]);
		const ctx = p.ctxFor('timeline');
		const ran: string[] = [];
		const off = installKeyboardDispatcher(window, {
			getCtx: () => ctx,
			getFocusKind: () => 'timeline',
			platform: 'linux',
			runtime: 'web',
			run: (c) => ran.push(c.id),
		});
		try {
			const key = new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', ctrlKey: true, cancelable: true });
			document.body.dispatchEvent(key);
			expect(key.defaultPrevented).toBe(false);
			await waitFor(() => expect(ran).toEqual(['timeline.paste']));
			const input = document.createElement('input');
			document.body.append(input);
			const inField = new KeyboardEvent('keydown', {
				code: 'KeyV',
				key: 'v',
				ctrlKey: true,
				cancelable: true,
				bubbles: true,
			});
			input.dispatchEvent(inField);
			await new Promise((r) => setTimeout(r, 200));
			expect(ran).toEqual(['timeline.paste']);
			const copy = new KeyboardEvent('keydown', { code: 'KeyC', key: 'c', ctrlKey: true, cancelable: true });
			document.body.dispatchEvent(copy);
			expect(copy.defaultPrevented).toBe(true);
			input.remove();
		} finally {
			off();
		}
	});
});
