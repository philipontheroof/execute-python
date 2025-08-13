// Run Pyodide inside a dedicated Web Worker using a static worker script (no CDN)
let pyWorker = null;
let workerReady = null;

function ensureWorker() {
    if (pyWorker) return pyWorker;
    // Use a same-origin worker file so we can import local pyodide assets
    pyWorker = new Worker('pyWorker.js', { type: 'classic' });
    workerReady = new Promise((resolve) => {
        function onMessage(e) {
            const data = e.data || {};
            if (data.type === 'ready') {
                pyWorker.removeEventListener('message', onMessage);
                resolve(data);
            }
        }
        pyWorker.addEventListener('message', onMessage);
    });
    pyWorker.postMessage({ type: 'init' });
    return pyWorker;
}

function postToWorkerAndWait(message) {
    const worker = ensureWorker();
    return new Promise((resolve) => {
        const id = message.id || Math.random().toString(36).slice(2);
        message.id = id;
        function onMessage(e) {
            const data = e.data || {};
            if (data.id === id && (data.type === 'result' || data.type === 'pong')) {
                worker.removeEventListener('message', onMessage);
                resolve(data);
            }
        }
        worker.addEventListener('message', onMessage);
        worker.postMessage(message);
    });
}

window.addEventListener('message', async (event) => {
    const data = event.data || {};
    const id = data.id || null;
    await workerReady;
    if (data.type === 'ping') {
        window.parent.postMessage({ type: 'pong', id }, '*');
        return;
    }
    if (data.type === 'run') {
        try {
            const res = await postToWorkerAndWait({ type: 'run', id, code: data.code || '' });
            window.parent.postMessage({ type: 'result', id, ok: res.ok, stdout: res.stdout, stderr: res.stderr }, '*');
        } catch (err) {
            window.parent.postMessage({ type: 'result', id, ok: false, stdout: '', stderr: String(err && err.message ? err.message : err) }, '*');
        }
        return;
    }
});

// Announce ready after worker initialized
(async () => {
    ensureWorker();
    await workerReady;
    window.parent.postMessage({ type: 'ready' }, '*');
})();


