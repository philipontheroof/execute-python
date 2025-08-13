(() => {
    const JLITE_ORIGIN = 'https://philipontheroof.github.io';
    const JLITE_URL = JLITE_ORIGIN + '/execute-python/lab/index.html';
    const BUTTON_CONTAINER_CLASS = "python-pad-controls";
    const OUTPUT_CLASS = "python-pad-output";
    const RUN_BUTTON_CLASS = "python-pad-run";
    const NB_BUTTON_CLASS = "python-pad-open-nb";

    let runnerFrame = null;
    let runnerReadyPromise = null;
    const processedBlocks = new WeakSet();

    function ensureRunnerFrame() {
        if (runnerFrame && document.documentElement.contains(runnerFrame)) return runnerFrame;
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.sandbox = 'allow-scripts allow-popups allow-same-origin';
        iframe.src = chrome.runtime.getURL('runner.html');
        const parentNode = document.body || document.documentElement;
        parentNode.appendChild(iframe);
        runnerFrame = iframe;
        if (!runnerReadyPromise) {
            runnerReadyPromise = new Promise((resolve) => {
                function onMessage(ev) {
                    const data = ev.data || {};
                    if (ev.source === iframe.contentWindow && data.type === 'ready') {
                        window.removeEventListener('message', onMessage);
                        resolve();
                    }
                }
                window.addEventListener('message', onMessage);
            });
        }
        return runnerFrame;
    }

    async function runInPyodide(code) {
        const iframe = ensureRunnerFrame();
        await runnerReadyPromise;
        return new Promise((resolve) => {
            const id = Math.random().toString(36).slice(2);
            function onMessage(ev) {
                const data = ev.data || {};
                if (ev.source === iframe.contentWindow && data.type === 'result' && data.id === id) {
                    window.removeEventListener('message', onMessage);
                    resolve(data);
                }
            }
            window.addEventListener('message', onMessage);
            iframe.contentWindow.postMessage({ type: 'run', id, code }, '*');
        });
    }

    function isPythonishText(text) {
        if (!text) return false;
        const t = text.trim();
        if (t.length < 4) return false;
        const indicators = ["def ", "import ", "print(", "class ", "for ", "while ", "if ", "from ", "#", "\n "];
        return indicators.some((k) => t.includes(k));
    }

    function findPythonBlocks() {
        const selectors = [
            'pre code.language-python',
            'pre code[class*="language-py"]',
            'code.language-python',
            'code.lang-python',
            '[data-lang="python"]',
            '.highlight-source-python',
            'pre code'
        ];
        const seen = new Set();
        const blocks = [];
        for (const sel of selectors) {
            document.querySelectorAll(sel).forEach((el) => {
                if (!(el instanceof HTMLElement)) return;
                if (seen.has(el)) return;
                const text = el.innerText || el.textContent || "";
                if (!text) return;
                if (sel === 'pre code' && !isPythonishText(text)) return;
                seen.add(el);
                blocks.push(el);
            });
        }
        return blocks;
    }

    function buildNotebookFromCode(code) {
        const lines = (code || '').replace(/\r\n?/g, '\n').split('\n');
        const source = lines.length ? lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l)) : [''];
        return {
            cells: [
                {
                    cell_type: 'code',
                    id: 'cell-1',
                    metadata: {},
                    source,
                    outputs: [],
                    execution_count: null
                }
            ],
            metadata: {
                kernelspec: { name: 'python', display_name: 'Python (Pyodide)', language: 'python' },
                language_info: { name: 'python' }
            },
            nbformat: 4,
            nbformat_minor: 5
        };
    }

    function toBase64Unicode(text) {
        const bytes = new TextEncoder().encode(text);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    function openJLiteWithPostMessage(nbContent, smallCodeForFallback) {
        const child = window.open(JLITE_URL, '_blank');
        if (!child) {
            if (smallCodeForFallback) {
                const url = JLITE_URL + '?code_b64=' + encodeURIComponent(toBase64Unicode(smallCodeForFallback));
                window.open(url, '_blank');
            }
            return;
        }

        let ready = false;
        const timeoutMs = 15000;
        function readyHandler(event) {
            if (event.origin !== JLITE_ORIGIN) return;
            const data = event.data || {};
            if (data.type !== 'ready') return;
            ready = true;
            window.removeEventListener('message', readyHandler);
            try {
                child.postMessage({ type: 'ipynb', content: nbContent }, JLITE_ORIGIN);
            } catch (e) {
                console.error('[content] postMessage failed, fallback to URL', e);
                if (smallCodeForFallback) {
                    const url = JLITE_URL + '?code_b64=' + encodeURIComponent(toBase64Unicode(smallCodeForFallback));
                    try { child.location.replace(url); } catch (_) { window.open(url, '_blank'); }
                }
            }
        }
        window.addEventListener('message', readyHandler);

        setTimeout(() => {
            if (ready) return;
            window.removeEventListener('message', readyHandler);
            if (smallCodeForFallback) {
                const url = JLITE_URL + '?code_b64=' + encodeURIComponent(toBase64Unicode(smallCodeForFallback));
                try { child.location.replace(url); } catch (_) { window.open(url, '_blank'); }
            }
        }, timeoutMs);
    }

    function ensureControlsForBlock(codeEl) {
        if (!(codeEl instanceof HTMLElement)) return;
        const parent = codeEl.closest('pre') || codeEl.parentElement || codeEl;
        if (!parent) return;

        if (processedBlocks.has(parent)) return;
        if (parent.dataset && parent.dataset.pythonPadProcessed === '1') return;

        const container = document.createElement('div');
        container.className = BUTTON_CONTAINER_CLASS;

        const runBtn = document.createElement('button');
        runBtn.className = RUN_BUTTON_CLASS;
        runBtn.textContent = 'Run Python';

        const nbBtn = document.createElement('button');
        nbBtn.className = NB_BUTTON_CLASS;
        nbBtn.textContent = 'Open Notebook';

        const output = document.createElement('div');
        output.className = OUTPUT_CLASS;
        output.style.display = 'none';

        const getCode = () => (codeEl.innerText || codeEl.textContent || "");

        runBtn.addEventListener('click', async () => {
            const code = getCode();
            output.style.display = '';
            output.textContent = 'Running...';
            try {
                const result = await runInPyodide(code);
                const stdout = result.stdout || '';
                const stderr = result.stderr || '';
                let text = '';
                if (stdout) text += stdout;
                if (stderr) text += (text ? '\n' : '') + '[stderr]\n' + stderr;
                output.textContent = text || 'Done.';
            } catch (err) {
                output.textContent = 'Error running code: ' + (err && err.message ? err.message : String(err));
            }
        });

        nbBtn.addEventListener('click', () => {
            const code = getCode();
            const nb = buildNotebookFromCode(code || '');
            openJLiteWithPostMessage(nb, code || '');
        });

        container.appendChild(runBtn);
        container.appendChild(nbBtn);
        // Insert controls immediately after the code block, then output below controls
        parent.insertAdjacentElement('afterend', container);
        container.insertAdjacentElement('afterend', output);

        processedBlocks.add(parent);
        if (parent.dataset) parent.dataset.pythonPadProcessed = '1';
    }

    function scanAndEnhance() {
        findPythonBlocks().forEach(ensureControlsForBlock);
    }

    let rescanScheduled = false;
    function scheduleRescan() {
        if (rescanScheduled) return;
        rescanScheduled = true;
        setTimeout(() => {
            rescanScheduled = false;
            scanAndEnhance();
        }, 400);
    }

    function init() {
        scanAndEnhance();
        // Remote JupyterLite handles code_b64; no client-side DOM automation needed here
        const observer = new MutationObserver(() => {
            scheduleRescan();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();


