(() => {
    const DEFAULTS = {
        enabled: true,
        jliteUrl: 'https://philipontheroof.github.io/execute-python/lab/index.html',
        maxUrlLen: 1800,
        showRun: true,
        showNotebook: true,
        siteMode: 'all', // all | whitelist | blacklist
        whitelist: [],
        blacklist: []
    };
    let CONFIG = { ...DEFAULTS };
    function loadConfig() {
        return new Promise((resolve) => {
            try {
                chrome.storage.sync.get(DEFAULTS, (cfg) => {
                    CONFIG = { ...DEFAULTS, ...cfg };
                    resolve(CONFIG);
                });
            } catch (_) {
                // Fallback to defaults if chrome storage fails
                CONFIG = { ...DEFAULTS };
                resolve(CONFIG);
            }
        });
    }
    function hostAllowed() {
        const host = location.hostname || '';
        if (CONFIG.siteMode === 'whitelist') {
            return CONFIG.whitelist.includes(host);
        }
        if (CONFIG.siteMode === 'blacklist') {
            return !CONFIG.blacklist.includes(host);
        }
        return true; // all
    }
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
        iframe.src = chrome.runtime.getURL('runner.html');
        const parentNode = document.body || document.documentElement;
        parentNode.appendChild(iframe);
        runnerFrame = iframe;
        if (!runnerReadyPromise) {
            runnerReadyPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    window.removeEventListener('message', onMessage);
                    reject(new Error('Runner iframe failed to initialize within 60 seconds. This may be due to slow Pyodide loading.'));
                }, 60000);

                function onMessage(ev) {
                    const data = ev.data || {};
                    if (ev.source === iframe.contentWindow && data.type === 'ready') {
                        clearTimeout(timeout);
                        window.removeEventListener('message', onMessage);
                        if (data.error) {
                            reject(new Error('Runner failed to initialize: ' + data.error));
                        } else {
                            resolve();
                        }
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
        return new Promise((resolve, reject) => {
            const id = Math.random().toString(36).slice(2);
            const timeout = setTimeout(() => {
                window.removeEventListener('message', onMessage);
                reject(new Error('Code execution timed out after 30 seconds'));
            }, 30000);

            function onMessage(ev) {
                const data = ev.data || {};
                if (ev.source === iframe.contentWindow && data.type === 'result' && data.id === id) {
                    clearTimeout(timeout);
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

    // Minimal LZString compressor (URI-safe) for sending ipynb via URL
    const LZString = (function () {
        const keyStrUriSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
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
        function _compress(uncompressed, bitsPerChar, getCharFromInt) {
            if (uncompressed == null) return '';
            let i, value;
            const context_dictionary = Object.create(null);
            const context_dictionaryToCreate = Object.create(null);
            let context_c = '';
            let context_wc = '';
            let context_w = '';
            let context_enlargeIn = 2;
            let context_dictSize = 3;
            let context_numBits = 2;
            const context_data = [];
            let context_data_val = 0;
            let context_data_position = 0;

            for (let ii = 0; ii < uncompressed.length; ii += 1) {
                context_c = uncompressed.charAt(ii);
                if (!Object.prototype.hasOwnProperty.call(context_dictionary, context_c)) {
                    context_dictionary[context_c] = context_dictSize++;
                    context_dictionaryToCreate[context_c] = true;
                }
                context_wc = context_w + context_c;
                if (Object.prototype.hasOwnProperty.call(context_dictionary, context_wc)) {
                    context_w = context_wc;
                } else {
                    if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
                        if (context_w.charCodeAt(0) < 256) {
                            for (i = 0; i < context_numBits; i++) {
                                context_data_val = (context_data_val << 1);
                                if (context_data_position == bitsPerChar - 1) {
                                    context_data_position = 0;
                                    context_data.push(getCharFromInt(context_data_val));
                                    context_data_val = 0;
                                } else {
                                    context_data_position++;
                                }
                            }
                            value = context_w.charCodeAt(0);
                            for (i = 0; i < 8; i++) {
                                context_data_val = (context_data_val << 1) | (value & 1);
                                if (context_data_position == bitsPerChar - 1) {
                                    context_data_position = 0;
                                    context_data.push(getCharFromInt(context_data_val));
                                    context_data_val = 0;
                                } else {
                                    context_data_position++;
                                }
                                value = value >> 1;
                            }
                        } else {
                            value = 1;
                            for (i = 0; i < context_numBits; i++) {
                                context_data_val = (context_data_val << 1) | value;
                                if (context_data_position == bitsPerChar - 1) {
                                    context_data_position = 0;
                                    context_data.push(getCharFromInt(context_data_val));
                                    context_data_val = 0;
                                } else {
                                    context_data_position++;
                                }
                                value = 0;
                            }
                            value = context_w.charCodeAt(0);
                            for (i = 0; i < 16; i++) {
                                context_data_val = (context_data_val << 1) | (value & 1);
                                if (context_data_position == bitsPerChar - 1) {
                                    context_data_position = 0;
                                    context_data.push(getCharFromInt(context_data_val));
                                    context_data_val = 0;
                                } else {
                                    context_data_position++;
                                }
                                value = value >> 1;
                            }
                        }
                        context_enlargeIn--;
                        if (context_enlargeIn == 0) {
                            context_enlargeIn = Math.pow(2, context_numBits);
                            context_numBits++;
                        }
                        delete context_dictionaryToCreate[context_w];
                    } else {
                        value = context_dictionary[context_w];
                        for (i = 0; i < context_numBits; i++) {
                            context_data_val = (context_data_val << 1) | (value & 1);
                            if (context_data_position == bitsPerChar - 1) {
                                context_data_position = 0;
                                context_data.push(getCharFromInt(context_data_val));
                                context_data_val = 0;
                            } else {
                                context_data_position++;
                            }
                            value = value >> 1;
                        }
                    }
                    context_enlargeIn--;
                    if (context_enlargeIn == 0) {
                        context_enlargeIn = Math.pow(2, context_numBits);
                        context_numBits++;
                    }
                    context_dictionary[context_wc] = context_dictSize++;
                    context_w = String(context_c);
                }
            }
            if (context_w !== '') {
                if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
                    if (context_w.charCodeAt(0) < 256) {
                        for (i = 0; i < context_numBits; i++) {
                            context_data_val = (context_data_val << 1);
                            if (context_data_position == bitsPerChar - 1) {
                                context_data_position = 0;
                                context_data.push(getCharFromInt(context_data_val));
                                context_data_val = 0;
                            } else {
                                context_data_position++;
                            }
                        }
                        value = context_w.charCodeAt(0);
                        for (i = 0; i < 8; i++) {
                            context_data_val = (context_data_val << 1) | (value & 1);
                            if (context_data_position == bitsPerChar - 1) {
                                context_data_position = 0;
                                context_data.push(getCharFromInt(context_data_val));
                                context_data_val = 0;
                            } else {
                                context_data_position++;
                            }
                            value = value >> 1;
                        }
                    } else {
                        value = 1;
                        for (i = 0; i < context_numBits; i++) {
                            context_data_val = (context_data_val << 1) | value;
                            if (context_data_position == bitsPerChar - 1) {
                                context_data_position = 0;
                                context_data.push(getCharFromInt(context_data_val));
                                context_data_val = 0;
                            } else {
                                context_data_position++;
                            }
                            value = 0;
                        }
                        value = context_w.charCodeAt(0);
                        for (i = 0; i < 16; i++) {
                            context_data_val = (context_data_val << 1) | (value & 1);
                            if (context_data_position == bitsPerChar - 1) {
                                context_data_position = 0;
                                context_data.push(getCharFromInt(context_data_val));
                                context_data_val = 0;
                            } else {
                                context_data_position++;
                            }
                            value = value >> 1;
                        }
                    }
                    context_enlargeIn--;
                    if (context_enlargeIn == 0) {
                        context_enlargeIn = Math.pow(2, context_numBits);
                        context_numBits++;
                    }
                    delete context_dictionaryToCreate[context_w];
                } else {
                    value = context_dictionary[context_w];
                    for (i = 0; i < context_numBits; i++) {
                        context_data_val = (context_data_val << 1) | (value & 1);
                        if (context_data_position == bitsPerChar - 1) {
                            context_data_position = 0;
                            context_data.push(getCharFromInt(context_data_val));
                            context_data_val = 0;
                        } else {
                            context_data_position++;
                        }
                        value = value >> 1;
                    }
                }
                context_enlargeIn--;
                if (context_enlargeIn == 0) {
                    context_enlargeIn = Math.pow(2, context_numBits);
                    context_numBits++;
                }
            }
            value = 2;
            for (i = 0; i < context_numBits; i++) {
                context_data_val = (context_data_val << 1) | (value & 1);
                if (context_data_position == bitsPerChar - 1) {
                    context_data_position = 0;
                    context_data.push(getCharFromInt(context_data_val));
                    context_data_val = 0;
                } else {
                    context_data_position++;
                }
                value = value >> 1;
            }
            while (true) {
                context_data_val = (context_data_val << 1);
                if (context_data_position == bitsPerChar - 1) {
                    context_data.push(getCharFromInt(context_data_val));
                    break;
                } else {
                    context_data_position++;
                }
            }
            return context_data.join('');
        }
        function compressToEncodedURIComponent(input) {
            if (input == null) return '';
            return _compress(input, 6, function (a) { return keyStrUriSafe.charAt(a); });
        }
        return { compressToEncodedURIComponent };
    })();

    function buildNbUrlParam(nbContent) {
        try {
            const json = JSON.stringify(nbContent);
            // Only send code_b64 (requested)
            const codeFallback = toBase64Unicode(nbContent.cells[0].source.join(''));
            return 'code_b64=' + encodeURIComponent(codeFallback);
        } catch (e) {
            // Fallback to base64 for the code content
            try {
                const code = nbContent.cells[0].source.join('');
                return 'code_b64=' + encodeURIComponent(toBase64Unicode(code));
            } catch (fallbackError) {
                return null;
            }
        }
    }

    function openJLiteWithUrlNb(nbContent) {
        const param = buildNbUrlParam(nbContent);
        if (!param) return false;
        const url = CONFIG.jliteUrl + '?' + param;
        window.open(url, '_blank');
        return true;
    }

    function ensureControlsForBlock(codeEl) {
        if (!(codeEl instanceof HTMLElement)) return;
        const parent = codeEl.closest('pre') || codeEl.parentElement || codeEl;
        if (!parent) return;

        if (processedBlocks.has(parent)) return;
        if (parent.dataset && parent.dataset.pythonPadProcessed === '1') return;

        const container = document.createElement('div');
        container.className = BUTTON_CONTAINER_CLASS;

        const output = document.createElement('div');
        output.className = OUTPUT_CLASS;
        output.style.display = 'none';

        const getCode = () => (codeEl.innerText || codeEl.textContent || "");

        // Only add Run button if enabled in config
        if (CONFIG.showRun) {
            const runBtn = document.createElement('button');
            runBtn.className = RUN_BUTTON_CLASS;
            runBtn.textContent = 'Run Python';

            runBtn.addEventListener('click', async () => {
                const code = getCode();
                output.style.display = '';
                output.textContent = 'Initializing Python environment... (this may take up to 60 seconds on first run)';
                try {
                    const result = await runInPyodide(code);
                    const stdout = result.stdout || '';
                    const stderr = result.stderr || '';

                    // Build output text
                    let text = '';
                    if (stdout) text += stdout;
                    if (stderr) {
                        if (text) text += '\n';
                        text += stderr;
                    }

                    // Show output or indicate completion
                    output.textContent = text || 'Code executed successfully (no output)';
                } catch (err) {
                    output.textContent = 'Error running code: ' + (err && err.message ? err.message : String(err));
                }
            });

            container.appendChild(runBtn);
        }

        // Only add Notebook button if enabled in config
        if (CONFIG.showNotebook) {
            const nbBtn = document.createElement('button');
            nbBtn.className = NB_BUTTON_CLASS;
            nbBtn.textContent = 'Open Notebook';

            nbBtn.addEventListener('click', () => {
                const code = getCode();
                const nb = buildNotebookFromCode(code || '');
                // Prefer URL delivery for small notebooks; if too big, use postMessage
                const param = buildNbUrlParam(nb);
                const url = param ? (CONFIG.jliteUrl + '?' + param) : null;
                const maxLen = CONFIG.maxUrlLen || 1800;
                if (url && url.length <= maxLen) {
                    window.open(url, '_blank');
                } else {
                    alert('Code is too long to open via URL on this site. Please shorten the code.');
                }
            });

            container.appendChild(nbBtn);
        }

        // Only add controls if at least one button was created
        if (container.children.length > 0) {
            // Insert controls immediately after the code block, then output below controls
            parent.insertAdjacentElement('afterend', container);
            container.insertAdjacentElement('afterend', output);
        }

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

    async function init() {
        await loadConfig();
        if (!CONFIG.enabled || !hostAllowed()) return;
        scanAndEnhance();
        const observer = new MutationObserver(() => { scheduleRescan(); });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();


