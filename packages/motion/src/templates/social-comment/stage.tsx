// Placement of a social-comment card on the design stage: centred, zoomed as a unit from its reference px
// (`socialCardScale`: the card stays proportional to its tokcomment blueprint), shrunk when a long comment would not
// fit (at most 88 % of the design height and 96 % of its width), and moved by the entrance / exit values.
//
// The zoom is CSS `zoom`, not a transform: the zoomed card's layout box is its drawn size, so the wrapper that carries
// the entrance transform has exactly the card's box (its `transform-origin` percentages land on the card's corners,
// the bubble tail included) and flex centring sees the real size. The fit is measured on that wrapper with layout
// boxes (`offsetWidth` / `offsetHeight`: unaffected by the entrance transform, the stage scale or the monitor zoom,
// S11:ANM-010) after the fonts are loaded (the layer renders templates only then). A shrink is applied in the same
// commit (layout effect, before paint), so every frame — Player, still or export — shows the fitted card; without
// layout (tests) the canvas scale is used.
import { type Fit, SOCIAL_CARD_MAX_HEIGHT, socialCardScale } from '@jasper/mg-templates';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/** Share of the design width a card may take at most. */
const MAX_WIDTH = 0.96;
/** Measurement passes per layout (font hinting can move a zoomed card by a pixel; never loops). */
const MAX_PASSES = 3;

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r3 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0);

/** The zoom that fits a card measured `w × h` layout px at zoom `k` into the stage (never above `max`). */
export function socialFitZoom(
	measured: { w: number; h: number },
	k: number,
	max: number,
	design: { width: number; height: number },
): number {
	if (!(measured.w > 0 && measured.h > 0 && k > 0)) return max;
	const natW = measured.w / k;
	const natH = measured.h / k;
	return r4(
		Math.min(max, (design.width * MAX_WIDTH) / natW, (design.height * SOCIAL_CARD_MAX_HEIGHT) / natH),
	);
}

export function SocialStage(p: {
	fit: Fit;
	/** Anything that changes the card's size (params): a new key measures again. */
	layoutKey: string;
	/** Card values: scale, opacity, drop (design px), tilt (deg). */
	card: Readonly<Record<string, number>>;
	/** `transform-origin` of the entrance (the card's centre, or the variant's grow corner). */
	origin: string;
	children: ReactNode;
}) {
	const design = { width: p.fit.designW, height: p.fit.designH };
	const max = socialCardScale(design);
	const ref = useRef<HTMLDivElement>(null);
	const [fitted, setFitted] = useState<{ key: string; k: number; passes: number } | null>(null);
	const key = `${p.layoutKey}|${design.width}x${design.height}`;
	const current = fitted && fitted.key === key ? fitted : null;
	const k = current ? current.k : max;
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const passes = current?.passes ?? 0;
		if (passes >= MAX_PASSES) return;
		const want = socialFitZoom({ w: el.offsetWidth, h: el.offsetHeight }, k, max, design);
		if (Math.abs(want - k) > 1e-3) setFitted({ key, k: want, passes: passes + 1 });
	});
	const v = p.card;
	return (
		<div
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				width: design.width,
				height: design.height,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
			}}
		>
			<div
				ref={ref}
				data-social-card=""
				style={{
					flex: 'none',
					transformOrigin: p.origin,
					transform: `translateY(${r3(v.y ?? 0)}px) rotate(${r3(v.r ?? 0)}deg) scale(${r3(v.s ?? 1)})`,
					opacity: r3(v.o ?? 1),
				}}
			>
				<div style={{ zoom: k }}>{p.children}</div>
			</div>
		</div>
	);
}
