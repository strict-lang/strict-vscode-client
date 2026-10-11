import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	compilerFile,
	findStrictRoot,
	newestExistingFile,
	normalizeFsPath,
	strictDocumentSelector
} from '../../paths';

suite('paths', () => {
	let tempRoot: string;

	setup(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-vscode-'));
	});

	teardown(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	const now = Math.floor(Date.now() / 1000);

	function compilerIn(root: string, secondsAgo: number): string {
		const compiler = path.join(root, compilerFile);
		fs.mkdirSync(path.dirname(compiler), { recursive: true });
		fs.writeFileSync(compiler, '');
		fs.utimesSync(compiler, now - secondsAgo, now - secondsAgo);
		return root;
	}

	test('findStrictRoot uses the newest NativeCompiler of sibling repo and bundled copy', () => {
		const extension = path.join(tempRoot, 'strict-vscode-client');
		const sibling = compilerIn(path.join(tempRoot, 'Strict'), 60);
		const bundled = compilerIn(path.join(extension, 'strict'), 120);
		assert.strictEqual(findStrictRoot(undefined, [], extension), sibling);
		compilerIn(bundled, 0);
		assert.strictEqual(findStrictRoot(undefined, [], extension), bundled);
	});

	test('findStrictRoot prefers the workspace over an equally new bundled copy', () => {
		const extension = path.join(tempRoot, 'extension');
		const workspace = compilerIn(path.join(tempRoot, 'Strict'), 60);
		compilerIn(path.join(extension, 'strict'), 60);
		assert.strictEqual(findStrictRoot(undefined, [workspace], extension), workspace);
	});

	test('findStrictRoot only uses a configured root', () => {
		compilerIn(path.join(tempRoot, 'Strict'), 0);
		const configured = path.join(tempRoot, 'Configured');
		assert.strictEqual(findStrictRoot(configured, [path.join(tempRoot, 'Strict')]), undefined);
		assert.strictEqual(findStrictRoot(compilerIn(configured, 60), [path.join(tempRoot, 'Strict')]), configured);
	});

	test('newestExistingFile picks the later write', () => {
		const older = path.join(tempRoot, 'old.dll');
		const newer = path.join(tempRoot, 'new.dll');
		fs.writeFileSync(older, '');
		const then = Date.now() - 60_000;
		fs.utimesSync(older, then / 1000, then / 1000);
		fs.writeFileSync(newer, '');
		assert.strictEqual(newestExistingFile([older, newer]), newer);
	});

	test('normalizeFsPath matches the same file across slash and case differences', () => {
		assert.strictEqual(
			normalizeFsPath('C:\\repo\\BaseTypesTest.strict'),
			normalizeFsPath('c:/repo/BaseTypesTest.strict')
		);
	});

	test('document selector always includes a scheme', () => {
		assert.ok(strictDocumentSelector.length > 0);
		for (const selector of strictDocumentSelector) {
			assert.ok(selector.scheme, JSON.stringify(selector));
		}
	});
});
