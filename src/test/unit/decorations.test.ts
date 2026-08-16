import * as assert from 'assert';
import { formatCoverageHover, formatInlineFailure, LineCoverageMark } from '../../scrunchModel';

suite('decorations', () => {
	test('coverage hover is duration, not a run-tests prompt', () => {
		const mark: LineCoverageMark = {
			lineNumber: 2,
			failed: false,
			kind: 'coverage',
			tests: [],
			durationMs: 0.04
		};
		const hover = formatCoverageHover(mark);
		assert.strictEqual(hover, '40us');
		assert.ok(!hover.includes('Click to run'));
		assert.ok(!hover.includes('right click'));
	});

	test('failed status hover shows the human error, not a type path', () => {
		const hover = formatCoverageHover({
			lineNumber: 1,
			failed: true,
			kind: 'status',
			tests: [],
			message: 'Cannot call body on trait method: TextWriter.Write is a trait method and has no implementation'
		});
		assert.ok(hover.includes('Cannot call body on trait method'));
		assert.ok(!hover.includes('Click to run'));
	});

	test('inline failure is only the discrepancy', () => {
		assert.strictEqual(formatInlineFailure({
			expected: '"Hello, yo!"',
			actual: '"Hello"'
		}), 'expected "Hello, yo!"  got "Hello"');
	});
});
