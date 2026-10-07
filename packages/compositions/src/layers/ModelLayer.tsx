// three-d: a 3D model layer (After Effects' 3D model layers). The model is drawn by the Advanced 3D renderer of its
// run (three-d/advanced.ts, loaded by three-d/model-loader.ts); the layer itself only hands its run a placeholder
// picture (its opacity and the frame it is at) so the run knows it is there. Outside a GPU 3D scope (Player fallback)
// it draws nothing; the scope's fallback chip says why.
import { useLayoutEffect } from 'react';
import type { LayerProps } from '../types.ts';

let blank: HTMLCanvasElement | null = null;
function blankCanvas(): HTMLCanvasElement {
	if (!blank) {
		blank = document.createElement('canvas');
		blank.width = 1;
		blank.height = 1;
	}
	return blank;
}

export function ModelLayer(p: LayerProps) {
	const tap = p.composite?.tap ?? null;
	const opacity = p.props.opacity;
	const frame = p.localFrame;
	useLayoutEffect(() => {
		if (!tap) return;
		tap.deliver(blankCanvas(), 1, 1, { compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity });
	}, [tap, opacity, frame]);
	return null;
}
