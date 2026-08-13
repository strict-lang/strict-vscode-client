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

	test('extractDiagnosticDetail keeps InstructionExecutionFailed reason despite :line dump', () => {
		const message = [
			"FieldLoad on non-struct value for field 'value'",
			'   in Strict/Boolean.not',
			'   Instructions (0/3):',
			'   >>>    0: FieldLoad value  (:line 4)',
			'   Boolean.strict',
			'>>>4: value then false else true',
			'   at Strict/Boolean.not in C:\\repo\\Boolean.strict:line 4'
		].join('\n');
		assert.strictEqual(
			extractDiagnosticDetail(message),
			"FieldLoad on non-struct value for field 'value'\nin Strict/Boolean.not"
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

	test('formatDiagnosticMessage keeps exception reason and extra context', () => {
		const raw = [
			"FieldLoad on non-struct value for field 'value'",
			'   in Strict/Boolean.not',
			'   at Strict/Boolean.not in C:\\repo\\Boolean.strict:line 4'
		].join('\n');
		assert.strictEqual(
			formatDiagnosticMessage('InstructionExecutionFailed', raw),
			"Instruction execution failed: FieldLoad on non-struct value for field 'value'\nin Strict/Boolean.not"
		);
	});

	test('formatDiagnosticMessage does not duplicate an already humanized server message', () => {
		assert.strictEqual(
			formatDiagnosticMessage(
				'InstructionExecutionFailed',
				"Instruction execution failed: FieldLoad on non-struct value for field 'value'\nStrict.InstructionExecutionFailed"
			),
			"Instruction execution failed: FieldLoad on non-struct value for field 'value'\nStrict.InstructionExecutionFailed"
		);
	});
});
