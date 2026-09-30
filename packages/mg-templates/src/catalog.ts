// The template catalog: one entry per Rust template in native/mg/crates/jasper-mg-templates.
import { lowerThird } from './templates/lower-third.ts';
import { titleCard } from './templates/title-card.ts';
import type { AnyMgTemplate } from './types.ts';

export const MG_CATALOG: readonly AnyMgTemplate[] = [lowerThird, titleCard];
