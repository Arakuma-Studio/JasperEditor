// wp fonts: font previews in the editor's own document (font menus, Preferences ▸ Fonts). Each face file is loaded
// once under a private family name (`jasper-preview-<n>`), so previews never change how the editor UI or a text
// layer resolves a real family name. Loading is lazy (a row asks when it becomes visible) and never throws: a face
// that cannot load previews in the UI font.
import { useEffect, useState } from 'react';

const families = new Map<string, Promise<string | null>>();
let seq = 0;

/** The private CSS family name of `url` once loaded, or null when it cannot be loaded. */
export function loadPreviewFamily(url: string): Promise<string | null> {
	const known = families.get(url);
	if (known) return known;
	const p = (async () => {
		if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return null;
		const name = `jasper-preview-${++seq}`;
		try {
			const face = new FontFace(name, `url('${url}')`);
			await face.load();
			document.fonts.add(face);
			return name;
		} catch {
			return null;
		}
	})();
	families.set(url, p);
	return p;
}

/**
 * The preview family for `url`, loaded when `el` scrolls into view (immediately without IntersectionObserver).
 * Null until loaded, and when the face cannot be loaded.
 */
export function usePreviewFamily(url: string | null, el: Element | null): string | null {
	const [family, setFamily] = useState<string | null>(null);
	useEffect(() => {
		setFamily(null);
		if (!url) return;
		let cancelled = false;
		const load = () =>
			void loadPreviewFamily(url).then((f) => {
				if (!cancelled) setFamily(f);
			});
		if (!el || typeof IntersectionObserver === 'undefined') {
			load();
			return () => {
				cancelled = true;
			};
		}
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) {
				io.disconnect();
				load();
			}
		});
		io.observe(el);
		return () => {
			cancelled = true;
			io.disconnect();
		};
	}, [url, el]);
	return family;
}
