// The build wraps every UI string in `__t("…")` (apps/web/i18n/transform.mjs);
// `__t` returns the active language's translation (English = the source text) every time it runs.
//
// The language is Preferences ▸ Appearance ▸ Language. Its catalogue is loaded before any module that shows text is
// evaluated (top-level await), and `setLanguage` swaps it while the editor runs: strings in function bodies are looked
// up on the next render, module-scope strings are getters (see the transform), and the shell remounts its views on
// the language epoch (`subscribeLanguage`), so nothing needs a reload and the open project, its undo history and the
// selection stay as they are.
const PREFS_KEY = 'jasper:gaps-prefs';

/** The UI language of this page: the stored preference, else English. */
export function storedLanguage(): string {
	try {
		const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PREFS_KEY);
		const lang = raw
			? (JSON.parse(raw) as { appearance?: { language?: unknown } }).appearance?.language
			: null;
		return typeof lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(lang) ? lang : 'en';
	} catch {
		return 'en';
	}
}

type Catalog = Record<string, string>;

/** Catalogues by language family; English is the source and has none. */
const LOADERS: Record<string, () => Promise<Catalog>> = {
	es: async () => (await import('./es.json')).default as Catalog,
};
const loaded = new Map<string, Catalog | null>();

const family = (lang: string) => lang.slice(0, 2);

async function loadCatalog(lang: string): Promise<Catalog | null> {
	const key = family(lang);
	if (loaded.has(key)) return loaded.get(key) ?? null;
	const load = LOADERS[key];
	let cat: Catalog | null = null;
	if (load) {
		try {
			cat = await load();
		} catch {
			cat = null; // the catalogue chunk is missing: English
		}
	}
	loaded.set(key, cat);
	return cat;
}

let language = storedLanguage();
let catalog: Catalog | null = await loadCatalog(language);
/** Names the UI shows from the project model (effects, parameters, transitions, presets, commands). */
let modelNames: ReadonlySet<string> | null = null;
let epoch = 0;
const listeners = new Set<() => void>();

async function loadModelNames(): Promise<ReadonlySet<string>> {
	if (modelNames) return modelNames;
	try {
		modelNames = new Set((await import('./model-strings.json')).default as string[]);
	} catch {
		modelNames = new Set();
	}
	return modelNames;
}

/** The language the UI shows right now (`en` when the stored language has no catalogue). */
export function getLanguage(): string {
	return catalog ? language : 'en';
}

/** The language of the page when it loaded (kept for callers that compare against the start-up language). */
export const currentLanguage = language;

/** Subscribes to language changes (the shell remounts its views; see `useLanguageEpoch`). */
export function subscribeLanguage(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Increments on every language change. */
export const languageEpoch = (): number => epoch;

/**
 * Switches the UI language while the editor runs. Resolves when the catalogue is loaded and the views have been
 * told; a language without a catalogue shows English.
 */
export async function setLanguage(lang: string): Promise<void> {
	const next = /^[a-z]{2}(-[A-Z]{2})?$/.test(lang) ? lang : 'en';
	const cat = await loadCatalog(next);
	if (cat) await loadModelNames();
	if (next === language && cat === catalog) return;
	restoreModelNames();
	language = next;
	catalog = cat;
	if (typeof document !== 'undefined') document.documentElement.lang = catalog ? family(language) : 'en';
	epoch++;
	syncObserver();
	for (const l of [...listeners]) l();
}

/** A placeholder in quotes holds a name the user gave (a clip, a preset, a file): never translated. */
const QUOTED = /[“"'«‘]\{(\d+)\}[”"'»’]/g;

function fill(key: string, s: string, args: readonly unknown[]): string {
	if (!args.length) return s;
	let quoted: Set<string> | null = null;
	if (catalog && modelNames) {
		quoted = new Set();
		for (const m of key.matchAll(QUOTED)) quoted.add(m[1]!);
	}
	return s.replace(/\{(\d+)\}/g, (m, i: string) => {
		const n = Number(i);
		if (n >= args.length) return m;
		const a = args[n];
		// Labels built from the model's names ("Bypass {0}" with an effect name): the name is translated too.
		if (quoted && typeof a === 'string' && !quoted.has(i)) return translateName(a) ?? a;
		return String(a);
	});
}

/** The translation of a source string (`{0}`… are filled with `args`). */
export function __t(key: string, ...args: unknown[]): string {
	return fill(key, catalog?.[key] ?? key, args);
}

/**
 * The setter of a lazy label property (see the transform): assigning the property turns it into a plain value, as if
 * it had never been a getter.
 */
export function __set(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** For dynamic text (effect names, command labels from the model): translated when the catalogue has it. */
export const t = __t;

/** Number of catalogue entries (diagnostics, the Preferences page). */
export const catalogSize = (): number => (catalog ? Object.keys(catalog).length : 0);

/**
 * Separators of labels built from several names: "Gaussian Blur: Radius", "Video Effects ▸ Blur & Sharpen",
 * "Cross Dissolve (Video Transitions)", "Lumetri Color · Basic Correction".
 */
const SEPARATORS = /(\s*(?:[:·▸›»|/]|[—–-]\s|→)\s*|\s+\(|\)\s*|,\s+)/;

/**
 * The translation of a name from the model, or of a label made of such names joined by separators; null when
 * nothing in it is a known name (or the language is English).
 */
export function translateName(s: string): string | null {
	const cat = catalog;
	const names = modelNames;
	if (!cat || !names) return null;
	const k = s.trim();
	if (!k) return null;
	if (names.has(k)) {
		const v = cat[k];
		return v && v !== k ? s.replace(k, v) : null;
	}
	if (k.length > 200 || !SEPARATORS.test(k)) return null;
	let changed = false;
	const parts = s.split(SEPARATORS).map((part) => {
		const p = part.trim();
		if (!p || !names.has(p)) return part;
		const v = cat[p];
		if (!v || v === p) return part;
		changed = true;
		return part.replace(p, v);
	});
	return changed ? parts.join('') : null;
}

/**
 * Names the UI shows from the project model (effect, parameter, transition, preset and command names —
 * model-strings.json) are rendered by many components as data, not literals: a document observer translates text
 * nodes and the title / aria-label / placeholder attributes whose whole text is such a name, or a label made of such
 * names ("Gaussian Blur: Radius"). Subtrees marked `data-no-i18n` (user names: clips, project items, markers) and
 * editable text are left alone. What it changed is remembered, so a language switch puts the source text back.
 */
const ATTRS = ['title', 'aria-label', 'placeholder'];
const textSource = new WeakMap<Text, { source: string; shown: string }>();
const attrSource = new WeakMap<Element, Map<string, { source: string; shown: string }>>();
let observer: MutationObserver | null = null;

const skip = (el: Element | null) =>
	!!el?.closest('[data-no-i18n],[contenteditable=""],[contenteditable="true"],textarea,code,pre');

function fixText(n: Text): void {
	if (skip(n.parentElement)) return;
	const v = translateName(n.data);
	if (v !== null) {
		textSource.set(n, { source: n.data, shown: v });
		n.data = v;
	}
}

function fixAttrs(el: Element): void {
	for (const a of ATTRS) {
		const cur = el.getAttribute(a);
		if (!cur) continue;
		const v = translateName(cur);
		if (v === null || skip(el)) continue;
		let m = attrSource.get(el);
		if (!m) {
			m = new Map();
			attrSource.set(el, m);
		}
		m.set(a, { source: cur, shown: v });
		el.setAttribute(a, v);
	}
}

function fixTree(el: Element): void {
	if (skip(el)) return;
	fixAttrs(el);
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.nodeType === Node.TEXT_NODE) fixText(n as Text);
		else fixAttrs(n as Element);
	}
}

/** Puts back the source text of everything the observer translated (before the language changes). */
function restoreModelNames(): void {
	if (typeof document === 'undefined' || !document.body) return;
	observer?.disconnect();
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.nodeType === Node.TEXT_NODE) {
			const rec = textSource.get(n as Text);
			if (rec && (n as Text).data === rec.shown) (n as Text).data = rec.source;
			textSource.delete(n as Text);
		} else {
			const m = attrSource.get(n as Element);
			if (!m) continue;
			for (const [a, rec] of m)
				if ((n as Element).getAttribute(a) === rec.shown) (n as Element).setAttribute(a, rec.source);
			attrSource.delete(n as Element);
		}
	}
}

/** Runs the observer while a catalogue is active (English needs none). */
function syncObserver(): void {
	if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
	observer?.disconnect();
	if (!catalog || !modelNames) return;
	observer ??= new MutationObserver((list) => {
		for (const m of list) {
			if (m.type === 'characterData') fixText(m.target as Text);
			else if (m.type === 'attributes') fixAttrs(m.target as Element);
			else
				for (const n of m.addedNodes) {
					if (n.nodeType === Node.TEXT_NODE) fixText(n as Text);
					else if (n.nodeType === Node.ELEMENT_NODE) fixTree(n as Element);
				}
		}
	});
	const obs = observer;
	const start = () => {
		fixTree(document.body);
		obs.observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ATTRS,
		});
	};
	if (document.body) start();
	else document.addEventListener('DOMContentLoaded', start, { once: true });
}

if (typeof document !== 'undefined') document.documentElement.lang = catalog ? family(language) : 'en';
if (catalog) {
	await loadModelNames();
	syncObserver();
}

/** Test hook: installs a catalogue and model names without the stored preference or the JSON chunks. */
export function __setCatalogForTests(lang: string, cat: Catalog | null, names: readonly string[] = []): void {
	restoreModelNames();
	language = lang;
	catalog = cat;
	loaded.set(family(lang), cat);
	modelNames = cat ? new Set(names) : modelNames;
	epoch++;
	syncObserver();
	for (const l of [...listeners]) l();
}
