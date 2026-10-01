// The template catalog: one entry per Rust template in native/mg/crates/jasper-mg-templates, then the anime
// templates (S11:ATP-003; metadata only, drawn by @jasper/motion/templates).
import { ANIME_CATALOG } from './templates/anime/index.ts';
import { lowerThird } from './templates/lower-third.ts';
import { titleCard } from './templates/title-card.ts';
import { type AnyMgTemplate, type AnySvgMgTemplate, isSvgTemplate } from './types.ts';

export const MG_CATALOG: readonly AnyMgTemplate[] = [lowerThird, titleCard, ...ANIME_CATALOG];

/** The fframes part of the catalog: the TS twins of the Rust templates (parity, schemas, jasper-mg). */
export const FFRAMES_CATALOG: readonly AnySvgMgTemplate[] = MG_CATALOG.filter(isSvgTemplate);
