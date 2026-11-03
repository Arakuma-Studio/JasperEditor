// Spec 19 TL-050: the categories of the library, general styles first. Pachinko is one category among equals: nothing in
// the model, the commands or the search treats it differently.

export type LookCategory = {
	id: string;
	label: string;
	labelEs: string;
	/** What people search for when they mean the category. */
	tags: readonly string[];
};

export const LOOK_CATEGORIES: readonly LookCategory[] = [
	{
		id: 'clean',
		label: 'Clean',
		labelEs: 'Limpio',
		tags: ['minimal', 'simple', 'subtle', 'minimalista', 'sencillo', 'sutil'],
	},
	{
		id: 'corporate',
		label: 'Corporate',
		labelEs: 'Corporativo',
		tags: ['business', 'professional', 'interview', 'negocios', 'profesional', 'entrevista'],
	},
	{
		id: 'cinematic',
		label: 'Cinematic',
		labelEs: 'Cinematográfico',
		tags: ['film', 'trailer', 'movie', 'epic', 'cine', 'película', 'épico', 'tráiler'],
	},
	{
		id: 'sports',
		label: 'Sports',
		labelEs: 'Deportes',
		tags: ['team', 'match', 'score', 'athletic', 'equipo', 'partido', 'marcador'],
	},
	{
		id: 'gaming',
		label: 'Gaming',
		labelEs: 'Videojuegos',
		tags: ['esports', 'stream', 'sci-fi', 'cyber', 'juego', 'ciencia ficción', 'directo'],
	},
	{
		id: 'neon-retro',
		label: 'Neon & Retro',
		labelEs: 'Neón y retro',
		tags: ['neon', 'synthwave', '80s', 'vintage', 'sign', 'neón', 'años 80', 'letrero', 'ネオン', 'レトロ'],
	},
	{
		id: 'comic',
		label: 'Comic',
		labelEs: 'Cómic',
		tags: ['cartoon', 'pop art', 'manga', 'dibujos', 'historieta', 'マンガ', '漫画'],
	},
	{
		id: 'luxury',
		label: 'Luxury',
		labelEs: 'Lujo',
		tags: ['elegant', 'premium', 'fashion', 'gold', 'elegante', 'moda', 'oro'],
	},
	{
		id: 'horror',
		label: 'Horror',
		labelEs: 'Terror',
		tags: ['scary', 'halloween', 'dark', 'miedo', 'oscuro', 'ホラー'],
	},
	{
		id: 'playful',
		label: 'Playful',
		labelEs: 'Divertido',
		tags: ['kids', 'fun', 'cute', 'bubble', 'niños', 'infantil', 'alegre', 'かわいい'],
	},
	{
		id: 'social',
		label: 'Social',
		labelEs: 'Redes sociales',
		tags: ['hook', 'caption', 'vertical video', 'subtítulo', 'gancho', 'テロップ'],
	},
	{
		id: 'japanese-variety',
		label: 'Japanese Variety',
		labelEs: 'Variedades japonesas',
		tags: ['telop', 'tv show', 'variety', 'japan', 'programa', 'japón', 'バラエティ', 'テロップ', '袋文字'],
	},
	{
		id: 'pachinko-arcade',
		label: 'Pachinko & Arcade',
		labelEs: 'Pachinko y arcade',
		tags: ['slots', 'casino', 'jackpot', 'pixel', 'tragaperras', 'パチンコ', 'パチスロ', 'アーケード'],
	},
	{
		id: 'brush',
		label: 'Brush',
		labelEs: 'Pincel',
		tags: ['calligraphy', 'ink', 'sumi', 'caligrafía', 'tinta', '筆文字', '書道'],
	},
	{
		// Depth a 2D look draws: extruded walls, domes and plates. Renders and bakes like any look.
		id: 'drawn-depth',
		label: 'Drawn Depth',
		labelEs: 'Profundidad dibujada',
		tags: ['extrude', 'faux 3d', '2.5d', 'block', 'extrusión', 'falso 3d', 'bloque', 'profundidad'],
	},
	{
		// Real Advanced 3D solids (spec 19 §9). A look cannot hold a solid, so this category holds templates, not looks.
		id: '3d',
		label: '3D',
		labelEs: '3D',
		tags: ['solid', 'bevel', 'metal', 'depth', 'sólido', 'bisel', 'profundidad', '立体'],
	},
];

export const lookCategory = (id: string): LookCategory | undefined =>
	LOOK_CATEGORIES.find((c) => c.id === id);
