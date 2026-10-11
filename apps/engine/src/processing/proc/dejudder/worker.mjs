// OpenCV.js worker thread of jasper-proc: de-judder optical flow + backward warp (S07:PST-013/014) and the
// sparse feature tracking of the smooth-path stabiliser (S07:PST-005, `track`).
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

/** @type {import('../../../tools/opencv.ts').OpenCv} */
let cv;

/** Emscripten's self-resolving thenable cannot be passed to a native promise's resolve. */
function loadCv() {
	return new Promise((resolve) => {
		const module = /** @type {import('../../../tools/opencv.ts').OpenCv} */ (cvModule);
		const done = () => {
			cv = module;
			resolve(undefined);
		};
		if (module.then) module.then(done);
		else if (module.Mat) done();
		else module.onRuntimeInitialized = done;
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

/**
 * Per-pair motion (PST-011): Farnebäck flow between two grey proxies, 75th percentile of the magnitude.
 * Parameters as the reference analyser (cadence.py).
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
		for (let i = 0; i < n; i++) {
			const x = f[2 * i];
			const y = f[2 * i + 1];
			mag[i] = Math.hypot(x, y);
		}
		return { p75: percentile(mag, 75) };
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

/**
 * Sparse feature tracking between two grey frames (smooth-path stabiliser, PST-005): Shi-Tomasi corners on
 * `a` (`goodFeaturesToTrack`), pyramidal Lucas-Kanade into `b`. Returns the tracked pairs (status 1) as
 * interleaved x,y Float32Arrays; the similarity fit (RANSAC) runs in the main thread (smoothpath/math.ts).
 */
function track(msg) {
	const { width: w, height: h, a, b, params: p } = msg;
	const ma = new cv.Mat(h, w, cv.CV_8UC1);
	const mb = new cv.Mat(h, w, cv.CV_8UC1);
	const p0 = new cv.Mat();
	const p1 = new cv.Mat();
	const st = new cv.Mat();
	const err = new cv.Mat();
	const none = new cv.Mat();
	try {
		ma.data.set(a);
		mb.data.set(b);
		cv.goodFeaturesToTrack(ma, p0, p.maxCorners, p.quality, p.minDistance, none, 3, false, 0.04);
		const n = p0.rows;
		if (n === 0) return { p0: new Float32Array(0), p1: new Float32Array(0) };
		const crit = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);
		cv.calcOpticalFlowPyrLK(ma, mb, p0, p1, st, err, new cv.Size(p.winSize, p.winSize), p.maxLevel, crit);
		const s = st.data;
		const f0 = p0.data32F;
		const f1 = p1.data32F;
		let k = 0;
		for (let i = 0; i < n; i++) if (s[i] === 1) k++;
		const o0 = new Float32Array(2 * k);
		const o1 = new Float32Array(2 * k);
		for (let i = 0, j = 0; i < n; i++) {
			if (s[i] !== 1) continue;
			o0[j] = f0[2 * i];
			o0[j + 1] = f0[2 * i + 1];
			o1[j] = f1[2 * i];
			o1[j + 1] = f1[2 * i + 1];
			j += 2;
		}
		return { p0: o0, p1: o1 };
	} finally {
		for (const m of [ma, mb, p0, p1, st, err, none]) m.delete();
	}
}

/**
 * Similarity / affine warp of an rgb48 frame (smooth-path stabiliser fallback, PST-005): `m` is the BACKWARD map
 * (output pixel → source pixel) as [a, b, c, d, e, f]; bicubic, replicated or black borders.
 */
function warpAffine(msg) {
	const { width: w, height: h, data, m, border } = msg;
	const src = new cv.Mat(h, w, cv.CV_16UC3);
	const dst = new cv.Mat();
	const M = cv.matFromArray(2, 3, cv.CV_64F, m);
	try {
		src.data16U.set(data);
		cv.warpAffine(
			src,
			dst,
			M,
			new cv.Size(w, h),
			cv.INTER_CUBIC | cv.WARP_INVERSE_MAP,
			border === 1 ? cv.BORDER_REPLICATE : cv.BORDER_CONSTANT,
			new cv.Scalar(0, 0, 0, 0),
		);
		return new Uint16Array(dst.data16U);
	} finally {
		src.delete();
		dst.delete();
		M.delete();
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
			} else if (msg.type === 'warpAffine') {
				const data = warpAffine(msg);
				port.postMessage({ type: 'warp', id: msg.id, data }, [data.buffer]);
			} else if (msg.type === 'track') {
				const r = track(msg);
				port.postMessage({ type: 'track', id: msg.id, ...r }, [r.p0.buffer, r.p1.buffer]);
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
