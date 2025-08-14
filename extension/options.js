const DEFAULTS = {
  enabled: true,
  jliteUrl: 'https://philipontheroof.github.io/execute-python/lab/index.html',
  maxUrlLen: 1800,
  showRun: true,
  showNotebook: true,
  siteMode: 'all',
  whitelist: [],
  blacklist: []
};

function normalizeHosts(text) {
  return (text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function $(id) { return document.getElementById(id); }

function load() {
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    $('enabled').checked = !!cfg.enabled;
    $('jliteUrl').value = cfg.jliteUrl || DEFAULTS.jliteUrl;
    $('maxUrlLen').value = String(cfg.maxUrlLen || DEFAULTS.maxUrlLen);
    $('showRun').checked = !!cfg.showRun;
    $('showNotebook').checked = !!cfg.showNotebook;
    $('siteMode').value = cfg.siteMode || DEFAULTS.siteMode;
    $('whitelist').value = (cfg.whitelist || []).join('\n');
    $('blacklist').value = (cfg.blacklist || []).join('\n');
  });
}

function save() {
  const cfg = {
    enabled: $('enabled').checked,
    jliteUrl: $('jliteUrl').value.trim() || DEFAULTS.jliteUrl,
    maxUrlLen: Math.max(256, parseInt($('maxUrlLen').value, 10) || DEFAULTS.maxUrlLen),
    showRun: $('showRun').checked,
    showNotebook: $('showNotebook').checked,
    siteMode: $('siteMode').value,
    whitelist: normalizeHosts($('whitelist').value),
    blacklist: normalizeHosts($('blacklist').value)
  };
  chrome.storage.sync.set(cfg, () => {
    const s = $('status');
    s.style.display = '';
    setTimeout(() => (s.style.display = 'none'), 1500);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('save').addEventListener('click', save);
});


