'use strict';

// Local-only admin server for the Insights content system. Binds to
// 127.0.0.1 only — never deployed, never given a GitHub token. "Publish"
// shells out to the machine's own already-authenticated git client instead
// of any web-based auth flow. Push is always a separate, explicit step.
//
// All article -> HTML/JSON-LD/sitemap rendering happens in build-insights.js;
// this server only decides *when* to call it and what to do with the result.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const insights = require('../build-insights.js');

const ROOT = path.join(__dirname, '..');
const ARTICLES_DIR = path.join(ROOT, 'content', 'articles');
const ADMIN_DIR = __dirname;
const HOST = '127.0.0.1';
const PORT = 5177;

const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024; // covers a base64-encoded ~8MB image
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILENAME_RE = /^[A-Za-z0-9_.-]+$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------
// Slug / path safety
// ---------------------------------------------------------------------

function assertValidSlug(slug) {
  if (typeof slug !== 'string' || slug.length > 100 || !SLUG_RE.test(slug)) {
    throw new HttpError(400, 'Invalid slug');
  }
}

function articleDir(slug) {
  assertValidSlug(slug);
  return path.join(ARTICLES_DIR, slug);
}

function slugify(title) {
  const base = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics after NFKD
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'article';
}

function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (fs.existsSync(path.join(ARTICLES_DIR, slug))) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

// ---------------------------------------------------------------------
// Article CRUD (reads/writes content/articles/<slug>/{meta.json,body.json})
// ---------------------------------------------------------------------

function emptyDoc() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function listArticleSummaries() {
  if (!fs.existsSync(ARTICLES_DIR)) return [];
  return fs.readdirSync(ARTICLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const metaPath = path.join(ARTICLES_DIR, entry.name, 'meta.json');
      if (!fs.existsSync(metaPath)) return null;
      return { slug: entry.name, meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.meta.updatedAt || 0) - new Date(a.meta.updatedAt || 0));
}

function getArticle(slug) {
  const dir = articleDir(slug);
  const metaPath = path.join(dir, 'meta.json');
  const bodyPath = path.join(dir, 'body.json');
  if (!fs.existsSync(metaPath) || !fs.existsSync(bodyPath)) {
    throw new HttpError(404, 'Article not found');
  }
  return {
    slug,
    meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')),
    bodyJson: JSON.parse(fs.readFileSync(bodyPath, 'utf8')),
  };
}

function createArticle(input) {
  const title = (input.title || 'Untitled').trim() || 'Untitled';
  const slug = uniqueSlug(slugify(title));
  const dir = articleDir(slug);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const now = new Date().toISOString();
  const meta = {
    title,
    slug,
    coverImage: '',
    commercialQuestion: input.commercialQuestion || '',
    summary: input.summary || '',
    seoDescription: input.seoDescription || '',
    keywords: Array.isArray(input.keywords) ? input.keywords : [],
    linkedinUrl: input.linkedinUrl || '',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'body.json'), JSON.stringify(input.bodyJson || emptyDoc(), null, 2));
  return { slug, meta, bodyJson: input.bodyJson || emptyDoc() };
}

function saveArticle(slug, input) {
  const existing = getArticle(slug); // throws 404 if missing
  const dir = articleDir(slug);
  const meta = {
    ...existing.meta,
    title: input.title ?? existing.meta.title,
    coverImage: input.coverImage ?? existing.meta.coverImage,
    commercialQuestion: input.commercialQuestion ?? existing.meta.commercialQuestion,
    summary: input.summary ?? existing.meta.summary,
    seoDescription: input.seoDescription ?? existing.meta.seoDescription,
    keywords: Array.isArray(input.keywords) ? input.keywords : existing.meta.keywords,
    linkedinUrl: input.linkedinUrl ?? existing.meta.linkedinUrl,
    updatedAt: new Date().toISOString(),
  };
  const bodyJson = input.bodyJson ?? existing.bodyJson;
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'body.json'), JSON.stringify(bodyJson, null, 2));
  return { slug, meta, bodyJson };
}

function duplicateArticle(slug) {
  const src = getArticle(slug);
  const newSlug = uniqueSlug(slugify(`${src.meta.title}-copy`));
  const destDir = articleDir(newSlug);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'body.json'), JSON.stringify(src.bodyJson, null, 2));

  const srcImages = path.join(articleDir(slug), 'images');
  const destImages = path.join(destDir, 'images');
  fs.mkdirSync(destImages, { recursive: true });
  if (fs.existsSync(srcImages)) {
    for (const file of fs.readdirSync(srcImages)) {
      fs.copyFileSync(path.join(srcImages, file), path.join(destImages, file));
    }
  }

  const now = new Date().toISOString();
  const meta = {
    ...src.meta,
    slug: newSlug,
    title: `${src.meta.title} (Copy)`,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
  };
  fs.writeFileSync(path.join(destDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { slug: newSlug, meta, bodyJson: src.bodyJson };
}

function deleteArticle(slug) {
  const dir = articleDir(slug);
  if (!fs.existsSync(dir)) throw new HttpError(404, 'Article not found');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { wasPublished: meta.status === 'published' };
}

function publishArticle(slug) {
  const article = getArticle(slug);
  const dir = articleDir(slug);
  const now = new Date().toISOString();
  const meta = {
    ...article.meta,
    status: 'published',
    publishedAt: article.meta.publishedAt || now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

// ---------------------------------------------------------------------
// Image uploads — base64 data URL in, relative path out, per-article folder
// ---------------------------------------------------------------------

const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function saveImage(slug, dataUrl) {
  const dir = articleDir(slug);
  if (!fs.existsSync(dir)) throw new HttpError(404, 'Article not found');
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw new HttpError(400, 'Unsupported image type');
  const ext = IMAGE_MIME_EXT[match[1]];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new HttpError(413, 'Image too large');
  }
  const imagesDir = path.join(dir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(imagesDir, filename), buffer);
  return `images/${filename}`;
}

// ---------------------------------------------------------------------
// Git — build+commit on publish, push only on a separate explicit call
// ---------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

function buildAndCommit(message) {
  insights.buildAll();
  git(['add', '-A']);
  const staged = git(['diff', '--cached', '--name-only']).trim();
  if (!staged) return { committed: false };
  git(['commit', '-m', message]);
  return { committed: true };
}

function getGitStatus() {
  const branch = currentBranch();
  try {
    git(['fetch', 'origin', branch, '--quiet']);
  } catch (err) {
    // Offline or no remote configured — fall back to the last-known ref.
  }
  let ahead = 0;
  try {
    ahead = parseInt(git(['rev-list', '--count', `origin/${branch}..HEAD`]).trim(), 10) || 0;
  } catch (err) {
    ahead = 0;
  }
  const dirty = git(['status', '--porcelain']).trim().length > 0;
  return { branch, ahead, dirty };
}

function pushOrigin() {
  const branch = currentBranch();
  git(['push', 'origin', branch]);
  return { branch };
}

// ---------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readRequestBody(req, MAX_JSON_BODY_BYTES);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

const STATIC_FILES = {
  '': 'index.html',
  'index.html': 'index.html',
  'app.js': 'app.js',
  'style.css': 'style.css',
};

const STATIC_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(reqPath, res) {
  const key = reqPath.replace(/^\/+/, '');
  const filename = STATIC_FILES[key];
  if (!filename) return false;
  const filePath = path.join(ADMIN_DIR, filename);
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': STATIC_CONTENT_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function serveArticleImage(slug, filename, res) {
  assertValidSlug(slug);
  if (!FILENAME_RE.test(filename)) return sendError(res, 400, 'Invalid filename');
  const dir = path.join(ARTICLES_DIR, slug, 'images');
  const filePath = path.join(dir, filename);
  if (path.dirname(filePath) !== dir || !fs.existsSync(filePath)) {
    return sendError(res, 404, 'Not found');
  }
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(method, segments, reqUrl, req, res) {
  // segments excludes the leading "api" segment, e.g. ['articles', 'my-slug', 'publish']
  const [resource, slug, action, sub] = segments;

  if (resource === 'articles' && !slug && method === 'GET') {
    return sendJson(res, 200, { articles: listArticleSummaries() });
  }
  if (resource === 'articles' && !slug && method === 'POST') {
    const input = await readJsonBody(req);
    return sendJson(res, 201, createArticle(input));
  }
  if (resource === 'articles' && slug && !action && method === 'GET') {
    return sendJson(res, 200, getArticle(slug));
  }
  if (resource === 'articles' && slug && !action && method === 'PUT') {
    const input = await readJsonBody(req);
    return sendJson(res, 200, saveArticle(slug, input));
  }
  if (resource === 'articles' && slug && !action && method === 'DELETE') {
    const result = deleteArticle(slug);
    let git_ = null;
    if (result.wasPublished) {
      buildAndCommit(`Remove "${slug}" from Insights`);
      git_ = getGitStatus();
    }
    return sendJson(res, 200, { deleted: true, git: git_ });
  }
  if (resource === 'articles' && slug && action === 'duplicate' && method === 'POST') {
    return sendJson(res, 201, duplicateArticle(slug));
  }
  if (resource === 'articles' && slug && action === 'publish' && method === 'POST') {
    const meta = publishArticle(slug);
    buildAndCommit(`Publish "${meta.title}"`);
    return sendJson(res, 200, { meta, git: getGitStatus() });
  }
  if (resource === 'images' && method === 'POST') {
    const input = await readJsonBody(req);
    if (!input.slug) throw new HttpError(400, 'Missing slug');
    const imagePath = saveImage(input.slug, input.dataUrl);
    return sendJson(res, 201, { path: imagePath });
  }
  if (resource === 'git-status' && method === 'GET') {
    return sendJson(res, 200, getGitStatus());
  }
  if (resource === 'push' && method === 'POST') {
    return sendJson(res, 200, pushOrigin());
  }

  throw new HttpError(404, 'Not found');
}

async function requestHandler(req, res) {
  const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(reqUrl.pathname);

  try {
    if (pathname.startsWith('/api/preview/')) {
      const rest = pathname.slice('/api/preview/'.length);
      const parts = rest.split('/').filter(Boolean);
      const slug = parts[0];
      assertValidSlug(slug);

      if (parts.length === 1) {
        if (!pathname.endsWith('/')) {
          res.writeHead(302, { Location: `${pathname}/` });
          return res.end();
        }
        const article = insights.readArticle(slug);
        if (!article) return sendError(res, 404, 'Article not found');
        const template = insights.readTemplate('article.html');
        return sendHtml(res, 200, insights.renderArticleHtml(article, template));
      }
      if (parts.length === 3 && parts[1] === 'images') {
        return serveArticleImage(slug, parts[2], res);
      }
      return sendError(res, 404, 'Not found');
    }

    if (pathname.startsWith('/api/')) {
      const segments = pathname.slice('/api/'.length).split('/').filter(Boolean);
      return await handleApi(req.method, segments, reqUrl, req, res);
    }

    if (req.method === 'GET' && serveStatic(pathname, res)) return;

    sendError(res, 404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err.status, err.message);
    } else {
      console.error(err);
      sendError(res, 500, 'Internal error');
    }
  }
}

const server = http.createServer((req, res) => {
  requestHandler(req, res).catch((err) => {
    console.error(err);
    sendError(res, 500, 'Internal error');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Insights admin running at http://${HOST}:${PORT} (local only)`);
});
