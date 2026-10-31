// La doc des développeurs : INTEGRATION.md et PROTOCOL.md, mis en page à la volée.
const PAGES = { integration: 'INTEGRATION.md', protocol: 'PROTOCOL.md' };

async function show() {
  const page = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'integration';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('on', a.getAttribute('href') === '#' + page);
  const r = await fetch('/docs/' + PAGES[page]);
  document.getElementById('doc').innerHTML = marked.parse(await r.text());
  scrollTo(0, 0);
}
addEventListener('hashchange', show);
void show();
