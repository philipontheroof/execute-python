// Open unified repo GitHub Pages (docs/) JupyterLite when the extension icon is clicked
chrome.action.onClicked.addListener(() => {
    const url = 'https://philipontheroof.github.io/execute-python/lab/index.html?code_b64=Cg%3D%3D';
    chrome.tabs.create({ url });
});

chrome.runtime.onInstalled.addListener(() => {
    // Keep for future onboarding/migrations
});


