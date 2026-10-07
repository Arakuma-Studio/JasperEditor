// Posters of media the engine does not decode (imports workstream): SVG files are their own poster, PDF pages are
// rendered by pdf.js into a small canvas, Lottie animations are drawn by the Lottie player at a frame and serialised
// as an SVG picture. Browser only (the Project panel and the Source monitor call them).
import { lottieDocument } from './LottieLayer.tsx';
import { pdfPagePicture } from './VectorLayer.tsx';

/** A data URL (PNG) of `page` of the PDF at `url`, at most `maxSide` px on its long side. */
export async function pdfThumbnail(url: string, page: number, maxSide = 320): Promise<string> {
	const canvas = await pdfPagePicture(url, page, maxSide);
	return canvas.toDataURL('image/png');
}

/** A data URL (SVG) of frame `frame` (absolute Lottie frame) of the Lottie animation at `url`. */
export async function lottieThumbnail(url: string, frame?: number): Promise<string> {
	const [lottie, doc] = await Promise.all([
		import('lottie-web/build/player/lottie_svg').then(
			(m) => ((m as { default?: unknown }).default ?? m) as { loadAnimation(p: Record<string, unknown>): { goToAndStop(v: number, f: boolean): void; destroy(): void; addEventListener(n: string, cb: () => void): void; isLoaded?: boolean } },
		),
		lottieDocument(url),
	]);
	const host = document.createElement('div');
	host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:320px;';
	document.body.appendChild(host);
	try {
		const anim = lottie.loadAnimation({
			container: host,
			renderer: 'svg',
			loop: false,
			autoplay: false,
			animationData: JSON.parse(JSON.stringify(doc)),
			rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: false },
		});
		await new Promise<void>((res) => {
			if (anim.isLoaded) res();
			anim.addEventListener('DOMLoaded', () => res());
			setTimeout(res, 3000);
		});
		const ip = Number(doc.ip) || 0;
		const op = Number(doc.op) || ip + 1;
		const f = frame ?? Math.floor(ip + (op - ip) * 0.5);
		anim.goToAndStop(Math.max(0, f - ip), true);
		const svg = host.querySelector('svg');
		const text = svg ? new XMLSerializer().serializeToString(svg) : '<svg xmlns="http://www.w3.org/2000/svg"/>';
		anim.destroy();
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
	} finally {
		host.remove();
	}
}
