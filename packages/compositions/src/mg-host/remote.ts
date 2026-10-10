// The editor's end of the live frame host (security review MG-1): a host page is a sandboxed iframe with an opaque
// origin, so the editor cannot (and must not) reach into it. `connectMgHost` hands the page's host agent (agent.ts)
// one MessagePort and returns an `MgHostRemote`: configure / seek (the renderer-page protocol), the text probe's
// locate / fonts / hide / restore, and the protocol check — that is the whole API.
//
// The page is somebody's code and shares the agent's realm: every reply is treated as hostile input. Numbers must
// be finite and in range, strings are bounded, measurements are matched to the ids that were asked for, font
// sources may only point at the bundle's own files, `data:` or `https:`, and a reply that does not fit is a
// protocol error or is dropped — never passed on. Requests time out, so a page that stops answering cannot hang
// the editor.
import type { MgTextMeasurement } from '@jasper/project';
import { MG_HOST_CONNECT, MG_HOST_PORT_PROTOCOL } from './agent.ts';
import { MG_HOST_TIMEOUT_MS } from './constants.ts';
import {
	type CompositionMetadata,
	type HostCompositionConfig,
	type HostProtocolCheck,
	type MgHostErrorCode,
	MgHostProtocolError,
} from './protocol.ts';
import type { BundleFontSource } from './text-probe.ts';

/** Largest composition side, rate and length a page may report (sizes allocate layers and canvases). */
const MAX_SIDE = 16_384;
const MAX_FPS = 1000;
const MAX_FRAMES = 100_000_000;
const MAX_TEXT_ITEMS = 2000;
const MAX_LINES = 500;
const MAX_FONTS = 512;
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_FONT_BYTES_TOTAL = 128 * 1024 * 1024;
const MAX_FONT_SOURCE_CHARS = 16_384;
/** How long the page has to answer the port handshake after its `load` event. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Slack added to a request's own timeout before the editor gives up on the reply. */
const REPLY_SLACK_MS = 5000;

const ERROR_CODES: ReadonlySet<string> = new Set<MgHostErrorCode>([
	'MG_HOST_PROTOCOL',
	'MG_HOST_TIMEOUT',
	'MG_HOST_CANCELLED',
	'MG_HOST_NO_COMPOSITION',
]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown, max: number, fallback = ''): string =>
	typeof v === 'string' ? v.slice(0, max) : fallback;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function intIn(v: unknown, min: number, max: number, what: string): number {
	const n = num(v);
	if (n === null || n < min || n > max)
		throw new MgHostProtocolError('MG_HOST_PROTOCOL', `The composition page reported an invalid ${what}`);
	return n;
}

/** The metadata a page reports, checked (S08:MGC-003: sizes and lengths size layers and buffers). */
export function sanitizeMetadata(raw: unknown): CompositionMetadata {
	if (!isObject(raw))
		throw new MgHostProtocolError('MG_HOST_PROTOCOL', 'The composition page reported no metadata');
	return {
		width: Math.round(intIn(raw.width, 1, MAX_SIDE, 'width')),
		height: Math.round(intIn(raw.height, 1, MAX_SIDE, 'height')),
		fps: intIn(raw.fps, 0.01, MAX_FPS, 'frame rate'),
		durationInFrames: Math.round(intIn(raw.durationInFrames, 1, MAX_FRAMES, 'duration')),
	};
}

type Rect = { x: number; y: number; width: number; height: number };
const COORD = 1e7;

function rect(raw: unknown): Rect | null {
	if (!isObject(raw)) return null;
	const x = num(raw.x);
	const y = num(raw.y);
	const width = num(raw.width);
	const height = num(raw.height);
	if (x === null || y === null || width === null || height === null) return null;
	if (
		Math.abs(x) > COORD ||
		Math.abs(y) > COORD ||
		width < 0 ||
		height < 0 ||
		width > COORD ||
		height > COORD
	)
		return null;
	return { x, y, width, height };
}

const notFound = (id: string): MgTextMeasurement => ({
	id,
	found: false,
	visible: false,
	rect: null,
	lines: [],
	clippedBy: null,
	truncated: false,
	style: null,
});

function measurement(id: string, raw: unknown): MgTextMeasurement {
	if (!isObject(raw) || raw.found !== true) return notFound(id);
	const r = rect(raw.rect);
	const s = isObject(raw.style) ? raw.style : null;
	const fontSize = s ? num(s.fontSize) : null;
	return {
		id,
		found: true,
		visible: raw.visible === true && r !== null,
		rect: r,
		lines: (Array.isArray(raw.lines) ? raw.lines.slice(0, MAX_LINES) : [])
			.map(rect)
			.filter((x): x is Rect => x !== null),
		clippedBy: rect(raw.clippedBy),
		truncated: raw.truncated === true,
		style: s
			? {
					fontFamily: str(s.fontFamily, 1024, 'sans-serif'),
					fontSize: fontSize !== null && fontSize > 0 && fontSize <= 10_000 ? fontSize : 16,
					fontWeight: str(s.fontWeight, 32, 'normal'),
					fontStyle: str(s.fontStyle, 32, 'normal'),
					color: str(s.color, 128, 'rgb(0, 0, 0)'),
					lineHeight: num(s.lineHeight),
					letterSpacing: num(s.letterSpacing) ?? 0,
					textAlign: str(s.textAlign, 32, 'start'),
					textTransform: str(s.textTransform, 32, 'none'),
					whiteSpace: str(s.whiteSpace, 32, 'normal'),
				}
			: null,
	};
}

/** One measurement per requested item, in request order; what the page did not answer properly is "not found". */
export function sanitizeMeasurements(items: readonly { id: string }[], raw: unknown): MgTextMeasurement[] {
	const byId = new Map<string, unknown>();
	if (Array.isArray(raw))
		for (const m of raw.slice(0, MAX_TEXT_ITEMS))
			if (isObject(m) && typeof m.id === 'string' && !byId.has(m.id)) byId.set(m.id, m);
	return items.map((i) => measurement(i.id, byId.get(i.id)));
}

const URL_IN_SRC = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;

/** Paths under which the engine serves bundle files, and nothing else (inert data: fonts, images, scripts as text). */
const BUNDLE_FILE_PATH = /^\/mg\/(sandbox\/[A-Za-z0-9_-]+|bundles)\/[^/]+\//;

/**
 * A font `src` the page reported is loaded by the editor's own document (on-canvas text editing draws with the
 * composition's typeface), so its URLs are fetched with the editor's origin and session. Only bundle files of the
 * editor's own origin (`origin`, e.g. `http://127.0.0.1:47900`), `data:` and `https:` are accepted; anything else
 * — the engine's API, `file:`, other loopback ports — drops the face.
 */
export function isSafeFontSource(source: string, origin: string): boolean {
	if (source.length > MAX_FONT_SOURCE_CHARS) return false;
	let urls = 0;
	for (const m of source.matchAll(URL_IN_SRC)) {
		urls++;
		const u = m[2] ?? '';
		if (/^data:/i.test(u)) continue;
		let parsed: URL;
		try {
			parsed = new URL(u);
		} catch {
			return false;
		}
		if (parsed.protocol === 'https:') continue;
		if (!origin || parsed.origin !== origin || !BUNDLE_FILE_PATH.test(parsed.pathname)) return false;
	}
	// `local(…)` alone names an installed font: harmless. Anything with a parenthesis that is not url/local/format
	// /tech is not a font source we understand.
	return urls > 0 || /^\s*(local\([^)]*\)\s*,?\s*)+$/.test(source);
}

/** The fonts a page reports, checked: bounded count and bytes, safe sources only. */
export function sanitizeFonts(raw: unknown, origin: string): BundleFontSource[] {
	if (!Array.isArray(raw)) return [];
	const out: BundleFontSource[] = [];
	let bytes = 0;
	for (const f of raw.slice(0, MAX_FONTS)) {
		if (!isObject(f)) continue;
		const family = str(f.family, 256).trim();
		if (!family) continue;
		const face: BundleFontSource = {
			family,
			weight: str(f.weight, 64, 'normal'),
			style: str(f.style, 64, 'normal'),
			loaded: f.loaded === true,
			...(typeof f.stretch === 'string' ? { stretch: f.stretch.slice(0, 64) } : {}),
			...(typeof f.unicodeRange === 'string' ? { unicodeRange: f.unicodeRange.slice(0, 4096) } : {}),
		};
		if (typeof f.source === 'string') {
			if (!isSafeFontSource(f.source, origin)) continue;
			face.source = f.source;
		} else if (f.buffer instanceof ArrayBuffer || ArrayBuffer.isView(f.buffer)) {
			const size = (f.buffer as ArrayBuffer | ArrayBufferView).byteLength;
			if (size > MAX_FONT_BYTES || bytes + size > MAX_FONT_BYTES_TOTAL) continue;
			bytes += size;
			face.buffer = f.buffer as ArrayBuffer | ArrayBufferView;
		} else continue;
		out.push(face);
	}
	return out;
}

function sanitizeCheck(raw: unknown): HostProtocolCheck {
	const r = isObject(raw) ? raw : {};
	return {
		ok: r.ok === true,
		missing: (Array.isArray(r.missing) ? r.missing.slice(0, 32) : []).map((m) => str(m, 200)),
		remotionVersion: typeof r.remotionVersion === 'string' ? r.remotionVersion.slice(0, 64) : null,
		siteVersion: typeof r.siteVersion === 'string' ? r.siteVersion.slice(0, 64) : null,
	};
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

/** The subset of a MessagePort the remote uses (tests pass a fake). */
export type MgHostPort = {
	postMessage(message: unknown): void;
	// biome-ignore lint/suspicious/noExplicitAny: a MessagePort's handler type; only `data` is read
	onmessage: ((ev: any) => void) | null;
	close(): void;
	start?(): void;
};

/** One connected host page. */
export class MgHostRemote {
	private seq = 0;
	private readonly pending = new Map<number, Pending>();
	private closed = false;

	constructor(
		private readonly port: MgHostPort,
		private readonly opts: { timeoutMs?: number; origin?: string } = {},
	) {
		port.onmessage = (ev: { data: unknown }) => this.onMessage(ev.data);
		port.start?.();
	}

	private onMessage(data: unknown): void {
		if (!isObject(data) || typeof data.id !== 'number') return;
		const p = this.pending.get(data.id);
		if (!p) return;
		this.pending.delete(data.id);
		clearTimeout(p.timer);
		if (data.ok === true) {
			p.resolve(data.result);
			return;
		}
		const e = isObject(data.error) ? data.error : {};
		const code = typeof e.code === 'string' && ERROR_CODES.has(e.code) ? e.code : 'MG_HOST_PROTOCOL';
		p.reject(
			new MgHostProtocolError(code as MgHostErrorCode, str(e.message, 500, 'The composition page failed')),
		);
	}

	private call(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		if (this.closed)
			return Promise.reject(new MgHostProtocolError('MG_HOST_PROTOCOL', 'The composition page is gone'));
		const id = ++this.seq;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new MgHostProtocolError(
						'MG_HOST_TIMEOUT',
						`The composition page did not answer within ${timeoutMs} ms`,
					),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.port.postMessage({ id, op, args });
			} catch (e) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new MgHostProtocolError('MG_HOST_PROTOCOL', e instanceof Error ? e.message : String(e)));
			}
		});
	}

	private get timeout(): number {
		return this.opts.timeoutMs ?? MG_HOST_TIMEOUT_MS;
	}

	/** Which pieces of the renderer-page protocol the page has. */
	async check(): Promise<HostProtocolCheck> {
		return sanitizeCheck(await this.call('check', {}, REPLY_SLACK_MS));
	}

	/** Sets props (and metadata overrides) of the composition; resolves with the metadata in effect. */
	async configure(config: HostCompositionConfig): Promise<CompositionMetadata> {
		// evaluation + calculateMetadata + mount, each bounded by the page's own timeout.
		const raw = await this.call(
			'configure',
			{ config, timeoutMs: this.timeout },
			this.timeout * 4 + REPLY_SLACK_MS,
		);
		return sanitizeMetadata(raw);
	}

	/** Shows composition frame `frame` (clamped to the composition); resolves when it is drawn. */
	async seek(compositionId: string, frame: number): Promise<void> {
		await this.call(
			'seek',
			{ compositionId, frame, timeoutMs: this.timeout },
			this.timeout * 5 + REPLY_SLACK_MS,
		);
	}

	/** Measures texts in the frame the page currently shows (S08:MGC-037). Never rejects: unanswered = not found. */
	async locateTexts(
		items: { id: string; text: string }[],
		frame: { width: number; height: number },
	): Promise<MgTextMeasurement[]> {
		try {
			return sanitizeMeasurements(items, await this.call('locate', { items, frame }, REPLY_SLACK_MS * 2));
		} catch {
			return items.map((i) => notFound(i.id));
		}
	}

	/** The faces the bundle registered (S08:MGC-039). Never rejects. */
	async fonts(): Promise<BundleFontSource[]> {
		try {
			return sanitizeFonts(await this.call('fonts', {}, REPLY_SLACK_MS * 2), this.opts.origin ?? '');
		} catch {
			return [];
		}
	}

	/** Hides a located text while the on-canvas editor replaces it. */
	async hideText(text: string): Promise<boolean> {
		try {
			return (await this.call('hide', { text }, REPLY_SLACK_MS)) === true;
		} catch {
			return false;
		}
	}

	/** Shows what `hideText` hid. */
	async restoreTexts(): Promise<void> {
		await this.call('restore', {}, REPLY_SLACK_MS).catch(() => undefined);
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new MgHostProtocolError('MG_HOST_PROTOCOL', 'The composition page is gone'));
		}
		this.pending.clear();
		this.port.onmessage = null;
		try {
			this.port.close();
		} catch {
			// already closed
		}
	}
}

const remotes = new WeakMap<HTMLIFrameElement, MgHostRemote>();

/** The remote of a host iframe that `connectMgHost` connected (null before its page loaded, or after a reload). */
export function mgHostOf(iframe: HTMLIFrameElement | null | undefined): MgHostRemote | null {
	return (iframe && remotes.get(iframe)) ?? null;
}

function originOf(iframe: HTMLIFrameElement): string {
	try {
		return new URL(iframe.src, document.baseURI).origin;
	} catch {
		return '';
	}
}

/**
 * Connects to the host agent of the page an iframe has just loaded (call it from the iframe's `load` event; a
 * reload needs a new connection). Rejects with `MG_HOST_PROTOCOL` when the page does not answer: it is not a host
 * page (no bootstrap), or its scripts broke the agent.
 */
export function connectMgHost(
	iframe: HTMLIFrameElement,
	opts: { timeoutMs?: number; connectTimeoutMs?: number } = {},
): Promise<MgHostRemote> {
	remotes.get(iframe)?.dispose();
	remotes.delete(iframe);
	const target = iframe.contentWindow;
	if (!target)
		return Promise.reject(new MgHostProtocolError('MG_HOST_PROTOCOL', 'The composition page is not loaded'));
	const channel = new MessageChannel();
	return new Promise<MgHostRemote>((resolve, reject) => {
		const timer = setTimeout(() => {
			channel.port1.onmessage = null;
			channel.port1.close();
			reject(
				new MgHostProtocolError(
					'MG_HOST_PROTOCOL',
					'The composition page did not connect (it is not a JasperEditor host page, or its scripts failed)',
				),
			);
		}, opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
		channel.port1.onmessage = (ev) => {
			const d = ev.data as { hello?: unknown } | null;
			if (!d || d.hello !== MG_HOST_PORT_PROTOCOL) return;
			clearTimeout(timer);
			const remote = new MgHostRemote(channel.port1, {
				...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
				// The bundle's files are served by the origin the iframe was loaded from (the editor's own).
				origin: originOf(iframe),
			});
			remotes.set(iframe, remote);
			resolve(remote);
		};
		// '*': a sandboxed page has an opaque origin, which no target origin can name. The message carries no
		// secret, only the port.
		target.postMessage({ jasperMgHost: MG_HOST_CONNECT }, '*', [channel.port2]);
	});
}
