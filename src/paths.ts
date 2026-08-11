import * as fs from 'fs';
import * as path from 'path';

export const languageServerPipeName = 'Strict.LanguageServer';
export const languageServerPipePath = '\\\\.\\pipe\\Strict.LanguageServer';

export type LaunchTarget = {
	command: string;
	args: string[];
	cwd?: string;
	displayName: string;
};

export type ResolveOptions = {
	configuredPath?: string;
	dotnetPath?: string;
	searchRoots?: string[];
	pathEnv?: string;
	executableNames?: string[];
	dllNames?: string[];
	projectFolderNames?: string[];
};

const defaultDotnet = 'dotnet';

export function isFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function isDirectory(dirPath: string): boolean {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

export function launchFromPath(targetPath: string, dotnetPath = defaultDotnet): LaunchTarget | undefined {
	const resolved = path.resolve(targetPath);
	if (!isFile(resolved) && !isDirectory(resolved)) {
		return undefined;
	}
	if (resolved.endsWith('.dll')) {
		return {
			command: dotnetPath,
			args: [resolved],
			cwd: path.dirname(resolved),
			displayName: resolved
		};
	}
	if (resolved.endsWith('.csproj')) {
		return {
			command: dotnetPath,
			args: ['run', '--project', resolved, '-c', 'Release', '--no-build'],
			cwd: path.dirname(resolved),
			displayName: resolved
		};
	}
	if (isDirectory(resolved)) {
		const csproj = path.join(resolved, path.basename(resolved) + '.csproj');
		if (isFile(csproj)) {
			return launchFromPath(csproj, dotnetPath);
		}
		return undefined;
	}
	return {
		command: resolved,
		args: [],
		cwd: path.dirname(resolved),
		displayName: resolved
	};
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => path.normalize(value)))];
}

export function candidateFiles(searchRoots: string[], relativePaths: string[]): string[] {
	const results: string[] = [];
	for (const root of searchRoots) {
		for (const relativePath of relativePaths) {
			results.push(path.join(root, relativePath));
		}
	}
	return unique(results);
}

function hasWindowsExecutableExtension(name: string, extensions: string[]): boolean {
	const ext = path.extname(name);
	if (!ext) {
		return false;
	}
	return extensions.some((candidate) => candidate.toLowerCase() === ext.toLowerCase());
}

export function findOnPath(executableNames: string[], pathEnv = process.env.PATH ?? ''): string | undefined {
	const extensions = process.platform === 'win32'
		? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
		: [''];
	const directories = pathEnv.split(path.delimiter).filter(Boolean);
	for (const directory of directories) {
		for (const name of executableNames) {
			const alreadyHasExecutableExtension = process.platform === 'win32'
				? hasWindowsExecutableExtension(name, extensions)
				: path.extname(name).length > 0;
			if (alreadyHasExecutableExtension) {
				const fullPath = path.join(directory, name);
				if (isFile(fullPath)) {
					return fullPath;
				}
				continue;
			}
			for (const extension of extensions) {
				const fullPath = path.join(directory, name + extension);
				if (isFile(fullPath)) {
					return fullPath;
				}
			}
		}
	}
	return undefined;
}

function dllRelativePaths(dllNames: string[]): string[] {
	const configs = ['Release', 'Debug'];
	const frameworks = ['net10.0', 'net9.0', 'net8.0'];
	const paths: string[] = [];
	for (const dllName of dllNames) {
		const projectName = dllName.replace(/\.dll$/i, '');
		for (const config of configs) {
			for (const framework of frameworks) {
				paths.push(path.join(projectName, 'bin', config, framework, dllName));
			}
		}
		paths.push(path.join(projectName, projectName + '.csproj'));
		paths.push(dllName);
	}
	return paths;
}

export function resolveLaunchTarget(options: ResolveOptions): LaunchTarget | undefined {
	const dotnetPath = options.dotnetPath?.trim() || defaultDotnet;
	const configuredPath = options.configuredPath?.trim();
	if (configuredPath) {
		const configured = launchFromPath(configuredPath, dotnetPath);
		if (configured) {
			return configured;
		}
	}
	const dllNames = options.dllNames ?? [];
	const searchRoots = options.searchRoots ?? [];
	for (const candidate of candidateFiles(searchRoots, dllRelativePaths(dllNames))) {
		const launch = launchFromPath(candidate, dotnetPath);
		if (launch) {
			// Prefer already-built dll over csproj when both exist; dllRelativePaths lists dll first.
			if (candidate.endsWith('.csproj')) {
				const built = preferBuiltDll(candidate, dotnetPath);
				return built ?? {
					command: dotnetPath,
					args: ['run', '--project', path.resolve(candidate), '-c', 'Debug'],
					cwd: path.dirname(path.resolve(candidate)),
					displayName: path.resolve(candidate)
				};
			}
			return launch;
		}
	}
	const executableNames = options.executableNames ?? [];
	const fromPath = findOnPath(executableNames, options.pathEnv ?? process.env.PATH ?? '');
	if (fromPath) {
		return launchFromPath(fromPath, dotnetPath);
	}
	return undefined;
}

function preferBuiltDll(csprojPath: string, dotnetPath: string): LaunchTarget | undefined {
	const projectDir = path.dirname(path.resolve(csprojPath));
	const projectName = path.basename(csprojPath, '.csproj');
	const dllName = projectName + '.dll';
	for (const config of ['Release', 'Debug']) {
		for (const framework of ['net10.0', 'net9.0', 'net8.0']) {
			const dllPath = path.join(projectDir, 'bin', config, framework, dllName);
			const launch = launchFromPath(dllPath, dotnetPath);
			if (launch) {
				return launch;
			}
		}
	}
	return undefined;
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
		roots.push(extensionPath);
		roots.push(path.dirname(extensionPath));
		roots.push(path.join(path.dirname(extensionPath), 'Strict'));
	}
	return unique(roots);
}

export function resolveLanguageServerLaunch(options: {
	configuredPath?: string;
	dotnetPath?: string;
	workspaceFolders?: string[];
	extensionPath?: string;
	pathEnv?: string;
}): LaunchTarget | undefined {
	return resolveLaunchTarget({
		configuredPath: options.configuredPath,
		dotnetPath: options.dotnetPath,
		searchRoots: defaultSearchRoots(options.workspaceFolders ?? [], options.extensionPath),
		pathEnv: options.pathEnv,
		executableNames: ['Strict.LanguageServer'],
		dllNames: ['Strict.LanguageServer.dll']
	});
}

export function resolveStrictCliLaunch(options: {
	configuredPath?: string;
	dotnetPath?: string;
	workspaceFolders?: string[];
	extensionPath?: string;
	pathEnv?: string;
}): LaunchTarget | undefined {
	return resolveLaunchTarget({
		configuredPath: options.configuredPath,
		dotnetPath: options.dotnetPath,
		searchRoots: defaultSearchRoots(options.workspaceFolders ?? [], options.extensionPath),
		pathEnv: options.pathEnv,
		executableNames: ['Strict'],
		dllNames: ['Strict.dll']
	});
}

export function buildRunFileArgs(launch: LaunchTarget, filePath: string, extraArgs: string[] = []): { command: string; args: string[] } {
	return {
		command: launch.command,
		args: [...launch.args, filePath, ...extraArgs]
	};
}
