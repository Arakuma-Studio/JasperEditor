// color-grade: the Lumetri eyedroppers (hue/saturation curves, HSL Secondary Set/Add/Remove Color). A picker armed in
// the Lumetri panel turns the Program monitor into a colour picker (overlay, crosshair cursor); a click samples the
// displayed picture of the graded clip there (a 5 × 5 average, 10 × 10 with Ctrl / Cmd, like Premiere's eyedropper)
// and hands the colour to the picker. Esc or a second click on the eyedropper button cancels.
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

/** Mean colour (0..1) of a `size` × `size` block of `el` around the client point, or null outside / unreadable. */
export function sampleElement(
	el: Source,
	clientX: number,
	clientY: number,
	size = 5,
): [number, number, number] | null {
	const r = el.getBoundingClientRect();
	const { width, height } = intrinsic(el);
	if (!(r.width > 0 && r.height > 0 && width > 0 && height > 0)) return null;
	if (clientX < r.left || clientX >= r.right || clientY < r.top || clientY >= r.bottom) return null;
	const n = Math.max(1, Math.min(32, Math.round(size)));
	// The block is `n` px of the picture (intrinsic pixels), centred on the point.
	const px = Math.floor(((clientX - r.left) / r.width) * width);
	const py = Math.floor(((clientY - r.top) / r.height) * height);
	const x0 = Math.min(Math.max(0, px - Math.floor(n / 2)), Math.max(0, width - n));
	const y0 = Math.min(Math.max(0, py - Math.floor(n / 2)), Math.max(0, height - n));
	scratch ??= document.createElement('canvas');
	scratch.width = n;
	scratch.height = n;
	const g = scratch.getContext('2d', { willReadFrequently: true });
	if (!g) return null;
	try {
		g.clearRect(0, 0, n, n);
		g.drawImage(el, x0, y0, n, n, 0, 0, n, n);
		const d = g.getImageData(0, 0, n, n).data;
		let k = 0;
		const sum = [0, 0, 0];
		for (let i = 0; i < n * n; i++) {
			const a = d[i * 4 + 3]!;
			if (a === 0) continue;
			sum[0] += d[i * 4]!;
			sum[1] += d[i * 4 + 1]!;
			sum[2] += d[i * 4 + 2]!;
			k++;
		}
		if (!k) return null;
		return [sum[0]! / k / 255, sum[1]! / k / 255, sum[2]! / k / 255];
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
	size = 5,
): [number, number, number] | null {
	const wrapper = root.querySelector('[data-testid="program-player-wrapper"]');
	if (!wrapper) return null;
	if (clipId) {
		const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(clipId) : clipId;
		const host = wrapper.querySelector(`[data-clip-id="${esc}"]`);
		const el = host ? pictureOf(host) : null;
		const c = el ? sampleElement(el, clientX, clientY, size) : null;
		if (c) return c;
	}
	const hosts = [...wrapper.querySelectorAll('[data-clip-id]')].reverse();
	for (const h of hosts) {
		const el = pictureOf(h);
		const c = el ? sampleElement(el, clientX, clientY, size) : null;
		if (c) return c;
	}
	return null;
}
