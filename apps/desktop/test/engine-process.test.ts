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
		let ready = false;
		const started = startEngineProcess(options).then((engine) => {
			ready = true;
			return engine;
		});
		for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '47900'])
			child.emit('message', { type: 'ready', port });
		await Promise.resolve();
		expect(ready).toBe(false);
		child.emit('message', { type: 'ready', port: 47900 });
		expect((await started).origin).toBe('http://127.0.0.1:47900');
	});

	it('waits for process exit and does not kill an already stopped engine', async () => {
		const started = startEngineProcess(options);
		child.emit('message', { type: 'ready', port: 47900 });
		const engine = await started;
		let finished = false;
		const stopped = engine.stop().then(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		expect(child.kill).toHaveBeenCalledOnce();
		child.emit('exit', 0);
		await stopped;
		await engine.stop();
		expect(child.kill).toHaveBeenCalledOnce();
	});

	it('rejects early process exits without killing the departed engine later', async () => {
		const started = startEngineProcess(options);
		const failed = expect(started).rejects.toThrow(/code 1/);
		child.emit('exit', 1);
		await failed;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(child.kill).not.toHaveBeenCalled();
	});

	it('rejects startup and kills an unresponsive engine', async () => {
		const started = startEngineProcess(options);
		const failed = expect(started).rejects.toThrow(/ready/);
		await vi.advanceTimersByTimeAsync(30_000);
		await failed;
		expect(child.kill).toHaveBeenCalledOnce();
	});
});
