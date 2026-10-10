// edit-structure: how a nest layer draws its nested sequence's tracks. `SequenceComposition` provides its own
// `VideoTracks` (no import cycle between the composition and the layer table).
import { type ComponentType, createContext } from 'react';
import type { RenderDoc, RenderOptions } from '../types.ts';

export type NestTracksComponent = ComponentType<{
	doc: RenderDoc;
	options: RenderOptions;
	offset: number;
	/** compositor: draw flat and hand the picture to the enclosing `FxPicture` (NestLayer's canvas source). */
	flat?: 'feed';
}>;

export const NestTracksContext = createContext<NestTracksComponent | null>(null);

/** The frame size of the nested sequence being drawn (GPU effects' `u_compSize` inside nests). */
export const NestCompSizeContext = createContext<{ width: number; height: number } | null>(null);
