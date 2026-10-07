// Lumetri Scopes panel (S06:SCP-001…003): waveform (luma), RGB parade, vectorscope (Rec.709 YUV, 75 % targets,
// skin-tone line) and histogram of the selected clip's graded picture read back from the Program monitor
// (≤ 256 px wide), computed in a worker; ≤ 15 updates/s while playing, on every change while paused. Drawn with
// design tokens only (CSS variables read with getComputedStyle).
import { sequenceColorInfo, workingSignalOfNits } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState } from '@jasper/session/react';
import { cx } from '@jasper/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { gradeEligible } from '../../color/model.ts';
import { cssColorRgb, findClipSource, frameHash, readFrame } from '../../color/scopes/capture.ts';
import { createScopeComputer } from '../../color/scopes/client.ts';
import {
	type RGB,
	SCOPE_MODES,
	type ScopeMode,
	type ScopeResult,
	skinToneDirection,
	vectorscopePoint,
	vectorscopeTargets,
} from '../../color/scopes/math.ts';
import type { PanelProps } from '../types.ts';

const MODE_LABEL: Record<ScopeMode, string> = {
	waveform: 'Waveform',
	parade: 'Parade',
	vectorscope: 'Vectorscope',
	histogram: 'Histogram',
};
const PLAYING_INTERVAL_MS = 1000 / 15;
const PAUSED_POLL_MS = 250;
const MODE_KEY = 'jasper.scopes.mode';

export function ScopesPanel(props: PanelProps) {
	const session = useSessionOrNull();
	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel font-pr text-pr-ui text-pr-text"
			data-panel-kind="scopes"
			data-instance-id={props.instanceId}
			data-testid="scopes-panel"
		>
			{session ? (
				<ScopesBody session={session} visible={props.visible} />
			) : (
				<p className="p-3 text-pr-small text-pr-muted">No project open.</p>
			)}
		</div>
	);
}

type Colors = {
	bg: string;
	graticule: string;
	label: string;
	skin: string;
	target: string;
	trace: RGB;
	luma: RGB;
	red: RGB;
	green: RGB;
	blue: RGB;
	/** Token values (CSS colours) of the channel traces, for the histogram fills. */
	css: { red: string; green: string; blue: string };
};

function readColors(el: Element): Colors {
	const cs = getComputedStyle(el);
	const v = (name: string) => cs.getPropertyValue(name).trim();
	// Unresolvable tokens (tests without CSS) fall back to a neutral trace.
	const tokenRgb = (name: string) => cssColorRgb(v(name), [200, 200, 200]);
	return {
		bg: v('--pr-scope-bg'),
		graticule: v('--pr-scope-graticule'),
		label: v('--pr-scope-label'),
		skin: v('--pr-scope-skin'),
		target: v('--pr-scope-target'),
		trace: tokenRgb('--pr-scope-trace'),
		luma: tokenRgb('--pr-scope-trace-luma'),
		red: tokenRgb('--pr-scope-red'),
		green: tokenRgb('--pr-scope-green'),
		blue: tokenRgb('--pr-scope-blue'),
		css: { red: v('--pr-scope-red'), green: v('--pr-scope-green'), blue: v('--pr-scope-blue') },
	};
}

function loadMode(): ScopeMode {
	try {
		const m = globalThis.localStorage?.getItem(MODE_KEY) as ScopeMode | null;
		return m && SCOPE_MODES.includes(m) ? m : 'waveform';
	} catch {
		return 'waveform';
	}
}

function ScopesBody({ session, visible }: { session: EditorSession; visible: boolean }) {
	const [mode, setModeState] = useState<ScopeMode>(loadMode);
	const [status, setStatus] = useState<string>('');
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const clipId = useSessionState((s) => {
		const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
		const id = s.selection.timeline.primaryClip ?? s.selection.timeline.clips.at(-1) ?? null;
		const clip = id ? seq?.clips[id] : undefined;
		return gradeEligible(clip) ? clip.id : null;
	});
	const revision = useSessionState((s) => (s.transient ? -s.revision - 1 : s.revision));
	// color-mgmt: the working space; HDR sequences can show the waveform in cd/m² (PQ / HLG signal positions).
	const working = useSessionState((s) => {
		const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
		return sequenceColorInfo(seq?.settings).space;
	});
	const hdr = working === 'rec2100-pq' || working === 'rec2100-hlg';
	const [nitsPref, setNitsPref] = useState(() => {
		try {
			return globalThis.localStorage?.getItem(SCALE_KEY) !== 'percent';
		} catch {
			return true;
		}
	});
	const scale: ScopeScale = hdr && nitsPref ? { kind: 'nits', space: working } : { kind: 'percent' };
	const setMode = (m: ScopeMode) => {
		setModeState(m);
		try {
			globalThis.localStorage?.setItem(MODE_KEY, m);
		} catch {
			// not persisted
		}
	};

	// Latest state for the loop (no re-subscription per change).
	const live = useRef({ mode, clipId, visible, scale });
	live.current = { mode, clipId, visible, scale };
	const last = useRef<ScopeResult | null>(null);
	/** Time the in-flight request was posted (0 = none); a lost reply unblocks after a second. */
	const pending = useRef(0);
	const captureNow = useRef<((force?: boolean) => void) | null>(null);
	const lastHash = useRef<number | null>(null);
	const reqId = useRef(0);
	const colors = useRef<Colors | null>(null);

	const draw = useCallback(() => {
		const canvas = canvasRef.current;
		const box = boxRef.current;
		if (!canvas || !box) return;
		const g = canvas.getContext('2d');
		if (!g) return;
		const rect = box.getBoundingClientRect();
		const dpr = globalThis.devicePixelRatio || 1;
		const W = Math.max(1, Math.floor(rect.width));
		const H = Math.max(1, Math.floor(rect.height));
		if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
			canvas.width = W * dpr;
			canvas.height = H * dpr;
		}
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		colors.current ??= readColors(box);
		drawScope(g, W, H, live.current.mode, last.current, colors.current, live.current.scale);
	}, []);

	// Result handling + worker lifetime.
	const computer = useRef<ReturnType<typeof createScopeComputer> | null>(null);
	useEffect(() => {
		const c = createScopeComputer((r) => {
			pending.current = 0;
			if (r.mode !== live.current.mode) return;
			last.current = r;
			draw();
		});
		computer.current = c;
		return () => {
			c.dispose();
			computer.current = null;
		};
	}, [draw]);

	// Capture loop.
	useEffect(() => {
		let disposed = false;
		const capture = (force = false) => {
			const { clipId: id, mode: m, visible: vis } = live.current;
			if (disposed || !vis || !computer.current) return;
			if (!id) {
				setStatus('Select a clip in the Timeline.');
				last.current = null;
				lastHash.current = null;
				draw();
				return;
			}
			if (pending.current && performance.now() - pending.current < 1000) return;
			const el = findClipSource(id);
			const frame = el ? readFrame(el) : null;
			if (!frame) {
				setStatus(el ? 'Waiting for the picture…' : 'The selected clip is not visible at the playhead.');
				last.current = null;
				lastHash.current = null;
				draw();
				return;
			}
			setStatus('');
			const h = frameHash(frame) ^ SCOPE_MODES.indexOf(m);
			if (!force && h === lastHash.current) return;
			lastHash.current = h;
			colors.current ??= boxRef.current ? readColors(boxRef.current) : null;
			const c = colors.current;
			if (!c) return;
			const box = boxRef.current?.getBoundingClientRect();
			const outW = Math.max(64, Math.min(512, Math.floor(box?.width || 256)));
			const outH = Math.max(64, Math.min(256, Math.floor(box?.height || 128)));
			pending.current = performance.now();
			computer.current.post({
				id: ++reqId.current,
				mode: m,
				data: frame.data,
				width: frame.width,
				height: frame.height,
				outW,
				outH,
				colors: { trace: c.trace, luma: c.luma, red: c.red, green: c.green, blue: c.blue },
			});
		};
		let timer: ReturnType<typeof setInterval> | null = null;
		const schedule = () => {
			if (timer) clearInterval(timer);
			const playing = session.transport.getState().playing;
			timer = setInterval(() => capture(), playing ? PLAYING_INTERVAL_MS : PAUSED_POLL_MS);
		};
		schedule();
		const unsub = session.transport.subscribe((s, prev) => {
			if (s.playing !== prev.playing) schedule();
			if (!s.playing && s.frame !== prev.frame) {
				capture();
				setTimeout(() => capture(), 120);
			}
		});
		captureNow.current = capture;
		capture(true);
		return () => {
			disposed = true;
			captureNow.current = null;
			if (timer) clearInterval(timer);
			unsub();
		};
	}, [session, draw]);

	// Immediate refresh on selection, document, mode or visibility changes (the paused poll catches pictures
	// that land later, e.g. a re-baked grade or a decoded frame).
	// biome-ignore lint/correctness/useExhaustiveDependencies: mode/clipId/revision/visible are triggers only
	useEffect(() => {
		if (last.current && last.current.mode !== mode) last.current = null;
		draw();
		captureNow.current?.(true);
	}, [mode, clipId, revision, visible, draw, scale.kind, working]);

	// Redraw on resize.
	useEffect(() => {
		const box = boxRef.current;
		if (!box || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => draw());
		ro.observe(box);
		return () => ro.disconnect();
	}, [draw]);

	return (
		<>
			<header className="flex h-[28px] shrink-0 items-center gap-1 border-b border-pr-border-subtle px-2">
				<div
					className="flex min-w-0 items-center gap-[2px] overflow-hidden"
					role="tablist"
					aria-label="Scope"
				>
					{SCOPE_MODES.map((m) => (
						<button
							key={m}
							type="button"
							role="tab"
							aria-selected={mode === m}
							className={cx(
								'h-[20px] shrink-0 whitespace-nowrap rounded-pr-control px-2 text-pr-small',
								mode === m ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:bg-pr-hover',
							)}
							onClick={() => setMode(m)}
							data-testid={`scopes-mode-${m}`}
						>
							{MODE_LABEL[m]}
						</button>
					))}
				</div>
				{hdr ? (
					<button
						type="button"
						className="ml-auto h-[20px] shrink-0 rounded-pr-control px-2 text-pr-small text-pr-muted hover:bg-pr-hover"
						onClick={() => {
							const next = !nitsPref;
							setNitsPref(next);
							try {
								globalThis.localStorage?.setItem(SCALE_KEY, next ? 'nits' : 'percent');
							} catch {
								// not persisted
							}
						}}
						title="Waveform scale: cd/m² (HDR) or percent of the signal"
						data-testid="scopes-scale"
					>
						{nitsPref ? 'Scale: nits' : 'Scale: %'}
					</button>
				) : null}
			</header>
			<div ref={boxRef} className="relative min-h-0 flex-1" style={{ background: 'var(--pr-scope-bg)' }}>
				<canvas
					ref={canvasRef}
					className="absolute inset-0 size-full"
					data-testid="scopes-canvas"
					data-mode={mode}
					data-has-trace={last.current ? 'true' : 'false'}
				/>
				<span className="pointer-events-none absolute top-1 right-2 text-pr-small text-pr-dim">
					Selected clip (graded)
				</span>
				{status ? (
					<p
						className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-pr-small text-pr-muted"
						data-testid="scopes-status"
					>
						{status}
					</p>
				) : null}
			</div>
		</>
	);
}

// ---------------------------------------------------------------- drawing (tokens only)

const PAD = 24;

function traceBitmap(r: ScopeResult): HTMLCanvasElement | null {
	if (!r.width || !r.height || typeof document === 'undefined') return null;
	const c = document.createElement('canvas');
	c.width = r.width;
	c.height = r.height;
	const g = c.getContext('2d');
	if (!g) return null;
	g.putImageData(new ImageData(new Uint8ClampedArray(r.image), r.width, r.height), 0, 0);
	return c;
}

/** color-mgmt: the waveform's vertical scale: percent of the signal, or cd/m² of an HDR working space. */
type ScopeScale = { kind: 'percent' } | { kind: 'nits'; space: 'rec2100-pq' | 'rec2100-hlg' | string };
const SCALE_KEY = 'jasper.scopes.hdrScale';
/** cd/m² graticule of HDR waveforms (BT.2408 reference white 203 labelled). */
const NITS_LINES = [0.1, 1, 10, 100, 203, 1000, 4000, 10000];

/** color-mgmt: cd/m² lines at their PQ / HLG signal positions (the trace is the working signal). */
function drawNitsGraticule(
	g: CanvasRenderingContext2D,
	space: string,
	x0: number,
	y0: number,
	w: number,
	h: number,
	c: Colors,
): void {
	for (const n of NITS_LINES) {
		if (space === 'rec2100-hlg' && n > 1000) continue;
		const v = workingSignalOfNits(space as 'rec2100-pq', n);
		const y = Math.round(y0 + h - v * h) + 0.5;
		g.strokeStyle = c.graticule;
		g.globalAlpha = n === 203 || n === 1000 ? 1 : 0.5;
		g.beginPath();
		g.moveTo(x0, y);
		g.lineTo(x0 + w, y);
		g.stroke();
		g.globalAlpha = 1;
		g.fillStyle = c.label;
		g.fillText(n < 1 ? String(n) : n >= 1000 ? `${n / 1000}k` : String(n), 1, y + 3);
	}
}

/** IRE-style graticule 0…100 every 10. */
function drawPercentGraticule(
	g: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	w: number,
	h: number,
	c: Colors,
): void {
	for (let i = 0; i <= 10; i++) {
		const y = Math.round(y0 + h - (i / 10) * h) + 0.5;
		g.strokeStyle = c.graticule;
		g.globalAlpha = i % 5 === 0 ? 1 : 0.5;
		g.beginPath();
		g.moveTo(x0, y);
		g.lineTo(x0 + w, y);
		g.stroke();
		g.globalAlpha = 1;
		if (i % 2 === 0) {
			g.fillStyle = c.label;
			g.fillText(String(i * 10), 2, y + 3);
		}
	}
}

function drawScope(
	g: CanvasRenderingContext2D,
	W: number,
	H: number,
	mode: ScopeMode,
	r: ScopeResult | null,
	c: Colors,
	scale: ScopeScale = { kind: 'percent' },
): void {
	g.clearRect(0, 0, W, H);
	g.fillStyle = c.bg;
	g.fillRect(0, 0, W, H);
	g.font = '10px var(--pr-font-ui), sans-serif';
	g.lineWidth = 1;
	const x0 = PAD;
	const y0 = 8;
	const w = Math.max(10, W - PAD - 8);
	const h = Math.max(10, H - 16);
	if (mode === 'waveform' || mode === 'parade') {
		if (scale.kind === 'nits') drawNitsGraticule(g, scale.space, x0, y0, w, h, c);
		else drawPercentGraticule(g, x0, y0, w, h, c);
		if (mode === 'parade')
			for (const t of [1 / 3, 2 / 3]) {
				const x = Math.round(x0 + w * t) + 0.5;
				g.strokeStyle = c.graticule;
				g.beginPath();
				g.moveTo(x, y0);
				g.lineTo(x, y0 + h);
				g.stroke();
			}
		const bmp = r && (r.mode === 'waveform' || r.mode === 'parade') ? traceBitmap(r) : null;
		if (bmp) {
			g.imageSmoothingEnabled = true;
			g.drawImage(bmp, x0, y0, w, h);
		}
		return;
	}
	if (mode === 'vectorscope') {
		const size = Math.max(10, Math.min(W, H) - 16);
		const vx = (W - size) / 2;
		const vy = (H - size) / 2;
		const cx0 = vx + size / 2;
		const cy0 = vy + size / 2;
		g.strokeStyle = c.graticule;
		g.beginPath();
		g.arc(cx0, cy0, size / 2, 0, Math.PI * 2);
		g.stroke();
		g.beginPath();
		g.moveTo(vx, cy0);
		g.lineTo(vx + size, cy0);
		g.moveTo(cx0, vy);
		g.lineTo(cx0, vy + size);
		g.stroke();
		// Skin-tone line.
		const skin = skinToneDirection();
		g.strokeStyle = c.skin;
		g.beginPath();
		g.moveTo(cx0, cy0);
		g.lineTo(cx0 + (skin.cb * size) / 2, cy0 - (skin.cr * size) / 2);
		g.stroke();
		// 75 % targets.
		g.strokeStyle = c.target;
		g.fillStyle = c.label;
		for (const t of vectorscopeTargets(0.75)) {
			const p = vectorscopePoint(t.cb, t.cr, size);
			const tx = vx + p.x;
			const ty = vy + p.y;
			g.strokeRect(tx - 4, ty - 4, 8, 8);
			g.fillText(t.name, tx + 6, ty + 3);
		}
		const bmp = r?.mode === 'vectorscope' ? traceBitmap(r) : null;
		if (bmp) g.drawImage(bmp, vx, vy, size, size);
		return;
	}
	// Histogram: R, G, B overlaid (additive) plus the luma outline.
	for (const t of [0.25, 0.5, 0.75]) {
		const x = Math.round(x0 + w * t) + 0.5;
		g.strokeStyle = c.graticule;
		g.beginPath();
		g.moveTo(x, y0);
		g.lineTo(x, y0 + h);
		g.stroke();
	}
	const hist = r?.mode === 'histogram' ? r.histogram : undefined;
	if (!hist) return;
	let max = 1;
	for (const ch of [hist.r, hist.g, hist.b]) for (let i = 1; i < 255; i++) max = Math.max(max, ch[i]!);
	const bar = (ch: Uint32Array, color: string) => {
		g.fillStyle = color;
		g.globalAlpha = 0.45;
		g.beginPath();
		g.moveTo(x0, y0 + h);
		for (let i = 0; i < 256; i++) g.lineTo(x0 + (i / 255) * w, y0 + h - Math.min(1, ch[i]! / max) * h);
		g.lineTo(x0 + w, y0 + h);
		g.closePath();
		g.fill();
		g.globalAlpha = 1;
	};
	g.globalCompositeOperation = 'lighter';
	bar(hist.r, c.css.red);
	bar(hist.g, c.css.green);
	bar(hist.b, c.css.blue);
	g.globalCompositeOperation = 'source-over';
	g.strokeStyle = c.label;
	g.beginPath();
	for (let i = 0; i < 256; i++) {
		const x = x0 + (i / 255) * w;
		const y = y0 + h - Math.min(1, hist.y[i]! / max) * h;
		if (i === 0) g.moveTo(x, y);
		else g.lineTo(x, y);
	}
	g.stroke();
}
