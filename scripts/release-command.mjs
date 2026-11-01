import { spawn } from 'node:child_process';

// Network/git commands normally take seconds (30 s ceiling). Callers give local
// suites their own budgets. A timeout or Ctrl-C stops the entire group we own,
// including npm's children; it never stops another checkout's processes.
export function run(command, args, { timeout = 30_000, env = {}, show = false } = {}) {
    return new Promise((resolve, reject) => {
        const grouped = process.platform !== 'win32';
        const child = spawn(command, args, {
            env: { ...process.env, ...env }, detached: grouped,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let interrupted = '';
        let forceTimer;
        const signalGroup = (signal) => {
            try {
                if (grouped) { process.kill(-child.pid, signal); }
                else { child.kill(signal); }
            } catch (error) {
                if (error.code !== 'ESRCH') { throw error; }
            }
        };
        const stop = (reason) => {
            if (interrupted) { return; }
            interrupted = reason;
            signalGroup('SIGTERM');
            forceTimer = setTimeout(() => signalGroup('SIGKILL'), 5_000);
        };
        const onInt = () => stop('interrupted');
        const onTerm = () => stop('terminated');
        process.once('SIGINT', onInt);
        process.once('SIGTERM', onTerm);
        const timer = setTimeout(() => stop(`exceeded ${timeout / 1000}s`), timeout);
        const cleanup = () => {
            clearTimeout(timer); clearTimeout(forceTimer);
            process.removeListener('SIGINT', onInt);
            process.removeListener('SIGTERM', onTerm);
        };
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (show) { process.stdout.write(chunk); }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
            if (show) { process.stderr.write(chunk); }
        });
        child.once('error', (error) => { cleanup(); reject(error); });
        child.once('close', (status) => {
            cleanup();
            if (interrupted) {
                signalGroup('SIGKILL');
                reject(new Error(`${command} ${interrupted}`));
            } else { resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }); }
        });
    });
}
