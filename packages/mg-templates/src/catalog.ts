// The template catalog: one entry per Rust template in native/mg/crates/jasper-mg-templates.
import { lowerThird } from './templates/lower-third.ts';
import { titleCard } from './templates/title-card.ts';
import { type AnyMgTemplate, type AnySvgMgTemplate, isSvgTemplate } from './types.ts';

export const MG_CATALOG: readonly AnyMgTemplate[] = [lowerThird, titleCard];

/** The fframes part of the catalog: the TS twins of the Rust templates (parity, schemas, jasper-mg). */
export const FFRAMES_CATALOG: readonly AnySvgMgTemplate[] = MG_CATALOG.filter(isSvgTemplate);
