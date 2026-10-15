import { parseType } from './strictIndex';

/** Leading whitespace as one tab per unit columns it reaches (tab stops every unit columns, half a level rounds down, so a
 * stray space before a member stays none), without trailing whitespace. */
export function withTabs(text: string, unit = 4): string {
	const indent = /^[\t ]*/.exec(text)![0];
	const columns = [...indent].reduce((column, character) => character === '\t' ? (Math.floor(column / unit) + 1) * unit
		: column + 1, 0);
	return '\t'.repeat(Math.ceil(columns / unit - 0.5)) + text.slice(indent.length).trimEnd();
}

/** Spaces per level of a file indented with spaces: its smallest space indentation from 2 on, else 4. */
export function indentUnit(lines: string[]): number {
	const spaces = lines.map((line) => /^ +(?=\S)/.exec(line)?.[0].length ?? 0).filter((count) => count >= 2);
	return spaces.length > 0 ? Math.min(...spaces) : 4;
}

// ponytail: whitespace only, a range or an unparsable file stays like this; upgrade: `strict format` of a line range
/** Lines first to last with tabs, without trailing whitespace, blank lines in methods or blank lines at the end of the
 * file (a final line break stays), whole files go through `strict format` afterwards (it drops space indentation). */
export function formatted(source: string, first = 0, last = Number.MAX_SAFE_INTEGER): string {
	const lines = source.split(/\r?\n/);
	const unit = indentUnit(lines);
	const indices = [...lines.keys()];
	const lastText = indices.filter((index) => lines[index].trim()).pop() ?? -1;
	const inMethods = new Set(parseType('', source).methods.flatMap((method) => indices.slice(method.line + 1, method.endLine + 1)));
	const isRemoved = (index: number) => !lines[index].trim() && (inMethods.has(index) || index > lastText) &&
		!(index === lines.length - 1 && lines[index] === '');
	return lines.flatMap((text, index) => index < first || index > last ? [text] : isRemoved(index) ? []
		: [text.trim() ? withTabs(text, unit) : '']).join(lineEnding(source));
}

// ponytail: guards against strict builds before 184bf30a (they dropped words they couldn't parse), brackets inside texts are not
// told apart; Strict now fails such lines itself
/** What `strict format` printed without the line break ending the print, in the line endings of source, nothing when it
 * changed more than whitespace and brackets (it drops words of lines it can't parse). */
export function printed(output: string, source: string): string | undefined {
	const text = output.replace(/\r?\n$/, '').split(/\r?\n/).join(lineEnding(source));
	const tokens = (code: string) => code.replace(/[\s()]/g, '');
	return tokens(text) === tokens(source) ? text : undefined;
}

function lineEnding(source: string): string {
	return source.includes('\r\n') ? '\r\n' : '\n';
}
