import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEngineProcess } from '../src/engine-process.ts';

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork } }));

class EngineChild extends EventEmitter {
	stdout = null;
	stderr = null;
	kill = vi.fn();
}

const options = { entry: '/engine.mjs', appdir: '/app', webDir: '/web', token: 'token', editorKey: 'key' };

describe('engine process lifecycle', () => {
	let child: EngineChild;

	beforeEach(() => {
		vi.useFakeTimers();
		child = new EngineChild();
		fork.mockReturnValue(child);
	});

	afterEach(() => vi.useRealTimers());

	it('waits for a validated port before declaring the engine ready', async () => {
		const started = startEngineProcess(options);
		for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '47900'])
			child.emit('message', { type: 'ready', port });
		expect(child.listenerCount('message')).toBe(1);
		expect(vi.getTimerCount()).toBe(1);
		child.emit('message', { type: 'ready', port: 47900 });
		expect((await started).origin).toBe('http://127.0.0.1:47900');
		expect(child.listenerCount('message')).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('releases the shutdown timeout when the process exits', async () => {
		const started = startEngineProcess(options);
		child.emit('message', { type: 'ready', port: 47900 });
		const engine = await started;
		const stopped = engine.stop();
		expect(child.kill).toHaveBeenCalledOnce();
		child.emit('exit', 0);
		await stopped;
		expect(vi.getTimerCount()).toBe(0);
		await engine.stop();
		expect(child.kill).toHaveBeenCalledOnce();
	});

	it('rejects early process exits and stops listening for readiness', async () => {
		const started = startEngineProcess(options);
		const failed = expect(started).rejects.toThrow('engine exited with code 1 before it was ready');
		child.emit('exit', 1);
		await failed;
		expect(child.listenerCount('message')).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('kills an unresponsive engine and removes its readiness listener', async () => {
		const started = startEngineProcess({ ...options, readyTimeoutMs: 20 });
		const failed = expect(started).rejects.toThrow('engine did not report ready within 20 ms');
		await vi.advanceTimersByTimeAsync(20);
		await failed;
		expect(child.kill).toHaveBeenCalledOnce();
		expect(child.listenerCount('message')).toBe(0);
	});
});
