// color-grade: everything the Lumetri Scopes worker computes for one read-back frame — the requested scopes of a
// layout, from the shared scope maths of @jasper/project (color/scopes.ts: the same code `scopes_read` runs on the
// engine), painted into RGBA trace images with the panel's colours. No DOM.
import {
	BRIGHTNESS_GAIN,
	histogram,
	type ParadeType,
	paintGrids,
	paintVectorscope,
	parade,
	type ScopeBrightness,
	type ScopeHistogram,
	type ScopeKind,
	type ScopeMatrix,
	type ScopeParams,
	signalFromRgba8,
	vectorscopeHls,
	vectorscopeYuv,
	type WaveformType,
	waveform,
	waveformReference,
} from '@jasper/project';

export type RGB = readonly [number, number, number];

export type ScopeSettings = {
	waveformType: WaveformType;
	paradeType: ParadeType;
	matrix: ScopeMatrix;
	clamp: boolean;
	brightness: ScopeBrightness;
};

export type ScopeColors = {
	trace: RGB;
	luma: RGB;
	chroma: RGB;
	red: RGB;
	green: RGB;
	blue: RGB;
};

export type ScopesRequest = {
	id: number;
	data: Uint8ClampedArray;
	width: number;
	height: number;
	kinds: readonly ScopeKind[];
	settings: ScopeSettings;
	colors: ScopeColors;
};

/** A painted scope: RGBA (straight) trace image; parades hold `blocks` traces side by side. */
export type ScopeImage = {
	kind: ScopeKind;
	width: number;
	height: number;
	image: Uint8ClampedArray;
	/** Waveform / parade value range ([0, 1] clamped, [−0.1, 1.1] unclamped). */
	lo: number;
	hi: number;
	blocks: number;
	/** Trace names of a parade, left to right. */
	names: string[];
};

export type ScopesResult = {
	id: number;
	images: ScopeImage[];
	histogram?: ScopeHistogram;
	samples: number;
	/** Time the maths took (ms), for the panel's real-time check. */
	ms: number;
};

function traceColor(name: string, c: ScopeColors, type: 'waveform' | 'parade', layout: string): RGB {
	switch (name) {
		case 'R':
			return c.red;
		case 'G':
			return c.green;
		case 'B':
			return c.blue;
		case 'Cb':
			return c.blue;
		case 'Cr':
			return c.red;
		case 'C':
			return c.chroma;
		default:
			// Y: white in RGB-White / YUV parades and the luma waveforms.
			return type === 'parade' || layout !== 'rgb' ? c.luma : c.trace;
	}
}

export function computeScopes(req: ScopesRequest): ScopesResult {
	const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
	const sig = signalFromRgba8(req.data, req.width, req.height);
	const p: ScopeParams = {
		matrix: req.settings.matrix,
		clamp: req.settings.clamp,
		rows: 256,
		vectorSize: 255,
	};
	const gain = BRIGHTNESS_GAIN[req.settings.brightness] ?? 1;
	const images: ScopeImage[] = [];
	let hist: ScopeHistogram | undefined;
	const done = new Set<ScopeKind>();
	for (const kind of req.kinds) {
		if (done.has(kind)) continue;
		done.add(kind);
		if (kind === 'histogram') {
			hist = histogram(sig, p);
			continue;
		}
		if (kind === 'vectorscopeYuv' || kind === 'vectorscopeHls') {
			const v = kind === 'vectorscopeYuv' ? vectorscopeYuv(sig, p) : vectorscopeHls(sig, p);
			const img = paintVectorscope(v, req.colors.trace, gain, kind === 'vectorscopeHls', req.settings.matrix);
			images.push({ kind, ...img, lo: 0, hi: 1, blocks: 1, names: [] });
			continue;
		}
		if (kind === 'waveform') {
			const w = waveform(sig, req.settings.waveformType, p);
			const ref = waveformReference(w.perColumn);
			const img = paintGrids(
				w.traces.map((grid) => ({
					grid,
					color: traceColor(grid.name, req.colors, 'waveform', req.settings.waveformType),
				})),
				ref,
				gain,
			);
			images.push({ kind, ...img, lo: w.lo, hi: w.hi, blocks: 1, names: w.traces.map((t) => t.name) });
			continue;
		}
		// Parade: each trace painted on its own, side by side.
		const w = parade(sig, req.settings.paradeType, p);
		const ref = waveformReference(w.perColumn);
		const parts = w.traces.map((grid) =>
			paintGrids(
				[{ grid, color: traceColor(grid.name, req.colors, 'parade', req.settings.paradeType) }],
				ref,
				gain,
			),
		);
		const bw = parts[0]?.width ?? 0;
		const bh = parts[0]?.height ?? 0;
		const n = parts.length;
		const image = new Uint8ClampedArray(bw * n * bh * 4);
		parts.forEach((part, k) => {
			for (let y = 0; y < bh; y++)
				image.set(part.image.subarray(y * bw * 4, (y + 1) * bw * 4), (y * bw * n + k * bw) * 4);
		});
		images.push({
			kind,
			width: bw * n,
			height: bh,
			image,
			lo: w.lo,
			hi: w.hi,
			blocks: n,
			names: w.traces.map((t) => t.name),
		});
	}
	const ms = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
	return { id: req.id, images, ...(hist ? { histogram: hist } : {}), samples: sig.w * sig.h, ms };
}
