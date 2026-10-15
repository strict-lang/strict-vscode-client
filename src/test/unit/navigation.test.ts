import * as assert from 'assert';
import {
	callers, calls, Edit, Hit, implementationsOf, nameError, references, renameEdits, Target, targetAt, typeAt
} from '../../navigationModel';
import { typeNameFromPath } from '../../scrunchDiscover';
import { parseType } from '../../strictIndex';

const sources = [
	['C:/Strict/Number.strict', 'has iterator', 'constant Epsilon = 0.00001', 'Clamp(minimum = 0, maximum = 1) Number',
		'\t1.7.Clamp(0.5, 1.5) is 1.5', '\tvalue > maximum then maximum else value < minimum then minimum else value',
		'Absolute Number', '\t-1.Absolute is 1', '\tvalue < 0 then -value else value'],
	['C:/Strict/Text.strict', 'has characters', 'Length Number', '\t"ab".Length is 2', '\tcharacters.Length'],
	['C:/Strict/List.strict', 'has iterator', 'has elements Generics', 'Length Number', '\t(1, 2).Length is 2', '\t2',
		'in(element Generic) Boolean', '\t2 is in (1, 2)', '\telements.Contains(element)'],
	['C:/Strict/Iterator.strict', 'has length', 'for Iterator(Generic)', 'in(element Generic) Boolean'],
	['C:/Strict/Logger.strict', 'has textWriter', 'Log(text)', '\ttextWriter.Write(text)'],
	['C:/Code/Temperature.strict', 'has celsius Number', 'has logger', 'Limited(low Number, high Number) Number',
		'\tTemperature(30).Limited(0, 20) is 20', '\tlet clamped = celsius.Clamp(low, high)', '\tlogger.Log("Clamp " + clamped)',
		'\t(clamped - low).Absolute + low'],
	['C:/Code/Cell.strict', 'has color Number', 'Brightness Number', '\tCell(5).Brightness is 5', '\tcolor'],
	['C:/Code/Board.strict', 'has cells', 'has origin Code/Cell', 'Paint(cell) Cells',
		'\tBoard(List(Cell)).Paint(Cell(2)) is (Cell(2))', '\tmutable painted = List(Mutable(Cell))',
		'\tcells + painted + cell + "Cell"'],
	['C:/Code/Game.strict', 'has board', 'Count Number', '\tGame(Board(List(Cell))).Count is 0', '\tboard.cells.Length',
		'Total Number', '\tGame(Board(List(Cell))).Total is 1', '\tfor board.cells', '\t\t1']
].map(([file, ...lines]) => ({ file, text: lines.join('\n') }));
const types = sources.map((source) => parseType(source.file, source.text));
const [number, text, , iterator, , temperature, cell] = types;
const source = (name: string) => sources.find((candidate) => typeNameFromPath(candidate.file) === name)!;
const target = (name: string, line: number, character: number) => targetAt(source(name), types, line, character);
const at = (hits: Array<{ file: string; line: number; character?: number }>) =>
	hits.map((hit) => [typeNameFromPath(hit.file), hit.line, hit.character].filter((part) => part !== undefined).join(':'));
const renamed = (edits: Edit[], name: string) => source(name).text.split('\n').map((line, index) => edits.filter((edit) =>
	edit.file === source(name).file && edit.line === index).sort((first, second) => second.character - first.character)
	.reduce((result, edit) => result.slice(0, edit.character) + edit.text + result.slice(edit.character + edit.length), line));
const rename = (renamedTarget: Target, name: string) =>
	renameEdits(renamedTarget, name, references(renamedTarget, sources, types));

suite('navigation', () => {
	test('targetAt takes parameters and locals also where declared, members through receivers, types also from plurals', () => {
		const describe = (found?: Target) => found && `${found.owner.name}.${found.name}${found.method ? ` in ${found.method.name}`
			: ''}${found.isType ? ' type' : ''}`;
		assert.deepStrictEqual([target('Temperature', 2, 9), target('Temperature', 4, 6), target('Temperature', 4, 25),
			target('Temperature', 6, 20), target('Temperature', 1, 5), target('Game', 6, 6), target('Board', 2, 13),
			target('Iterator', 2, 0), target('Temperature', 5, 15)].map(describe), ['Temperature.low in Limited',
			'Temperature.clamped in Limited', 'Number.Clamp', 'Number.Absolute', 'Temperature.logger', 'Game.board', 'Cell.Cell type',
			'Iterator.in', undefined]);
	});

	test('a local is renamed from its declaration on, never to the name of another local', () => {
		const counter = { file: 'C:/Code/Counter.strict', text: ['has count Number', 'Next Number', '\tCounter(1).Next is 3',
			'\tlet doubled = count * 2', '\tlet count = doubled + 1', '\tlet other = 2', '\tcount + other'].join('\n') };
		const all = [...types, parseType(counter.file, counter.text)];
		const local = targetAt(counter, all, 4, 6)!;
		assert.deepStrictEqual(at(references(local, [...sources, counter], all)), ['Counter:4:5', 'Counter:6:1']);
		assert.strictEqual(nameError(local, 'other', all), 'other already exists');
	});

	test('references of a method are its declaration and the calls on its type, literals included, texts left out', () => {
		const referenced = (owner: typeof number, name: string) => at(references({ name, owner }, sources, types));
		assert.deepStrictEqual(referenced(number, 'Clamp'), ['Number:2:0', 'Number:3:5', 'Temperature:4:23']);
		assert.deepStrictEqual(referenced(number, 'Absolute'), ['Number:5:0', 'Number:6:4', 'Temperature:6:17']);
		assert.deepStrictEqual(referenced(text, 'Length'), ['Text:1:0', 'Text:2:6']);
	});

	test('references of a parameter stay inside its method', () => {
		assert.deepStrictEqual(at(references(target('Temperature', 2, 9)!, sources, types)),
			['Temperature:2:8', 'Temperature:4:29', 'Temperature:6:12', 'Temperature:6:28']);
	});

	test('renaming a type renames plurals, generic and package uses and the members and parameters named after it', () => {
		const edits = rename({ name: 'Cell', owner: cell, isType: true }, 'Tile');
		assert.deepStrictEqual(renamed(edits, 'Cell')[2], '\tTile(5).Brightness is 5');
		assert.deepStrictEqual(renamed(edits, 'Board'), ['has tiles', 'has origin Code/Tile', 'Paint(tile) Tiles',
			'\tBoard(List(Tile)).Paint(Tile(2)) is (Tile(2))', '\tmutable painted = List(Mutable(Tile))',
			'\ttiles + painted + tile + "Cell"']);
		assert.deepStrictEqual(renamed(edits, 'Game').slice(2, 4), ['\tGame(Board(List(Tile))).Count is 0',
			'\tboard.tiles.Length']);
	});

	test('renaming an implicitly typed member or parameter writes out the type it had', () => {
		const member = rename(target('Temperature', 1, 5)!, 'output');
		assert.deepStrictEqual([renamed(member, 'Temperature')[1], renamed(member, 'Temperature')[5]],
			['has output Logger', '\toutput.Log("Clamp " + clamped)']);
		const parameter = rename(target('Board', 2, 7)!, 'tile');
		assert.deepStrictEqual([renamed(parameter, 'Board')[2], renamed(parameter, 'Board')[5]],
			['Paint(tile Cell) Cells', '\tcells + painted + tile + "Cell"']);
	});

	test('nameError rejects keywords, value, too short or long names, lower case types and taken names', () => {
		const type: Target = { name: 'Cell', owner: cell, isType: true };
		assert.deepStrictEqual(['Tile', 'tile', 'Board', 'X', 'is', 'value', 'Ti_le', 'T'.repeat(51)].map((name) =>
			nameError(type, name, types) === undefined), [true, false, false, false, false, false, false, false]);
		assert.deepStrictEqual(['output', 'celsius'].map((name) =>
			nameError({ name: 'logger', owner: temperature }, name, types) === undefined), [true, false]);
	});

	test('typeAt is the type of the expression before the cursor, lists give their element type', () => {
		assert.deepStrictEqual([typeAt(source('Temperature'), types, 2, 11), typeAt(source('Temperature'), types, 6, 9),
			typeAt(source('Temperature'), types, 4, 28), typeAt(source('Temperature'), types, 5, 7),
			typeAt(source('Board'), types, 0, 9)].map((type) => type?.name), ['Number', 'Number', 'Number', 'Logger', 'Cell']);
	});

	test('implementationsOf a trait are the types having it, of a trait method their methods of that name', () => {
		const implemented = (implementedTarget: Target) => at(implementationsOf(implementedTarget, types));
		assert.deepStrictEqual(implemented({ name: 'Iterator', owner: iterator, isType: true }), ['Number:0', 'List:0']);
		assert.deepStrictEqual(implemented({ name: 'iterator', owner: number }), ['Number:0', 'List:0']);
		assert.deepStrictEqual(implemented(target('Iterator', 2, 0)!), ['List:5']);
		assert.deepStrictEqual(implemented({ name: 'Number', owner: number, isType: true }), []);
	});

	test('callers group the references by calling method, tests apart, calls are the methods an implementation calls', () => {
		const groups = callers(references({ name: 'Clamp', owner: number }, sources, types));
		assert.deepStrictEqual(groups.map((group: Hit[]) => `${typeNameFromPath(group[0].file)}.${group[0].method?.name}${
			group[0].isTest ? ' test' : ''}`), ['Number.Clamp test', 'Temperature.Limited']);
		assert.deepStrictEqual(calls(source('Temperature'), 2, types).map((call) => `${call.entry.owner.name}.${call.entry.name}`),
			['Number.Clamp', 'Logger.Log', 'Number.Absolute']);
	});
});
