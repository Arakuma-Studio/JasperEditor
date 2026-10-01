// Types of scripts/check-anime.mjs for TypeScript callers (tests).
export type AnimeViolation = { line: number; column: number; rule: string; match: string };
export function findViolations(rel: string, text: string): AnimeViolation[];
export function checkRepo(root: string): (AnimeViolation & { file: string })[];
