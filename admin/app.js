import { Editor } from 'https://esm.sh/@tiptap/core@3.29.2';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@3.29.2';
import Image from 'https://esm.sh/@tiptap/extension-image@3.29.2';
import Placeholder from 'https://esm.sh/@tiptap/extension-placeholder@3.29.2';

// Same TipTap version pinned here and in package.json (build-insights.js),
// so browser-authored JSON and server-rendered HTML never drift apart.

const state = {
  articles: [],
  filter: 'all',
  search: '',
  selectedSlug: null,
  current: null, // { slug, meta, bodyJson }
  editor: null,
  dirty: false,
  coverImage: '',
  keywords: [],
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------
// Image src rewriting: body.json always stores relative "images/x.png"
// (correct for the published page). The admin editor displays that same
// document from a different URL depth, so we rewrite to an absolute,
// admin-servable URL only for on-screen display, and rewrite back before
// every save. What's persisted never changes.
// ---------------------------------------------------------------------

function walkAndRewriteImages(node, fn) {
  if (!node || typeof node !== 'object') return node;
  const clone = { ...node };
  if (clone.type === 'image' && clone.attrs && typeof clone.attrs.src === 'string') {
    clone.attrs = { ...clone.attrs, src: fn(clone.attrs.src) };
  }
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.map((child) => walkAndRewriteImages(child, fn));
  }
  return clone;
}

function toDisplaySrc(slug, src) {
  return src.startsWith('images/') ? `/api/preview/${slug}/${src}` : src;
}

function toStoredSrc(slug, src) {
  const prefix = `/api/preview/${slug}/images/`;
  return src.startsWith(prefix) ? `images/${src.slice(prefix.length)}` : src;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer;
function showToast(message, isError) {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

function setSaveStatus(text) {
  el('save-status').textContent = text;
}

function markDirty() {
  state.dirty = true;
  setSaveStatus('Unsaved changes');
}

async function withErrorToast(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Something went wrong', true);
    return undefined;
  }
}

// ---------------------------------------------------------------------
// Sidebar list
// ---------------------------------------------------------------------

async function loadArticles() {
  const { articles } = await api('GET', '/api/articles');
  state.articles = articles;
  renderList();
}

function renderList() {
  const container = el('article-list');
  const query = state.search.trim().toLowerCase();
  const filtered = state.articles.filter((a) => {
    if (state.filter !== 'all' && a.meta.status !== state.filter) return false;
    if (query && !(a.meta.title || '').toLowerCase().includes(query)) return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-list">No articles found.</div>';
    return;
  }

  container.innerHTML = '';
  for (const article of filtered) {
    const row = document.createElement('button');
    row.className = 'article-row' + (article.slug === state.selectedSlug ? ' selected' : '');
    row.innerHTML = `
      <div class="article-row-title">${escapeHtml(article.meta.title || 'Untitled')}</div>
      <div class="article-row-meta">
        <span class="status-pill ${article.meta.status}">${article.meta.status}</span>
        <span>${formatDate(article.meta.updatedAt)}</span>
      </div>`;
    row.addEventListener('click', () => withErrorToast(() => selectArticle(article.slug)));
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------
// Editor lifecycle
// ---------------------------------------------------------------------

const TOOLBAR_COMMANDS = {
  bold: (chain) => chain.toggleBold(),
  italic: (chain) => chain.toggleItalic(),
  strike: (chain) => chain.toggleStrike(),
  code: (chain) => chain.toggleCode(),
  heading2: (chain) => chain.toggleHeading({ level: 2 }),
  heading3: (chain) => chain.toggleHeading({ level: 3 }),
  bulletList: (chain) => chain.toggleBulletList(),
  orderedList: (chain) => chain.toggleOrderedList(),
  blockquote: (chain) => chain.toggleBlockquote(),
  codeBlock: (chain) => chain.toggleCodeBlock(),
  undo: (chain) => chain.undo(),
  redo: (chain) => chain.redo(),
};

const ACTIVE_CHECK = {
  bold: (e) => e.isActive('bold'),
  italic: (e) => e.isActive('italic'),
  strike: (e) => e.isActive('strike'),
  code: (e) => e.isActive('code'),
  heading2: (e) => e.isActive('heading', { level: 2 }),
  heading3: (e) => e.isActive('heading', { level: 3 }),
  bulletList: (e) => e.isActive('bulletList'),
  orderedList: (e) => e.isActive('orderedList'),
  blockquote: (e) => e.isActive('blockquote'),
  codeBlock: (e) => e.isActive('codeBlock'),
  link: (e) => e.isActive('link'),
};

function updateToolbarState() {
  if (!state.editor) return;
  document.querySelectorAll('#toolbar button[data-cmd]').forEach((btn) => {
    const check = ACTIVE_CHECK[btn.dataset.cmd];
    btn.classList.toggle('active', check ? check(state.editor) : false);
  });
}

function initEditor(bodyJsonForDisplay) {
  if (state.editor) {
    state.editor.destroy();
    state.editor = null;
  }
  state.editor = new Editor({
    element: el('editor-content'),
    extensions: [
      StarterKit,
      Image,
      Placeholder.configure({ placeholder: 'Start writing…' }),
    ],
    content: bodyJsonForDisplay,
    onUpdate: () => markDirty(),
    onSelectionUpdate: () => updateToolbarState(),
    onTransaction: () => updateToolbarState(),
  });
  updateToolbarState();
}

el('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cmd]');
  if (!btn || !state.editor) return;
  const cmd = btn.dataset.cmd;

  if (cmd === 'link') {
    if (state.editor.isActive('link')) {
      state.editor.chain().focus().unsetLink().run();
    } else {
      const url = window.prompt('Link URL:');
      if (url) state.editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  } else if (cmd === 'image') {
    el('body-image-input').click();
  } else if (TOOLBAR_COMMANDS[cmd]) {
    TOOLBAR_COMMANDS[cmd](state.editor.chain().focus()).run();
  }
  updateToolbarState();
});

el('body-image-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.current) return;
  await withErrorToast(async () => {
    const dataUrl = await fileToDataUrl(file);
    const { path } = await api('POST', '/api/images', { slug: state.current.slug, dataUrl });
    state.editor.chain().focus().setImage({ src: toDisplaySrc(state.current.slug, path), alt: '' }).run();
  });
});

// ---------------------------------------------------------------------
// Cover image
// ---------------------------------------------------------------------

function renderCoverPreview() {
  const dropEl = el('cover-drop');
  if (state.coverImage && state.current) {
    dropEl.innerHTML = `<img src="${toDisplaySrc(state.current.slug, state.coverImage)}" alt="">`;
  } else {
    dropEl.textContent = 'Click to upload';
  }
}

el('cover-drop').addEventListener('click', () => el('cover-file-input').click());

el('cover-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.current) return;
  await withErrorToast(async () => {
    const dataUrl = await fileToDataUrl(file);
    const { path } = await api('POST', '/api/images', { slug: state.current.slug, dataUrl });
    state.coverImage = path;
    renderCoverPreview();
    markDirty();
  });
});

// ---------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------

function renderKeywordChips() {
  const container = el('keywords-chips');
  container.innerHTML = '';
  state.keywords.forEach((kw, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(kw)} <button type="button" aria-label="Remove">&times;</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.keywords.splice(idx, 1);
      renderKeywordChips();
      markDirty();
    });
    container.appendChild(chip);
  });
}

el('field-keyword-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const value = e.target.value.trim();
  if (value && !state.keywords.includes(value)) {
    state.keywords.push(value);
    renderKeywordChips();
    markDirty();
  }
  e.target.value = '';
});

// ---------------------------------------------------------------------
// Selecting / showing / hiding an article
// ---------------------------------------------------------------------

function showEditorPanels() {
  el('empty-main').style.display = 'none';
  el('editor-column').style.display = 'flex';
  el('details-panel').style.display = 'flex';
}

function hideEditorPanels() {
  el('empty-main').style.display = 'flex';
  el('editor-column').style.display = 'none';
  el('details-panel').style.display = 'none';
}

function populateFields(article) {
  el('title-input').value = article.meta.title || '';
  el('field-commercial-question').value = article.meta.commercialQuestion || '';
  el('field-summary').value = article.meta.summary || '';
  el('field-seo-description').value = article.meta.seoDescription || '';
  el('field-linkedin-url').value = article.meta.linkedinUrl || '';
  state.coverImage = article.meta.coverImage || '';
  state.keywords = [...(article.meta.keywords || [])];
  renderCoverPreview();
  renderKeywordChips();
  el('publish-btn').textContent = article.meta.status === 'published' ? 'Republish' : 'Publish';
  el('save-btn').textContent = article.meta.status === 'published' ? 'Save' : 'Save Draft';
  setSaveStatus('');
  state.dirty = false;
}

async function selectArticle(slug) {
  const article = await api('GET', `/api/articles/${slug}`);
  state.selectedSlug = slug;
  state.current = article;
  showEditorPanels();
  populateFields(article);
  const displayDoc = walkAndRewriteImages(article.bodyJson, (src) => toDisplaySrc(slug, src));
  initEditor(displayDoc);
  renderList();
}

async function createArticle() {
  const article = await api('POST', '/api/articles', { title: 'Untitled' });
  await loadArticles();
  await selectArticle(article.slug);
  el('title-input').focus();
}

// ---------------------------------------------------------------------
// Save / Publish / Duplicate / Delete / Preview / Push
// ---------------------------------------------------------------------

function gatherPayload() {
  return {
    title: el('title-input').value.trim() || 'Untitled',
    coverImage: state.coverImage || '',
    commercialQuestion: el('field-commercial-question').value,
    summary: el('field-summary').value,
    seoDescription: el('field-seo-description').value,
    keywords: state.keywords,
    linkedinUrl: el('field-linkedin-url').value,
    bodyJson: walkAndRewriteImages(state.editor.getJSON(), (src) => toStoredSrc(state.current.slug, src)),
  };
}

async function saveArticle({ silent } = {}) {
  if (!state.current) return undefined;
  if (!silent) setSaveStatus('Saving…');
  const updated = await api('PUT', `/api/articles/${state.current.slug}`, gatherPayload());
  state.current = { slug: state.current.slug, meta: updated.meta, bodyJson: updated.bodyJson };
  state.dirty = false;
  setSaveStatus(silent ? '' : 'Saved');
  await loadArticles();
  return updated;
}

async function refreshGitStatus() {
  const status = await api('GET', '/api/git-status');
  el('git-branch').textContent = status.branch;
  const aheadEl = el('git-ahead');
  const pushBtn = el('push-btn');
  if (status.ahead > 0) {
    aheadEl.textContent = `${status.ahead} commit${status.ahead === 1 ? '' : 's'} ahead of origin`;
    aheadEl.classList.add('ahead');
    pushBtn.classList.add('visible');
  } else {
    aheadEl.textContent = 'up to date';
    aheadEl.classList.remove('ahead');
    pushBtn.classList.remove('visible');
  }
  return status;
}

async function previewArticle() {
  if (!state.current) return;
  await saveArticle({ silent: true });
  window.open(`/api/preview/${state.current.slug}/`, '_blank');
}

async function publishArticle() {
  if (!state.current) return;
  const title = el('title-input').value.trim() || 'Untitled';
  if (!window.confirm(`Publish "${title}"? This generates the live page and creates a commit. Nothing is pushed until you confirm separately.`)) return;
  await saveArticle({ silent: true });
  const result = await api('POST', `/api/articles/${state.current.slug}/publish`);
  state.current.meta = result.meta;
  populateFields(state.current);
  showToast('Published locally — review, then push when ready.');
  await loadArticles();
  await refreshGitStatus();
}

async function duplicateArticleCurrent() {
  if (!state.current) return;
  const copy = await api('POST', `/api/articles/${state.current.slug}/duplicate`);
  await loadArticles();
  await selectArticle(copy.slug);
  showToast('Duplicated as draft.');
}

async function deleteArticleCurrent() {
  if (!state.current) return;
  const title = el('title-input').value.trim() || 'Untitled';
  if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
  await api('DELETE', `/api/articles/${state.current.slug}`);
  state.current = null;
  state.selectedSlug = null;
  state.dirty = false;
  hideEditorPanels();
  await loadArticles();
  await refreshGitStatus();
  showToast('Deleted.');
}

async function pushNow() {
  const aheadText = el('git-ahead').textContent;
  if (!window.confirm(`Push (${aheadText}) to origin? This makes the published changes live on the real site.`)) return;
  el('push-btn').disabled = true;
  await withErrorToast(async () => {
    await api('POST', '/api/push');
    showToast('Pushed to origin — live shortly.');
  });
  el('push-btn').disabled = false;
  await refreshGitStatus();
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

el('new-article-btn').addEventListener('click', () => withErrorToast(createArticle));
el('preview-btn').addEventListener('click', () => withErrorToast(previewArticle));
el('save-btn').addEventListener('click', () => withErrorToast(() => saveArticle()));
el('publish-btn').addEventListener('click', () => withErrorToast(publishArticle));
el('duplicate-btn').addEventListener('click', () => withErrorToast(duplicateArticleCurrent));
el('delete-btn').addEventListener('click', () => withErrorToast(deleteArticleCurrent));
el('push-btn').addEventListener('click', () => withErrorToast(pushNow));

el('search-input').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderList();
});

document.querySelectorAll('.filter-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.filter = tab.dataset.filter;
    renderList();
  });
});

['title-input', 'field-commercial-question', 'field-summary', 'field-seo-description', 'field-linkedin-url'].forEach((id) => {
  el(id).addEventListener('input', markDirty);
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

(async function init() {
  await withErrorToast(loadArticles);
  await withErrorToast(refreshGitStatus);
})();
