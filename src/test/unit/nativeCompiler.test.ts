import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	checkIssues, crashLocation, crashText, dependents, focusedQueue, gitIgnored, isOnDemand, lineCounts, lineValues, nextProblem, runProcess,
	startProcess, stopProcess, testProcesses, testResults
} from '../../nativeCompiler';
import { isIgnoredBy } from '../../paths';

const adder = [
	'Add(first Number, second Number) Number',
	'\tAdder.Add(1, 2) is 4',
	'\tAdder.Add(2, 2) is 4',
	'\tfirst + second'
].join('\n');
const threeTests = adder.replace('\tfirst + second', '\tAdder.Add(3, 2) is 4\n\tfirst + second');
const overBudget = 'TestDurationMustNotExceedHundredMilliseconds: unit test exceeded 100 ms; use Slow(ReturnType) for explicit ' +
	'functional tests';

suite('native compiler', () => {
	test('explicit functional runs can disable the automatic timeout', async () => {
		const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 25)'], os.tmpdir(), { timeoutMs: 0 });
		assert.strictEqual(result.exitCode, 0, result.output);
	});

	test('started processes run below normal priority so many tests at once keep VS Code responsive', () => {
		const child = startProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], os.tmpdir());
		try {
			assert.strictEqual(os.getPriority(child.pid), os.constants.priority.PRIORITY_BELOW_NORMAL);
		} finally {
			stopProcess(child);
		}
	});
	test('testResults marks the failing is-test with expected and actual, the others pass', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 30,
			output: 'Test failed: Adder.Add(1, 2) is 4 in Add\n  got: 3\n' +
				'Test passed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 3 (0.01 ms)\n1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state]), [[1, 0], [2, 1]]);
		assert.strictEqual(results[0].expected, '4');
		assert.strictEqual(results[0].actual, '3');
		assert.strictEqual(results[0].methodName, 'Add');
	});

	test('testResults maps a failure with its location to the test on that line', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 30,
			output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2 (0.01 ms)\n' +
				'Test failed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 3\n  got: 5\n1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state]), [[1, 1], [2, 0]]);
		assert.strictEqual(results[1].actual, '5');
		assert.strictEqual(results[1].consoleOutput, undefined);
	});

	test('testResults report only the lines Strict printed, a line it did not print is no test', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 0, durationMs: 30,
			output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2 (0.02 ms)\nAll tests passed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state, result.durationMs]), [[1, 1, 0.02]]);
	});

	test('testResults pass every discovered test of a cached type, Strict printed only its summary', () => {
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 0, durationMs: 30, output: 'All tests passed in Adder.strict\n' });
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state, result.cached]), [[1, 1, true], [2, 1, true]]);
	});

	test('testResults of a lines run are no crash, its build and line counts are no console output', () => {
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 0, durationMs: 900, output: 'Built ./Adder.test.exe\n' +
			'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2 (0.02 ms)\n' +
			'Line Adder.strict:5 executed 1 times in 0.01 ms (self 0.01 ms)\nAll tests passed in Adder.strict\n' });
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state, result.consoleOutput, result.message]),
			[[1, 1, undefined, undefined]]);
	});

	test('up to date native tests passed without running again, slow and native ones too', () => {
		const source = `${adder}\nLoaded Number slow\n\tAdder.Loaded is 1\n\t1\nGenerated Number native\n\tAdder.Generated is 2\n\t2`;
		const upToDate = { exitCode: 0, durationMs: 30, output: 'Tests up to date: Adder.strict (last changed 2026-11-18 00:46) < ' +
			'Adder.test.exe (last build 2026-11-18 00:46)\n' };
		assert.strictEqual(crashText(upToDate), undefined);
		assert.deepStrictEqual(testResults(source, 'file:///Adder.strict', upToDate).map((result) => [result.lineNumber, result.state,
			result.cached, result.consoleOutput]), [1, 2, 5, 8].map((line) => [line, 1, true, undefined]));
		const unchanged = testResults(source, 'file:///Adder.strict', { exitCode: 0, durationMs: 30,
			output: 'Built ./obj/Adder.test.exe, unchanged\nTest passed: Adder.Generated is 2 in Generated at Adder.strict:line 9 (0 ms)\n' +
				'All tests passed in Adder.strict\n' });
		assert.deepStrictEqual(unchanged.map((result) => [result.lineNumber, result.state, result.consoleOutput]), [[8, 1, undefined]]);
	});

	test('a slow test passing after more than 1 s on the VM failed, Strict says to mark its method native', () => {
		const tooLong = 'Test failed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2 took 2202 ms on the VM, slow tests may take ' +
			'1000 ms at most: mark the method native';
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 1, durationMs: 2300,
			output: `Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2 (2201.57 ms)\n${tooLong}\n` +
				'Test passed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 3 (0.01 ms)\n1 tests failed in Adder.strict\n' });
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state, result.message, result.durationMs]),
			[[1, 0, tooLong, 2201.57], [2, 1, undefined, 0.01]]);
	});

	test('lineCounts are how often and how long each line ran, zero based', () => {
		assert.deepStrictEqual(lineCounts('Built ./A.test.exe\nLine Examples/A.strict:8 executed 4 times in 1.25 ms (self 0.40 ms)\r\n' +
			'Line Number.strict:40 executed 0 times in 0.00 ms (self -0.00 ms)\n', 'C:\\Strict'), [
			{ file: path.resolve('C:\\Strict', 'Examples/A.strict'), line: 7, executions: 4, ms: 1.25, selfMs: 0.4 },
			{ file: path.resolve('C:\\Strict', 'Number.strict'), line: 39, executions: 0, ms: 0, selfMs: 0 }]);
	});

	test('lineValues are how often each line ran with its value or its values per hit, zero based', () => {
		assert.deepStrictEqual(lineValues('Test passed: A.Sum is 8 in Sum at Examples/A.strict:line 2 (0.1 ms)\n' +
			'Value Examples/A.strict:line 8 hit 3 times: sum = 5 + 3 = 8\r\nValue Examples/A.strict:line 61 hit 7 times, each: false, true\n' +
			'Value Number.strict:line 4 hit 2 times\n', 'C:\\Strict').map((value) => [value.line, value.hits, value.name, value.value,
			value.each]), [[7, 3, 'sum', '5 + 3 = 8', undefined], [60, 7, undefined, undefined, 'false, true'],
			[3, 2, undefined, undefined, undefined]]);
	});

	test('runProcess returns the output and exit code', async () => {
		const run = await runProcess(process.execPath,
			['-e', 'console.log("first"); setTimeout(() => console.log("second"), 60)'], os.tmpdir());
		assert.strictEqual(run.exitCode, 0);
		assert.deepStrictEqual(run.output.split(/\r?\n/).filter(Boolean), ['first', 'second']);
	});

	test('runProcess writes input to the standard input of the process', async () =>
		assert.strictEqual((await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], os.tmpdir(),
			{ input: 'has number\n' })).output, 'has number\n'));

	test('runProcess stops the process when its signal aborts', async () => {
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 50);
		const run = await runProcess(process.execPath, ['-e', 'setTimeout(() => console.log("late"), 5000)'], os.tmpdir(),
			{ signal: abort.signal });
		assert.strictEqual(run.exitCode, -1);
		assert.ok(run.durationMs < 3000 && !run.output.includes('late'), run.output);
	});

	test('runProcess also stops the processes it started when its signal aborts', async () => {
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 500);
		const run = await runProcess(process.execPath, ['-e', 'console.log(require("child_process").spawn(process.execPath, ' +
			'["-e", "setTimeout(() => {}, 9000)"], { stdio: "ignore", detached: process.platform === "win32" }).pid); ' +
			'setTimeout(() => {}, 9000)'], os.tmpdir(),
			{ signal: abort.signal });
		const isRunning = () => {
			try {
				return process.kill(Number(run.output.split(/\r?\n/)[0]), 0);
			} catch {
				return false;
			}
		};
		for (let waited = 0; isRunning() && waited < 3000; waited += 100) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(!isRunning(), run.output);
	});

	test('gitIgnored lists what git ignores in a folder or its repositories, isIgnoredBy also their content', async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-git-'));
		const repository = path.join(parent, 'Repository');
		fs.mkdirSync(repository);
		try {
			await runProcess('git', ['init', '-q'], repository);
			fs.writeFileSync(path.join(repository, '.gitignore'), 'artifacts/\nCopy.strict\n');
			for (const file of ['artifacts/Repros/Probe.strict', 'Games/Copy.strict', 'Games/Scene.strict']) {
				fs.mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
				fs.writeFileSync(path.join(repository, file), '');
			}
			const ignored = await gitIgnored(repository);
			assert.deepStrictEqual(['artifacts/Repros/Probe.strict', 'artifacts/New.strict', 'Games/Copy.strict', 'Games/Scene.strict']
				.map((file) => isIgnoredBy(path.join(repository, file), ignored)), [true, true, true, false]);
			assert.deepStrictEqual([...await gitIgnored(parent)].sort(), [...ignored].sort());
			assert.deepStrictEqual([...await gitIgnored(path.join(parent, 'NotCloned'))], []);
			const runs = [gitIgnored(repository), gitIgnored(repository)];
			await Promise.all(runs);
			assert.strictEqual(runs[0], runs[1], 'calls in flight share one git run');
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
	});

	test('testResults expect true of a failed test without is', () => {
		const results = testResults(['has number', 'Falls Boolean', '\tPhysics(1).Falls', '\tnumber > 0'].join('\n'),
			'file:///Physics.strict', { exitCode: 1, durationMs: 30, output: 'Test failed: Physics(1).Falls in Falls at ' +
				'Physics.strict:line 3\n  got: false\n1 tests failed in Physics.strict\n' });
		assert.deepStrictEqual([results[0].expected, results[0].message], ['true', 'Expected true, got false']);
	});

	test('testResults take the duration Strict prints after a test', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 40,
			output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2 (0.02 ms)\n' +
				'Test failed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 3 (12.5 ms)\n  got: 5\n1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.state, result.durationMs]), [[1, 0.02], [0, 12.5]]);
		assert.strictEqual(results[1].actual, '5');
	});

	test('testResults fails every test with the exit code when Strict crashed before its summary', () => {
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 3221225477, durationMs: 30, output: '' });
		assert.deepStrictEqual(results.map((result) => result.state), [0, 0]);
		assert.ok(results[0].message?.includes('3221225477'));
	});

	test('testResults fails every test once with the error that stopped Strict, not again as console output', () => {
		const error = 'NameNotFound: LoadedUnitData used in ./WebWars/Scene.strict:8';
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 1, durationMs: 30, output: error + '\n' });
		assert.deepStrictEqual(results.map((result) => [result.state, result.message, result.consoleOutput]),
			[[0, error, undefined], [0, error, undefined]]);
	});

	test('testResults keeps the stack Strict prints after got with its failed test', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 30, output: 'Test failed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2 (0.02 ms)\n' +
				'  got: Error: Add\n\tat Adder.Add in Adder.strict:line 4\n\tat Adder.$Tests in Adder.strict:line 2\n' +
				'1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual([results[0].actual, results[0].stackTrace, results[0].consoleOutput],
			['Error: Add', 'at Adder.Add in Adder.strict:line 4\nat Adder.$Tests in Adder.strict:line 2', undefined]);
	});

	test('testResults keeps the tests that passed before Strict crashed', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 3221225477, durationMs: 30, output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2\n'
		});
		assert.deepStrictEqual(results.map((result) => result.state), [1, 0]);
		assert.strictEqual(results[0].message, undefined);
		assert.strictEqual(results[0].consoleOutput, undefined);
		assert.ok(results[1].message?.includes('3221225477'));
	});

	test('testResults names the test that timed out instead of a crash, the later tests did not run', () => {
		const results = testResults(threeTests, 'file:///Adder.strict', {
			exitCode: -1, durationMs: 60000, output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2\nTimed out after 60 s'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state]), [[1, 1], [2, 0]]);
		assert.strictEqual(results[1].message, 'Timed out after 60 s in Adder.Add(2, 2) is 4 (line 3), later tests did not run');
	});

	test('testResults of a run stopped at an over budget test fail only that test, the later tests did not run', () => {
		const run = { exitCode: 1, durationMs: 300, output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2 (0.02 ms)\n' +
			`Test failed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 3\n  got: ${overBudget}\n` };
		const results = testResults(threeTests, 'file:///Adder.strict', run);
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state, result.expected]), [[1, 1, undefined],
			[2, 0, undefined]]);
		assert.strictEqual(results[1].message, `${overBudget}, the tests after it did not run`);
		assert.strictEqual(crashText(run), undefined);
	});

	test('testResults keep the failure of a test Strict reported again as passed after its budget ran out', () => {
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 0, durationMs: 3000,
			output: `Test failed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2\n  got: ${overBudget}\n` +
				'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 2 (2036.06 ms)\n' +
				'Test passed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 3 (0.1 ms)\nAll tests passed in Adder.strict\n' });
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state]), [[1, 0], [2, 1]]);
	});

	test('testProcesses use the configured count or half the cores while focused, one in the background', () => {
		assert.deepStrictEqual([testProcesses(true, 0, 16), testProcesses(true, 3, 16), testProcesses(true, 0, 1),
			testProcesses(false, 3, 16)], [8, 3, 1, 1]);
	});

	test('a file in an on demand folder at any depth is only tested on demand', () => {
		assert.deepStrictEqual(['Compiler/Mlir.strict', 'Games/Runtime/Loop.strict', 'Number.strict', 'Compilers/A.strict']
			.map((file) => isOnDemand(file, ['Compiler', 'Runtime'])), [true, true, false, false]);
	});

	test('crashText is the error Strict reports with its location, only real crashes name the exit code', () => {
		assert.strictEqual(crashText({ exitCode: 1, durationMs: 9, output: 'EmptyLineInsideMethod: Twice in ./A.strict:3\n' }),
			'EmptyLineInsideMethod: Twice in ./A.strict:3');
		assert.strictEqual(crashText({ exitCode: 139, durationMs: 9, output: '' }), 'Strict crashed with exit code 139');
		assert.strictEqual(crashText({ exitCode: 1, durationMs: 9, output: 'Unsupported native call DefaultProbe.Run\n' }),
			'Unsupported native call DefaultProbe.Run\nStrict crashed with exit code 1');
		assert.strictEqual(crashText({ exitCode: 0, durationMs: 9, output: 'All tests passed in A.strict' }), undefined);
		assert.strictEqual(crashText({ exitCode: 1, durationMs: 9, output: 'Error: ResultMustBeUsed: a.Stop in Queue.strict:line 66, ' +
			'use the value\n\tat ErrorScope.Used in Bytecode/ErrorScope.strict:line 71\n\t... (skipped 12 lines)\n' +
			'\tat Strict.Ran in Strict.strict:line 82\n' }), 'Error: ResultMustBeUsed: a.Stop in Queue.strict:line 66, use the value');
	});

	test('crashLocation is the file and zero based line of the error Strict reports, also in another file', () => {
		const file = path.resolve('C:\\Strict', 'Examples', 'Bad.strict');
		assert.deepStrictEqual(crashLocation('ParsingFailed: number +* minimum in Examples/Bad.strict:5', 'C:\\Strict'), { file, line: 4 });
		assert.deepStrictEqual(crashLocation(`TypeNotFound: Foo used in ${file}:4 is not in this folder`, 'C:\\Strict'), { file, line: 3 });
		assert.deepStrictEqual(crashLocation('Error: ResultMustBeUsed: a.Stop in Examples/Other.strict:line 2, use the value',
			'C:\\Strict'), { file: path.resolve('C:\\Strict', 'Examples', 'Other.strict'), line: 1 });
		assert.strictEqual(crashLocation('Strict crashed with exit code 1', 'C:\\Strict'), undefined);
	});

	test('focusedQueue starts the file in front of the user and the check of its folder first, only them while it is red', () => {
		const queue = [path.join('C:', 'A'), path.join('C:', 'A', 'One.strict'), path.join('C:', 'B', 'Two.strict'), path.join('C:', 'B'),
			path.join('C:', 'B', 'Three.strict')];
		const focus = path.join('C:', 'B', 'Three.strict');
		assert.deepStrictEqual(focusedQueue(queue, focus, true), [focus, path.join('C:', 'B')]);
		assert.deepStrictEqual(focusedQueue(queue, focus, false), [focus, path.join('C:', 'B'), ...queue.slice(0, 3)]);
		assert.deepStrictEqual(focusedQueue(queue, undefined, true), queue);
	});

	test('nextProblem is the first problem elsewhere: errors stopping tests, then failed tests, then check issues', () => {
		const problems = [{ file: 'C:/B.strict', line: 9, message: 'MethodLengthMustNotExceedTwelve: Run', kind: 'check' as const },
			{ file: 'C:/C.strict', line: 2, message: 'Expected 4, got 3', kind: 'test' as const },
			{ file: 'C:/A.strict', line: 5, message: 'ResultMustBeUsed: a.Stop', kind: 'crash' as const }];
		assert.strictEqual(nextProblem(problems, undefined)?.file, 'C:/A.strict');
		assert.strictEqual(nextProblem(problems, 'c:\\A.strict')?.file, 'C:/C.strict');
		assert.strictEqual(nextProblem(problems.slice(0, 1), 'C:/B.strict'), undefined);
	});

	test('checkIssues reads file, zero based line, rule and target of each issue line', () => {
		const issues = checkIssues([
			'Examples\\Bad.strict:line 4: ExtraWhitespacesFoundAtBeginningOfLine: indent with tabs',
			'Examples/Bad.strict:line 1: UnusedMemberMustBeRemoved: width',
			'Validation issues: 2'
		].join('\n'), 'C:\\Strict');
		assert.deepStrictEqual(issues.map((issue) => [issue.line, issue.rule, issue.target]), [
			[3, 'ExtraWhitespacesFoundAtBeginningOfLine', 'indent with tabs'],
			[0, 'UnusedMemberMustBeRemoved', 'width']
		]);
		assert.strictEqual(issues[0].file, path.resolve('C:\\Strict', 'Examples', 'Bad.strict'));
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
});
