// UI-6 i18n runtime (workstream gaps, docs/wp-notes/gaps.md §UI-6). The build wraps every UI string in `__t("…")`
// (apps/web/i18n/transform.mjs); `__t` returns the active language's translation (English = the source text).
// The language is Preferences ▸ Appearance ▸ Language, read once at start-up (like Premiere, a change applies after
// a restart / reload): its catalogue is loaded before any module that shows text is evaluated (top-level await).
const PREFS_KEY = 'jasper:gaps-prefs';

/** The UI language of this page: the stored preference, else English. */
export function storedLanguage(): string {
	try {
		const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PREFS_KEY);
		const lang = raw ? (JSON.parse(raw) as { appearance?: { language?: unknown } }).appearance?.language : null;
		return typeof lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(lang) ? lang : 'en';
	} catch {
		return 'en';
	}
}

export const currentLanguage = storedLanguage();

let catalog: Record<string, string> | null = null;
if (currentLanguage.startsWith('es')) {
	try {
		catalog = (await import('./es.json')).default as Record<string, string>;
	} catch {
		catalog = null;
	}
}
if (typeof document !== 'undefined') document.documentElement.lang = catalog ? 'es' : 'en';

const fill = (s: string, args: readonly unknown[]) =>
	args.length ? s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s;

/** The translation of a source string (`{0}`… are filled with `args`). */
export function __t(key: string, ...args: unknown[]): string {
	return fill(catalog?.[key] ?? key, args);
}

/** For dynamic text (effect names, command labels from the model): translated when the catalogue has it. */
export const t = __t;

/** Number of catalogue entries (diagnostics, the Preferences page). */
export const catalogSize = (): number => (catalog ? Object.keys(catalog).length : 0);

// ---------------------------------------------------------------- names from the model

/**
 * Names the UI shows from the project model (effect, parameter, transition and command names — model-strings.json)
 * are rendered by many components as data, not literals: a document observer translates text nodes and the
 * title / aria-label / placeholder attributes whose whole text is such a name. Subtrees marked `data-no-i18n` (user
 * names: clips, project items, markers) and editable text are left alone.
 */
function installModelNames(cat: Record<string, string>, names: ReadonlySet<string>): void {
	if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
	const skip = (el: Element | null) =>
		!!el?.closest('[data-no-i18n],[contenteditable=""],[contenteditable="true"],textarea,code,pre');
	const tr = (s: string): string | null => {
		const k = s.trim();
		if (!k || !names.has(k)) return null;
		const v = cat[k];
		return v && v !== k ? s.replace(k, v) : null;
	};
	const ATTRS = ['title', 'aria-label', 'placeholder'];
	const fixText = (n: Text) => {
		if (skip(n.parentElement)) return;
		const v = tr(n.data);
		if (v !== null) n.data = v;
	};
	const fixEl = (el: Element) => {
		if (skip(el)) return;
		for (const a of ATTRS) {
			const cur = el.getAttribute(a);
			if (cur) {
				const v = tr(cur);
				if (v !== null) el.setAttribute(a, v);
			}
		}
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n.nodeType === Node.TEXT_NODE) fixText(n as Text);
			else
				for (const a of ATTRS) {
					const cur = (n as Element).getAttribute(a);
					if (cur) {
						const v = tr(cur);
						if (v !== null && !skip(n as Element)) (n as Element).setAttribute(a, v);
					}
				}
		}
	};
	const obs = new MutationObserver((list) => {
		for (const m of list) {
			if (m.type === 'characterData') fixText(m.target as Text);
			else if (m.type === 'attributes') fixEl(m.target as Element);
			else
				for (const n of m.addedNodes) {
					if (n.nodeType === Node.TEXT_NODE) fixText(n as Text);
					else if (n.nodeType === Node.ELEMENT_NODE) fixEl(n as Element);
				}
		}
	});
	const start = () => {
		fixEl(document.body);
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

if (catalog) {
	try {
		const names = (await import('./model-strings.json')).default as string[];
		installModelNames(catalog, new Set(names));
	} catch {
		/* no model names */
	}
}
