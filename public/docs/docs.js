// La doc des développeurs : INTEGRATION.md et PROTOCOL.md, mis en page à la volée, avec un sommaire, un lien direct vers
// chaque section (#integration/step-3-send-through-a-queue) et un bouton pour copier le code.
const PAGES = { integration: ['INTEGRATION.md', 'Connect your app'], protocol: ['PROTOCOL.md', 'Protocol'] };
const doc = document.getElementById('doc'), tocList = document.getElementById('tocList');
const slug = s => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9 -]/g, '').trim().replace(/ +/g, '-');
let shown = '';

function dress(page) {
  tocList.replaceChildren();
  for (const h of doc.querySelectorAll('h2, h3')) {
    h.id = slug(h.textContent);
    const href = `#${page}/${h.id}`;
    const mark = document.createElement('a');
    mark.className = 'anchor'; mark.href = href; mark.textContent = '#';
    mark.setAttribute('aria-label', 'Link to this section');
    const item = document.createElement('a');
    item.href = href; item.textContent = h.textContent;
    if (h.tagName === 'H3') item.className = 'sub';
    const li = document.createElement('li');
    li.append(item);
    tocList.append(li);
    h.append(mark);
  }
  for (const pre of doc.querySelectorAll('pre')) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Copy';
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pre.querySelector('code').textContent);
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    });
    pre.append(b);
  }
}

async function show() {
  const [p, section] = location.hash.slice(1).split('/');
  const page = PAGES[p] ? p : 'integration';
  if (page !== shown) {
    const r = await fetch('/docs/' + PAGES[page][0]);
    doc.innerHTML = marked.parse(await r.text());
    dress(page);
    shown = page;
    document.title = `${PAGES[page][1]} – Open Paragliders Network`;
    for (const a of document.querySelectorAll('.top a')) a.classList.toggle('on', a.getAttribute('href') === '#' + page);
  }
  const at = section && document.getElementById(section);
  if (at) at.scrollIntoView(); else scrollTo(0, 0);
  // sur téléphone, le sommaire se referme une fois la section choisie
  if (section && matchMedia('(max-width: 899px)').matches) document.querySelector('#toc details').open = false;
}
if (matchMedia('(max-width: 899px)').matches) document.querySelector('#toc details').open = false;
addEventListener('hashchange', show);
void show();
