// Observe rendered, user-supplied text through the public template component. Browser ranges keep these
// measurements independent of wrapper elements, CSS positioning strategy and the timeline's target layout.
import { ANIME_CATALOG, animeTemplateTiming } from '@jasper/mg-templates';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ANIME_TEMPLATE_IMPLS } from '../src/templates/index.ts';

export type MotionSample = {
	frame: number;
	x: number;
	y: number;
	width: number;
	opacity: number;
	text: string;
};

function labelRange(host: HTMLElement, label: string): Range {
	const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
	const start = host.textContent!.indexOf(label);
	if (start < 0) throw new Error(`Template did not render its label: ${label}`);
	const range = document.createRange();
	let offset = 0;
	for (const node of nodes) {
		const end = offset + node.length;
		if (offset <= start && start < end) range.setStart(node, start - offset);
		if (offset < start + label.length && start + label.length <= end) {
			range.setEnd(node, start + label.length - offset);
			return range;
		}
		offset = end;
	}
	throw new Error('Template label range was incomplete');
}

function capture(
	template: string,
	params: Record<string, unknown>,
	durationFrames: number,
	frames: number[],
) {
	const fps = 60000 / 1001;
	const def = ANIME_CATALOG.find((d) => d.id === template)!;
	const Impl = ANIME_TEMPLATE_IMPLS[`${template}@${def.version}`]!;
	const input = { ...def.defaults, ...params };
	const label = String(
		template === 'title-reveal' ? input.title : template === 'lower-third-anim' ? input.role : input.label,
	);
	const host = document.createElement('div');
	host.style.cssText = 'position:relative;width:1920px;height:1080px';
	document.body.append(host);
	const root = createRoot(host);
	try {
		return frames.map((frame): MotionSample => {
			const timing = animeTemplateTiming(def, { fps, localFrame: frame, durationFrames });
			flushSync(() =>
				root.render(
					<Impl
						params={input}
						{...timing}
						fps={fps}
						canvas={{ width: 1920, height: 1080 }}
						seed={7}
						isPreview={false}
					/>,
				),
			);
			const range = labelRange(host, label);
			const rect = range.getBoundingClientRect();
			let opacity = 1;
			let element = range.startContainer.parentElement;
			while (element && element !== host) {
				opacity *= Number(getComputedStyle(element).opacity);
				element = element.parentElement;
			}
			return {
				frame,
				x: rect.x,
				y: rect.y,
				width: rect.width,
				opacity,
				text: template === 'counter' ? host.textContent!.replace(label, '') : '',
			};
		});
	} finally {
		flushSync(() => root.unmount());
		host.remove();
	}
}

Object.assign(window, { captureMotion: capture });
