import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkIssues, dependents, issueLine, testResults } from '../../nativeCompiler';
import { hasFreshBinary } from '../../scrunchCache';

const adder = [
	'has logger',
	'Add(first Number, second Number) Number',
	'\tAdder.Add(1, 2) is 4',
	'\tAdder.Add(2, 2) is 4',
	'\tfirst + second'
].join('\n');

suite('native compiler', () => {
	test('testResults marks the failing is-test with expected and actual, the others pass', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 30,
			output: 'Test failed: Adder.Add(1, 2) is 4 in Add\n  got: 3\n1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state]), [[2, 0], [3, 1]]);
		assert.strictEqual(results[0].expected, '4');
		assert.strictEqual(results[0].actual, '3');
		assert.strictEqual(results[0].methodName, 'Add');
	});

	test('testResults fails every test with the exit code when Strict crashed before its summary', () => {
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 3221225477, durationMs: 30, output: '' });
		assert.deepStrictEqual(results.map((result) => result.state), [0, 0]);
		assert.ok(results[0].message?.includes('3221225477'));
	});

	test('checkIssues reads file, rule and target of each issue line', () => {
		const issues = checkIssues([
			'Examples\\Bad.strict: ExtraWhitespacesFoundAtBeginningOfLine: line 4',
			'Examples/Bad.strict: UnusedMemberMustBeRemoved: logger',
			'Validation issues: 2'
		].join('\n'), 'C:\\Strict');
		assert.deepStrictEqual(issues.map((issue) => [issue.rule, issue.target]), [
			['ExtraWhitespacesFoundAtBeginningOfLine', 'line 4'],
			['UnusedMemberMustBeRemoved', 'logger']
		]);
		assert.strictEqual(issues[0].file, path.resolve('C:\\Strict', 'Examples', 'Bad.strict'));
	});

	test('issueLine maps line numbers and names to zero based lines', () => {
		assert.strictEqual(issueLine(adder, 'line 4'), 3);
		assert.strictEqual(issueLine(adder, 'logger'), 0);
		assert.strictEqual(issueLine(adder, 'second'), 1);
		assert.strictEqual(issueLine(adder, 'missing'), 0);
	});

	test('dependents follow type names transitively and skip unrelated files', () => {
		const sources = new Map([
			['C:/Strict/Number.strict', 'has value'],
			['C:/Strict/Counter.strict', 'has number Number'],
			['C:/Strict/Examples/Clock.strict', 'has counter Counter'],
			['C:/Strict/Examples/Hello.strict', 'Run\n\tlogger.Log("Hi")']
		]);
		assert.deepStrictEqual(dependents('C:/Strict/Number.strict', sources),
			['C:/Strict/Counter.strict', 'C:/Strict/Examples/Clock.strict']);
	});

	test('hasFreshBinary only when the .strictbinary is not older than its source', () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-binary-'));
		const source = path.join(folder, 'Adder.strict');
		const binary = path.join(folder, 'Adder.strictbinary');
		fs.writeFileSync(source, adder);
		assert.strictEqual(hasFreshBinary(source), false);
		fs.writeFileSync(binary, '');
		fs.utimesSync(binary, 1000, 1000);
		assert.strictEqual(hasFreshBinary(source), false);
		fs.utimesSync(source, 1000, 1000);
		assert.strictEqual(hasFreshBinary(source), true);
		fs.rmSync(folder, { recursive: true });
	});
});
