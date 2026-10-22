import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

suite('Extension Test Suite', () => {
	test('extension contributes strict language', async () => {
		const extension = vscode.extensions.getExtension('strict-lang.strict-language');
		assert.ok(extension, 'strict-lang.strict-language extension should be present');
		await extension!.activate();
		const languages = await vscode.languages.getLanguages();
		assert.ok(languages.includes('strict'));
	});

	test('strict files save while typing so SCrunch tests them', () =>
		assert.strictEqual(vscode.workspace.getConfiguration('files', { languageId: 'strict' }).get('autoSave'), 'afterDelay'));

	test('method names complete to Get, not to the own type hiding its constructor', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'strict', content: 'has number\n' });
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',
			document.uri, new vscode.Position(1, 0));
		const labels = list.items.map((item) => typeof item.label === 'string' ? item.label : item.label.label);
		assert.ok(labels.includes('Get'), labels.join(', '));
		assert.ok(!labels.includes('Number'), labels.join(', '));
	});
	test('folder action and current-file command run normal tasks without a debugger', async function () {
		this.timeout(60000);
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		assert.ok(root, 'smoke test workspace is required');
		const folder = path.join(root!, 'Sample'), file = path.join(folder, 'Sample.strict');
		fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(file, 'Run Number\n\t0\n');
		const document = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(document);
		for (const uri of [vscode.Uri.file(folder), undefined]) {
			let listener: vscode.Disposable | undefined;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const done = new Promise<void>((resolve, reject) => {
				timeout = setTimeout(() => reject(new Error('Run task did not finish')), 30000);
				listener = vscode.tasks.onDidEndTaskProcess((event) => {
					if (event.execution.task.name === 'Run Sample') {
						if (event.exitCode === 0) { resolve(); } else { reject(new Error(`Run exited ${event.exitCode}`)); }
					}
				});
			});
			try { await Promise.all([done, vscode.commands.executeCommand('strict-vscode-client.runFile', uri)]); }
			finally { listener?.dispose(); if (timeout) { clearTimeout(timeout); } }
		}
		assert.strictEqual(vscode.debug.activeDebugSession, undefined);
	});

});
