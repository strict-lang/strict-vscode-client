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
});
