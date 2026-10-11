import type { Format } from './options.ts';

/** What a format can represent of a visual clip (for other applications, not JasperEditor's own metadata). */
type Caps = {
	video: boolean;
	transform: 'full' | 'uniform' | 'none';
	opacity: boolean;
	speed: boolean;
	/** Variable speed (time maps). */
	timeMap: boolean;
	nesting: boolean;
};

export const FORMAT_CAPS: Record<Format, Caps> = {
	fcp7: { video: true, transform: 'uniform', opacity: true, speed: true, timeMap: true, nesting: true },
	fcpxml: { video: true, transform: 'full', opacity: true, speed: true, timeMap: true, nesting: true },
	otio: { video: true, transform: 'none', opacity: false, speed: true, timeMap: false, nesting: true },
	edl: { video: true, transform: 'none', opacity: false, speed: true, timeMap: false, nesting: false },
	aaf: { video: true, transform: 'none', opacity: false, speed: false, timeMap: false, nesting: false },
	omf: { video: false, transform: 'none', opacity: false, speed: false, timeMap: false, nesting: false },
	ale: { video: false, transform: 'none', opacity: false, speed: false, timeMap: false, nesting: false },
};
