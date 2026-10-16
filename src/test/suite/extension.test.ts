import * as assert from 'assert';
import * as vscode from 'vscode';

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
});
