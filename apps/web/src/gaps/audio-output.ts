// Every AudioContext the page creates (the Program / Source monitor Player, scrubbing, the mixers'
// meters) is routed to the chosen device with `AudioContext.setSinkId` and gets the chosen latency hint unless its
// creator asked for one; media elements that play sound directly follow with `HTMLMediaElement.setSinkId`. Changing
// the preference moves the open contexts. Browsers without `setSinkId` keep the system default (the page says so).
import { gapsPrefs } from './app-prefs.ts';

type SinkCapable = { setSinkId?(id: string): Promise<void> };

const contexts = new Set<WeakRef<AudioContext>>();

/** Whether this browser can route Web Audio to a chosen device. */
export function canChooseOutput(): boolean {
	const AC = (globalThis as { AudioContext?: { prototype: SinkCapable } }).AudioContext;
	return !!AC && typeof AC.prototype.setSinkId === 'function';
}

function applySink(target: SinkCapable, id: string): void {
	if (typeof target.setSinkId !== 'function') return;
	void target.setSinkId(id).catch(() => {
		// The device is gone or not allowed: the system default plays.
	});
}

let installed = false;
/** Installs the routing once per page (idempotent; a no-op without Web Audio). */
export function installAudioOutput(): void {
	if (installed) return;
	installed = true;
	const g = globalThis as unknown as {
		AudioContext?: typeof AudioContext;
		HTMLMediaElement?: typeof HTMLMediaElement;
	};
	const Native = g.AudioContext;
	if (Native) {
		const Wrapped = class extends Native {
			constructor(opts?: AudioContextOptions) {
				const latency = gapsPrefs.get().audioHardware.latency;
				super({ latencyHint: latency, ...(opts ?? {}) });
				contexts.add(new WeakRef(this));
				const id = gapsPrefs.get().audioHardware.outputDeviceId;
				if (id) applySink(this as unknown as SinkCapable, id);
			}
		};
		// Static members (and `instanceof AudioContext`) keep working.
		Object.defineProperty(Wrapped, 'name', { value: 'AudioContext' });
		g.AudioContext = Wrapped as unknown as typeof AudioContext;
	}
	const ME = g.HTMLMediaElement;
	if (ME && typeof (ME.prototype as SinkCapable).setSinkId === 'function') {
		const play = ME.prototype.play;
		ME.prototype.play = function (this: HTMLMediaElement & { sinkId?: string }) {
			const id = gapsPrefs.get().audioHardware.outputDeviceId;
			if ((this.sinkId ?? '') !== id) applySink(this as unknown as SinkCapable, id);
			return play.call(this);
		};
	}
	let last = gapsPrefs.get().audioHardware.outputDeviceId;
	gapsPrefs.subscribe(() => {
		const id = gapsPrefs.get().audioHardware.outputDeviceId;
		if (id === last) return;
		last = id;
		for (const ref of [...contexts]) {
			const ctx = ref.deref();
			if (!ctx || ctx.state === 'closed') contexts.delete(ref);
			else applySink(ctx as unknown as SinkCapable, id);
		}
		if (typeof document !== 'undefined')
			for (const el of Array.from(document.querySelectorAll('audio,video')))
				applySink(el as unknown as SinkCapable, id);
	});
}

/** Audio output devices (labels need a granted microphone permission in some browsers). */
export async function listOutputDevices(): Promise<{ id: string; label: string }[]> {
	try {
		const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
		return all
			.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default')
			.map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }));
	} catch {
		return [];
	}
}
