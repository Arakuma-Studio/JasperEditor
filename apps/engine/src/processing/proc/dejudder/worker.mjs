// De-judder worker thread (S07:PST-013/014): OpenCV.js (WASM) optical flow + backward warp.
//
// Plain ESM JavaScript on purpose: worker threads cannot run TypeScript under Node 20 without a loader, and
// this file must run unchanged from the source tree (tests, tsx) AND be bundled by esbuild into
// `dist/dejudder-worker.mjs` next to `dist/jasper-proc.mjs` (see pool.ts `resolveWorkerUrl`). The message
// protocol is typed in pool.ts (`WorkerRequest` / `WorkerResponse`); keep both in sync.
//
// OpenCV.js is loaded once per worker (~0.5 s). The WASM module is single-threaded; parallelism comes from the
// pool (one task per worker at a time).
import { parentPort } from 'node:worker_threads';
import cvModule from '@techstark/opencv-js';

/** @type {any} */
let cv;

/** Waits for the Emscripten runtime without resolving a promise with the (thenable) Module itself. */
function loadCv() {
	return new Promise((resolve, reject) => {
		try {
			const m = /** @type {any} */ (cvModule);
			if (m instanceof Promise) {
				m.then((mod) => {
					cv = mod;
					resolve(undefined);
				}, reject);
				return;
			}
			m.then(() => {
				cv = m;
				resolve(undefined);
			});
		} catch (e) {
			reject(e);
		}
	});
}

/** numpy-style linear-interpolated percentile of a Float32Array (sorted in place). */
function percentile(values, p) {
	if (values.length === 0) return 0;
	values.sort();
	const pos = (p / 100) * (values.length - 1);
	const lo = Math.floor(pos);
	const hi = Math.min(values.length - 1, lo + 1);
	return values[lo] + (values[hi] - values[lo]) * (pos - lo);
}

function median(values) {
	return percentile(values, 50);
}

/**
 * Per-pair motion (PST-011): Farnebäck flow between two grey proxies, 75th percentile of the magnitude,
 * plus the median displacement (diagnostics). Parameters as the reference analyser (cadence.py).
 */
function motion(msg) {
	const { width: w, height: h, a, b } = msg;
	const ma = new cv.Mat(h, w, cv.CV_8UC1);
	const mb = new cv.Mat(h, w, cv.CV_8UC1);
	const flow = new cv.Mat();
	try {
		ma.data.set(a);
		mb.data.set(b);
		cv.calcOpticalFlowFarneback(ma, mb, flow, 0.5, 4, 21, 3, 5, 1.1, 0);
		const f = flow.data32F;
		const n = w * h;
		const mag = new Float32Array(n);
		const dx = new Float32Array(n);
		const dy = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const x = f[2 * i];
			const y = f[2 * i + 1];
			dx[i] = x;
			dy[i] = y;
			mag[i] = Math.hypot(x, y);
		}
		return { p75: percentile(mag, 75), dx: median(dx), dy: median(dy) };
	} finally {
		ma.delete();
		mb.delete();
		flow.delete();
	}
}

/** BT.709 luma of an rgb48 frame as 8 bit (flow input). */
function grey8(rgb, w, h) {
	const n = w * h;
	const out = new Uint8Array(n);
	for (let i = 0, j = 0; i < n; i++, j += 3) {
		const y = 0.2126 * rgb[j] + 0.7152 * rgb[j + 1] + 0.0722 * rgb[j + 2];
		out[i] = Math.min(255, Math.round(y / 257));
	}
	return out;
}

/** A grey Mat of `rgb` at the flow resolution (area downscale when smaller). */
function greyMat(rgb, w, h, fw, fh) {
	const full = new cv.Mat(h, w, cv.CV_8UC1);
	full.data.set(grey8(rgb, w, h));
	if (fw === w && fh === h) return full;
	const small = new cv.Mat();
	cv.resize(full, small, new cv.Size(fw, fh), 0, 0, cv.INTER_AREA);
	full.delete();
	return small;
}

/**
 * Nearest-frame backward warp (PST-013): output(x) = near(x − t·F(x − t·F(x))) with F = flow near→far,
 * computed on a grey proxy ≤ `flowMaxWidth` px wide and upsampled; bicubic sampling, replicated borders.
 * The two frames are never blended.
 */
function warp(msg) {
	const { width: w, height: h, near, far, t } = msg;
	const fp = msg.flow;
	const fw = Math.min(w, fp.maxWidth);
	const fh = fw === w ? h : Math.max(1, Math.round((h * fw) / w));
	const mats = [];
	const keep = (m) => {
		mats.push(m);
		return m;
	};
	try {
		const gn = keep(greyMat(near, w, h, fw, fh));
		const gf = keep(greyMat(far, w, h, fw, fh));
		const flow = keep(new cv.Mat());
		cv.calcOpticalFlowFarneback(
			gn,
			gf,
			flow,
			fp.pyrScale,
			fp.levels,
			fp.winsize,
			fp.iterations,
			fp.polyN,
			fp.polySigma,
			fp.gaussian ? cv.OPTFLOW_FARNEBACK_GAUSSIAN : 0,
		);
		// Optional smoothing of the flow field (suppresses Farnebäck noise along edges in flat areas, which
		// would otherwise show as wavy straight lines); sigma in flow-resolution pixels.
		if (fp.smoothSigma > 0) {
			const k = 2 * Math.ceil(3 * fp.smoothSigma) + 1;
			cv.GaussianBlur(flow, flow, new cv.Size(k, k), fp.smoothSigma, fp.smoothSigma, cv.BORDER_REPLICATE);
		}
		// One fixed-point step of the flow lookup at the flow resolution: d(x) = t·F(x − t·F(x)).
		const f = flow.data32F;
		const mx = keep(new cv.Mat(fh, fw, cv.CV_32FC1));
		const my = keep(new cv.Mat(fh, fw, cv.CV_32FC1));
		const mxd = mx.data32F;
		const myd = my.data32F;
		for (let y = 0, i = 0; y < fh; y++) {
			for (let x = 0; x < fw; x++, i++) {
				mxd[i] = x - t * f[2 * i];
				myd[i] = y - t * f[2 * i + 1];
			}
		}
		const f2 = keep(new cv.Mat());
		cv.remap(flow, f2, mx, my, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
		let disp = f2;
		if (fw !== w || fh !== h) {
			disp = keep(new cv.Mat());
			cv.resize(f2, disp, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
		}
		const sx = t * (w / fw);
		const sy = t * (h / fh);
		const d = disp.data32F;
		const map = keep(new cv.Mat(h, w, cv.CV_32FC2));
		const md = map.data32F;
		for (let y = 0, i = 0; y < h; y++) {
			for (let x = 0; x < w; x++, i += 2) {
				md[i] = x - sx * d[i];
				md[i + 1] = y - sy * d[i + 1];
			}
		}
		const src = keep(new cv.Mat(h, w, cv.CV_16UC3));
		src.data16U.set(near);
		const dst = keep(new cv.Mat());
		const none = keep(new cv.Mat());
		cv.remap(src, dst, map, none, cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
		return new Uint16Array(dst.data16U);
	} finally {
		for (const m of mats) m.delete();
	}
}

async function main() {
	const port = parentPort;
	if (!port) throw new Error('dejudder worker: not running in a worker thread');
	try {
		await loadCv();
	} catch (e) {
		port.postMessage({ type: 'error', id: -1, message: `OpenCV.js failed to load: ${String(e)}` });
		return;
	}
	port.on('message', (msg) => {
		try {
			if (msg.type === 'motion') {
				port.postMessage({ type: 'motion', id: msg.id, ...motion(msg) });
			} else if (msg.type === 'warp') {
				const data = warp(msg);
				port.postMessage({ type: 'warp', id: msg.id, data }, [data.buffer]);
			} else {
				port.postMessage({ type: 'error', id: msg.id, message: `unknown request ${msg.type}` });
			}
		} catch (e) {
			const message = typeof e === 'number' ? `OpenCV exception ${e}` : String(e?.stack ?? e);
			port.postMessage({ type: 'error', id: msg.id, message });
		}
	});
	port.postMessage({ type: 'ready' });
}

main();
