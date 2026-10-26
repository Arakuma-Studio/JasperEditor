// Observe rendered, user-supplied text through the public template component. Browser ranges keep these
// measurements independent of wrapper elements, CSS positioning strategy and the timeline's target layout.
import { ANIME_CATALOG, animeTemplateTiming } from '@jasper/mg-templates';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ANIME_TEMPLATE_IMPLS } from '../src/templates/index.ts';

export type MotionBox = { x: number; y: number; width: number; opacity: number };

export type MotionSample = MotionBox & {
	frame: number;
	text: string;
	/** Further rendered boxes that move on their own (social-comment: the card, its like icons and stars). */
	parts?: MotionBox[];
};

/** Rendered box of an element and its effective opacity (its own and its ancestors' up to `host`). */
function boxOf(el: Element, host: HTMLElement): MotionBox {
	const rect = el.getBoundingClientRect();
	let opacity = 1;
	for (let e: Element | null = el; e && e !== host; e = e.parentElement)
		opacity *= Number(getComputedStyle(e).opacity);
	return { x: rect.x, y: rect.y, width: rect.width, opacity };
}

/**
 * social-comment@1: what its picture shows changing besides the observed word — the card (entrance / exit), every
 * word (the word reveal) and every drawn glyph (the like icons' thump and fill, the stars), and as text the like count
 * and the stars' fill (the like tick).
 */
function socialObservables(host: HTMLElement): { parts: MotionBox[]; text: string } {
	const card = host.querySelector('[data-social-card]');
	if (!card) throw new Error('social-comment did not render its card');
	// a star's glyphs come and go as it fills: its fixed box stands for it (the fill is read below)
	const moving = [...host.querySelectorAll('[data-unit], img[data-vector], [data-star]')].filter(
		(el) => !el.parentElement?.closest('[data-star]'),
	);
	// the stars' drawn fill (a partial star is clipped from the right), in hundredths of a star as the cards' tick reads
	let filled = 0;
	for (const star of host.querySelectorAll<HTMLElement>('[data-star]')) {
		if (star.dataset.star === 'filled') filled += 1;
		else if (star.dataset.star === 'partial') {
			const clip = [...star.querySelectorAll<HTMLElement>('[style]')]
				.map((g) => /inset\(\S+ ([\d.]+)%/.exec(g.style.clipPath))
				.find(Boolean);
			if (!clip) throw new Error('a partial star without its clip');
			filled += 1 - Number(clip[1]) / 100;
		}
	}
	const stars = host.querySelector('[data-star]')
		? `${(Math.round(filled * 100) / 100).toFixed(2)} stars`
		: '';
	return {
		parts: [card, ...moving].map((el) => boxOf(el, host)),
		text: `${card.textContent}|${stars}`,
	};
}

function labelRange(host: Element, label: string, last = false): Range {
	const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
	const start = last ? host.textContent!.lastIndexOf(label) : host.textContent!.indexOf(label);
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
	fps = 60000 / 1001,
) {
	const def = ANIME_CATALOG.find((d) => d.id === template)!;
	const Impl = ANIME_TEMPLATE_IMPLS[`${template}@${def.version}`]!;
	const input = { ...def.defaults, ...params };
	const label = String(
		template === 'title-reveal'
			? String(input.title).at(-1)
			: template === 'lower-third-anim'
				? input.role
				: template === 'social-comment'
					? // the comment's last word (emoji are pictures, marks are not drawn): the last one a word reveal shows
						String(input.text)
							.replace(/==|\|\||~~/g, '')
							.split(/\s+/)
							.filter((w) => /\p{L}/u.test(w))
							.at(-1)
					: input.label,
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
						mediaUrls={{}}
						emojiUrls={{}}
						imageUrls={{}}
					/>,
				),
			);
			// social-comment: the word in the comment's own text box (the name or a reply line may repeat it)
			const scope = template === 'social-comment' ? host.querySelector('[data-template-param="text"]') : host;
			if (!scope) throw new Error(`${template} did not render its text`);
			const range = labelRange(scope, label, template === 'social-comment');
			const rect = range.getBoundingClientRect();
			let opacity = 1;
			let element = range.startContainer.parentElement;
			while (element && element !== host) {
				opacity *= Number(getComputedStyle(element).opacity);
				element = element.parentElement;
			}
			const sample = { frame, x: rect.x, y: rect.y, width: rect.width, opacity };
			if (template === 'social-comment') return { ...sample, ...socialObservables(host) };
			return { ...sample, text: template === 'counter' ? host.textContent!.replace(label, '') : '' };
		});
	} finally {
		flushSync(() => root.unmount());
		host.remove();
	}
}

Object.assign(window, { captureMotion: capture });
