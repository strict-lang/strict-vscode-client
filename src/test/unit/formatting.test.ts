import * as assert from 'assert';
import { formatted, printed } from '../../formatting';

suite('formatting', () => {
	test('formatted indents with tabs, removes trailing whitespace and blank lines in methods and at the end', () => {
		assert.strictEqual(formatted(['has number', ' \t', 'Doubled Number  ', '    Gizmo(3).Doubled is 6', '', '\t  ',
			'  \t"a  b" + number ', '', '\t'].join('\n')),
		['has number', '', 'Doubled Number', '\tGizmo(3).Doubled is 6', '\t"a  b" + number'].join('\n'));
		assert.strictEqual(formatted('has number\n\t\n\n'), 'has number\n');
	});

	test('formatted keeps the nesting of files indented with 2 spaces, a stray space before a member is no tab', () => {
		assert.strictEqual(formatted([' has numbers', 'Sum Number', '  Loop.Sum is 0', '  mutable total = 0', '  for numbers',
			'    total = total + value', '  total'].join('\n')), ['has numbers', 'Sum Number', '\tLoop.Sum is 0',
			'\tmutable total = 0', '\tfor numbers', '\t\ttotal = total + value', '\ttotal'].join('\n'));
	});

	test('printed is what strict format printed without the line break ending the print, in the line endings of the source', () => {
		assert.strictEqual(printed('has number\r\nRun\r\n\tnumber + 1\r\n', 'has number\nRun\n\tnumber+1'),
			'has number\nRun\n\tnumber + 1');
		assert.strictEqual(printed('has number\n\n', 'has number\r\n'), 'has number\r\n');
	});

	test('printed is nothing when strict format changed more than whitespace and brackets, it may drop unparsable words', () => {
		assert.strictEqual(printed('Run\n\tif (number > 0)\n', 'Run\n\tif number > 0'), 'Run\n\tif (number > 0)');
		assert.strictEqual(printed('Run\n\tTODO(this)\n', 'Run\n\tTODO fix this later'), undefined);
		assert.strictEqual(printed('\n', '\thas number\n\tRun\n\t\tnumber'), undefined);
	});

	test('formatted only changes the lines of the range and keeps the line endings', () => {
		assert.strictEqual(formatted('Doubled Number\r\n  1 is 1  \r\n\r\n\t2 ', 1, 2), 'Doubled Number\r\n\t1 is 1\r\n\t2 ');
	});
});
