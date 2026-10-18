import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { implementationCandidates, passingBodies } from '../../implementations';
import { findStrictRoot } from '../../paths';
import { parseType } from '../../strictIndex';

suite('selected method suggestions', () => {
	test('Doubled reuses its operand and verifies both tests with the supported compiler', async () => {
		const root = findStrictRoot(process.env.STRICT_ROOT, [], process.cwd());
		assert.ok(root, 'Strict compiler required');
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-suggest-'));
		const file = path.join(folder, 'Suggesting.strict');
		const source = 'has number\nDoubled Number\n\tSuggesting(3).Doubled is 6\n\tSuggesting(0).Doubled is 0\n';
		try {
			fs.writeFileSync(file, source);
			const own = parseType(file, source);
			const numberFile = path.join(root, 'Number.strict');
			const candidates = implementationCandidates(own.methods[0], own,
				[own, parseType(numberFile, fs.readFileSync(numberFile, 'utf8'))]);
			assert.ok(candidates.includes('number + number'), candidates.join('\n'));
			assert.ok(!candidates.some((body) => /\.(Epsilon|E|Pi|Phi)\b/.test(body)), candidates.join('\n'));
			const passing = await passingBodies(root, folder, file, source, own.methods[0], candidates);
			assert.ok(passing.includes('number + number'), passing.join('\n'));
			assert.ok(!passing.includes('number'), passing.join('\n'));
			assert.strictEqual(fs.readFileSync(file, 'utf8'), source);
			assert.deepStrictEqual(fs.readdirSync(folder), ['Suggesting.strict']);
		} finally {
			fs.rmSync(folder, { recursive: true, force: true });
		}
	});
});
