let pyodideReady = null;
let pyodide = null;

async function init() {
    if (!pyodideReady) {
        pyodideReady = new Promise(async (resolve, reject) => {
            try {
                console.log('PyWorker: Loading pyodide.js...');
                importScripts('pyodide/pyodide.js');
                console.log('PyWorker: pyodide.js loaded, initializing Pyodide...');
                pyodide = await loadPyodide({ indexURL: 'pyodide/' });
                console.log('PyWorker: Pyodide initialized successfully');
                resolve();
            } catch (e) {
                console.error('PyWorker: Failed to initialize:', e);
                reject(e);
            }
        });
    }
    return pyodideReady;
}

function runAndCapture(code) {
    // Set up output capture
    pyodide.runPython(`
import sys
import io
import traceback

# Backup original stdout/stderr
sys_stdout_backup = sys.stdout
sys_stderr_backup = sys.stderr

# Create new string buffers
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
`);

    let stdout = '';
    let stderr = '';
    let success = true;

    try {
        pyodide.runPython(code);
    } catch (err) {
        console.error('PyWorker: Python execution error:', err);
        success = false;
        // Capture the error details
        pyodide.runPython(`
import traceback
print(traceback.format_exc(), file=sys.stderr)
`);
    } finally {
        // Get the captured output
        try {
            stdout = pyodide.runPython('sys.stdout.getvalue()');
            stderr = pyodide.runPython('sys.stderr.getvalue()');
        } catch (captureErr) {
            console.error('PyWorker: Failed to capture output:', captureErr);
            stderr = 'Failed to capture output: ' + String(captureErr);
        }

        // Restore original stdout/stderr
        try {
            pyodide.runPython(`
sys.stdout = sys_stdout_backup
sys.stderr = sys_stderr_backup
`);
        } catch (restoreErr) {
            console.error('PyWorker: Failed to restore stdout/stderr:', restoreErr);
        }
    }

    return { stdout, stderr, success };
}

self.onmessage = async (e) => {
    const data = e.data || {};
    const id = data.id || null;
    if (data.type === 'init') {
        try {
            await init();
            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({ type: 'ready', error: String(err && err.message ? err.message : err) });
        }
        return;
    }
    if (data.type === 'run') {
        try {
            await init();
            const res = runAndCapture(data.code || '');
            self.postMessage({
                type: 'result',
                id,
                ok: res.success,
                stdout: res.stdout,
                stderr: res.stderr
            });
        } catch (err) {
            console.error('PyWorker: Failed to run code:', err);
            self.postMessage({
                type: 'result',
                id,
                ok: false,
                stdout: '',
                stderr: String(err && err.message ? err.message : err)
            });
        }
        return;
    }
};


