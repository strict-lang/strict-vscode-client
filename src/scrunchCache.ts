export const strictBinaryExtension = '.strictbinary';

export function isStrictBinaryPath(filePath: string): boolean {
	return filePath.toLowerCase().endsWith(strictBinaryExtension);
}

export function siblingBinaryPath(strictPath: string): string {
	return strictPath.replace(/\.strict$/i, strictBinaryExtension);
}

export function isCacheFresh(sourceMtimeMs: number, binaryMtimeMs: number | undefined): boolean {
	return binaryMtimeMs !== undefined && binaryMtimeMs >= sourceMtimeMs;
}
