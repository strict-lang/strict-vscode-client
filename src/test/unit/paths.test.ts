import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildRunFileArgs,
	candidateFiles,
	findOnPath,
	launchFromPath,
	resolveLanguageServerLaunch,
	resolveStrictCliLaunch
} from '../../paths';

suite('paths', () => {
	let tempRoot: string;

	setup(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-vscode-'));
	});

	teardown(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	test('launchFromPath uses dotnet for dll', () => {
		const dllPath = path.join(tempRoot, 'Strict.LanguageServer.dll');
		fs.writeFileSync(dllPath, '');
		const launch = launchFromPath(dllPath, 'dotnet');
		assert.ok(launch);
		assert.strictEqual(launch!.command, 'dotnet');
		assert.deepStrictEqual(launch!.args, [path.resolve(dllPath)]);
	});

	test('resolveLanguageServerLaunch finds sibling Debug build', () => {
		const dllDir = path.join(
			tempRoot,
			'Strict',
			'Strict.LanguageServer',
			'bin',
			'Debug',
			'net10.0'
		);
		fs.mkdirSync(dllDir, { recursive: true });
		const dllPath = path.join(dllDir, 'Strict.LanguageServer.dll');
		fs.writeFileSync(dllPath, '');
		const workspace = path.join(tempRoot, 'strict-vscode-client');
		fs.mkdirSync(workspace, { recursive: true });
		const launch = resolveLanguageServerLaunch({
			workspaceFolders: [workspace],
			dotnetPath: 'dotnet'
		});
		assert.ok(launch);
		assert.strictEqual(launch!.command, 'dotnet');
		assert.strictEqual(path.basename(launch!.args[0]), 'Strict.LanguageServer.dll');
	});

	test('resolveStrictCliLaunch prefers configured path', () => {
		const configured = path.join(tempRoot, 'Strict.dll');
		fs.writeFileSync(configured, '');
		const launch = resolveStrictCliLaunch({
			configuredPath: configured,
			workspaceFolders: [tempRoot]
		});
		assert.ok(launch);
		assert.deepStrictEqual(launch!.args, [path.resolve(configured)]);
	});

	test('buildRunFileArgs appends file path', () => {
		const result = buildRunFileArgs(
			{ command: 'dotnet', args: ['Strict.dll'], displayName: 'Strict.dll' },
			'Sum.strict',
			['1', '2']
		);
		assert.deepStrictEqual(result, {
			command: 'dotnet',
			args: ['Strict.dll', 'Sum.strict', '1', '2']
		});
	});

	test('candidateFiles joins roots and relative paths', () => {
		const files = candidateFiles(['A', 'B'], ['x.dll']);
		assert.strictEqual(files.length, 2);
		assert.ok(files[0].endsWith('x.dll'));
	});

	test('findOnPath locates executable', () => {
		const bin = path.join(tempRoot, 'bin');
		fs.mkdirSync(bin);
		const exeName = process.platform === 'win32' ? 'Strict.LanguageServer.CMD' : 'Strict.LanguageServer';
		const exePath = path.join(bin, exeName);
		fs.writeFileSync(exePath, '');
		const found = findOnPath(['Strict.LanguageServer'], bin);
		assert.ok(found);
		assert.strictEqual(path.normalize(found!), path.normalize(exePath));
	});
});
