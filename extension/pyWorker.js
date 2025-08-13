let pyodideReady = null;
let pyodide = null;

async function init() {
    if (!pyodideReady) {
        pyodideReady = new Promise(async (resolve, reject) => {
            try {
                importScripts('pyodide/pyodide.js');
                pyodide = await loadPyodide({ indexURL: 'pyodide/' });
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    }
    return pyodideReady;
}

function runAndCapture(code) {
    pyodide.runPython('import sys\nimport io\nsys_stdout_backup = sys.stdout\nsys_stderr_backup = sys.stderr\nsys.stdout = io.StringIO()\nsys.stderr = io.StringIO()');
    let stdout = '';
    let stderr = '';
    try {
        pyodide.runPython(code);
    } finally {
        stdout = pyodide.runPython('sys.stdout.getvalue()');
        stderr = pyodide.runPython('sys.stderr.getvalue()');
        pyodide.runPython('sys.stdout = sys_stdout_backup\nsys.stderr = sys_stderr_backup');
    }
    return { stdout, stderr };
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
            self.postMessage({ type: 'result', id, ok: true, stdout: res.stdout, stderr: res.stderr });
        } catch (err) {
            self.postMessage({ type: 'result', id, ok: false, stdout: '', stderr: String(err && err.message ? err.message : err) });
        }
        return;
    }
};


