// Packages the .vsix with a copy of the native Strict compiler and the base .strict types in strict/, so the installed
// extension works without a Strict repository. strict/ only exists while packaging, development always uses ../Strict.
import { createVSIX } from '@vscode/vsce';
import { execFileSync } from 'child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

const source = process.env.STRICT_ROOT ?? '../Strict';
const compiler = process.platform === 'win32' ? 'strict.exe' : 'strict';
if (!existsSync(join(source, compiler))) {
	console.error(`package-vsix: ${join(source, compiler)} not found, build it or set STRICT_ROOT`);
	process.exit(1);
}
console.log(`package-vsix: bundling ${join(source, compiler)} ${execFileSync(join(source, compiler), ['version'], { encoding: 'utf8' }).trim()}`);
for (const file of [compiler, ...readdirSync(source).filter((name) => name.endsWith('.strict'))]) {
	cpSync(join(source, file), join('strict', file));
}
try {
	await createVSIX({ dependencies: false, target: `${process.platform}-${process.arch}` });
} finally {
	rmSync('strict', { recursive: true, force: true });
}
