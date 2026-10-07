// color-grade: the Lumetri eyedroppers (hue/saturation curves, HSL Secondary Set/Add/Remove Color). A picker armed in
// the Lumetri panel turns the Program monitor into a colour picker (overlay, crosshair cursor); a click samples the
// displayed picture of the graded clip there (3 × 3 average, like Premiere's eyedropper) and hands the colour to the
// picker. Esc or a second click on the eyedropper button cancels.
import { useSyncExternalStore } from 'react';

export type PickRequest = {
	/** Identifies the armed button (so it can show its pressed state). */
	id: string;
	/** Shown in the overlay ("Click a colour for Hue vs Sat"). */
	label: string;
	/** Prefer this clip's picture (the graded clip); any clip under the pointer otherwise. */
	clipId: string | null;
	onPick(rgb: [number, number, number]): void;
};

let current: PickRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of [...listeners]) l();
};

export const eyedropper = {
	get: () => current,
	/** Arms a picker (replaces any armed one); calling it again with the same id cancels (toggle). */
	toggle(req: PickRequest) {
		current = current?.id === req.id ? null : req;
		emit();
	},
	cancel() {
		if (!current) return;
		current = null;
		emit();
	},
	/** Delivers a sampled colour to the armed picker and disarms it. */
	pick(rgb: [number, number, number]) {
		const r = current;
		current = null;
		emit();
		r?.onPick(rgb);
	},
	subscribe(l: () => void) {
		listeners.add(l);
		return () => {
			listeners.delete(l);
		};
	},
};

export function useEyedropper(): PickRequest | null {
	return useSyncExternalStore(eyedropper.subscribe, eyedropper.get, eyedropper.get);
}

type Source = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;

function intrinsic(el: Source): { width: number; height: number } {
	if (el instanceof HTMLVideoElement) return { width: el.videoWidth, height: el.videoHeight };
	if (el instanceof HTMLImageElement) return { width: el.naturalWidth, height: el.naturalHeight };
	return { width: el.width, height: el.height };
}

let scratch: HTMLCanvasElement | null = null;

/** Mean colour (0..1) of a 3 × 3 block of `el` around the client point, or null outside / unreadable. */
export function sampleElement(el: Source, clientX: number, clientY: number): [number, number, number] | null {
	const r = el.getBoundingClientRect();
	const { width, height } = intrinsic(el);
	if (!(r.width > 0 && r.height > 0 && width > 0 && height > 0)) return null;
	if (clientX < r.left || clientX >= r.right || clientY < r.top || clientY >= r.bottom) return null;
	const px = Math.floor(((clientX - r.left) / r.width) * width);
	const py = Math.floor(((clientY - r.top) / r.height) * height);
	scratch ??= document.createElement('canvas');
	scratch.width = 3;
	scratch.height = 3;
	const g = scratch.getContext('2d', { willReadFrequently: true });
	if (!g) return null;
	try {
		g.clearRect(0, 0, 3, 3);
		g.drawImage(el, px - 1, py - 1, 3, 3, 0, 0, 3, 3);
		const d = g.getImageData(0, 0, 3, 3).data;
		let n = 0;
		const sum = [0, 0, 0];
		for (let i = 0; i < 9; i++) {
			const a = d[i * 4 + 3]!;
			if (a === 0) continue;
			sum[0] += d[i * 4]!;
			sum[1] += d[i * 4 + 1]!;
			sum[2] += d[i * 4 + 2]!;
			n++;
		}
		if (!n) return null;
		return [sum[0]! / n / 255, sum[1]! / n / 255, sum[2]! / n / 255];
	} catch {
		return null;
	}
}

const pictureOf = (host: Element): Source | null =>
	host.querySelector<HTMLCanvasElement>('canvas') ??
	host.querySelector<HTMLImageElement>('img') ??
	host.querySelector<HTMLVideoElement>('video');

/**
 * The colour of the Program picture at a client point: the preferred clip's picture when the point is on it, else
 * the topmost clip picture under the point. `root` = the Program monitor (contains the player wrapper).
 */
export function sampleProgram(
	root: ParentNode,
	clientX: number,
	clientY: number,
	clipId: string | null,
): [number, number, number] | null {
	const wrapper = root.querySelector('[data-testid="program-player-wrapper"]');
	if (!wrapper) return null;
	if (clipId) {
		const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(clipId) : clipId;
		const host = wrapper.querySelector(`[data-clip-id="${esc}"]`);
		const el = host ? pictureOf(host) : null;
		const c = el ? sampleElement(el, clientX, clientY) : null;
		if (c) return c;
	}
	const hosts = [...wrapper.querySelectorAll('[data-clip-id]')].reverse();
	for (const h of hosts) {
		const el = pictureOf(h);
		const c = el ? sampleElement(el, clientX, clientY) : null;
		if (c) return c;
	}
	return null;
}
