// Posters of media the engine does not decode: SVG files are their own poster, PDF pages are
// rendered by pdf.js into a small canvas, Lottie animations are drawn by the Lottie player at a frame and serialised
// as an SVG picture. Browser only (the Project panel and the Source monitor call them).
import type { AnimationItem } from 'lottie-web';
import { lottieDocument, lottiePlayer } from './lottie.ts';
import { pdfPagePicture } from './VectorLayer.tsx';

/** A data URL (PNG) of `page` of the PDF at `url`, at most `maxSide` px on its long side. */
export async function pdfThumbnail(url: string, page: number, maxSide = 320): Promise<string> {
	const canvas = await pdfPagePicture(url, page, maxSide);
	return canvas.toDataURL('image/png');
}

/** A data URL (SVG) of frame `frame` (absolute Lottie frame) of the Lottie animation at `url`. */
export async function lottieThumbnail(url: string, frame?: number): Promise<string> {
	const [lottie, doc] = await Promise.all([lottiePlayer(), lottieDocument(url)]);
	const host = document.createElement('div');
	host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:320px;';
	document.body.appendChild(host);
	let anim: AnimationItem | undefined;
	try {
		anim = lottie.loadAnimation({
			container: host,
			renderer: 'svg',
			loop: false,
			autoplay: false,
			animationData: JSON.parse(JSON.stringify(doc)),
			rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: false },
		});
		await waitForThumbnail(anim, url);
		const ip = doc.ip;
		const op = doc.op;
		const f = frame ?? Math.floor(ip + (op - ip) * 0.5);
		anim.goToAndStop(Math.max(0, f - ip), true);
		const svg = host.querySelector('svg');
		if (!svg) throw new Error(`LOTTIE_RENDER_FAILED: No SVG picture in ${url}`);
		const text = new XMLSerializer().serializeToString(svg);
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
	} finally {
		anim?.destroy();
		host.remove();
	}
}

function waitForThumbnail(animation: AnimationItem, url: string): Promise<void> {
	if (animation.isLoaded) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			animation.removeEventListener('DOMLoaded', loaded);
			animation.removeEventListener('data_failed', failed);
		};
		const loaded = () => {
			cleanup();
			resolve();
		};
		const failed = () => {
			cleanup();
			reject(new Error(`LOTTIE_RENDER_FAILED: Could not render a thumbnail of ${url}`));
		};
		const timer = setTimeout(failed, 3000);
		animation.addEventListener('DOMLoaded', loaded);
		animation.addEventListener('data_failed', failed);
	});
}
