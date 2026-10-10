// Values inside FFmpeg filter text (security review ENG-3). FFmpeg unescapes filter text twice: the filtergraph
// parser (`[`, `]`, `,`, `;`, quotes, backslashes) hands each filter its argument string, then the filter's option
// parser splits that string at `:` and `=` and unescapes it again. A value therefore needs both levels: escape
// `\`, `'` and `:` for the option parser, then quote the result for the graph parser (inside single quotes the
// graph parser keeps everything literally; a `'` is closed, escaped and reopened). With only one level, every
// Windows path (`C:/…`) was split at its drive colon, and a `'` or `:` in a file name broke the filter or injected
// options into it. Documented in FFmpeg's filters manual, "Notes on filtergraph escaping".

/** A filter option value (file path or text) escaped for both FFmpeg parsing levels. */
export function filterValue(value: string): string {
	const option = value.replace(/[\\':]/g, (c) => `\\${c}`);
	return `'${option.replace(/'/g, "'\\''")}'`;
}

/**
 * A file path as a filter option value. On Windows backslashes become `/` (FFmpeg opens both there); elsewhere a
 * backslash is an ordinary file-name character and is kept (escaped).
 */
export function filterPath(path: string, platform: NodeJS.Platform = process.platform): string {
	return filterValue(platform === 'win32' ? path.replace(/\\/g, '/') : path);
}
