import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectedTasks, runMethods, taskCommand } from '../../tasks';

suite('tasks', () => {
	let tempRoot: string;

	setup(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-tasks-'));
	});

	teardown(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	test('taskCommand runs in the project with / paths and the base types before arguments, update in its folder', () => {
		const repository = path.join(tempRoot, 'DeltaEngine');
		fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
		const games = path.join(repository, 'Games');
		const root = path.join(tempRoot, 'Strict');
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, 'Any.strict'), '');
		assert.deepStrictEqual(taskCommand({ type: 'strict', file: 'Samples/Demo.strict', args: ['Data'] }, games, [games], root),
			{ name: 'Run Demo', args: ['Games/Samples/Demo.strict', root.split(path.sep).join('/'), 'Data'], cwd: repository });
		assert.deepStrictEqual(taskCommand({ type: 'strict', file: 'Sum.strict', args: ['5'] }, root, [root], root),
			{ name: 'Run Sum', args: ['Sum.strict', '.', '5'], cwd: root });
		assert.deepStrictEqual(taskCommand({ type: 'strict', command: 'test', file: '.' }, repository, [repository], root),
			{ name: 'test DeltaEngine', args: ['test', '.'], cwd: repository });
		assert.deepStrictEqual(taskCommand({ type: 'strict', command: 'update', file: 'Games' }, repository, [repository], root),
			{ name: 'update Games', args: ['update', '.'], cwd: games });
		const work = path.join(tempRoot, 'Work');
		assert.deepStrictEqual(taskCommand({ type: 'strict', command: 'build', file: 'Hello.strict' }, work, [work], root),
			{ name: 'build Hello.strict', args: ['build', 'Hello.strict'], cwd: work });
	});

	test('runMethods are the Run methods without tests, Run(numbers) needs arguments', () => {
		const source = ['has logger', 'Run(position Number) Number', '\tGray.Run(0) is 0', '\tposition', 'Run(numbers)',
			'\tlogger.Log(numbers)'].join('\n');
		assert.deepStrictEqual(runMethods(source).map((method) => [method.lineNumber, method.runnable]), [[4, false]]);
	});

	test('detectedTasks test and check the folder, build the current file and run every program without arguments', () => {
		const write = (file: string, lines: string[]) => {
			fs.mkdirSync(path.dirname(path.join(tempRoot, file)), { recursive: true });
			fs.writeFileSync(path.join(tempRoot, file), lines.join('\n'));
		};
		write('Hello.strict', ['has logger', 'Run', '\tlogger.Log("Hi")']);
		write('Sum.strict', ['has logger', 'Run(numbers)', '\tlogger.Log(numbers.Sum)']);
		write('Tested.strict', ['has logger', 'Run', '\t5 is 5', '\tlogger.Log(5)']);
		write(path.join('Shapes', 'Square.strict'), ['has logger', 'Run', '\tlogger.Log(4)']);
		const names = detectedTasks(tempRoot, path.join(tempRoot, 'Sum.strict')).map((task) => [task.command, task.file]);
		assert.deepStrictEqual(names.sort(), [[undefined, 'Hello.strict'], [undefined, path.join('Shapes', 'Square.strict')],
			['build', 'Sum.strict'], ['check', '.'], ['test', '.']].sort());
		assert.ok(!detectedTasks(tempRoot, path.join(os.tmpdir(), 'Other.strict')).some((task) => task.command === 'build'));
	});

	test('the $strict problem matcher reads check issues, failed tests, errors and stack frames, not passed tests', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
		const matcher = manifest.contributes.problemMatchers?.find((candidate: { name: string }) => candidate.name === 'strict');
		const problem = (line: string) => {
			const match = new RegExp(matcher?.pattern.regexp ?? '$^').exec(line);
			return match && [match[matcher.pattern.file], Number(match[matcher.pattern.line]), match[matcher.pattern.message]];
		};
		assert.deepStrictEqual(problem('../Work/Unused.strict:line 2: UnusedMemberMustBeRemoved: unused'),
			['../Work/Unused.strict', 2, 'UnusedMemberMustBeRemoved: unused']);
		assert.deepStrictEqual(problem('Test failed: Adder(1, 2).Add is 4 in Add at Examples/Adder.strict:line 4 (0.02 ms)'),
			['Examples/Adder.strict', 4, 'Test failed: Adder(1, 2).Add is 4 in Add']);
		assert.deepStrictEqual(problem('Test failed: 3 is in (1, 2) in Has at Has.strict:line 3'),
			['Has.strict', 3, 'Test failed: 3 is in (1, 2) in Has']);
		assert.deepStrictEqual(problem('ParsingFailed: number * * 2 in ./../Work/Broken.strict:4'),
			['./../Work/Broken.strict', 4, 'ParsingFailed: number * * 2']);
		assert.deepStrictEqual(problem('\tat Character.from in Character.strict:line 10'), ['Character.strict', 10, 'at Character.from']);
		assert.strictEqual(problem('Test passed: Adder(1, 2).Add is 3 in Add at Examples/Adder.strict:line 4 (0.02 ms)'), null);
		assert.strictEqual(problem('1 tests failed in Examples/Adder.strict'), null);
	});
});
