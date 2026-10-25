// Geometry of the editable texts of a rendered anime-template layer (WP7b canvas-edit), read from the Program
// monitor's own DOM — the Player draws templates as DOM, so the browser's layout is the ground truth (font metrics,
// wrapping, CSS `zoom`, the design-stage fit and the template's own transforms all included).
//
// Coordinates are layer px (the layer box of `ResolvedLayer.props.box`). To get them without the layer's Motion /
// corner pin, the layer root's transform is switched off for the measurement and restored before returning; the
// change and the restore happen in the same task, so nothing is painted in between. What remains between the layer
// box and the screen is a uniform scale (Program zoom × Player scale), divided out. A rotation inside the template
// (none at rest for the shipped templates) is measured as the bounding box of the rotated text.
import { readEditableParam } from '@jasper/mg-templates';

export type LayerRect = { x: number; y: number; width: number; height: number };

/** Typography of an editable element in its own CSS px (what the editor copies to look like the text). */
export type ParamTypography = {
	fontFamily: string;
	fontSize: number;
	fontWeight: string;
	fontStyle: string;
	/** px, or null for `normal`. */
	lineHeight: number | null;
	letterSpacing: number;
	wordSpacing: number;
	textAlign: string;
	textTransform: string;
	whiteSpace: string;
	overflowWrap: string;
	wordBreak: string;
	direction: string;
	color: string;
	padding: [number, number, number, number];
	/** The element's box is inline (sized by its text): the editor grows with the text instead of wrapping. */
	inline: boolean;
	/** The nearest painted background behind the text (an ancestor inside the layer), or null. */
	background: string | null;
};

export type ParamBox = {
	param: string;
	marks: boolean;
	/** The element's border box in layer px. */
	rect: LayerRect;
	/** Layer px per element CSS px (design-stage fit × zoom × template scale). */
	scale: number;
	typography: ParamTypography;
};

export type LayerMeasurement = {
	params: ParamBox[];
	/** Boxes of painted content (backgrounds, pictures, SVG): a click there hits this layer, not one below. */
	opaque: LayerRect[];
};

/** Elements inspected per layer at most (a template's DOM is untrusted in size). */
const MAX_ELEMENTS = 4000;
const PROBE_PX = 100;

const num = (s: string | null | undefined, d = 0): number => {
	const v = Number.parseFloat(s ?? '');
	return Number.isFinite(v) ? v : d;
};

/** Alpha of a computed colour (the rgb, rgba and color() functions with an alpha, or `transparent`). */
function colorAlpha(c: string): number {
	const s = c.trim().toLowerCase();
	if (!s || s === 'transparent' || s === 'none') return 0;
	const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(s);
	if (slash) return num(slash[1]) / (slash[2] ? 100 : 1);
	const rgba = /^rgba\(([^)]*)\)$/.exec(s);
	if (rgba) {
		const parts = rgba[1]!.split(',');
		return parts.length === 4 ? num(parts[3], 1) : 1;
	}
	return 1;
}

/** The rendered layer root of `clipId` (LayerBox, `data-clip-id`) that draws an anime template, inside `scope`. */
export function templateLayerRoot(scope: ParentNode, clipId: string): HTMLElement | null {
	const sel = `[data-clip-id="${CSS.escape(clipId)}"]`;
	for (const el of scope.querySelectorAll<HTMLElement>(sel))
		if (el.querySelector('[data-mg-renderer="anime"]')) return el;
	return null;
}

/** Whether the root shows the edit hold (`data-template-hold`, set by MotionGraphicLayer). */
export function rootIsHeld(root: HTMLElement): boolean {
	return !!root.querySelector('[data-mg-renderer="anime"][data-template-hold="true"]');
}

function rectIn(r: DOMRect, origin: DOMRect, sx: number, sy: number): LayerRect {
	return {
		x: (r.left - origin.left) / sx,
		y: (r.top - origin.top) / sy,
		width: r.width / sx,
		height: r.height / sy,
	};
}

/** Size of 100 element px and of 1em on screen, through a hidden probe inside `el` (removed again). */
function probe(el: HTMLElement): { px: number; em: number } | null {
	const p = el.ownerDocument.createElement('span');
	p.setAttribute('aria-hidden', 'true');
	p.style.cssText = `position:absolute;left:0;top:0;width:${PROBE_PX}px;height:1em;visibility:hidden;pointer-events:none;padding:0;border:0;margin:0;transform:none;zoom:1`;
	el.appendChild(p);
	try {
		const r = p.getBoundingClientRect();
		return r.width > 0 ? { px: r.width, em: r.height } : null;
	} finally {
		p.remove();
	}
}

function typographyOf(el: HTMLElement, root: HTMLElement, fontPx: number): ParamTypography {
	const cs = getComputedStyle(el);
	// Computed lengths may be expressed at another zoom than the element's px: convert through the font size.
	const csFont = num(cs.fontSize, fontPx);
	const f = csFont > 0 ? fontPx / csFont : 1;
	const lh = cs.lineHeight === 'normal' ? null : num(cs.lineHeight) * f || null;
	let background: string | null = null;
	for (let a: HTMLElement | null = el; a && a !== root; a = a.parentElement) {
		const bg = getComputedStyle(a).backgroundColor;
		if (colorAlpha(bg) >= 0.99) {
			background = bg;
			break;
		}
	}
	return {
		fontFamily: cs.fontFamily || 'sans-serif',
		fontSize: fontPx,
		fontWeight: cs.fontWeight || '400',
		fontStyle: cs.fontStyle || 'normal',
		lineHeight: lh,
		letterSpacing: cs.letterSpacing === 'normal' ? 0 : num(cs.letterSpacing) * f,
		wordSpacing: cs.wordSpacing === 'normal' ? 0 : num(cs.wordSpacing) * f,
		textAlign: cs.textAlign || 'start',
		textTransform: cs.textTransform || 'none',
		whiteSpace: cs.whiteSpace || 'pre-wrap',
		overflowWrap: cs.overflowWrap || 'normal',
		wordBreak: cs.wordBreak || 'normal',
		direction: cs.direction || 'ltr',
		color: cs.color || 'currentColor',
		padding: [
			num(cs.paddingTop) * f,
			num(cs.paddingRight) * f,
			num(cs.paddingBottom) * f,
			num(cs.paddingLeft) * f,
		],
		inline: cs.display === 'inline',
		background,
	};
}

function paintsSomething(el: Element): boolean {
	const tag = el.tagName.toLowerCase();
	if (tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video') return true;
	const cs = getComputedStyle(el);
	return colorAlpha(cs.backgroundColor) > 0 || (!!cs.backgroundImage && cs.backgroundImage !== 'none');
}

/**
 * Measures the editable texts (`data-template-param`) and painted boxes of a rendered template layer in layer px.
 * `box` is the layer box (`ResolvedLayer.props.box`). Returns null when the layer cannot be measured (not laid out,
 * zero size).
 */
export function measureTemplateLayer(
	root: HTMLElement,
	box: { width: number; height: number },
): LayerMeasurement | null {
	if (!(box.width > 0 && box.height > 0)) return null;
	const saved = root.style.transform;
	root.style.transform = 'none';
	try {
		const origin = root.getBoundingClientRect();
		const sx = origin.width / box.width;
		const sy = origin.height / box.height;
		if (!(sx > 0 && sy > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
		const params: ParamBox[] = [];
		const opaque: LayerRect[] = [];
		let seen = 0;
		for (const el of root.querySelectorAll<HTMLElement>('*')) {
			if (++seen > MAX_ELEMENTS) break;
			const editable = readEditableParam(el);
			if (editable) {
				const r = el.getBoundingClientRect();
				if (!(r.width > 0 && r.height > 0)) continue;
				const pr = probe(el);
				if (!pr) continue;
				const scale = pr.px / PROBE_PX / sx;
				const fontPx = pr.em > 0 ? (pr.em / pr.px) * PROBE_PX : 16;
				if (!(scale > 0) || !Number.isFinite(scale)) continue;
				params.push({
					...editable,
					rect: rectIn(r, origin, sx, sy),
					scale,
					typography: typographyOf(el, root, fontPx),
				});
			} else if (paintsSomething(el)) {
				const r = el.getBoundingClientRect();
				// The design stage and other full-layer wrappers paint nothing; a full-size painted box is a backdrop.
				if (r.width > 0 && r.height > 0) opaque.push(rectIn(r, origin, sx, sy));
			}
		}
		return { params, opaque };
	} finally {
		root.style.transform = saved;
	}
}
