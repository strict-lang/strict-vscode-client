import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export function isStrictBinaryPath(filePath: string): boolean {
	return filePath.toLowerCase().endsWith('.strictbinary');
}

/** Read only the first ZIP entry (native source manifest), never the bytecode payload. Unknown formats miss cache. */
export function cachedInputs(file: string, cwd: string, compiler: string): string | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(file.replace(/\.strict$/, '.strictbinary'), 'r');
		const header = Buffer.alloc(30);
		if (fs.readSync(descriptor, header, 0, 30, 0) !== 30 || header.readUInt32LE(0) !== 0x04034b50 ||
			header.readUInt16LE(8) !== 0 || (header.readUInt16LE(6) & 8)) { return undefined; }
		const size = header.readUInt32LE(18), nameSize = header.readUInt16LE(26), extra = header.readUInt16LE(28);
		if (size > 8 * 1024 * 1024 || nameSize !== 7) { return undefined; }
		const entry = Buffer.alloc(nameSize + extra + size);
		if (fs.readSync(descriptor, entry, 0, entry.length, 30) !== entry.length || entry.subarray(0, 7).toString() !== 'sources') {
			return undefined;
		}
		const data = entry.subarray(nameSize + extra), integers: number[] = [];
		let number = 0, scale = 1;
		for (const byte of data) {
			number += (byte % 128) * scale;
			if (!Number.isSafeInteger(number) || scale > 2 ** 49) { return undefined; }
			if (byte < 128) { integers.push(number); number = 0; scale = 1; } else { scale *= 128; }
		}
		if (scale !== 1) { return undefined; }
		const start = 1 + integers[0], count = integers[1];
		if (!count || integers[start] !== 4 || integers.length !== start + 1 + count) { return undefined; }
		let position = 2;
		for (let index = 0; index < count; index++) {
			const length = integers[position++];
			if (!Number.isInteger(length) || length < 1 || position + length > start) { return undefined; }
			const name = String.fromCodePoint(...integers.slice(position, position + length));
			position += length;
			let modified = 0;
			try { modified = Math.floor(fs.statSync(path.resolve(cwd, name)).mtimeMs); } catch { /* Native File.Modified returns zero for missing inputs. */ }
			if (modified !== integers[start + 1 + index]) { return undefined; }
		}
		if (position !== start) { return undefined; }
		return createHash('sha256').update(data).update(compiler).update(String(fs.statSync(compiler).mtimeMs)).digest('hex');
	} catch { return undefined; } finally { if (descriptor !== undefined) { fs.closeSync(descriptor); } }
}

/** Failed runs have no native success cache; conservatively watch project inputs until the next passing run. */
export function failedInputs(project: string, root: string): string {
	const hash = createHash('sha256');
	const visit = (folder: string): void => {
		for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const file = path.join(folder, entry.name);
			if (entry.isDirectory()) {
				if (/^[A-Z]/.test(entry.name) && !['Release', 'Debug', 'Tools', 'Backup'].includes(entry.name)) { visit(file); }
			} else if (!/\.(strictbinary|exe|test|o|obj|ptx|log|wasm|data|html|js)$/i.test(entry.name)) {
				const stat = fs.statSync(file); hash.update(file).update(`${stat.mtimeMs}:${stat.size}`);
			}
		}
	};
	visit(project); if (project !== root) { visit(root); }
	hash.update(String(fs.statSync(path.join(root, process.platform === 'win32' ? 'strict.exe' : 'strict')).mtimeMs));
	return hash.digest('hex');
}
