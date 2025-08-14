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
    const JLITE_ORIGIN = 'https://philipontheroof.github.io';

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

    // Minimal LZString decompress for URL-encoded data (nb_lz)
    const LZString = (function () {
        function f(n) { return String.fromCharCode(n); }
        const keyStrUriSafe = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';
        const baseReverseDic = {};
        function getBaseValue(alphabet, character) {
            if (!baseReverseDic[alphabet]) {
                baseReverseDic[alphabet] = {};
                for (let i = 0; i < alphabet.length; i++) {
                    baseReverseDic[alphabet][alphabet.charAt(i)] = i;
                }
            }
            return baseReverseDic[alphabet][character];
        }
        function _decompress(length, resetValue, getNextValue) {
            const dictionary = [];
            let next, enlargeIn = 4, dictSize = 4, numBits = 3, entry = '', result = [], i, w, bits, resb, maxpower, power, c;
            const data = { index: 0, val: 0, position: resetValue };
            function readBits(n) {
                bits = 0; maxpower = Math.pow(2, n); power = 1;
                while (power != maxpower) {
                    resb = getNextValue(data.index++);
                    data.val = (data.val << data.position) + resb;
                    data.position += resetValue;
                    while (data.position >= 8) {
                        data.position -= 8;
                        bits |= (data.val >> data.position) & 255;
                    }
                    power <<= 1;
                }
                return bits;
            }
            for (i = 0; i < 3; i += 1) dictionary[i] = i;
            bits = readBits(2);
            switch (bits) {
                case 0: c = f(readBits(8)); break;
                case 1: c = f(readBits(16)); break;
                case 2: return '';
            }
            dictionary[3] = c; w = c; result.push(c);
            while (true) {
                if (data.index > length) return '';
                bits = readBits(numBits);
                switch (bits) {
                    case 0:
                        c = f(readBits(8)); dictionary[dictSize++] = c; bits = dictSize - 1; enlargeIn--;
                        break;
                    case 1:
                        c = f(readBits(16)); dictionary[dictSize++] = c; bits = dictSize - 1; enlargeIn--;
                        break;
                    case 2: return result.join('');
                }
                if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
                if (dictionary[bits]) {
                    entry = dictionary[bits];
                } else {
                    if (bits === dictSize) entry = w + w.charAt(0); else return '';
                }
                result.push(entry);
                dictionary[dictSize++] = w + entry.charAt(0);
                enlargeIn--;
                w = entry;
                if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
            }
        }
        function decompressFromEncodedURIComponent(input) {
            if (input == null) return '';
            input = input.replace(/ /g, '+');
            return _decompress(input.length, 32, function (index) {
                return getBaseValue(keyStrUriSafe, input.charAt(index));
            });
        }
        return { decompressFromEncodedURIComponent };
    })();

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
            // Install postMessage listener immediately and queue payload
            let queuedIpynb = null;
            window.addEventListener('message', (event) => {
                const data = event.data || {};
                if (!data || data.type !== 'ipynb' || !data.content) return;
                if (typeof data.content !== 'object' || !Array.isArray(data.content.cells)) return;
                queuedIpynb = data.content;
            });

            // Notify opener immediately (before app is ready) to avoid parent timeout
            try {
                if (window.opener && typeof window.opener.postMessage === 'function') {
                    window.opener.postMessage({ type: 'ready' }, JLITE_ORIGIN);
                    window.opener.postMessage({ type: 'ready' }, '*');
                }
            } catch (e) {
                console.warn('[auto-run-from-url] unable to notify opener early', e);
            }

            const app = await waitForJupyterApp();

            // We no longer support nb_lz or postMessage; only URL code params are handled.

            // URL fallback (Method B): code/code_b64 parameters
            const code = await getCodeFromUrlParams();
            if (code) {
                console.log('[auto-run-from-url] code detected from URL params');
                const panel = await createNotebookWithCode(app, code);
                console.log('[auto-run-from-url] notebook created');
                await runAllCells(app);
                window.__AUTO_RUN_FROM_URL_DONE__ = true;
            }
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


