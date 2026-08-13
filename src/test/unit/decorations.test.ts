import * as assert from 'assert';
import { formatTestHover, TestRunnerNotification } from '../../testResults';

suite('decorations', () => {
	test('formatTestHover describes a passing test', () => {
		const message: TestRunnerNotification = {
			lineNumber: 1,
			state: 1,
			expression: 'not true is false',
			methodName: 'not'
		};
		assert.strictEqual(formatTestHover(message), 'Passed `not true is false`\nnot');
	});

	test('formatTestHover includes caller and failure details', () => {
		const message: TestRunnerNotification = {
			lineNumber: 6,
			state: 0,
			expression: 'true and false is false',
			methodName: 'and',
			message: '"and" method failed: true and false is false, result: false',
			details: 'false is false'
		};
		const hover = formatTestHover(message);
		assert.ok(hover.includes('Failed `true and false is false`'));
		assert.ok(hover.includes('and'));
		assert.ok(hover.includes('false is false'));
		assert.ok(hover.includes('"and" method failed'));
	});
});
