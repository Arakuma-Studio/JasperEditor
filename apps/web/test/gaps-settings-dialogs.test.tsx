import { EngineClient } from '@jasper/engine-client';
import { projectSettingsOf } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCommandContext, getCommand, registerAllCommands } from '../src/commands/index.ts';
import { reconnectCommands } from '../src/gaps/ProxyDialogs.tsx';
import { formatTimecode, parseTimecodeEntry, syncDisplayFormat } from '../src/gaps/time-display.ts';
import { resolveMediaHandle } from '../src/panels/program/render-doc.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());

const engine = new EngineClient({
	baseUrl: 'http://127.0.0.1:9',
	fetch: async () => new Response('{}'),
});

describe('Project Settings', () => {
	it('display-format changes reach time fields and undo restores timecode', async () => {
		const { session } = makeSession();
		const off = syncDisplayFormat(session);
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
	});

	it('Reconnect Full Resolution keeps the old file as proxy and refuses a mismatched frame rate', () => {
		const { session } = makeSession();
		const imported = session.apply({
			label: 'import',
			origin: 'user',
			commands: [{ type: 'media.register', asset: videoAsset(10), ref: '$media' }] as never[],
		});
		if (!imported.ok) throw new Error('fixture import failed');
		const mediaId = imported.refs.$media!;
		const small = session.getCommitted().media[mediaId]!;
		const full = videoAsset(10);
		const reg = { ...full, mediaKey: 'mk_full', kind: 'video', browserPlayable: 'yes' } as never;
		const built = reconnectCommands(small, reg);
		if ('error' in built) throw new Error(built.error);
		expect(session.apply({ label: 'Reconnect', origin: 'user', commands: built.commands }).ok).toBe(true);
		const connected = session.getCommitted().media[mediaId]!;
		expect(connected.fingerprint).toBe(full.fingerprint);
		expect(connected.proxy?.fingerprint).toBe(small.fingerprint);
		expect(connected.proxy?.locators).toEqual(small.locators);
		session.undo();
		expect(session.getCommitted().media[mediaId]).toEqual(small);
		const wrongRate = { ...(reg as object), probe: videoAsset(10, true).probe };
		(wrongRate.probe.streams[0] as { frameRate: unknown }).frameRate = { num: 25, den: 1 };
		expect('error' in reconnectCommands(small, wrongRate as never)).toBe(true);
	});
});
