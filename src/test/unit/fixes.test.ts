import * as assert from 'assert';
import { formatDiagnosticMessage } from '../../diagnosticMessages';
import { Fix, issueTarget, renamedPositions, ruleFix, safeFixes, typeFixes } from '../../fixes';
import { parseType } from '../../strictIndex';
import { list, number, text, vector } from './strictIndex.test';

const rules = ['has total = 17 + 4', 'Add(first Number) Number', '\tRules(1).Add(1) is 23', '\tlet five = 5',
	'    mutable count = first', '\tlet unused = first + 1', '    first + count + five + total'];
const edited = (fix: Fix | undefined) => fix?.edits.map((edit) => [...edit.range, edit.text]);

suite('fixes', () => {
	test('ruleFix makes a let or has a constant, a never changed mutable a let and indents with tabs, only where it is named', () => {
		const fixed = (rule: string, line: number, target: string) => ruleFix(rule, rules, line, target)?.edits[0].text;
		assert.strictEqual(fixed('UseConstantHere', 3, issueTarget(formatDiagnosticMessage('UseConstantHere', 'five'))),
			'\tconstant five = 5');
		assert.strictEqual(fixed('UseConstantHere', 0, 'total'), 'constant total = 17 + 4');
		assert.strictEqual(fixed('VariableDeclaredAsMutableButValueNeverChanged', 4, 'count'), '    let count = first');
		assert.strictEqual(fixed('ExtraWhitespacesFoundAtBeginningOfLine', 6, 'indent with tabs'), '\tfirst + count + five + total');
		assert.strictEqual(fixed('UseConstantHere', 4, 'five'), undefined);
		assert.strictEqual(fixed('EmptyLineIsNotAllowed', 4, ''), undefined);
	});

	test('safeFixes only make a let a constant and a never changed mutable a let, members and indentation stay', () => {
		assert.deepStrictEqual(safeFixes(rules, [
			{ rule: 'VariableDeclaredAsMutableButValueNeverChanged', line: 4, target: 'count' },
			{ rule: 'ExtraWhitespacesFoundAtBeginningOfLine', line: 4, target: 'indent with tabs' },
			{ rule: 'UseConstantHere', line: 3, target: 'five' },
			{ rule: 'UseConstantHere', line: 0, target: 'total' },
			{ rule: 'UnusedMethodVariableMustBeRemoved', line: 5, target: 'unused' }
		]).map((edit) => [...edit.range, edit.text]), [[4, 0, 4, 25, '    let count = first'], [3, 0, 3, 13, '\tconstant five = 5']]);
	});

	test('ruleFix removes unused variables and members with their line, a parameter only when no call passes it', () => {
		assert.deepStrictEqual(edited(ruleFix('UnusedMethodVariableMustBeRemoved', rules, 5, 'unused')), [[5, 0, 6, 0, '']]);
		assert.deepStrictEqual(edited(ruleFix('UnusedMemberMustBeRemoved', rules, 0, 'total')), [[0, 0, 1, 0, '']]);
		assert.strictEqual(ruleFix('UnusedMemberMustBeRemoved', rules, 1, 'total'), undefined);
		assert.deepStrictEqual(edited(ruleFix('EmptyLineInsideMethod', ['Twice Number', '\tA.Twice is 2', '\t', '\t2'], 2,
			'Twice in ./A.strict:3')), [[2, 0, 3, 0, '']]);
		const header = (lines: string[], name: string) => ruleFix('UnusedMethodParameterMustBeRemoved', lines, 0, name)?.edits[0].text;
		assert.strictEqual(header(['Optional(start Number, extra = (1, 2)) Number', '\tRules(1).Optional(1) is 1', '\tstart'], 'extra'),
			'Optional(start Number) Number');
		assert.strictEqual(header(['Halve(number Number) Number', '\tRules(4).Halve is 2', '\tsize / 2'], 'number'), 'Halve Number');
		assert.strictEqual(header(['Add(first Number, second Number) Number', '\tRules(1).Add(1, 2) is 1', '\tfirst'], 'second'),
			undefined);
	});

	test('renamedPositions are the whole words of a parameter or local in its method, of a member in the file', () => {
		const lines = ['has count Number', 'Add(amount Number) Number', '\tRules(1).Add(2) is 3', '\tlet total = amount + count',
			'\ttotal', 'Twice Number', '\tRules(1).Twice is 2', '\tlogger.Log("count" + amount)', '\tcount * 2'];
		assert.deepStrictEqual(renamedPositions(lines, 1, 'amount'), [[1, 4], [3, 13]]);
		assert.deepStrictEqual(renamedPositions(lines, 4, 'total'), [[3, 5], [4, 1]]);
		assert.deepStrictEqual(renamedPositions(lines, 0, 'count'), [[0, 4], [3, 22], [8, 1]]);
	});

	test('ruleFix renames a list prefixed name to the plural of its list type, other names are renamed by the user', () => {
		const lines = ['has listNumbers List(Number)', 'ListSum(listValues Texts) Number', '\tLists((1), ("a")).ListSum(("b")) is 6',
			'\tlistValues.Length + listNumbers.Sum', 'Count Number', '\tLists((1), ("a")).Count is 1', '\tlistNumbers.Length'];
		const rule = 'ListPrefixIsNotAllowedUseImplementationTypeNameInPlural';
		const member = ruleFix(rule, lines, 0, 'listNumbers');
		assert.strictEqual(member?.title, 'Rename listNumbers to numbers');
		assert.deepStrictEqual(edited(member), [[0, 4, 0, 28, 'numbers'], [3, 21, 3, 32, 'numbers'], [6, 1, 6, 12, 'numbers']]);
		assert.deepStrictEqual(edited(ruleFix(rule, lines, 1, 'listValues')), [[1, 8, 1, 24, 'texts'], [3, 1, 3, 11, 'texts']]);
		assert.deepStrictEqual(ruleFix(rule, lines, 1, 'ListSum')?.rename, [1, 0]);
		assert.deepStrictEqual(ruleFix('ParameterHidesMemberUseDifferentName', ['has value', 'Add(value Number) Number'], 1, 'value')
			?.rename, [1, 4]);
	});

	test('typeFixes change a name Strict did not find to the 3 closest types, names in scope or members of its receiver', () => {
		const lines = ['has numbr', 'Scaled(factor Number) Number', '\tShop(2).Scaled(3) is 6', '\tnumbr.Clampp(0, factr) + numbr'];
		const shop = parseType('C:/Code/Shop.strict', lines.join('\n'));
		const changes = (message: string, line: number) => typeFixes(message, undefined, lines, line, () =>
			({ own: shop, types: [shop, number, text, list, vector] })).map((fix) => [fix.title, ...fix.edits.map((edit) =>
			edit.range.join(' '))]);
		assert.deepStrictEqual(changes('Strict crashed with exit code 1\nTypeNotFound: Numbr used in C:/Code/Shop.strict:1 is not in ' +
			'this folder', 0), [['Change to number', '0 4 0 9', '3 1 3 6', '3 26 3 31']]);
		assert.deepStrictEqual(changes('NameNotFound: factr used in ./Shop.strict:4', 3), [['Change to factor', '3 17 3 22']]);
		assert.deepStrictEqual(changes('MethodNotFound: Number.Clampp used in ./Shop.strict:4', 3), [['Change to Clamp', '3 7 3 13']]);
		assert.deepStrictEqual(changes('NameNotFound: factr used in ./Other.strict:4', 3), []);
		const printer = parseType('C:/Code/Printer.strict', ['has count', 'has cot', 'has out', 'has court', 'has total'].join('\n'));
		assert.deepStrictEqual(typeFixes('NameNotFound: cout used in Printer.strict:1', undefined, ['\tcout'], 0, () =>
			({ own: printer, types: [printer] })).map((fix) => fix.title), ['Change to count', 'Change to cot', 'Change to out']);
	});

	test('typeFixes use the method strict check reports as copied, called like copiedFrom calls it', () => {
		const body = ['\tlet squared = number * number * factor', '\tsquared * squared / factor / factor'];
		const beta = parseType('C:/Code/Beta.strict', ['has number', 'SquareTwice(factor Number) Number',
			'\tBeta(2).SquareTwice(3) is 16', ...body].join('\n'));
		const lines = ['has number', 'SquareTwice(factor Number) Number', '\tAlpha(2).SquareTwice(3) is 16', ...body];
		const alpha = parseType('C:/Code/Alpha.strict', lines.join('\n'));
		const use = [['Use Beta(number).SquareTwice(factor)', 3, 0, 4, 36, '\tBeta(number).SquareTwice(factor)']];
		assert.deepStrictEqual(typeFixes(formatDiagnosticMessage('MethodAlreadyExists', 'Beta.SquareTwice'), 'MethodAlreadyExists',
			lines, 1, () => ({ own: alpha, types: [alpha, beta, number] })).map((fix) => [fix.title, ...edited(fix)![0]]), use);
		const verified = ruleFix('MethodAlreadyExists', lines, 1, issueTarget('Beta.SquareTwice already exists: ' +
			'`Beta(number).SquareTwice(factor)` passes the test of SquareTwice, use it instead'));
		assert.deepStrictEqual([verified?.title, ...edited(verified)![0]], use[0]);
	});
});
