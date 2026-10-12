import * as fs from 'fs';
import * as path from 'path';

export const compilerFile = process.platform === 'win32' ? 'strict.exe' : 'strict';
export const strictNotFound = `${compilerFile} not found: build it in ../Strict next to strict-vscode-client (preferred) or ` +
	`add the folder with ${compilerFile} and the base .strict types to your PATH`;

export function normalizeFsPath(filePath: string): string {
	return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export const strictDocumentSelector = [
	{ language: 'strict', scheme: 'file' },
	{ language: 'strict', scheme: 'untitled' }
];

export function newestExistingFile(paths: string[]): string | undefined {
	let best: { filePath: string; mtime: number } | undefined;
	for (const filePath of paths) {
		try {
			const stat = fs.statSync(filePath);
			if (!stat.isFile()) {
				continue;
			}
			if (!best || stat.mtimeMs > best.mtime) {
				best = { filePath, mtime: stat.mtimeMs };
			}
		} catch {
		}
	}
	return best?.filePath;
}

export function defaultSearchRoots(workspaceFolders: string[] = [], extensionPath?: string): string[] {
	const roots: string[] = [];
	for (const folder of workspaceFolders) {
		roots.push(folder);
		roots.push(path.dirname(folder));
		roots.push(path.join(path.dirname(folder), 'Strict'));
		roots.push(path.join(folder, 'Strict'));
	}
	if (extensionPath) {
		roots.push(path.dirname(extensionPath));
		roots.push(path.join(path.dirname(extensionPath), 'Strict'));
	}
	return [...new Set(roots.map((root) => path.normalize(root)))];
}

/** Strict folder with the newest strict compiler (next to the base types), checked on every call so rebuilds are used at once.
 * Without any Strict repository the first strict on PATH is used, then the copy bundled in the .vsix (strict/). */
export function findStrictRoot(configured: string | undefined, workspaceFolders: string[], extensionPath?: string,
	searchPath = process.env.PATH ?? ''): string | undefined {
	if (configured?.trim()) {
		return newestRoot([configured.trim()]);
	}
	return newestRoot(defaultSearchRoots(workspaceFolders, extensionPath)) ??
		searchPath.split(path.delimiter).find((folder) => folder && newestRoot([folder])) ??
		(extensionPath ? newestRoot([path.join(extensionPath, 'strict')]) : undefined);
}

function newestRoot(roots: string[]): string | undefined {
	const newest = newestExistingFile(roots.map((root) => path.join(root, compilerFile)));
	return newest ? path.dirname(newest) : undefined;
}
