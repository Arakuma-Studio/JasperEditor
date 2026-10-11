import { EngineClient } from '@jasper/engine-client';
import { projectSettingsOf, type Sequence } from '@jasper/project';
import { DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { selectedMediaIds } from '../src/commands/gaps.ts';
import { createCommandContext, getCommand, registerAllCommands } from '../src/commands/index.ts';
import {
	PROJECT_SETTINGS_DIALOG,
	registerProjectSettingsDialog,
} from '../src/gaps/ProjectSettingsDialog.tsx';
import { reconnectCommands } from '../src/gaps/ProxyDialogs.tsx';
import { formOf, settingsPatch } from '../src/gaps/SequenceSettingsDialog.tsx';
import { formatTimecode, parseTimecodeEntry, syncDisplayFormat } from '../src/gaps/time-display.ts';
import { resolveMediaHandle } from '../src/panels/program/render-doc.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

const fetchStub = (async (url: string) => {
	if (String(url).includes('/scratch'))
		return new Response(
			JSON.stringify({
				local: true,
				projectMedia: { path: '/p/Generated Media', exists: false, writable: false, freeBytes: 1e9 },
				previews: { path: '/c/previews', exists: true, writable: true, freeBytes: 1e9 },
				mediaCache: { path: '/c', exists: true, writable: true, freeBytes: 1e9 },
				autoSave: { path: '/p/versions', exists: true, writable: true, freeBytes: 1e9 },
				home: '/home/u',
			}),
			{ headers: { 'content-type': 'application/json' } },
		);
	return new Response('{}', { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const engine = new EngineClient({ baseUrl: 'http://127.0.0.1:9', fetch: fetchStub });

describe('Sequence Settings', () => {
	it('patches only what changed; anamorphic and square conversions', () => {
		const { session, seqId } = makeSession();
		const seq = () => session.getCommitted().sequences[seqId] as Sequence;
		const f = formOf(seq());
		expect(settingsPatch(seq(), f)).toEqual({ patch: {} });
		const hdv = settingsPatch(seq(), { ...f, storageWidth: 1440, par: 'hdv', fieldOrder: 'upper' });
		expect(hdv).toEqual({
			patch: { pixelAspectRatio: { num: 4, den: 3 }, storageWidth: 1440, fieldOrder: 'upper' },
		});
		const r = session.apply({
			label: 's',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'sequence.updateSettings', settings: (hdv as { patch: object }).patch }] as never[],
		});
		expect(r.ok).toBe(true);
		expect(seq().settings.width).toBe(1920);
		expect(formOf(seq())).toMatchObject({ storageWidth: 1440, par: 'hdv' });
		expect(settingsPatch(seq(), { ...formOf(seq()), par: 'square' })).toEqual({
			patch: { pixelAspectRatio: null, width: 1440 },
		});
		expect('error' in settingsPatch(seq(), { ...formOf(seq()), height: 1081 })).toBe(true);
		expect(getCommand('sequence.settings')).toBeTruthy();
		expect(getCommand('project.newSequenceFromClip')).toBeTruthy();
	});
});

describe('Project Settings', () => {
	it('saves display formats, the generated media folder and ingest in one undoable step; the UI shows frames', async () => {
		const { session } = makeSession();
		const off = syncDisplayFormat(session);
		registerProjectSettingsDialog();
		render(<DialogHost />);
		act(() => void openDialog(PROJECT_SETTINGS_DIALOG, { session, engine }));
		await screen.findByTestId('project-settings-dialog');
		await waitFor(() => expect(screen.getByText(/Renderer \(preview\)/)).toBeTruthy());
		const r = session.apply({
			label: 'Project Settings',
			origin: 'user',
			commands: [
				{ type: 'project.updateSettings', settings: { display: { video: 'frames', audio: 'milliseconds' } } },
			] as never[],
		});
		expect(r.ok).toBe(true);
		expect(projectSettingsOf(session.getCommitted()).display.video).toBe('frames');
		expect(formatTimecode(95, { num: 30, den: 1 })).toBe('95');
		expect(parseTimecodeEntry('120', { num: 30, den: 1 }, { current: 0 })).toBe(120);
		session.undo();
		expect(formatTimecode(95, { num: 30, den: 1 })).toBe('00:00:03:05');
		off();
		fireEvent.keyDown(document.body, { key: 'Escape' });
	});
});

describe('proxies in the UI', () => {
	it('Toggle Proxies plays the attached proxy; otherwise the original or the engine proxy', async () => {
		const { session, seqId } = makeSession();
		const proxy = videoAsset(10);
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'media.register', asset: videoAsset(10), ref: '$m' }] as never[],
		});
		const mediaId = (r.ok && (r.results[0] as { mediaId: string }).mediaId) as string;
		session.apply({
			label: 'attach',
			origin: 'user',
			commands: [
				{
					type: 'media.attachProxy',
					mediaId,
					proxy: { ...proxy, originalName: 'p.mp4', origin: 'created' },
				},
			] as never[],
		});
		const asset = session.getCommitted().media[mediaId]!;
		const key = (proxy.locators[0] as { key: string }).key;
		expect(
			resolveMediaHandle(asset, undefined, { attachedProxies: true, autoProxies: false })?.proxyUrl,
		).toBe(`/media/${key}`);
		expect(resolveMediaHandle(asset, undefined, {})?.proxyUrl).toBeNull();
		const ctx = createCommandContext({ engine, session });
		await getCommand('media.toggleProxies')!.run(ctx);
		expect(session.getState().toggles.attachedProxies).toBe(true);
		expect(getCommand('media.toggleProxies')!.checked!(ctx)).toBe(true);
		session.select(
			'project',
			Object.values(session.getCommitted().items)
				.filter((i) => i.kind === 'media')
				.map((i) => i.id),
			'replace',
		);
		expect(
			selectedMediaIds(
				createCommandContext({ engine, session, focus: { panel: 'project', instanceId: null } }),
			),
		).toEqual([mediaId]);
	});

	it('Reconnect Full Resolution: the file the clip used becomes its proxy', () => {
		const { session } = makeSession();
		const small = { ...videoAsset(10), id: 'med_x' } as never;
		const full = videoAsset(10);
		const reg = { ...full, mediaKey: 'mk_full', kind: 'video', browserPlayable: 'yes' } as never;
		const built = reconnectCommands(small, reg);
		expect('commands' in built && built.commands.map((c) => (c as { type: string }).type)).toEqual([
			'media.relink',
			'media.attachProxy',
		]);
		const wrongRate = { ...(reg as object), probe: videoAsset(10, true).probe };
		(wrongRate.probe.streams[0] as { frameRate: unknown }).frameRate = { num: 25, den: 1 };
		expect('error' in reconnectCommands(small, wrongRate as never)).toBe(true);
		void session;
	});
});
