// color-grade: Lumetri ▸ Creative ▸ Looks browser. Every built-in look (procedural, registry `CREATIVE_LOOKS`) is
// previewed on the clip's current Program picture (or a hue/lightness chart when the clip is not on screen) by the
// very pixel function the grade bakes (`creativeLookFn`), at the instance's Intensity. Clicking a tile sets the look
// (and clears a look LUT, which would take precedence) in one undo step.
import {
	type Clip,
	CREATIVE_LOOKS,
	creativeLookFn,
	type EffectInstance,
	hslToRgb,
	type Rgb,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx } from '@jasper/ui';
import { useEffect, useRef, useState } from 'react';
import { findClipSource, readFrame } from '../scopes/capture.ts';
import { applyLumetriValues } from './actions.ts';

const TILE_W = 96;
const TILE_H = 54;

type Picture = { data: Uint8ClampedArray; width: number; height: number };

/** A hue (x) × lightness (y) chart: what the looks are previewed on when the clip is not on screen. */
function chart(): Picture {
	const data = new Uint8ClampedArray(TILE_W * TILE_H * 4);
	const c: Rgb = [0, 0, 0];
	for (let y = 0; y < TILE_H; y++)
		for (let x = 0; x < TILE_W; x++) {
			hslToRgb(x / TILE_W, 0.65, 0.85 - (0.75 * y) / (TILE_H - 1), c);
			const i = (y * TILE_W + x) * 4;
			data[i] = c[0] * 255;
			data[i + 1] = c[1] * 255;
			data[i + 2] = c[2] * 255;
			data[i + 3] = 255;
		}
	return { data, width: TILE_W, height: TILE_H };
}

/** The picture through a look at `intensity` (0..1), as RGBA8. */
function graded(src: Picture, id: string, intensity: number): Uint8ClampedArray {
	const fn = creativeLookFn(id);
	const out = new Uint8ClampedArray(src.data);
	if (!fn) return out;
	const c: Rgb = [0, 0, 0];
	for (let i = 0; i < out.length; i += 4) {
		const r = src.data[i]! / 255;
		const g = src.data[i + 1]! / 255;
		const b = src.data[i + 2]! / 255;
		c[0] = r;
		c[1] = g;
		c[2] = b;
		fn(c);
		out[i] = (r + (c[0] - r) * intensity) * 255;
		out[i + 1] = (g + (c[1] - g) * intensity) * 255;
		out[i + 2] = (b + (c[2] - b) * intensity) * 255;
	}
	return out;
}

function Tile(props: {
	id: string;
	label: string;
	description: string;
	picture: Picture;
	intensity: number;
	selected: boolean;
	disabled: boolean;
	onPick(): void;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const el = ref.current;
		const g = el?.getContext('2d');
		if (!el || !g) return;
		el.width = props.picture.width;
		el.height = props.picture.height;
		try {
			const img = g.createImageData(props.picture.width, props.picture.height);
			img.data.set(graded(props.picture, props.id, props.intensity));
			g.putImageData(img, 0, 0);
		} catch {
			// no canvas backend (tests): the label still shows
		}
	}, [props.picture, props.id, props.intensity]);
	return (
		<button
			type="button"
			className={cx(
				'flex w-[100px] shrink-0 flex-col items-center gap-[2px] rounded-pr-control p-[2px] text-pr-small',
				props.selected ? 'bg-pr-selected text-pr-strong' : 'text-pr-text hover:bg-pr-hover',
				'disabled:text-pr-dim',
			)}
			title={props.description}
			aria-pressed={props.selected}
			disabled={props.disabled}
			onClick={props.onPick}
			data-testid={`lumetri-look-tile-${props.id}`}
		>
			<canvas ref={ref} className="h-[54px] w-[96px] rounded-pr-control" />
			<span className="w-full truncate text-center">{props.label}</span>
		</button>
	);
}

export function LooksBrowser(props: {
	session: EditorSession;
	clip: Clip;
	fx: EffectInstance | null;
	current: string;
	intensity: number;
	disabled: boolean;
	hint(message: string): void;
}) {
	const [open, setOpen] = useState(false);
	const [picture, setPicture] = useState<Picture | null>(null);
	useEffect(() => {
		if (!open) return;
		const el = findClipSource(props.clip.id);
		const f = el ? readFrame(el, TILE_W) : null;
		setPicture(f && f.width > 0 ? f : chart());
	}, [open, props.clip.id]);
	const k = Math.min(1, Math.max(0, props.intensity / 100));
	return (
		<div className="px-2 py-1">
			<button
				type="button"
				className="h-[20px] rounded-pr-control border border-pr-border px-2 text-pr-small text-pr-text hover:bg-pr-hover"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				data-testid="lumetri-looks-browser"
			>
				{open ? 'Hide Looks' : 'Browse Looks…'}
			</button>
			{open && picture ? (
				<div className="mt-1 flex gap-1 overflow-x-auto pb-1" role="listbox" aria-label="Built-in looks">
					{CREATIVE_LOOKS.map((l) => (
						<Tile
							key={l.id}
							id={l.id}
							label={l.label}
							description={`${l.family}: ${l.description}`}
							picture={picture}
							intensity={k}
							selected={props.current === l.id}
							disabled={props.disabled}
							onPick={() => {
								const err = applyLumetriValues(props.session, `Look: ${l.label}`, props.clip, props.fx, {
									creativeLook: l.id,
									...(l.id !== 'none' ? { look: { mediaId: '' } } : {}),
								});
								if (err) props.hint(err);
							}}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}
