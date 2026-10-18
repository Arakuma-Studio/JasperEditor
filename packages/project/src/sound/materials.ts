// Materials of a library sound (spec 12 P6-E10, the index field built by WP-E5; wp-note "Phase 6 → WP-E5"): what the
// sounding object is made of, read from the words of its title, tags and folders. The index stores them
// (`SoundEntry.materials`), search filters by them (`material`, the Library's Refine pill "Material") and the ranking's
// palette-coherence bonus ("one material family per film", WP-E6) reads them. Words, not audio: a sound whose name says
// nothing has none. Pure and deterministic.
import { tokenizeSoundText } from './taxonomy.ts';

/** The twelve materials, in display order. */
export const SOUND_MATERIALS = [
	'wood',
	'glass',
	'metal',
	'plastic',
	'paper',
	'cloth',
	'stone',
	'water',
	'air',
	'electronic',
	'rubber',
	'ceramic',
] as const;
export type SoundMaterial = (typeof SOUND_MATERIALS)[number];

/**
 * Words (lower-case tokens) that name a material: the material itself, its adjectives, its kinds and objects that are
 * made of nothing else. Words about how a sound was made (synth, synthetic, procedural) name none: a synthesised knock
 * is still wood (a saucepan is metal, a page paper, a pebble stone). Ambiguous words (a door, a key, a bowl,
 * a plate, a pan — also stereo panning —, a stick) name none. Decisions recorded in the wp-note.
 */
export const MATERIAL_SYNONYMS: Readonly<Record<string, SoundMaterial>> = Object.freeze({
	// wood
	wood: 'wood',
	wooden: 'wood',
	woody: 'wood',
	timber: 'wood',
	plank: 'wood',
	planks: 'wood',
	plywood: 'wood',
	oak: 'wood',
	pine: 'wood',
	bamboo: 'wood',
	log: 'wood',
	logs: 'wood',
	twig: 'wood',
	twigs: 'wood',
	branch: 'wood',
	branches: 'wood',
	// glass
	glass: 'glass',
	glasses: 'glass',
	glassy: 'glass',
	crystal: 'glass',
	bottle: 'glass',
	bottles: 'glass',
	jar: 'glass',
	jars: 'glass',
	// metal
	metal: 'metal',
	metallic: 'metal',
	metals: 'metal',
	steel: 'metal',
	iron: 'metal',
	aluminium: 'metal',
	aluminum: 'metal',
	copper: 'metal',
	brass: 'metal',
	bronze: 'metal',
	tin: 'metal',
	chain: 'metal',
	chains: 'metal',
	coin: 'metal',
	coins: 'metal',
	saucepan: 'metal',
	cymbal: 'metal',
	gong: 'metal',
	anvil: 'metal',
	sword: 'metal',
	blade: 'metal',
	knife: 'metal',
	wire: 'metal',
	// plastic
	plastic: 'plastic',
	plastics: 'plastic',
	pvc: 'plastic',
	acrylic: 'plastic',
	polystyrene: 'plastic',
	// paper
	paper: 'paper',
	papers: 'paper',
	page: 'paper',
	pages: 'paper',
	paperback: 'paper',
	cardboard: 'paper',
	carton: 'paper',
	newspaper: 'paper',
	envelope: 'paper',
	map: 'paper',
	tissue: 'paper',
	// cloth
	cloth: 'cloth',
	fabric: 'cloth',
	textile: 'cloth',
	cotton: 'cloth',
	nylon: 'cloth',
	silk: 'cloth',
	wool: 'cloth',
	denim: 'cloth',
	flag: 'cloth',
	clothes: 'cloth',
	clothing: 'cloth',
	trouser: 'cloth',
	trousers: 'cloth',
	shirt: 'cloth',
	jacket: 'cloth',
	curtain: 'cloth',
	towel: 'cloth',
	// stone
	stone: 'stone',
	stones: 'stone',
	rock: 'stone',
	rocks: 'stone',
	pebble: 'stone',
	pebbles: 'stone',
	gravel: 'stone',
	brick: 'stone',
	bricks: 'stone',
	concrete: 'stone',
	marble: 'stone',
	granite: 'stone',
	cobble: 'stone',
	cobbles: 'stone',
	// water
	water: 'water',
	watery: 'water',
	liquid: 'water',
	splash: 'water',
	splashes: 'water',
	drip: 'water',
	drips: 'water',
	pour: 'water',
	pouring: 'water',
	bubble: 'water',
	bubbles: 'water',
	stream: 'water',
	river: 'water',
	sea: 'water',
	ocean: 'water',
	rain: 'water',
	puddle: 'water',
	underwater: 'water',
	// air
	air: 'air',
	airy: 'air',
	wind: 'air',
	windy: 'air',
	breeze: 'air',
	gust: 'air',
	breath: 'air',
	pneumatic: 'air',
	// electronic
	electronic: 'electronic',
	electric: 'electronic',
	electrical: 'electronic',
	digital: 'electronic',
	beep: 'electronic',
	beeps: 'electronic',
	bleep: 'electronic',
	blip: 'electronic',
	blips: 'electronic',
	laser: 'electronic',
	scifi: 'electronic',
	computer: 'electronic',
	circuit: 'electronic',
	chiptune: 'electronic',
	// rubber
	rubber: 'rubber',
	rubbery: 'rubber',
	latex: 'rubber',
	balloon: 'rubber',
	balloons: 'rubber',
	eraser: 'rubber',
	tyre: 'rubber',
	tire: 'rubber',
	// ceramic
	ceramic: 'ceramic',
	ceramics: 'ceramic',
	porcelain: 'ceramic',
	pottery: 'ceramic',
	clay: 'ceramic',
	tile: 'ceramic',
	tiles: 'ceramic',
	mug: 'ceramic',
});

/** Two-word names (`sci fi`), matched on consecutive tokens before single words. */
const MATERIAL_PHRASES: readonly [string, string, SoundMaterial][] = Object.freeze([
	['sci', 'fi', 'electronic'],
	['wine', 'glass', 'glass'],
]);

const ORDER = new Map<string, number>(SOUND_MATERIALS.map((m, i) => [m, i]));

/** Whether a value is one of the twelve material ids. */
export function isSoundMaterial(v: unknown): v is SoundMaterial {
	return typeof v === 'string' && ORDER.has(v);
}

/**
 * The materials named by texts (a title, tags, a folder path…), in {@link SOUND_MATERIALS} order, each once. Pure and
 * total (any input; non-strings are ignored).
 */
export function materialsOf(texts: readonly unknown[]): SoundMaterial[] {
	const found = new Set<SoundMaterial>();
	if (!Array.isArray(texts)) return [];
	for (const text of texts.slice(0, 128)) {
		if (typeof text !== 'string') continue;
		const tokens = tokenizeSoundText(text);
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i]!;
			const phrase = MATERIAL_PHRASES.find(([a, b]) => a === t && tokens[i + 1] === b);
			if (phrase) {
				found.add(phrase[2]);
				i++;
				continue;
			}
			const m = Object.hasOwn(MATERIAL_SYNONYMS, t) ? MATERIAL_SYNONYMS[t] : undefined;
			if (m) found.add(m);
		}
	}
	return [...found].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
}
