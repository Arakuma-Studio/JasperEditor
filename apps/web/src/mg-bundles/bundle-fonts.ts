// Bundle fonts in the editor document (M3, wp-m3-mgtext, S08:MGC-039): the faces a Remotion bundle registers
// (`@remotion/fonts`, `new FontFace`, `@font-face`), recorded by the host page's text probe, are added to the
// editor's own document under a per-bundle alias, so the on-canvas text editor draws with the composition's
// fonts and the Properties font menus can list what the bundle embeds (what renders identically on export).
import type { BundleFontSource } from '@jasper/compositions';

const registered = new Map<string, Map<string, string>>();

const alias = (bundleKey: string, family: string) => `jmg-${bundleKey.slice(0, 10)}-${family}`;

/** Families the bundle embeds (unique, in registration order). */
export function bundleFontFamilies(fonts: readonly BundleFontSource[]): string[] {
	return [...new Set(fonts.map((f) => f.family).filter(Boolean))];
}

/**
 * Adds the bundle's faces to `document.fonts` (once per bundle and face) and returns family → alias. Faces that
 * fail to load are skipped (the editor falls back to the next family of the stack).
 */
export async function registerBundleFonts(
	bundleKey: string,
	fonts: readonly BundleFontSource[],
): Promise<Map<string, string>> {
	let map = registered.get(bundleKey);
	if (!map) {
		map = new Map();
		registered.set(bundleKey, map);
	}
	if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return map;
	const loads: Promise<unknown>[] = [];
	for (const f of fonts) {
		const name = alias(bundleKey, f.family);
		const faceKey = `${name}|${f.weight}|${f.style}|${f.unicodeRange ?? ''}`;
		if (map.has(faceKey)) continue;
		map.set(faceKey, name);
		let source: string | ArrayBuffer | ArrayBufferView | undefined = f.source;
		if (!source && f.buffer) {
			// The buffer belongs to the page's realm: copy it into ours.
			const b = f.buffer as ArrayBuffer | ArrayBufferView;
			source = ArrayBuffer.isView(b)
				? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice().buffer
				: new Uint8Array(b as ArrayBuffer).slice().buffer;
		}
		if (!source) continue;
		try {
			const face = new FontFace(name, source as string | ArrayBuffer, {
				weight: f.weight,
				style: f.style,
				...(f.stretch ? { stretch: f.stretch } : {}),
				...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
			});
			document.fonts.add(face);
			loads.push(face.load().catch(() => undefined));
		} catch {
			// an unusable source: skipped
		}
		map.set(f.family, name);
	}
	await Promise.all(loads);
	return map;
}

/** Rewrites a computed `font-family` list so bundle families use their editor aliases (originals kept). */
export function aliasFontFamily(cssFamily: string, aliases: ReadonlyMap<string, string>): string {
	const parts = cssFamily
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);
	const out: string[] = [];
	for (const p of parts) {
		const bare = p.replace(/^['"]|['"]$/g, '');
		const a = aliases.get(bare);
		if (a) out.push(JSON.stringify(a));
		out.push(p);
	}
	return out.join(', ');
}
