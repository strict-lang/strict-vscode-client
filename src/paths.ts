import * as fs from 'fs';
import * as path from 'path';

export const compilerFile = path.join('Compiler', process.platform === 'win32' ? 'NativeCompiler.exe' : 'NativeCompiler');

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
		roots.push(path.join(extensionPath, 'strict'));
	}
	return [...new Set(roots.map((root) => path.normalize(root)))];
}

/** Strict folder whose Compiler/NativeCompiler is newest, checked on every call so rebuilds are used at once. */
export function findStrictRoot(configured: string | undefined, workspaceFolders: string[], extensionPath?: string): string | undefined {
	const roots = configured?.trim() ? [configured.trim()] : defaultSearchRoots(workspaceFolders, extensionPath);
	const newest = newestExistingFile(roots.map((root) => path.join(root, compilerFile)));
	return newest ? path.dirname(path.dirname(newest)) : undefined;
}
