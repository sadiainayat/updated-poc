// Shared Allied Bank header, footer and fonts, injected on every page.
(function injectShell() {
  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Manrope:wght@600;700;800&display=swap';
  document.head.appendChild(fonts);

  const here = window.location.pathname.split('/').pop() || 'index.html';
  const nav = [['index.html', 'New application'], ['queue.html', 'Ops queue']]
    .map(([href, label]) => `<a href="${href}"${href === here ? ' class="active"' : ''}>${label}</a>`).join('');

  const header = document.createElement('header');
  header.className = 'abl-header';
  header.innerHTML = `
    <div class="abl-header-inner">
      <a class="abl-brand" href="index.html" aria-label="Allied Bank - home">
        <img src="favicon.png" alt="">
        <span class="name">Allied Bank</span>
        <span class="product">Merchant Onboarding</span>
      </a>
      <nav class="abl-nav">${nav}</nav>
    </div>
    <div class="abl-rule"></div>`;
  document.body.insertBefore(header, document.body.firstChild);

  const footer = document.createElement('footer');
  footer.className = 'abl-footer';
  footer.innerHTML = `
    <div class="abl-footer-inner">
      <span>&copy; ${new Date().getFullYear()} Allied Bank Limited. Digital merchant onboarding.</span>
      <span>Internal pilot &middot; Sample data</span>
    </div>`;
  document.body.appendChild(footer);
})();

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${url} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function goTo(page, caseId) {
  window.location.href = `${page}?case=${encodeURIComponent(caseId)}`;
}

// Reads a File into a base64 data: URL (e.g. "data:image/jpeg;base64,...").
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
