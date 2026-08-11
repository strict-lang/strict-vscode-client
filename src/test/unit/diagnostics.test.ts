import * as assert from 'assert';
import {
	extractDiagnosticDetail,
	formatDiagnosticMessage,
	humanizePascalCase
} from '../../diagnosticMessages';

suite('diagnostics', () => {
	test('humanizePascalCase splits error codes into a readable sentence', () => {
		assert.strictEqual(humanizePascalCase('EmptyLineIsNotAllowed'), 'Empty line is not allowed');
		assert.strictEqual(
			humanizePascalCase('ExtraWhitespacesFoundAtEndOfLine'),
			'Extra whitespaces found at end of line'
		);
	});

	test('extractDiagnosticDetail drops stack-location noise', () => {
		const message =
			'\n   at Strict/Boolean in C:\\code\\GitHub\\strict-lang\\Strict\\Boolean.strict:line 30\n';
		assert.strictEqual(extractDiagnosticDetail(message), '');
	});

	test('extractDiagnosticDetail keeps useful exception detail', () => {
		const message =
			'num (strict always requires tab for indentation)\n   at Strict/X in C:\\x.strict:line 2\n\t num';
		assert.strictEqual(
			extractDiagnosticDetail(message),
			'num (strict always requires tab for indentation)'
		);
	});

	test('formatDiagnosticMessage prefers humanized code over raw type name', () => {
		const raw =
			'EmptyLineIsNotAllowed: \n   at Strict/Boolean in C:\\repo\\Boolean.strict:line 30\n';
		assert.strictEqual(
			formatDiagnosticMessage('EmptyLineIsNotAllowed', raw),
			'Empty line is not allowed'
		);
	});
});
