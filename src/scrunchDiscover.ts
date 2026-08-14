export type DiscoveredTest = {
	expression: string;
	lineNumber: number;
};

export type DiscoveredMethod = {
	name: string;
	lineNumber: number;
	tests: DiscoveredTest[];
	implementation: DiscoveredTest[];
};

const memberPrefix = /^(has|constant|mutable|implement)\b/;
const implementationStart = /^(for |if |return |constant |mutable )/;
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
			if (indent === 1 && stripped.length > 0) {
				current.body.push({ expression: stripped, lineNumber });
			}
			continue;
		}
		if (memberPrefix.test(line)) {
			current = undefined;
			continue;
		}
		current = { name: methodName(line), lineNumber, tests: [], implementation: [], body: [] };
		methods.push(current);
	}
	for (const method of methods) {
		method.tests = inferTests(method.body);
		const testLines = new Set(method.tests.map((test) => test.lineNumber));
		method.implementation = method.body.filter((line) => !testLines.has(line.lineNumber));
	}
	return methods.map(({ name, lineNumber, tests, implementation }) => ({
		name, lineNumber, tests, implementation
	}));
}

function methodName(header: string): string {
	const match = header.match(/^([^\s(]+)/);
	return match?.[1] ?? header;
}

function inferTests(body: DiscoveredTest[]): DiscoveredTest[] {
	const tests: DiscoveredTest[] = [];
	for (const line of body) {
		if (implementationStart.test(line.expression) || isImplementationUsingMembers(line.expression)) {
			break;
		}
		tests.push(line);
	}
	return tests;
}

function isImplementationUsingMembers(expression: string): boolean {
	return memberIdentifier.test(expression) && !/\bis\b/.test(expression);
}
