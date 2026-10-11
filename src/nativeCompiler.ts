import { execFile } from 'child_process';
import * as path from 'path';
import { compilerFile } from './paths';
import { discoverStrictTests, typeNameFromPath } from './scrunchDiscover';
import { TestRunnerNotification } from './testResults';

export type StrictRun = { exitCode: number; output: string; durationMs: number };
export type CheckIssue = { file: string; rule: string; target: string };

const timeoutMs = 60000;
const summaryLine = /^(All tests passed|\d+ (tests )?failed) in /m;
const issuePattern = /^(.+?\.strict): (\w+): (.*)$/;

/** Runs root/strict with root as working directory, root arguments are always ".". */
export function runStrict(root: string, args: string[]): Promise<StrictRun> {
	const started = Date.now();
	return new Promise((resolve) => {
		execFile(path.join(root, compilerFile), args, { cwd: root, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 26 },
			(error, stdout, stderr) => {
				const exitCode = !error ? 0 : typeof error.code === 'number' ? error.code : -1;
				const failure = exitCode !== -1 ? '' : error?.killed ? `Timed out after ${timeoutMs / 1000} s` : error?.message ?? '';
				resolve({ exitCode, output: stdout + stderr + failure, durationMs: Date.now() - started });
			});
	});
}

export function crashText(run: StrictRun): string | undefined {
	return summaryLine.test(run.output)
		? undefined
		: `Strict crashed with exit code ${run.exitCode}${run.output.trim() ? '\n' + run.output.trim() : ''}`;
}

/** One result per discovered test line from `strict test` output. */
export function testResults(source: string, uri: string, run: StrictRun): TestRunnerNotification[] {
	const lines = run.output.split(/\r?\n/);
	const crash = crashText(run);
	const consoleOutput = lines.filter((line) => line && !line.startsWith('Test failed: ') &&
		!line.startsWith('  got: ') && !summaryLine.test(line)).join('\n') || undefined;
	const reported = new Set<number>();
	const methods = discoverStrictTests(source);
	const results = methods.flatMap((method) => method.tests.map((test): TestRunnerNotification => {
		const failed = lines.indexOf(`Test failed: ${test.expression} in ${method.name}`);
		reported.add(failed);
		const actual = failed >= 0 ? /^ {2}got: (.*)$/.exec(lines[failed + 1] ?? '')?.[1] : undefined;
		const expected = actual === undefined ? undefined : test.expression.slice(test.expression.lastIndexOf(' is ') + 4);
		return {
			lineNumber: test.lineNumber, state: crash || failed >= 0 ? 0 : 1, uri, methodName: method.name,
			expression: test.expression, expected, actual, consoleOutput,
			message: crash ?? (failed < 0 ? undefined : actual === undefined ? lines[failed] : `Expected ${expected}, got ${actual}`)
		};
	}));
	const unmatched = lines.filter((line, index) => line.startsWith('Test failed: ') && !reported.has(index));
	return results.concat(unmatched.map((line) => {
		const methodName = line.slice(line.lastIndexOf(' in ') + 4);
		const lineNumber = methods.find((method) => method.name === methodName)?.lineNumber ?? 0;
		return { lineNumber, state: 0, uri, methodName, message: line, consoleOutput };
	}));
}

/** Issues printed by `strict check` as `file: Rule: target`. */
export function checkIssues(output: string, root: string): CheckIssue[] {
	return output.split(/\r?\n/).flatMap((line) => {
		const match = issuePattern.exec(line);
		return match ? [{ file: path.resolve(root, match[1]), rule: match[2], target: match[3] }] : [];
	});
}

// ponytail: a name target maps to the first line containing it, may hit an earlier mention; upgrade: Strict reports line numbers
export function issueLine(source: string, target: string): number {
	const numbered = /^line (\d+)$/.exec(target);
	return numbered ? Number(numbered[1]) - 1 : Math.max(0, source.split(/\r?\n/).findIndex((line) => line.includes(target)));
}

// ponytail: impact by type name mentions, over-approximates common names like Type, O(n²) on long chains; upgrade: dependencies from Strict
export function dependents(changed: string, sources: Map<string, string>): string[] {
	let remaining = [...sources].filter(([file]) => file !== changed);
	const affected = [changed];
	for (let index = 0; index < affected.length && remaining.length > 0; index++) {
		const name = new RegExp(`\\b${typeNameFromPath(affected[index])}\\b`);
		const hits = remaining.filter(([, text]) => name.test(text));
		remaining = remaining.filter((entry) => !hits.includes(entry));
		affected.push(...hits.map(([file]) => file));
	}
	return affected.slice(1);
}
