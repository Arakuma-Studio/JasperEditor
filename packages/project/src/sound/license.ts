// Licences of library sounds (spec 12 §1 "Licence first", §2.1). Library entries and project media carry an SPDX id,
// or one of our `LicenseRef-…` ids. This module classifies them for ranking, filtering and credits. Pure.

/** Sounds from a user folder whose licence the user did not declare (spec 12 §1: flagged). */
export const USER_PROVIDED_LICENSE = 'LicenseRef-UserProvided';
/** A user folder the user declared royalty-free for their use (Preferences ▸ Sound Library, per folder). */
export const ROYALTY_FREE_LICENSE = 'LicenseRef-UserRoyaltyFree';
/** Original work made for this project (the Jasper Synth kit). */
export const JASPER_LICENSE = 'LicenseRef-JasperEditor';
/** SPDX "no assertion": the licence is unknown (repaired data, a pack without one). */
export const UNKNOWN_LICENSE = 'NOASSERTION';

/**
 * - `cc0`: public domain dedication (CC0, PDDL, Unlicense);
 * - `jasper`: original work of this project;
 * - `cc-by`, `cc-by-sa`: Creative Commons with attribution (and share-alike);
 * - `permissive`: other open licences that need a notice (MIT, BSD, Apache, ISC, Zlib, OFL);
 * - `royalty-free`: declared by the user for a folder;
 * - `user-provided`: a user folder without a declaration;
 * - `nc`, `nd`: non-commercial or no-derivatives Creative Commons (not commercial-safe; AGENTS.md §3.2);
 * - `unknown`: anything else.
 */
export type LicenseClass =
	| 'cc0'
	| 'jasper'
	| 'cc-by'
	| 'cc-by-sa'
	| 'permissive'
	| 'royalty-free'
	| 'user-provided'
	| 'nc'
	| 'nd'
	| 'unknown';

const PERMISSIVE = /^(?:MIT|MIT-0|ISC|0BSD|Zlib|BSD-[23]-Clause|Apache-2\.0|OFL-1\.1|BSL-1\.0|Unicode-[\w.-]+)$/i;

/** Classifies an SPDX id or LicenseRef (case-insensitive). Total: anything unrecognised is `unknown`. */
export function licenseClass(license: unknown): LicenseClass {
	if (typeof license !== 'string') return 'unknown';
	const l = license.trim();
	if (!l || l.length > 200) return 'unknown';
	const u = l.toUpperCase();
	if (u === JASPER_LICENSE.toUpperCase()) return 'jasper';
	if (u === USER_PROVIDED_LICENSE.toUpperCase()) return 'user-provided';
	if (u === ROYALTY_FREE_LICENSE.toUpperCase()) return 'royalty-free';
	if (/^CC0(?:-1\.0)?$/.test(u) || u === 'PDDL-1.0' || u === 'UNLICENSE' || u === 'CC-PDDC') return 'cc0';
	if (u.startsWith('CC-BY')) {
		if (/(?:^|-)NC(?:-|$)/.test(u.slice(5))) return 'nc';
		if (/(?:^|-)ND(?:-|$)/.test(u.slice(5))) return 'nd';
		if (/^CC-BY-SA(?:-|$)/.test(u)) return 'cc-by-sa';
		if (/^CC-BY(?:-\d|$)/.test(u)) return 'cc-by';
		return 'unknown';
	}
	if (PERMISSIVE.test(l)) return 'permissive';
	return 'unknown';
}

/**
 * Commercial-safe = on the asset allowlist (AGENTS.md §3.2: CC0, CC-BY, CC-BY-SA, open-source, original work) or
 * declared royalty-free by the user. NC, ND, undeclared user files and unknown licences are not.
 */
export function isCommercialSafe(license: unknown): boolean {
	const c = licenseClass(license);
	return (
		c === 'cc0' ||
		c === 'jasper' ||
		c === 'cc-by' ||
		c === 'cc-by-sa' ||
		c === 'permissive' ||
		c === 'royalty-free'
	);
}

/** The licence obliges a credit (attribution) when the sound is used. */
export function requiresAttribution(license: unknown): boolean {
	const c = licenseClass(license);
	return c === 'cc-by' || c === 'cc-by-sa' || c === 'permissive' || c === 'nc' || c === 'nd';
}

/**
 * Ranking preference 0…1 (spec 12 §2.1: CC0 > CC-BY > CC-BY-SA > user-provided): free of obligations first, then
 * attribution, share-alike, the user's own declarations, undeclared files; NC/ND/unknown last.
 */
export function licensePreference(license: unknown): number {
	switch (licenseClass(license)) {
		case 'cc0':
		case 'jasper':
			return 1;
		case 'cc-by':
		case 'permissive':
			return 0.8;
		case 'cc-by-sa':
			return 0.7;
		case 'royalty-free':
			return 0.6;
		case 'user-provided':
			return 0.4;
		default:
			return 0;
	}
}

const CC_VERSION = /^CC-BY(?:-(SA|NC|ND|NC-SA|NC-ND))?-(\d\.\d)$/i;

/** The canonical deed URL of a Creative Commons or CC0 licence, else null. */
export function licenseUrlOf(license: unknown): string | null {
	if (typeof license !== 'string') return null;
	const l = license.trim();
	if (/^CC0(?:-1\.0)?$/i.test(l)) return 'https://creativecommons.org/publicdomain/zero/1.0/';
	const m = CC_VERSION.exec(l);
	if (m) return `https://creativecommons.org/licenses/${m[1] ? `by-${m[1].toLowerCase()}` : 'by'}/${m[2]}/`;
	return null;
}
