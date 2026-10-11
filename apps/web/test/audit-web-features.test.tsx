import { type EngineJob, EngineJobSchema } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDialogClose } from '../src/extensions/dialog.ts';
import { buildMediaAsset } from '../src/import/assets.ts';
import { createMediaRuntimeSync } from '../src/import/media-runtime.ts';
import { parseMulticamView } from '../src/multicam/state.ts';
import { pollActiveJob } from '../src/processing/engine-jobs.ts';
import { loadAuto, parseAutoTranscribe } from '../src/speech/auto.tsx';
import { defaultOptions, loadOptions, parseGenerateOptions } from '../src/speech/model.ts';
import { addTracker, startTrack } from '../src/tracking/actions.ts';
import { trackingStore } from '../src/tracking/store.ts';
import { fakeEngine, trackingSession } from './tracking-helpers.tsx';
import { memorySession, registered, ScriptedEngine } from './wp2e/helpers.ts';

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.useRealTimers();
	trackingStore.setState(trackingStore.getInitialState(), true);
});

function job(state: EngineJob['state']): EngineJob {
	return EngineJobSchema.parse({
		id: 'job_audit',
		kind: 'track',
		title: 'Track',
		state,
		origin: { type: 'user' },
		progress: 0,
		createdAt: '2026-10-11T00:00:00Z',
		priority: 'interactive',
		cpuSlots: 1,
	});
}

describe('feature job polling', () => {
	it.each(['UNAUTHORIZED', 'NOT_FOUND', 'INTERNAL'])('stops on %s', async (code) => {
		vi.useFakeTimers();
		const failure = new EngineError(code, 'Cannot read job');
		const getJob = vi.fn<EngineClient['getJob']>().mockRejectedValue(failure);
		const pending = pollActiveJob({ getJob }, 'job_audit', { isActive: () => true, intervalMs: 1 });
		const result = expect(pending).rejects.toBe(failure);
		await vi.runAllTimersAsync();
		await result;
		expect(getJob).toHaveBeenCalledTimes(1);
	});

	it('bounds consecutive network failures', async () => {
		vi.useFakeTimers();
		const failure = new EngineError('NETWORK', 'Disconnected');
		const getJob = vi.fn<EngineClient['getJob']>().mockRejectedValue(failure);
		const result = expect(
			pollActiveJob({ getJob }, 'job_audit', { isActive: () => true, intervalMs: 1 }),
		).rejects.toBe(failure);
		await vi.runAllTimersAsync();
		await result;
		expect(getJob).toHaveBeenCalledTimes(3);
	});

	it('resets the retry budget after a response and treats interrupted as terminal', async () => {
		vi.useFakeTimers();
		const failure = new EngineError('NETWORK', 'Disconnected');
		const getJob = vi
			.fn<EngineClient['getJob']>()
			.mockRejectedValueOnce(failure)
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(job('running'))
			.mockRejectedValueOnce(failure)
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(job('interrupted'));
		const pending = pollActiveJob({ getJob }, 'job_audit', { isActive: () => true, intervalMs: 1 });
		await vi.runAllTimersAsync();
		expect((await pending)?.state).toBe('interrupted');
		expect(getJob).toHaveBeenCalledTimes(6);
	});

	it('does not publish an obsolete job response', async () => {
		vi.useFakeTimers();
		let active = true;
		const getJob = vi.fn<EngineClient['getJob']>().mockImplementation(async () => {
			active = false;
			return job('succeeded');
		});
		const onUpdate = vi.fn();
		const pending = pollActiveJob({ getJob }, 'job_audit', {
			isActive: () => active,
			intervalMs: 1,
			onUpdate,
		});
		await vi.runAllTimersAsync();
		expect(await pending).toBeNull();
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it('clears a running tracker and exposes polling failure', async () => {
		vi.useFakeTimers();
		const { session, plate } = trackingSession();
		const engine = fakeEngine();
		engine.getJob = async () => {
			throw new EngineError('UNAUTHORIZED', 'Pair the engine again');
		};
		const id = addTracker(session, plate, 'planar');
		await startTrack(session, engine, id, 'forward');
		await vi.advanceTimersByTimeAsync(500);
		expect(trackingStore.getState().running[id]).toBeUndefined();
		expect(trackingStore.getState().errors[id]).toContain('Pair the engine again');
	});
});

describe('stored feature preferences', () => {
	it('rejects unsafe types without discarding valid independent choices', () => {
		localStorage.setItem(
			'jasper:speech-auto',
			JSON.stringify({ enabled: 'false', model: {}, language: 'es' }),
		);
		expect(loadAuto()).toEqual({ enabled: false, model: 'whisper-base', language: 'es' });
		localStorage.setItem(
			'jasper:speech-options',
			JSON.stringify({ model: {}, speakerCount: 100, analysis: 'mix', replace: 'false' }),
		);
		expect(loadOptions('whisper-small')).toEqual({ ...defaultOptions('whisper-small'), analysis: 'mix' });
		expect(
			parseMulticamView({ view: 'false', audioFollowsVideo: null, layout: 3, showNames: false, page: 99 }),
		).toMatchObject({ view: false, audioFollowsVideo: true, layout: 3, showNames: false, page: 0 });
	});

	it('parses arbitrary stored JSON into usable UI values', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				const auto = parseAutoTranscribe(value);
				const options = parseGenerateOptions(value, 'whisper-base');
				const multicam = parseMulticamView(value);
				expect(typeof auto.enabled).toBe('boolean');
				expect(typeof auto.model).toBe('string');
				expect(typeof options.language).toBe('string');
				expect(options.speakerCount).toBeGreaterThanOrEqual(0);
				expect(options.speakerCount).toBeLessThanOrEqual(32);
				expect(typeof multicam.view).toBe('boolean');
				expect(['auto', 2, 3, 4]).toContain(multicam.layout);
				expect(multicam.page).toBe(0);
			}),
			{ numRuns: 100 },
		);
	});
});

it('closes a hosted dialog only once before React flushes state', () => {
	const close = vi.fn<(value?: string) => void>();
	const { result } = renderHook(() => useDialogClose(close));
	act(() => {
		result.current.finish('accepted');
		result.current.finish('cancelled');
	});
	expect(close).toHaveBeenCalledExactlyOnceWith('accepted');
	expect(result.current.open).toBe(false);
});

it.each([401, 500])('marks media status HTTP %s failures as errors', async (status) => {
	const { session } = await memorySession();
	const id = session.ctx.ids.next('med');
	const added = session.apply({
		label: 'Import',
		origin: 'user',
		commands: [{ type: 'media.register', asset: buildMediaAsset(registered('audit.mp4'), { id, now: 't' }) }],
	});
	expect(added.ok).toBe(true);
	const engine = new ScriptedEngine().on((request) =>
		request.path.startsWith('/api/media/')
			? {
					status,
					body: {
						code: status === 401 ? 'UNAUTHORIZED' : 'INTERNAL',
						message: 'Cannot resolve media',
						retryable: false,
					},
				}
			: undefined,
	);
	const sync = createMediaRuntimeSync(session, engine.client(), null);
	try {
		await waitFor(() => expect(session.getState().media[id]?.availability).toBe('error'));
	} finally {
		sync.dispose();
	}
});
