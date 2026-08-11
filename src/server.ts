import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { connect, Socket } from 'net';
import { OutputChannel } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, StreamInfo } from 'vscode-languageclient/node';
import { languageServerPipePath, LaunchTarget } from './paths';

export type ServerHandles = {
	client: LanguageClient;
	stop: () => Promise<void>;
};

function connectToPipe(pipePath: string, timeoutMs: number, intervalMs: number): Promise<Socket> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const socket = connect(pipePath);
			let settled = false;
			socket.once('connect', () => {
				settled = true;
				resolve(socket);
			});
			socket.once('error', () => {
				socket.destroy();
				if (settled) {
					return;
				}
				if (Date.now() >= deadline) {
					reject(new Error(`Timed out connecting to Strict language server pipe at ${pipePath}`));
					return;
				}
				setTimeout(attempt, intervalMs);
			});
		};
		attempt();
	});
}

function startProcess(launch: LaunchTarget, output: OutputChannel): ChildProcessWithoutNullStreams {
	output.appendLine(`Starting language server: ${launch.command} ${launch.args.join(' ')}`);
	const child = spawn(launch.command, launch.args, {
		cwd: launch.cwd,
		windowsHide: true,
		env: process.env
	});
	child.stdout.on('data', (chunk: Buffer | string) => output.append(chunk.toString()));
	child.stderr.on('data', (chunk: Buffer | string) => output.append(chunk.toString()));
	child.on('exit', (code, signal) => {
		output.appendLine(`Language server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
	});
	child.on('error', (error) => {
		output.appendLine(`Language server process error: ${error.message}`);
	});
	return child;
}

export async function startLanguageClient(
	launch: LaunchTarget,
	clientOptions: LanguageClientOptions,
	output: OutputChannel
): Promise<ServerHandles> {
	const child = startProcess(launch, output);
	let socket: Socket | undefined;
	const serverOptions: ServerOptions = async (): Promise<StreamInfo> => {
		socket = await connectToPipe(languageServerPipePath, 30000, 150);
		output.appendLine('Connected to Strict.LanguageServer named pipe');
		return { reader: socket, writer: socket };
	};
	const client = new LanguageClient('strict', 'Strict Language Server', serverOptions, clientOptions);
	await client.start();
	const stop = async () => {
		try {
			if (client.isRunning()) {
				await client.stop();
			}
		} catch (error) {
			output.appendLine(`Error stopping language client: ${error}`);
		}
		if (socket) {
			socket.destroy();
			socket = undefined;
		}
		if (!child.killed) {
			if (process.platform === 'win32') {
				spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
			} else {
				child.kill('SIGTERM');
			}
		}
	};
	return { client, stop };
}
