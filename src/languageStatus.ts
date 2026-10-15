import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runStrict } from './nativeCompiler';
import { compilerFile, strictDocumentSelector, strictNotFound } from './paths';

const selectCommand = 'strict-vscode-client.selectRoot';
/** Shows a rebuilt strict, NativeTester runs it before every test or check (cheap: compares the modification time). */
export const refreshStatusCommand = 'strict-vscode-client.refreshStatus';

// ponytail: refreshed when the editor or a setting changes, a rebuilt strict shows after the next switch; upgrade: watch it
/** `strict <version>` and the Strict folder in use for .strict files, an error without one, its link selects another. */
export function registerLanguageStatus(root: () => string | undefined, candidates: () => string[], log: (line: string) => void):
	vscode.Disposable {
	const status = vscode.languages.createLanguageStatusItem('strict', strictDocumentSelector);
	status.name = 'Strict';
	status.command = { command: selectCommand, title: 'Select Folder' };
	let shown: string | undefined;
	const update = async () => {
		const folder = root();
		const build = `${folder} ${folder && fs.statSync(path.join(folder, compilerFile), { throwIfNoEntry: false })?.mtimeMs}`;
		if (build === shown) {
			return;
		}
		shown = build;
		const version = folder ? await runStrict(folder, ['version']) : undefined;
		if (shown === build) {
			if (version) {
				log(`Using ${path.join(folder!, compilerFile)} ${version.output.trim()}`);
			}
			status.text = version ? `strict ${version.output.trim().split(/\r?\n/)[0]}` : 'strict not found';
			status.detail = folder ?? strictNotFound;
			status.severity = version?.exitCode === 0 ? vscode.LanguageStatusSeverity.Information
				: vscode.LanguageStatusSeverity.Error;
		}
	};
	void update();
	return vscode.Disposable.from(status, vscode.window.onDidChangeActiveTextEditor(() => void update()),
		vscode.workspace.onDidChangeConfiguration(() => void update()),
		vscode.commands.registerCommand(selectCommand, () => selectRoot(candidates(), root())),
		vscode.commands.registerCommand(refreshStatusCommand, () => update()));
}

/** Picks one of the Strict folders by its version and writes strict.root, empty uses the newest found again. */
async function selectRoot(folders: string[], current: string | undefined): Promise<void> {
	const items = Promise.all(folders.map(async (folder) => ({ folder, label: folder === current ? `$(check) ${folder}` : folder,
		description: (await runStrict(folder, ['version'])).output.trim() })))
		.then((found) => [{ folder: '', label: 'Newest found', description: 'empty strict.root, always the newest' }, ...found]);
	const picked = await vscode.window.showQuickPick(items, { title: 'Strict folder with strict and the base types' });
	if (picked) {
		const settings = vscode.workspace.getConfiguration('strict');
		await settings.update('root', picked.folder || undefined, settings.inspect('root')?.workspaceValue === undefined
			? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
	}
}
