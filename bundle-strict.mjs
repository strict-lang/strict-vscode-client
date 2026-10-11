// Copies the native Strict compiler and the base .strict types into strict/ so the packaged extension needs no Strict
// repository and no .NET. The copy is stamped 1 s older than its source (copies round mtimes up), so the repository
// NativeCompiler wins at runtime unless it is really older than the bundled one.
import { cpSync, existsSync, readdirSync, rmSync, statSync, utimesSync } from 'fs';
import { join } from 'path';

const source = process.env.STRICT_ROOT ?? '../Strict';
const compiler = join('Compiler', process.platform === 'win32' ? 'NativeCompiler.exe' : 'NativeCompiler');
if (!existsSync(join(source, compiler))) {
	console.warn(`bundle-strict: no ${join(source, compiler)}, keeping the previously bundled Strict`);
	process.exit(0);
}
rmSync('strict', { recursive: true, force: true });
for (const file of [compiler, ...readdirSync(source).filter((name) => name.endsWith('.strict'))]) {
	cpSync(join(source, file), join('strict', file));
}
const built = statSync(join(source, compiler));
utimesSync(join('strict', compiler), built.atime, (built.mtimeMs - 1000) / 1000);
console.log(`bundle-strict: copied ${compiler} and the base types from ${source}`);
