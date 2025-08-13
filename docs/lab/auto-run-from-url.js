/*
Lightweight client-side helper for JupyterLite/JupyterLab (WASM) pages.

Features:
- Reads code from URL via one of:
  - ?code=...            (URI component encoded text)
  - ?code_b64=...        (base64-encoded text)
  - ?codeUrl=https://... (fetch code from a URL; must allow CORS)
- Creates a new notebook, injects the code into the first cell, and runs it.

Usage (in your JupyterLite lab page, e.g. lab/index.html):
  <script src="./auto-run-from-url.js"></script>

Then open:
  https://your-site/lab/index.html?code=print('hello from url')
or
  https://your-site/lab/index.html?code_b64=cHJpbnQoJ2hlbGxvJyk=
or
  https://your-site/lab/index.html?codeUrl=https%3A%2F%2Fexample.com%2Fsnippet.py
*/

(function () {
    if (window.__AUTO_RUN_FROM_URL_INITED__) {
        return;
    }
    window.__AUTO_RUN_FROM_URL_INITED__ = true;
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitFor(predicate, timeoutMs = 20000, intervalMs = 50) {
        const start = Date.now();
        while (true) {
            try {
                if (predicate()) return true;
            } catch (_) { }
            if (Date.now() - start > timeoutMs) return false;
            await sleep(intervalMs);
        }
    }

    function getSearchParams() {
        try {
            return new URLSearchParams(window.location.search || '');
        } catch (_) {
            return new URLSearchParams('');
        }
    }

    function decodeBase64Unicode(b64) {
        try {
            // Handle unicode safely
            const bin = atob(b64);
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            const decoded = new TextDecoder().decode(bytes);
            return decoded;
        } catch (err) {
            console.warn('[auto-run-from-url] base64 decode failed:', err);
            return null;
        }
    }

    async function getCodeFromUrlParams() {
        const params = getSearchParams();

        // Priority: codeUrl > code_b64 > code
        const codeUrl = params.get('codeUrl') || params.get('code_url');
        if (codeUrl) {
            try {
                const res = await fetch(codeUrl);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const txt = await res.text();
                return txt;
            } catch (err) {
                console.error('[auto-run-from-url] Failed to fetch codeUrl:', err);
                return null;
            }
        }

        const codeB64 = params.get('code_b64');
        if (codeB64) {
            const decoded = decodeBase64Unicode(codeB64);
            if (decoded != null) return decoded;
        }

        const code = params.get('code');
        if (code != null) {
            try {
                return decodeURIComponent(code);
            } catch (_) {
                // In case it's already decoded
                return code;
            }
        }

        return null;
    }

    async function waitForJupyterApp() {
        // JupyterLite exposes `window.jupyterapp`.
        // It can be the app instance or a Promise resolving to it.
        let app = window.jupyterapp;
        const maxWaitMs = 120000; // 2 minutes for initial Pyodide boot on slow devices
        const start = Date.now();

        while (!app) {
            if (Date.now() - start > maxWaitMs) throw new Error('Timed out waiting for window.jupyterapp');
            await sleep(50);
            app = window.jupyterapp;
        }

        if (typeof app.then === 'function') {
            try { app = await app; } catch (_) { }
        }

        // Wait for app.started/restored if present
        try {
            if (app && app.started && typeof app.started.then === 'function') {
                await app.started;
            }
            if (app && app.restored && typeof app.restored.then === 'function') {
                await app.restored;
            }
        } catch (err) {
            console.warn('[auto-run-from-url] waiting for app.started failed:', err);
        }

        return app;
    }

    async function createNotebookWithCode(app, code) {
        // Create an untitled notebook file, write full JSON with our code, then open it
        let panel;
        let createdPath = null;
        try {
            const cwd = '';
            const created = await app.commands.execute('docmanager:new-untitled', { path: cwd, type: 'notebook' });
            createdPath = (created && created.path) || null;
        } catch (err) {
            console.warn('[auto-run-from-url] new-untitled failed, trying notebook:create-new then derive path:', err);
            try {
                panel = await app.commands.execute('notebook:create-new', {});
                createdPath = panel && panel.context ? panel.context.path : null;
            } catch (err2) {
                console.error('[auto-run-from-url] failed to create notebook via any method:', err2);
                throw err2;
            }
        }

        if (!createdPath && panel && panel.context) {
            createdPath = panel.context.path;
        }

        // Build a minimal ipynb with the code in the first cell
        const nb = {
            cells: [
                {
                    cell_type: 'code',
                    execution_count: null,
                    metadata: {},
                    outputs: [],
                    source: [String(code), '\n']
                }
            ],
            metadata: {
                kernelspec: { name: 'python', display_name: 'Python (Pyodide)' },
                language_info: { name: 'python' }
            },
            nbformat: 4,
            nbformat_minor: 5
        };

        try {
            const contents = app.serviceManager && app.serviceManager.contents;
            if (contents && createdPath) {
                await contents.save(createdPath, { type: 'notebook', format: 'json', content: nb });
            }
        } catch (err) {
            console.warn('[auto-run-from-url] contents.save failed (will still try to open):', err);
        }

        try {
            const pathToOpen = createdPath || (panel && panel.context && panel.context.path) || 'Untitled.ipynb';
            panel = await app.commands.execute('docmanager:open', { path: pathToOpen });
            if (app.shell && panel && panel.id) {
                app.shell.activateById(panel.id);
            }
        } catch (err) {
            console.warn('[auto-run-from-url] opening created notebook failed:', err);
        }

        return panel;
    }

    async function runAllCells(app) {
        // Prefer using a built-in command to avoid importing modules
        try {
            await app.commands.execute('notebook:run-all-cells');
            return;
        } catch (err) {
            console.warn('[auto-run-from-url] run-all command failed, trying fallback:', err);
        }

        // Trigger run cell if available
        try {
            await app.commands.execute('notebook:run-cell-and-select-next');
        } catch (_) { }
    }

    async function init() {
        try {
            const code = await getCodeFromUrlParams();
            if (!code) return; // Nothing to do
            console.log('[auto-run-from-url] code detected from URL params');

            const app = await waitForJupyterApp();
            const panel = await createNotebookWithCode(app, code);
            console.log('[auto-run-from-url] notebook created');
            await runAllCells(app);
            window.__AUTO_RUN_FROM_URL_DONE__ = true;
        } catch (err) {
            console.error('[auto-run-from-url] initialization failed:', err);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();


