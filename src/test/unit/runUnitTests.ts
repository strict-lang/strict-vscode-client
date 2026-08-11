import * as path from 'path';
import Mocha = require('mocha');
import { glob } from 'glob';

async function main(): Promise<void> {
	const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 10000 });
	const testsRoot = path.resolve(__dirname);
	const files = await glob('**/*.test.js', { cwd: testsRoot });
	for (const file of files) {
		mocha.addFile(path.resolve(testsRoot, file));
	}
	await new Promise<void>((resolve, reject) => {
		mocha.run((failures: number) => {
			if (failures > 0) {
				reject(new Error(`${failures} tests failed.`));
				return;
			}
			resolve();
		});
	});
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
