import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	buildRunFileArgs,
	languageServerPipeName,
	resolveLanguageServerLaunch
} from '../../paths';

suite('Extension Test Suite', () => {
	test('extension contributes strict language', async () => {
		const extension = vscode.extensions.getExtension('strict-lang.strict-language');
		assert.ok(extension, 'strict-lang.strict-language extension should be present');
		await extension!.activate();
		const languages = await vscode.languages.getLanguages();
		assert.ok(languages.includes('strict'));
	});

	test('pipe name matches language server', () => {
		assert.strictEqual(languageServerPipeName, 'Strict.LanguageServer');
	});

	test('run file args keep cli launch prefix', () => {
		const result = buildRunFileArgs(
			{ command: 'dotnet', args: ['C:\\Strict.dll'], displayName: 'Strict.dll' },
			'C:\\code\\Sum.strict'
		);
		assert.deepStrictEqual(result.args, ['C:\\Strict.dll', 'C:\\code\\Sum.strict']);
	});

	test('language server resolver returns undefined for empty roots', () => {
		const launch = resolveLanguageServerLaunch({
			workspaceFolders: [],
			pathEnv: ''
		});
		assert.strictEqual(launch, undefined);
	});
});
