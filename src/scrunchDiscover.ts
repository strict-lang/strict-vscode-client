export type DiscoveredTest = {
	expression: string;
	lineNumber: number;
};

export type DiscoveredMethod = {
	name: string;
	header: string;
	lineNumber: number;
	tests: DiscoveredTest[];
	implementation: DiscoveredTest[];
	runnable: boolean;
};

const memberPrefix = /^(has|constant|mutable|implement)\b/;
const implementationStart = /^(for |if |return |constant |mutable |let )/;
const memberIdentifier = /\b(value|other)\b/;

export function typeNameFromPath(filePath: string): string {
	const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
	return base.replace(/\.strict$/i, '');
}

export function discoverStrictTests(source: string): DiscoveredMethod[] {
	const lines = source.split(/\r?\n/);
	const methods: Array<DiscoveredMethod & { body: DiscoveredTest[] }> = [];
	let current: (DiscoveredMethod & { body: DiscoveredTest[] }) | undefined;
	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber];
		if (line.length === 0) {
			continue;
		}
		if (line.startsWith('\t') || line.startsWith(' ')) {
			if (!current) {
				continue;
			}
			const stripped = line.replace(/^[\t ]+/, '');
			const indent = line.length - stripped.length;
			if (stripped.length > 0) {
				(indent === 1 ? current.body : current.implementation).push({ expression: stripped, lineNumber });
			}
			continue;
		}
		if (memberPrefix.test(line)) {
			current = undefined;
			continue;
		}
		current = {
			name: methodName(line), header: line, lineNumber, tests: [], implementation: [], body: [],
			runnable: isRunnableHeader(line)
		};
		methods.push(current);
	}
	for (const method of methods) {
		method.tests = inferTests(method.body);
		const testLines = new Set(method.tests.map((test) => test.lineNumber));
		method.implementation = [...method.body.filter((line) => !testLines.has(line.lineNumber)), ...method.implementation]
			.sort((first, second) => first.lineNumber - second.lineNumber);
	}
	return methods.map(({ name, header, lineNumber, tests, implementation, runnable }) => ({
		name, header, lineNumber, tests, implementation, runnable
	}));
}

export function isRunnableHeader(header: string): boolean {
	const rest = header.slice(methodName(header).length);
	if (!rest.startsWith('(')) {
		return true;
	}
	const inside = rest.slice(1, closingBracket(rest)).trim();
	return inside.length === 0 || inside.split(',').every((part) => part.includes('='));
}

export function isSlowHeader(header: string): boolean {
	const rest = header.slice(methodName(header).length);
	return (rest.startsWith('(') ? rest.slice(closingBracket(rest) + 1) : rest).trimStart().startsWith('Slow(');
}

/** Index of the bracket closing the one text starts with, brackets in texts are skipped. */
export function closingBracket(text: string): number {
	let depth = 0;
	let inText = false;
	for (let index = 0; index < text.length; index++) {
		inText = text[index] === '"' ? !inText : inText;
		depth += inText ? 0 : text[index] === '(' ? 1 : text[index] === ')' ? -1 : 0;
		if (depth === 0) {
			return index;
		}
	}
	return text.length;
}

function methodName(header: string): string {
	const match = header.match(/^([^\s(]+)/);
	return match?.[1] ?? header;
}

/** Leading lines before the last one, a `constant` directly followed by a test belongs to the tests like in Strict. */
function inferTests(body: DiscoveredTest[]): DiscoveredTest[] {
	const candidates = body.slice(0, -1);
	const tests: DiscoveredTest[] = [];
	for (const [index, line] of candidates.entries()) {
		const isConstant = line.expression.startsWith('constant ') && isTest(candidates[index + 1]?.expression ?? '');
		if (!isConstant && !isTest(line.expression)) {
			break;
		}
		tests.push(...isConstant ? [] : [line]);
	}
	return tests;
}

// Without type inference, leading lines are classified by syntax; member, parameter and keyword starts are excluded.
export function isTest(expression: string): boolean {
	return !implementationStart.test(expression) && !/^(?!(not|true|false)\b)[a-z]/.test(expression) &&
		!(memberIdentifier.test(expression) && !/\bis\b/.test(expression));
}
