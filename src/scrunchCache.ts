import * as fs from 'fs';

export function isStrictBinaryPath(filePath: string): boolean {
	return filePath.toLowerCase().endsWith('.strictbinary');
}

// ponytail: fresh = not older than its own source, a changed type it uses does not invalidate it; upgrade: Strict compares the used types too
/** Strict writes Name.strictbinary only when all tests of Name.strict passed, so they need no rerun while it is fresh. */
export function hasFreshBinary(file: string): boolean {
	const source = fs.statSync(file, { throwIfNoEntry: false });
	const binary = fs.statSync(file.replace(/\.strict$/i, '.strictbinary'), { throwIfNoEntry: false });
	return !!source && !!binary && binary.mtimeMs >= source.mtimeMs;
}
