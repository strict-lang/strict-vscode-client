import * as assert from 'assert';
import * as path from 'path';
import { creations, extractToLet, FileEdit, inlineLet } from '../../refactorings';
import { parseType, scopeAt, StrictType } from '../../strictIndex';
import { list, number, text, vector } from './strictIndex.test';

const shapeLines = [
	'has numbers',
	'constant Limit = 3',
	'Total(factor Number) Number',
	'\tShape((1, 2)).Total(2) is 6',
	'\tlet first = numbers(0)',
	'\tlet second = first * factor',
	'\tlet third = second + numbers(1)',
	'\tthird * third + Limit * 2'
];
const gizmoLines = [
	'has number',
	'Doubled Number',
	'\tGizmo(3).Doubled is 6',
	'\tGizmo(3).Framed("(", ", ") is "(3, "',
	'\tSettings(3, (1, 2), true).Total is 6',
	'\t3.Halved is 1.5',
	'\tnumber * 2'
];
const scope = (own: StrictType, lines: string[], line: number) =>
	scopeAt([own, number, text, list, vector], own, lines, line);
const shape = parseType('C:/Code/Shape.strict', shapeLines.join('\n'));
const gizmo = parseType('C:/Code/Gizmo.strict', gizmoLines.join('\n'));
const applied = (lines: string[], edits: FileEdit[]) => {
	const offset = (line: number, character: number) =>
		lines.slice(0, line).reduce((sum, line) => sum + line.length + 1, 0) + character;
	return edits.map((edit) => ({ ...edit, start: offset(edit.line, edit.character),
		end: offset(edit.endLine ?? edit.line, edit.endCharacter ?? edit.character) })).sort((first, second) =>
		second.start - first.start).reduce((all, edit) => all.slice(0, edit.start) + edit.text + all.slice(edit.end),
		lines.join('\n')).split('\n');
};
const extracted = (line: number, selected: string, from = shapeLines[line].indexOf(selected)) => {
	const refactoring = extractToLet(shapeLines, line, from, from + selected.length, scope(shape, shapeLines, line));
	return refactoring && [refactoring.title, ...applied(shapeLines, refactoring.edits).slice(line, line + 2)];
};
const inlined = (line: number) => {
	const refactoring = inlineLet(shapeLines, line, scope(shape, shapeLines, line));
	return refactoring && [refactoring.title, ...applied(shapeLines, refactoring.edits).slice(4)];
};
const crash = (error: string) => `Strict crashed with exit code 1\n${error}`;

suite('refactorings', () => {
	test('extractToLet declares the selected expression above its line, as constant when it only uses constants', () => {
		assert.deepStrictEqual(extracted(4, 'numbers(0)'),
			['Extract to let number', '\tlet number = numbers(0)', '\tlet first = number']);
		assert.deepStrictEqual(extracted(7, ' Limit * 2'),
			['Extract to constant extracted', '\tconstant extracted = Limit * 2', '\tthird * third + extracted']);
		for (const [line, selected] of [[3, 'Shape((1, 2))'], [4, 'umbers(0)'], [4, 'numbers(0'], [7, '* third'], [2, 'Number']]) {
			assert.strictEqual(extracted(Number(line), String(selected)), undefined, String(selected));
		}
		const again = [...shapeLines.slice(0, 7), '\tconstant extracted = Limit * 2', '\tthird * third + extracted'];
		assert.strictEqual(extractToLet(again, 8, 1, 14, scope(parseType(shape.file, again.join('\n')), again, 8))?.title,
			'Extract to let extracted2');
	});

	test('inlineLet replaces the only later use with the value, bracketed inside other expressions', () => {
		assert.deepStrictEqual(inlined(4), ['Inline first', '\tlet second = numbers(0) * factor',
			'\tlet third = second + numbers(1)', '\tthird * third + Limit * 2']);
		assert.deepStrictEqual(inlined(5), ['Inline second', '\tlet first = numbers(0)',
			'\tlet third = (first * factor) + numbers(1)', '\tthird * third + Limit * 2']);
		assert.strictEqual(inlined(6), undefined);
		assert.strictEqual(inlined(7), undefined);
		const loops = ['has numbers', 'Count Number', '\tLoops((1)).Count is 1', '\tfor numbers', '\t\tlet doubled = value * 2',
			'\t\tfor 2', '\t\t\tdoubled', '\t1'];
		const own = parseType('C:/Code/Loops.strict', loops.join('\n'));
		assert.strictEqual(inlineLet(loops, 4, scopeAt([own, list, number, text, vector], own, loops, 4)), undefined);
	});

	test('creations add the missing method with the test line to the type it was called on', () => {
		const read = (file: string) => file === number.file ? 'has iterator' : gizmoLines.join('\n');
		const created = (line: number, error: string) => creations(crash(error), gizmo.file, gizmoLines, line,
			scope(gizmo, gizmoLines, line), read).map((creation) => [creation.title, ...creation.edits.map((edit) =>
			[edit.file, edit.line, edit.character, edit.text])]);
		assert.deepStrictEqual(created(3, 'MethodNotFound: Gizmo.Framed used in C:/Code/Gizmo.strict:4'), [
			['Create method Framed in Gizmo', [gizmo.file, 6, 11,
				'\nFramed(first Text, second Text) Text\n\tGizmo(3).Framed("(", ", ") is "(3, "']]]);
		assert.deepStrictEqual(created(5, 'MethodNotFound: Number.Halved used in C:/Code/Gizmo.strict:6'), [
			['Create method Halved in Number', [number.file, 0, 12, '\nHalved Number\n\t3.Halved is 1.5']]]);
		assert.deepStrictEqual(created(3, 'MethodNotFound: Gizmo.Framed used in C:/Code/Other.strict:4'), []);
		assert.deepStrictEqual(created(2, 'MethodNotFound: Gizmo.Framed used in C:/Code/Gizmo.strict:4'), []);
	});

	test('creations add an unknown type next to the file with members from the constructor arguments', () => {
		const settings = path.join('C:/Code', 'Settings.strict');
		const [type, method] = creations(crash(`TypeNotFound: Settings used in C:/Code/Gizmo.strict:5 is not in this folder`),
			gizmo.file, gizmoLines, 4, scope(gizmo, gizmoLines, 4), () => gizmoLines.join('\n'));
		assert.deepStrictEqual([type.title, type.newFile, type.edits], ['Create type Settings', settings,
			[{ file: settings, line: 0, character: 0, text: 'has number\nhas numbers\nhas boolean' }]]);
		assert.deepStrictEqual([method.title, method.edits[0].text], ['Create method Settings in Gizmo',
			'\nSettings(first Number, numbers Numbers, boolean Boolean)\n\tSettings(3, (1, 2), true).Total is 6']);
	});
});
