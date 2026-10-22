import * as fs from 'fs';
import * as path from 'path';
import { projectFolder, rootArgument, strictPath } from './paths';
import { discoverStrictTests, DiscoveredMethod } from './scrunchDiscover';
import { strictFiles } from './strictIndex';

/** `strict` task: runs the Run method of file, or command (test, check, build, update) on a file or folder. */
export type StrictTask = { type: string; file: string; command?: string; args?: string[] };

/** Run methods without tests are programs (`Run(numbers)` ones take arguments), a Run with tests is a normal method. */
export function runMethods(source: string): DiscoveredMethod[] {
	return discoverStrictTests(source).filter((method) => method.name === 'Run' && method.tests.length === 0);
}

/** Name and `strict` arguments of a task with its file relative to folder, run in the project folder (cwd) of that file, an
 * update in the folder it refreshes (Strict copies packages into the cwd), arguments after the base types in root. */
export function taskCommand(task: StrictTask, folder: string, workspaceFolders: string[], root: string):
	{ name: string; args: string[]; cwd: string } {
	const file = path.resolve(folder, task.file);
	const cwd = task.command === 'update' ? file : projectFolder(file, workspaceFolders);
	return {
		name: task.command ? `${task.command} ${path.basename(file)}` : `Run ${path.basename(file, '.strict')}`,
		args: [...(task.command ? [task.command] : []), strictPath(cwd, file),
			...task.args?.length ? [rootArgument(cwd, root), ...task.args] : []], cwd
	};
}

/** Test and check the folder, build the current file and run every program that needs no arguments. */
export function detectedTasks(folder: string, current?: string): StrictTask[] {
	const relative = current?.endsWith('.strict') ? path.relative(folder, current) : '..';
	return [{ type: 'strict', command: 'test', file: '.' }, { type: 'strict', command: 'check', file: '.' },
		...(relative.startsWith('..') || path.isAbsolute(relative) ? [] : [{ type: 'strict', command: 'build', file: relative }]),
		...strictFiles(folder).filter((file) => runMethods(fs.readFileSync(file, 'utf8')).some((method) => method.runnable))
			.map((file) => ({ type: 'strict', file: path.relative(folder, file) }))];
}

export function runTargets(target: string): string[] {
	if (!fs.existsSync(target)) { return []; }
	if (!fs.statSync(target).isDirectory()) {
		if (!target.endsWith('.strict')) { return []; }
		const named = path.join(path.dirname(target), path.basename(path.dirname(target)) + '.strict');
		return runMethods(fs.readFileSync(target, 'utf8')).length === 0 && fs.existsSync(named)
			&& runMethods(fs.readFileSync(named, 'utf8')).length > 0 ? [named] : [target];
	}
	const files = fs.readdirSync(target).filter((name) => name.endsWith('.strict')).map((name) => path.join(target, name))
		.filter((file) => runMethods(fs.readFileSync(file, 'utf8')).length > 0);
	const named = path.join(target, path.basename(target) + '.strict');
	if (files.length) { return files.includes(named) ? [named] : files; }
	return fs.readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isDirectory() &&
		/^[A-Z]/.test(entry.name) && !['Release', 'Debug', 'Tools'].includes(entry.name))
		.flatMap((entry) => runTargets(path.join(target, entry.name)));
}

/** Native games need their release working directory for relative Content paths. */
export function nativeGame(file: string): { file: string; cwd: string } | undefined {
	if (process.platform !== 'win32' || !fs.existsSync(path.join(path.dirname(file), 'Content'))) { return; }
	const name = path.basename(file, '.strict'), parent = path.dirname(file);
	const demo = name.endsWith('Demo') && fs.existsSync(path.join(parent, path.basename(parent) + '.strict'));
	const cwd = path.join(parent, 'Release', ...(demo ? [] : ['Windows']));
	return { file: path.join(cwd, name + '.exe'), cwd };
}
