import * as fs from 'fs';
import * as path from 'path';

export const compilerFile = process.platform === 'win32' ? 'strict.exe' : 'strict';
export const strictNotFound = `${compilerFile} not found: build it in ../Strict next to strict-vscode-client (preferred) or ` +
	`add the folder with ${compilerFile} and the base .strict types to your PATH`;

export function normalizeFsPath(filePath: string): string {
	return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Folder strict runs in for a file or folder: its repository, else the innermost workspace folder holding it, else its own
 * folder. Strict looks up types in it and all its sub folders, prints paths relative to it and copies linked packages into it. */
export function projectFolder(target: string, workspaceFolders: string[]): string {
	for (let folder = target, child = ''; folder !== child; child = folder, folder = path.dirname(folder)) {
		if (fs.existsSync(path.join(folder, '.git'))) {
			return folder;
		}
	}
	return workspaceFolders.filter((folder) => !path.relative(folder, target).startsWith('..') &&
		!path.isAbsolute(path.relative(folder, target))).sort((first, second) => second.length - first.length)[0] ??
		path.dirname(target);
}

/** target relative to folder with / like Strict expects (with \ it finds no native code), `.` for folder itself. */
export function strictPath(folder: string, target: string): string {
	return path.relative(folder, target).split(path.sep).join('/') || '.';
}

/** Base types folder Strict picks in cwd (Execute.Root), passed before arguments, else it takes a first one naming a folder. */
export function rootArgument(cwd: string, root: string): string {
	return fs.existsSync(path.join(cwd, 'Any.strict')) ? '.' : root.split(path.sep).join('/');
}

/** printed, a path Strict printed, resolved against the first of folders that has it, else against the first folder. */
export function resolveIn(printed: string, folders: string[]): string {
	const candidates = folders.map((folder) => path.resolve(folder, printed));
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/** Whether file or one of its folders is in ignored, normalized paths like gitIgnored returns them. */
export function isIgnoredBy(file: string, ignored: Set<string>): boolean {
	for (let entry = file; path.dirname(entry) !== entry; entry = path.dirname(entry)) {
		if (ignored.has(normalizeFsPath(entry))) {
			return true;
		}
	}
	return false;
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

/** Every folder with strict that findStrictRoot looks at: the configured one, the repositories, PATH, the bundled copy. */
export function strictRoots(configured: string | undefined, workspaceFolders: string[], extensionPath?: string,
	searchPath = process.env.PATH ?? ''): string[] {
	const seen = new Set<string>();
	return [...(configured?.trim() ? [configured.trim()] : []), ...defaultSearchRoots(workspaceFolders, extensionPath),
		...searchPath.split(path.delimiter).filter(Boolean), ...(extensionPath ? [path.join(extensionPath, 'strict')] : [])]
		.filter((root) => fs.existsSync(path.join(root, compilerFile)) && !seen.has(normalizeFsPath(root)) &&
			seen.add(normalizeFsPath(root)));
}
