// Text layout checks of composition clips (M3, wp-m3-mgtext, S08:MGC-037): an off-screen live frame host (the
// bundle's own page, same protocol as the Program monitor's host) renders a composition with the clip's props at
// the text's measuring frame, and the page's text probe reports where each text lands — the Properties text
// editors turn that into "runs off the frame / cut off / outside its safe area / wraps to n lines" warnings.
// One page per editor (reloaded when the bundle changes), requests serialized, results cached by request.
import {
	type BundleFontSource,
	bundleServeUrl,
	type HostWindow,
	hostPageUrl,
	locateTexts,
	MgFrameHostDriver,
	textProbeOf,
} from '@jasper/compositions';
import type { MgTextMeasurement } from '@jasper/project';

export type TextMeasureRequest = {
	bundleKey: string;
	compositionId: string;
	/** Effective props. */
	props: Record<string, unknown>;
	width: number;
	height: number;
	/** Sequence frame rate (renders and previews run at it, MGC-005) and the composition length at it. */
	fps: number;
	durationInFrames: number;
	/** Composition frame to measure at. */
	frame: number;
	items: { id: string; text: string }[];
};

export type TextMeasureResult = { measurements: MgTextMeasurement[]; fonts: BundleFontSource[] };

const CACHE_SIZE = 64;

export class MgTextMeasurer {
	private iframe: HTMLIFrameElement | null = null;
	private bundleKey: string | null = null;
	private driver: MgFrameHostDriver | null = null;
	private chain: Promise<unknown> = Promise.resolve();
	private readonly cache = new Map<string, TextMeasureResult>();

	constructor(private readonly bundleUrl: (key: string) => string = bundleServeUrl) {}

	/** Measures the texts of `req` (cached); never rejects for page errors — texts are then "not found". */
	measure(req: TextMeasureRequest): Promise<TextMeasureResult> {
		const key = JSON.stringify(req);
		const hit = this.cache.get(key);
		if (hit) return Promise.resolve(hit);
		const run = this.chain.then(() => this.run(req, key));
		this.chain = run.catch(() => undefined);
		return run;
	}

	dispose(): void {
		this.iframe?.remove();
		this.iframe = null;
		this.driver = null;
		this.bundleKey = null;
	}

	private async run(req: TextMeasureRequest, key: string): Promise<TextMeasureResult> {
		const hit = this.cache.get(key);
		if (hit) return hit;
		const win = await this.page(req);
		const driver = this.driver!;
		await driver.configure({
			compositionId: req.compositionId,
			props: req.props,
			override: {
				width: req.width,
				height: req.height,
				fps: req.fps,
				durationInFrames: req.durationInFrames,
			},
		});
		await driver.seek(req.compositionId, req.frame);
		const result: TextMeasureResult = {
			measurements: locateTexts(win, req.items, { width: req.width, height: req.height }),
			fonts: textProbeOf(win)?.fonts() ?? [],
		};
		this.cache.set(key, result);
		if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
		return result;
	}

	/** The host page of the request's bundle, sized to the composition canvas (layout depends on it). */
	private async page(req: TextMeasureRequest): Promise<HostWindow> {
		if (!this.iframe?.isConnected) {
			const f = document.createElement('iframe');
			f.setAttribute('aria-hidden', 'true');
			f.tabIndex = -1;
			f.title = 'Composition text measuring';
			f.dataset.mgTextMeasure = '';
			// Off screen but laid out and painted (hidden/display:none pages may be throttled).
			Object.assign(f.style, {
				position: 'fixed',
				left: '0px',
				top: '0px',
				border: '0',
				opacity: '0',
				pointerEvents: 'none',
				zIndex: '-1',
				colorScheme: 'light',
				transform: 'translate(-200vw, 0)',
			});
			document.body.appendChild(f);
			this.iframe = f;
			this.bundleKey = null;
		}
		const f = this.iframe;
		f.style.width = `${req.width}px`;
		f.style.height = `${req.height}px`;
		if (this.bundleKey !== req.bundleKey || !this.driver) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('The composition page did not load')), 60_000);
				f.onload = () => {
					clearTimeout(timer);
					resolve();
				};
				f.src = hostPageUrl(this.bundleUrl(req.bundleKey));
			});
			this.bundleKey = req.bundleKey;
			this.driver = new MgFrameHostDriver(f.contentWindow as unknown as HostWindow);
		}
		return f.contentWindow as unknown as HostWindow;
	}
}

let shared: MgTextMeasurer | null = null;
/** The editor-wide measurer (one hidden page). */
export function textMeasurer(): MgTextMeasurer {
	shared ??= new MgTextMeasurer();
	return shared;
}
