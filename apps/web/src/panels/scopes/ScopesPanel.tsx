// Lumetri Scopes panel (S06:SCP-001…003; color-grade upgrade, FilmCraft `crates/scopes` port): Waveform (RGB, Luma,
// YC, YC no Chroma), Parade (RGB, YUV, RGB-White), Histogram, Vectorscope YUV (75 % / 100 % targets, skin-tone line)
// and Vectorscope HLS, alone or in layout presets (two and four scopes), with Premiere's settings — Color Space
// (Rec. 601 / 709 / 2020), Clamp Signal, Brightness and the levels scale (8-bit, 10-bit, float). The selected
// clip's graded picture is read back from the Program monitor and every scope of the layout is computed in a worker
// by the shared maths (@jasper/project color/scopes.ts, the same code `scopes_read` runs); ≤ 15 updates/s while
// playing, on every change while paused. Drawn with design tokens only (CSS variables read with getComputedStyle).
import {
	hlsTargets,
	PARADE_TYPE_LABELS,
	PARADE_TYPES,
	type ParadeType,
	SCOPE_KIND_LABELS,
	SCOPE_MATRICES,
	SCOPE_MATRIX_LABELS,
	SCOPE_SCALE_LABELS,
	SCOPE_SCALES,
	type ScopeBrightness,
	type ScopeKind,
	type ScopeMatrix,
	type ScopeScale,
	scaleLabels,
	skinToneLine,
	VECTOR_EXTENT,
	type VectorTargets,
	vectorTargets,
	WAVEFORM_TYPE_LABELS,
	WAVEFORM_TYPES,
	type WaveformType,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState } from '@jasper/session/react';
import { cx } from '@jasper/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { gradeEligible } from '../../color/model.ts';
import { cssColorRgb, findClipSource, frameHash, readFrame } from '../../color/scopes/capture.ts';
import { createScopesComputer } from '../../color/scopes/client.ts';
import type { RGB, ScopeImage, ScopeSettings, ScopesResult } from '../../color/scopes/compute.ts';
import type { PanelProps } from '../types.ts';

const PLAYING_INTERVAL_MS = 1000 / 15;
const PAUSED_POLL_MS = 250;
/** Read-back width (the maths decimate to ≤ 480 × 270 samples). */
const CAPTURE_WIDTH = 480;
const SETTINGS_KEY = 'jasper.scopes.settings.v2';

/** Layout presets (Premiere's Lumetri Scopes presets: one scope, pairs, the four-scope layouts). */
export const SCOPE_LAYOUTS: readonly { id: string; label: string; slots: readonly ScopeKind[] }[] = [
	{ id: 'waveform', label: 'Waveform', slots: ['waveform'] },
	{ id: 'parade', label: 'Parade', slots: ['parade'] },
	{ id: 'vectorscopeYuv', label: 'Vectorscope YUV', slots: ['vectorscopeYuv'] },
	{ id: 'vectorscopeHls', label: 'Vectorscope HLS', slots: ['vectorscopeHls'] },
	{ id: 'histogram', label: 'Histogram', slots: ['histogram'] },
	{ id: 'vector-waveform', label: 'Vectorscope + Waveform', slots: ['vectorscopeYuv', 'waveform'] },
	{ id: 'parade-vector', label: 'Parade + Vectorscope', slots: ['parade', 'vectorscopeYuv'] },
	{ id: 'waveform-histogram', label: 'Waveform + Histogram', slots: ['waveform', 'histogram'] },
	{ id: 'four-up', label: 'Four Scopes (YUV)', slots: ['vectorscopeYuv', 'histogram', 'parade', 'waveform'] },
	{
		id: 'four-up-hls',
		label: 'Four Scopes (HLS)',
		slots: ['vectorscopeHls', 'histogram', 'parade', 'waveform'],
	},
];

type PanelSettings = ScopeSettings & { layout: string; scale: ScopeScale; targets: VectorTargets };

const DEFAULTS: PanelSettings = {
	layout: 'waveform',
	waveformType: 'rgb',
	paradeType: 'rgb',
	matrix: 'bt709',
	clamp: true,
	brightness: 'normal',
	scale: '8bit',
	targets: 75,
};

function loadSettings(): PanelSettings {
	try {
		const raw = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) ?? '{}') as Partial<PanelSettings>;
		const pick = <T,>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
		return {
			layout: pick(
				raw.layout,
				SCOPE_LAYOUTS.map((l) => l.id),
				DEFAULTS.layout,
			),
			waveformType: pick(raw.waveformType, WAVEFORM_TYPES, DEFAULTS.waveformType),
			paradeType: pick(raw.paradeType, PARADE_TYPES, DEFAULTS.paradeType),
			matrix: pick(raw.matrix, SCOPE_MATRICES, DEFAULTS.matrix),
			clamp: typeof raw.clamp === 'boolean' ? raw.clamp : DEFAULTS.clamp,
			brightness: pick<ScopeBrightness>(raw.brightness, ['dimmed', 'normal', 'bright'], DEFAULTS.brightness),
			scale: pick(raw.scale, SCOPE_SCALES, DEFAULTS.scale),
			targets: pick<VectorTargets>(raw.targets, [75, 100], DEFAULTS.targets),
		};
	} catch {
		return { ...DEFAULTS };
	}
}

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
	ire: string;
	label: string;
	skin: string;
	target: string;
	trace: RGB;
	luma: RGB;
	chroma: RGB;
	red: RGB;
	green: RGB;
	blue: RGB;
	/** Token values (CSS colours) of the channel traces, for the histogram fills. */
	css: { red: string; green: string; blue: string; luma: string };
};

function readColors(el: Element): Colors {
	const cs = getComputedStyle(el);
	const v = (name: string) => cs.getPropertyValue(name).trim();
	// Unresolvable tokens (tests without CSS) fall back to a neutral trace.
	const tokenRgb = (name: string) => cssColorRgb(v(name), [200, 200, 200]);
	return {
		bg: v('--pr-scope-bg'),
		graticule: v('--pr-scope-graticule'),
		ire: v('--pr-scope-ire'),
		label: v('--pr-scope-label'),
		skin: v('--pr-scope-skin'),
		target: v('--pr-scope-target'),
		trace: tokenRgb('--pr-scope-trace'),
		luma: tokenRgb('--pr-scope-trace-luma'),
		chroma: tokenRgb('--pr-scope-chroma'),
		red: tokenRgb('--pr-scope-red'),
		green: tokenRgb('--pr-scope-green'),
		blue: tokenRgb('--pr-scope-blue'),
		css: {
			red: v('--pr-scope-red'),
			green: v('--pr-scope-green'),
			blue: v('--pr-scope-blue'),
			luma: v('--pr-scope-trace-luma'),
		},
	};
}

const SELECT =
	'h-[20px] min-w-0 rounded-pr-control border border-transparent bg-pr-field px-1 text-pr-small text-pr-text hover:border-pr-border-strong';

function ScopesBody({ session, visible }: { session: EditorSession; visible: boolean }) {
	const [settings, setSettingsState] = useState<PanelSettings>(loadSettings);
	const [showSettings, setShowSettings] = useState(false);
	const [status, setStatus] = useState<string>('');
	const [hasTrace, setHasTrace] = useState(false);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const clipId = useSessionState((s) => {
		const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
		const id = s.selection.timeline.primaryClip ?? s.selection.timeline.clips.at(-1) ?? null;
		const clip = id ? seq?.clips[id] : undefined;
		return gradeEligible(clip) ? clip.id : null;
	});
	const revision = useSessionState((s) => (s.transient ? -s.revision - 1 : s.revision));
	const setSettings = (patch: Partial<PanelSettings>) => {
		setSettingsState((cur) => {
			const next = { ...cur, ...patch };
			try {
				globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(next));
			} catch {
				// not persisted
			}
			return next;
		});
	};
	const layout = SCOPE_LAYOUTS.find((l) => l.id === settings.layout) ?? SCOPE_LAYOUTS[0]!;

	// Latest state for the loop (no re-subscription per change).
	const live = useRef({ settings, layout, clipId, visible });
	live.current = { settings, layout, clipId, visible };
	const last = useRef<ScopesResult | null>(null);
	/** Time the in-flight request was posted (0 = none); a lost reply unblocks after a second. */
	const pending = useRef(0);
	const captureNow = useRef<((force?: boolean) => void) | null>(null);
	const lastHash = useRef<string | null>(null);
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
		drawLayout(g, W, H, live.current.layout.slots, live.current.settings, last.current, colors.current);
	}, []);

	// Result handling + worker lifetime.
	const computer = useRef<ReturnType<typeof createScopesComputer> | null>(null);
	useEffect(() => {
		const c = createScopesComputer((r) => {
			pending.current = 0;
			if (r.id !== reqId.current) return;
			last.current = r;
			setHasTrace(true);
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
			const { clipId: id, settings: st, layout: lay, visible: vis } = live.current;
			if (disposed || !vis || !computer.current) return;
			if (!id) {
				setStatus('Select a clip in the Timeline.');
				last.current = null;
				setHasTrace(false);
				lastHash.current = null;
				draw();
				return;
			}
			if (pending.current && performance.now() - pending.current < 1000) return;
			const el = findClipSource(id);
			const frame = el ? readFrame(el, CAPTURE_WIDTH) : null;
			if (!frame) {
				setStatus(el ? 'Waiting for the picture…' : 'The selected clip is not visible at the playhead.');
				last.current = null;
				setHasTrace(false);
				lastHash.current = null;
				draw();
				return;
			}
			setStatus('');
			const key = `${frameHash(frame)}|${lay.slots.join(',')}|${st.waveformType}|${st.paradeType}|${st.matrix}|${st.clamp}|${st.brightness}`;
			if (!force && key === lastHash.current) return;
			lastHash.current = key;
			colors.current ??= boxRef.current ? readColors(boxRef.current) : null;
			const c = colors.current;
			if (!c) return;
			pending.current = performance.now();
			computer.current.post({
				id: ++reqId.current,
				data: frame.data,
				width: frame.width,
				height: frame.height,
				kinds: lay.slots,
				settings: {
					waveformType: st.waveformType,
					paradeType: st.paradeType,
					matrix: st.matrix,
					clamp: st.clamp,
					brightness: st.brightness,
				},
				colors: { trace: c.trace, luma: c.luma, chroma: c.chroma, red: c.red, green: c.green, blue: c.blue },
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

	// Immediate refresh on selection, document, settings or visibility changes (the paused poll catches pictures
	// that land later, e.g. a re-baked grade or a decoded frame).
	// biome-ignore lint/correctness/useExhaustiveDependencies: settings/clipId/revision/visible are triggers only
	useEffect(() => {
		draw();
		captureNow.current?.(true);
	}, [settings, clipId, revision, visible, draw]);

	// Redraw on resize.
	useEffect(() => {
		const box = boxRef.current;
		if (!box || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => draw());
		ro.observe(box);
		return () => ro.disconnect();
	}, [draw]);

	const has = (k: ScopeKind) => layout.slots.includes(k);
	return (
		<>
			<header className="flex h-[28px] shrink-0 items-center gap-1 border-b border-pr-border-subtle px-2">
				<select
					aria-label="Scopes layout"
					className={SELECT}
					value={layout.id}
					onChange={(e) => setSettings({ layout: e.target.value })}
					data-testid="scopes-layout"
				>
					{SCOPE_LAYOUTS.map((l) => (
						<option key={l.id} value={l.id}>
							{l.label}
						</option>
					))}
				</select>
				{has('waveform') ? (
					<select
						aria-label="Waveform type"
						className={SELECT}
						value={settings.waveformType}
						onChange={(e) => setSettings({ waveformType: e.target.value as WaveformType })}
						data-testid="scopes-waveform-type"
					>
						{WAVEFORM_TYPES.map((t) => (
							<option key={t} value={t}>
								{WAVEFORM_TYPE_LABELS[t]}
							</option>
						))}
					</select>
				) : null}
				{has('parade') ? (
					<select
						aria-label="Parade type"
						className={SELECT}
						value={settings.paradeType}
						onChange={(e) => setSettings({ paradeType: e.target.value as ParadeType })}
						data-testid="scopes-parade-type"
					>
						{PARADE_TYPES.map((t) => (
							<option key={t} value={t}>
								{PARADE_TYPE_LABELS[t]}
							</option>
						))}
					</select>
				) : null}
				<span className="flex-1" />
				<button
					type="button"
					aria-label="Scope settings"
					aria-expanded={showSettings}
					className={cx(
						'h-[20px] rounded-pr-control px-2 text-pr-small',
						showSettings ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:bg-pr-hover',
					)}
					onClick={() => setShowSettings((v) => !v)}
					data-testid="scopes-settings"
				>
					Settings
				</button>
			</header>
			{showSettings ? (
				<div
					className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-pr-border-subtle px-2 py-1 text-pr-small"
					data-testid="scopes-settings-row"
				>
					<label className="inline-flex items-center gap-1">
						Color Space
						<select
							aria-label="Color space"
							className={SELECT}
							value={settings.matrix}
							onChange={(e) => setSettings({ matrix: e.target.value as ScopeMatrix })}
							data-testid="scopes-matrix"
						>
							{SCOPE_MATRICES.map((m) => (
								<option key={m} value={m}>
									{SCOPE_MATRIX_LABELS[m]}
								</option>
							))}
						</select>
					</label>
					<label className="inline-flex items-center gap-1">
						Scale
						<select
							aria-label="Scale"
							className={SELECT}
							value={settings.scale}
							onChange={(e) => setSettings({ scale: e.target.value as ScopeScale })}
							data-testid="scopes-scale"
						>
							{SCOPE_SCALES.map((s) => (
								<option key={s} value={s}>
									{SCOPE_SCALE_LABELS[s]}
								</option>
							))}
						</select>
					</label>
					<label className="inline-flex items-center gap-1">
						Brightness
						<select
							aria-label="Brightness"
							className={SELECT}
							value={settings.brightness}
							onChange={(e) => setSettings({ brightness: e.target.value as ScopeBrightness })}
							data-testid="scopes-brightness"
						>
							<option value="dimmed">Dimmed</option>
							<option value="normal">Normal</option>
							<option value="bright">Bright</option>
						</select>
					</label>
					<label className="inline-flex items-center gap-1">
						Targets
						<select
							aria-label="Vectorscope targets"
							className={SELECT}
							value={settings.targets}
							onChange={(e) => setSettings({ targets: Number(e.target.value) === 100 ? 100 : 75 })}
							data-testid="scopes-targets"
						>
							<option value={75}>75%</option>
							<option value={100}>100%</option>
						</select>
					</label>
					<label className="inline-flex cursor-pointer items-center gap-1">
						<input
							type="checkbox"
							checked={settings.clamp}
							onChange={(e) => setSettings({ clamp: e.target.checked })}
							className="size-[12px] accent-[var(--pr-text-primary)]"
							data-testid="scopes-clamp"
						/>
						Clamp Signal
					</label>
				</div>
			) : null}
			<div ref={boxRef} className="relative min-h-0 flex-1" style={{ background: 'var(--pr-scope-bg)' }}>
				<canvas
					ref={canvasRef}
					className="absolute inset-0 size-full"
					data-testid="scopes-canvas"
					data-layout={layout.id}
					data-has-trace={hasTrace ? 'true' : 'false'}
					data-compute-ms={last.current ? Math.round(last.current.ms) : undefined}
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

const PAD = 30;

function bitmap(img: ScopeImage): HTMLCanvasElement | null {
	if (!img.width || !img.height || typeof document === 'undefined') return null;
	const c = document.createElement('canvas');
	c.width = img.width;
	c.height = img.height;
	const g = c.getContext('2d');
	if (!g) return null;
	const data = g.createImageData(img.width, img.height);
	data.data.set(img.image);
	g.putImageData(data, 0, 0);
	return c;
}

type Rect = { x: number; y: number; w: number; h: number };

/** Slot rectangles: one full, two side by side, four in a 2 × 2 grid. */
function slotRects(n: number, W: number, H: number): Rect[] {
	if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
	if (n === 2)
		return [
			{ x: 0, y: 0, w: W / 2, h: H },
			{ x: W / 2, y: 0, w: W / 2, h: H },
		];
	return [
		{ x: 0, y: 0, w: W / 2, h: H / 2 },
		{ x: W / 2, y: 0, w: W / 2, h: H / 2 },
		{ x: 0, y: H / 2, w: W / 2, h: H / 2 },
		{ x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
	];
}

function drawLayout(
	g: CanvasRenderingContext2D,
	W: number,
	H: number,
	slots: readonly ScopeKind[],
	st: PanelSettings,
	r: ScopesResult | null,
	c: Colors,
): void {
	g.clearRect(0, 0, W, H);
	g.fillStyle = c.bg;
	g.fillRect(0, 0, W, H);
	g.font = '10px var(--pr-font-ui), sans-serif';
	g.lineWidth = 1;
	const rects = slotRects(slots.length, W, H);
	slots.forEach((kind, i) => {
		const rect = rects[i]!;
		g.save();
		g.beginPath();
		g.rect(rect.x, rect.y, rect.w, rect.h);
		g.clip();
		const img = r?.images.find((x) => x.kind === kind) ?? null;
		if (kind === 'waveform' || kind === 'parade') drawLevels(g, rect, kind, img, st, c);
		else if (kind === 'histogram') drawHistogram(g, rect, r?.histogram ?? null, st, c);
		else drawVectorscope(g, rect, kind, img, st, c);
		if (slots.length > 1) {
			g.fillStyle = c.label;
			g.fillText(SCOPE_KIND_LABELS[kind], rect.x + PAD, rect.y + rect.h - 4);
			g.strokeStyle = c.graticule;
			g.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
		}
		g.restore();
	});
}

function drawLevels(
	g: CanvasRenderingContext2D,
	r: Rect,
	kind: 'waveform' | 'parade',
	img: ScopeImage | null,
	st: PanelSettings,
	c: Colors,
): void {
	const lo = img?.lo ?? (st.clamp ? 0 : -0.1);
	const hi = img?.hi ?? (st.clamp ? 1 : 1.1);
	const x0 = r.x + PAD;
	const y0 = r.y + 8;
	const w = Math.max(10, r.w - PAD - 8);
	const h = Math.max(10, r.h - 22);
	const yOf = (v: number) => y0 + h - ((v - lo) / (hi - lo)) * h;
	// Fine IRE graticule every 5 %, labelled in the chosen scale every 10 %.
	for (let i = 0; i <= 20; i++) {
		const y = Math.round(yOf(i / 20)) + 0.5;
		g.strokeStyle = i % 2 === 0 ? c.graticule : c.ire;
		g.beginPath();
		g.moveTo(x0, y);
		g.lineTo(x0 + w, y);
		g.stroke();
	}
	g.fillStyle = c.label;
	for (const [v, label] of scaleLabels(st.scale, 0, 1)) g.fillText(label, r.x + 2, Math.round(yOf(v)) + 3);
	const blocks = img?.blocks ?? 1;
	if (kind === 'parade')
		for (let k = 1; k < blocks; k++) {
			const x = Math.round(x0 + (w * k) / blocks) + 0.5;
			g.strokeStyle = c.graticule;
			g.beginPath();
			g.moveTo(x, y0);
			g.lineTo(x, y0 + h);
			g.stroke();
		}
	const bmp = img ? bitmap(img) : null;
	if (bmp) {
		g.imageSmoothingEnabled = true;
		g.drawImage(bmp, x0, y0, w, h);
		if (kind === 'parade') {
			g.fillStyle = c.label;
			img!.names.forEach((n, k) => {
				g.fillText(n, x0 + (w * k) / blocks + 3, y0 + 10);
			});
		}
	}
}

function drawVectorscope(
	g: CanvasRenderingContext2D,
	r: Rect,
	kind: ScopeKind,
	img: ScopeImage | null,
	st: PanelSettings,
	c: Colors,
): void {
	const size = Math.max(10, Math.min(r.w, r.h) - 16);
	const vx = r.x + (r.w - size) / 2;
	const vy = r.y + (r.h - size) / 2;
	const cx0 = vx + size / 2;
	const cy0 = vy + size / 2;
	const toPx = (cb: number, cr: number) =>
		[cx0 + (cb / VECTOR_EXTENT) * (size / 2), cy0 - (cr / VECTOR_EXTENT) * (size / 2)] as const;
	g.strokeStyle = c.graticule;
	// Saturation circles at 25 %, 50 % (radius 0.25) … 100 % (radius 0.5).
	for (const rad of [0.125, 0.25, 0.375, 0.5]) {
		g.beginPath();
		g.arc(cx0, cy0, (rad / VECTOR_EXTENT) * (size / 2), 0, Math.PI * 2);
		g.stroke();
	}
	g.beginPath();
	g.moveTo(vx, cy0);
	g.lineTo(vx + size, cy0);
	g.moveTo(cx0, vy);
	g.lineTo(cx0, vy + size);
	g.stroke();
	g.fillStyle = c.label;
	if (kind === 'vectorscopeYuv') {
		// Skin-tone line.
		const [sx, sy] = skinToneLine();
		const [ex, ey] = toPx(sx * VECTOR_EXTENT, sy * VECTOR_EXTENT);
		g.strokeStyle = c.skin;
		g.beginPath();
		g.moveTo(cx0, cy0);
		g.lineTo(ex, ey);
		g.stroke();
		// Colour-bar targets at 75 % or 100 % for the chosen matrix.
		g.strokeStyle = c.target;
		for (const t of vectorTargets(st.matrix, st.targets)) {
			const [tx, ty] = toPx(t.cb, t.cr);
			g.strokeRect(tx - 4, ty - 4, 8, 8);
			g.fillText(t.name, tx + 6, ty + 3);
		}
	} else {
		for (const t of hlsTargets(st.matrix)) {
			const [tx, ty] = toPx(t.cb, t.cr);
			g.fillText(t.name, tx - 4, ty + 3);
		}
	}
	g.fillText(SCOPE_MATRIX_LABELS[st.matrix], vx + 2, vy + 10);
	const bmp = img ? bitmap(img) : null;
	if (bmp) g.drawImage(bmp, vx, vy, size, size);
}

function drawHistogram(
	g: CanvasRenderingContext2D,
	r: Rect,
	hist: ScopesResult['histogram'] | null,
	st: PanelSettings,
	c: Colors,
): void {
	const x0 = r.x + PAD;
	const y0 = r.y + 8;
	const w = Math.max(10, r.w - PAD - 8);
	const h = Math.max(10, r.h - 22);
	for (const t of [0.25, 0.5, 0.75]) {
		const x = Math.round(x0 + w * t) + 0.5;
		g.strokeStyle = c.graticule;
		g.beginPath();
		g.moveTo(x, y0);
		g.lineTo(x, y0 + h);
		g.stroke();
	}
	g.fillStyle = c.label;
	for (const [v, label] of scaleLabels(st.scale, 0, 1).filter((_, i) => i % 5 === 0))
		g.fillText(label, Math.min(x0 + v * w - 6, x0 + w - 18), y0 + h + 11);
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
	g.strokeStyle = c.css.luma;
	g.beginPath();
	for (let i = 0; i < 256; i++) {
		const x = x0 + (i / 255) * w;
		const y = y0 + h - Math.min(1, hist.y[i]! / max) * h;
		if (i === 0) g.moveTo(x, y);
		else g.lineTo(x, y);
	}
	g.stroke();
	// Clipping readout (samples outside 0..1 or in the end bins).
	const n = Math.max(1, hist.samples);
	const lowPct = ((hist.y[0]! + hist.below[3]) / n) * 100;
	const highPct = ((hist.y[255]! + hist.above[3]) / n) * 100;
	g.fillStyle = c.label;
	g.fillText(`▼ ${lowPct.toFixed(1)}%  ▲ ${highPct.toFixed(1)}%`, x0 + 2, y0 + 10);
}
