// Finds strict like the extension does (newest Strict repository like ../Strict, else the first on PATH) and prints its
// version. `bun strict.mjs package` also packages the .vsix with a copy of it and the base .strict types in strict/, so
// the installed extension works without a Strict repository. strict/ only exists while packaging.
import { execFileSync } from 'child_process';
import { cpSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { compilerFile, findStrictRoot, strictNotFound } from './out/paths.js';

const packaging = process.argv[2] === 'package';
rmSync('strict', { recursive: true, force: true });
const root = findStrictRoot(process.env.STRICT_ROOT, [], process.cwd());
if (!root) {
	console.error(`${strictNotFound}, or set STRICT_ROOT`);
	process.exit(packaging ? 1 : 0);
}
const compiler = join(root, compilerFile);
console.log(`${packaging ? 'Bundling' : 'Using'} ${compiler} ${execFileSync(compiler, ['version'], { encoding: 'utf8' }).trim()}`);
if (packaging) {
	for (const file of [compilerFile, ...readdirSync(root).filter((name) => name.endsWith('.strict'))]) {
		cpSync(join(root, file), join('strict', file));
	}
	try {
		const { createVSIX } = await import('@vscode/vsce');
		await createVSIX({ dependencies: false, target: `${process.platform}-${process.arch}` });
	} finally {
		rmSync('strict', { recursive: true, force: true });
	}
}
