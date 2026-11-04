import type { PlayerRef } from '@remotion/player';
import type { ContextType } from 'react';
import { Internals } from 'remotion';

// Observe real scheduled work: decoder buffering, animation-frame draws, effect-chain promises and canvas paint
// events. The receipt drains those jobs; it never samples pixels or waits for an arbitrary number of frames.
const pending = new Set<Promise<unknown>>();
const failures: unknown[] = [];
function track<T>(job: Promise<T>): Promise<T> {
	pending.add(job);
	void job.then(
		() => pending.delete(job),
		(error) => {
			pending.delete(job);
			failures.push(error);
		},
	);
	return job;
}
// Observe detached images started by production feeders; never start a load from the fixture.
const imageSource = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
Object.defineProperty(HTMLImageElement.prototype, 'src', {
	...imageSource,
	set(this: HTMLImageElement, value: string) {
		track(
			new Promise<void>((resolve) => {
				const settled = () => {
					this.removeEventListener('load', settled);
					this.removeEventListener('error', settled);
					resolve();
				};
				this.addEventListener('load', settled);
				this.addEventListener('error', settled);
			}),
		);
		imageSource.set!.call(this, value);
	},
});
const decode = HTMLImageElement.prototype.decode;
HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
	return track(decode.call(this));
};
// Observe the decoder's existing delayPlayback/unblock receipt synchronously. The React buffering flag can lag
// addBlock by one commit, so checking only that flag could miss a decoder that is still loading its first frame.
const observedBuffers = new WeakSet<object>();
export function observeBuffering(
	buffer: NonNullable<ContextType<typeof Internals.BufferingContextReact>>,
): void {
	if (observedBuffers.has(buffer)) return;
	observedBuffers.add(buffer);
	const addBlock = buffer.addBlock;
	buffer.addBlock = (block) => {
		const handle = addBlock(block);
		let resolve!: () => void;
		track(
			new Promise<void>((done) => {
				resolve = done;
			}),
		);
		return {
			...handle,
			unblock: () => {
				handle.unblock();
				resolve();
			},
		};
	};
}

const internals = Internals as { runEffectChain: typeof Internals.runEffectChain };
const runEffectChain = internals.runEffectChain;
internals.runEffectChain = (input) => track(runEffectChain(input));
const animationFrame = window.requestAnimationFrame.bind(window);
/** Keep continuous PCM observations outside the composition's finite render-work queue. */
export const monitorFrame = animationFrame;
const cancelFrame = window.cancelAnimationFrame.bind(window);
const frames = new Map<number, () => void>();
window.requestAnimationFrame = (callback) => {
	let resolve!: () => void;
	track(
		new Promise<void>((done) => {
			resolve = done;
		}),
	);
	const id = animationFrame((time) => {
		try {
			callback(time);
		} finally {
			frames.delete(id);
			resolve();
		}
	});
	frames.set(id, resolve);
	return id;
};
window.cancelAnimationFrame = (id) => {
	cancelFrame(id);
	frames.get(id)?.();
	frames.delete(id);
};
const listen = EventTarget.prototype.addEventListener;
const unlisten = EventTarget.prototype.removeEventListener;
const paintListeners = new WeakMap<EventListenerOrEventListenerObject, EventListener>();
EventTarget.prototype.addEventListener = function (this: EventTarget, type, callback, options) {
	if (type !== 'paint' || !callback) return listen.call(this, type, callback, options);
	let wrapped = paintListeners.get(callback);
	if (!wrapped) {
		wrapped = function (this: EventTarget, event) {
			const result =
				typeof callback === 'function'
					? (callback as (this: EventTarget, event: Event) => unknown).call(this, event)
					: callback.handleEvent(event);
			if (result) track(Promise.resolve(result));
		};
		paintListeners.set(callback, wrapped);
	}
	listen.call(this, type, wrapped, options);
};
EventTarget.prototype.removeEventListener = function (this: EventTarget, type, callback, options) {
	unlisten.call(
		this,
		type,
		type === 'paint' && callback ? (paintListeners.get(callback) ?? callback) : callback,
		options,
	);
};
const canvasPrototype = HTMLCanvasElement.prototype as HTMLCanvasElement & { requestPaint?: () => void };
const paint = canvasPrototype.requestPaint;
if (paint)
	canvasPrototype.requestPaint = function (this: HTMLCanvasElement) {
		track(new Promise<void>((resolve) => listen.call(this, 'paint', () => resolve(), { once: true })));
		paint.call(this);
	};
async function drain() {
	while (pending.size) await Promise.all([...pending]);
	if (failures.length) throw failures[0];
}
export async function settlePlayer(
	player: PlayerRef,
	container: HTMLElement,
	buffering: { readonly current: boolean },
): Promise<void> {
	await Promise.all([...container.querySelectorAll('img')].map((image) => image.decode()));
	await drain();
	if (buffering.current)
		await new Promise<void>((resolve) => {
			const resumed = () => {
				player.removeEventListener('resume', resumed);
				resolve();
			};
			player.addEventListener('resume', resumed);
		});
	await drain();
}
