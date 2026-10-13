import * as assert from 'assert';
import { formatCoverageHover, formatInlineFailure, formatInlineSlow, LineCoverageMark, slowestTests } from '../../scrunchModel';

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

	test('slow marker on tests and method headers from the threshold on, never on failures or implementation lines', () => {
		const timed = { lineNumber: 2, state: 1, durationMs: 238 };
		const mark = (lineNumber: number, kind: 'status' | 'coverage', durationMs: number, failed = false): LineCoverageMark =>
			({ lineNumber, failed, kind, tests: [timed], durationMs });
		assert.strictEqual(formatInlineSlow(mark(2, 'coverage', 238), 10), 'slow: 238ms');
		assert.strictEqual(formatInlineSlow(mark(1, 'status', 238), 10), 'slow: 238ms');
		assert.strictEqual(formatInlineSlow(mark(3, 'coverage', 238), 10), undefined);
		assert.strictEqual(formatInlineSlow(mark(2, 'coverage', 9.9), 10), undefined);
		assert.strictEqual(formatInlineSlow(mark(2, 'coverage', 238, true), 10), undefined);
	});

	test('slowestTests sorts timed results by duration and leaves out untimed ones', () => {
		const result = (lineNumber: number, durationMs?: number) => ({ lineNumber, state: 1, durationMs });
		assert.deepStrictEqual(slowestTests([result(1, 0.2), result(2), result(3, 238), result(4, 12)], 2).map((test) =>
			test.lineNumber), [3, 4]);
	});

	test('inline failure is only the discrepancy', () => {
		assert.strictEqual(formatInlineFailure({
			expected: '"Hello, yo!"',
			actual: '"Hello"'
		}), 'expected "Hello, yo!"  got "Hello"');
	});
});
