import { DiscoveredMethod } from './scrunchDiscover';
import { TestRunnerNotification } from './testResults';

export type LineCoverageMark = {
	lineNumber: number;
	failed: boolean;
	tests: TestRunnerNotification[];
};

export function methodsWithTests(methods: DiscoveredMethod[]): DiscoveredMethod[] {
	return methods.filter((method) => method.tests.length > 0);
}

export function lineCoverageMarks(
	methods: DiscoveredMethod[],
	results: Map<number, TestRunnerNotification>,
	errorLines: Set<number>
): LineCoverageMark[] {
	const marks = new Map<number, LineCoverageMark>();
	for (const method of methodsWithTests(methods)) {
		const tests = coveringTests(method, results);
		if (tests.length === 0) {
			continue;
		}
		const failed = tests.some((test) => test.state === 0);
		paint(marks, method.lineNumber, tests, failed || errorLines.has(method.lineNumber));
		for (const test of method.tests) {
			const own = results.get(test.lineNumber);
			const lineTests = own ? [own] : tests;
			paint(marks, test.lineNumber, lineTests,
				(own ? own.state === 0 : failed) || errorLines.has(test.lineNumber));
		}
		for (const line of method.implementation) {
			paint(marks, line.lineNumber, tests, failed || errorLines.has(line.lineNumber));
		}
	}
	for (const line of errorLines) {
		if (!marks.has(line)) {
			marks.set(line, { lineNumber: line, failed: true, tests: [] });
		}
	}
	return [...marks.values()].sort((left, right) => left.lineNumber - right.lineNumber);
}

function coveringTests(
	method: DiscoveredMethod,
	results: Map<number, TestRunnerNotification>
): TestRunnerNotification[] {
	const tests: TestRunnerNotification[] = [];
	for (const test of method.tests) {
		const result = results.get(test.lineNumber);
		if (result) {
			tests.push(result);
		}
	}
	if (tests.length > 0) {
		return tests;
	}
	return [...results.values()].filter((result) => result.methodName === method.name);
}

function paint(
	marks: Map<number, LineCoverageMark>,
	lineNumber: number,
	tests: TestRunnerNotification[],
	failed: boolean
): void {
	const existing = marks.get(lineNumber);
	if (!existing) {
		marks.set(lineNumber, { lineNumber, failed, tests });
		return;
	}
	existing.failed = existing.failed || failed;
	for (const test of tests) {
		if (!existing.tests.some((item) => item.lineNumber === test.lineNumber &&
			item.expression === test.expression)) {
			existing.tests.push(test);
		}
	}
}
