import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Transform,
  Selector,
  MatchOption,
  QueryContext,
  initDefaultTypeInfo,
  getStringAttr,
  getStringInvoke,
  getIntInvoke,
  getBooleanInvoke,
} from '@gkd-kit/selector';
import { retrieveFewShot, buildFewShotPrompt } from './rag.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const D_DATASET_DIR = 'D:\\gkd-dataset';
const USE_D_DRIVE = fs.existsSync(D_DATASET_DIR);
const CRAWLER_DIR = USE_D_DRIVE ? D_DATASET_DIR : path.join(ROOT_DIR, '.scratch', 'dataset-crawler');
const SAMPLES_FILE = path.join(CRAWLER_DIR, 'verified_samples.jsonl');
const SNAPSHOTS_DIR = path.join(CRAWLER_DIR, 'snapshots');
console.log(`[Storage] Using dataset directory: ${CRAWLER_DIR}`);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLEAN_DIR = path.join(CRAWLER_DIR, 'clean');
const FEWSHOT_LIBRARY_FILE = path.join(CLEAN_DIR, 'fewshot_library.jsonl');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8899;

// Global Selector environment
let cachedGlobals = null;
function getGlobals() {
  if (!cachedGlobals) {
    cachedGlobals = {
      matchOption: new MatchOption(false),
      typeInfo: initDefaultTypeInfo(true),
    };
  }
  return cachedGlobals;
}

function unwrapNode(target) {
  if (target == null) return null;
  if (target instanceof QueryContext) {
    const c = target.current;
    return (c && typeof c === 'object' && 'attr' in c) ? c : null;
  }
  if (typeof target === 'object' && 'attr' in target) {
    return target;
  }
  return null;
}

function readAttr(target, name) {
  if (name === '_id') {
    const n = unwrapNode(target);
    return n ? n.id : null;
  }
  if (name === '_pid') {
    const n = unwrapNode(target);
    return n ? n.pid : null;
  }
  if (typeof target === 'string') return getStringAttr(target, name);
  if (typeof target === 'number' || typeof target === 'boolean') return null;
  const node = unwrapNode(target);
  if (!node) return null;
  if (name === 'text.length') return node.attr.text?.length ?? 0;
  const value = node.attr[name];
  if (value === undefined || value === null) return null;
  return value;
}

function buildTransform(nodeById) {
  return Transform.Companion.multiplatformBuild(
    (node, name) => readAttr(node, name),
    (node, fnName, args) => {
      if (typeof node === 'string') return getStringInvoke(node, fnName, args);
      if (typeof node === 'number') return getIntInvoke(node, fnName, args);
      if (typeof node === 'boolean') return getBooleanInvoke(node, fnName, args);
      const real = unwrapNode(node);
      if (!real) return null;
      if (fnName === 'getChild') {
        const view = typeof args?.asJsReadonlyArrayView === 'function'
          ? args.asJsReadonlyArrayView()
          : args;
        const i = view[0] ?? 0;
        return nodeById.get(real.children[i]) ?? null;
      }
      return null;
    },
    (node) => {
      const real = unwrapNode(node);
      return real ? real.attr.name : null;
    },
    (node) => {
      const real = unwrapNode(node);
      if (!real) return [];
      const out = [];
      for (const id of real.children) {
        const c = nodeById.get(id);
        if (c) out.push(c);
      }
      return out;
    },
    (node) => {
      const real = unwrapNode(node);
      if (!real) return null;
      return real.pid >= 0 ? nodeById.get(real.pid) ?? null : null;
    }
  );
}

// Memory cache for snapshots
const snapshotCache = new Map();

function getNormalizedSnapshot(snapshotId) {
  if (snapshotCache.has(snapshotId)) {
    return snapshotCache.get(snapshotId);
  }
  const jsonPath = path.join(SNAPSHOTS_DIR, String(snapshotId), `${snapshotId}.json`);
  if (!fs.existsSync(jsonPath)) {
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const nodes = (raw.nodes || []).map(n => ({
    ...n,
    attr: {
      ...n.attr,
      id: n.attr.id ?? null,
      vid: n.attr.vid ?? null,
      text: n.attr.text ?? null,
      desc: n.attr.desc ?? null,
      clickable: Boolean(n.attr.clickable),
      focusable: Boolean(n.attr.focusable),
      checkable: Boolean(n.attr.checkable),
      checked: Boolean(n.attr.checked),
      editable: Boolean(n.attr.editable),
      longClickable: Boolean(n.attr.longClickable),
      visibleToUser: Boolean(n.attr.visibleToUser),
    },
    children: [],
  }));
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    if (n.pid >= 0) {
      nodeById.get(n.pid)?.children.push(n.id);
    }
  }
  const entry = { raw, nodes, nodeById };
  snapshotCache.set(snapshotId, entry);
  return entry;
}

function splitSelectorUnion(expr) {
  const segments = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      current += ch;
      if (ch === quoteChar && expr[i - 1] !== '\\') {
        inQuote = false;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
        current += ch;
      } else if (ch === '[') {
        bracketDepth++;
        current += ch;
      } else if (ch === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        current += ch;
      } else if (ch === '(') {
        parenDepth++;
        current += ch;
      } else if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        current += ch;
      } else if (ch === ',' && bracketDepth === 0 && parenDepth === 0) {
        if (current.trim()) segments.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments.length > 0 ? segments : [expr];
}

function matchSingleExpr(nodes, nodeById, expr) {
  const ast = Selector.Companion.parseAst(expr);
  const { matchOption, typeInfo } = getGlobals();
  ast.value.checkType(typeInfo.globalType);
  const transform = buildTransform(nodeById);
  const root = nodes.find(n => n.pid < 0) ?? nodes[0];
  if (!root) return { hit: false, reason: 'empty-snapshot', clickIds: [], supportIds: [] };

  const results = transform.querySelectorAllContextArray(root, ast.value, matchOption);
  const seenClick = new Set();
  const clickIds = [];
  const supportIds = new Set();

  for (const r of results) {
    const target = r.target;
    if (target && !seenClick.has(target.id)) {
      seenClick.add(target.id);
      clickIds.push(target.id);
    }
    if (r.context) {
      for (const ctx of r.context.toArray()) {
        if (ctx.id !== target?.id) {
          supportIds.add(ctx.id);
        }
      }
    }
  }
  return {
    hit: clickIds.length > 0,
    hitCount: clickIds.length,
    clickIds,
    supportIds: [...supportIds],
    matchedExpr: expr,
  };
}

function evaluateSelector(snapshotId, selector) {
  const norm = getNormalizedSnapshot(snapshotId);
  if (!norm) {
    return { error: `Snapshot ${snapshotId} not found on server.` };
  }
  if (!selector || !selector.trim()) {
    return { hit: false, hitCount: 0, clickIds: [], supportIds: [], targetNodes: [] };
  }

  const startTime = Date.now();
  try {
    const subExprs = splitSelectorUnion(selector.trim());
    let bestResult = null;
    let lastError = null;

    for (const sub of subExprs) {
      try {
        const res = matchSingleExpr(norm.nodes, norm.nodeById, sub);
        if (res.hit) {
          bestResult = res;
          break;
        }
        if (!bestResult) bestResult = res;
      } catch (err) {
        lastError = err;
      }
    }

    if (!bestResult && lastError) {
      return {
        error: lastError.message || String(lastError),
        hit: false,
        hitCount: 0,
        clickIds: [],
        supportIds: [],
        targetNodes: [],
        elapsedMs: Date.now() - startTime,
      };
    }

    const clickIds = bestResult?.clickIds || [];
    const supportIds = bestResult?.supportIds || [];
    const targetNodes = clickIds.map(id => {
      const node = norm.nodeById.get(id);
      if (!node) return null;
      return {
        id: node.id,
        name: node.attr.name,
        vid: node.attr.vid,
        id_attr: node.attr.id,
        text: node.attr.text,
        desc: node.attr.desc,
        clickable: node.attr.clickable,
        visibleToUser: node.attr.visibleToUser,
        bounds: {
          left: node.attr.left,
          top: node.attr.top,
          right: node.attr.right,
          bottom: node.attr.bottom,
          width: node.attr.width,
          height: node.attr.height,
        }
      };
    }).filter(Boolean);

    return {
      hit: clickIds.length > 0,
      hitCount: clickIds.length,
      clickIds,
      supportIds,
      targetNodes,
      matchedExpr: bestResult?.matchedExpr || selector,
      elapsedMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      error: err.message || String(err),
      hit: false,
      hitCount: 0,
      clickIds: [],
      supportIds: [],
      targetNodes: [],
      elapsedMs: Date.now() - startTime,
    };
  }
}

// ---- Few-shot (RAG) index ----
let fewShotLibrary = null;
let featureIndex = null;

function readJsonlFile(file) {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function ensureFewShotLoaded() {
  if (fewShotLibrary && featureIndex) return true;
  if (!fs.existsSync(FEWSHOT_LIBRARY_FILE)) return false;
  fewShotLibrary = readJsonlFile(FEWSHOT_LIBRARY_FILE);
  featureIndex = new Map();
  for (const name of ['train.jsonl', 'val.jsonl', 'test.jsonl']) {
    const file = path.join(CLEAN_DIR, name);
    if (!fs.existsSync(file)) continue;
    for (const record of readJsonlFile(file)) {
      featureIndex.set(record.id, record);
    }
  }
  console.log(`[RAG] library=${fewShotLibrary.length}, indexed=${featureIndex.size}`);
  return true;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API 1: List all samples
  if (req.method === 'GET' && pathname === '/api/samples') {
    if (!fs.existsSync(SAMPLES_FILE)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'verified_samples.jsonl not found' }));
      return;
    }
    const lines = fs.readFileSync(SAMPLES_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    const samples = lines.map((l, index) => {
      const data = JSON.parse(l);
      data.sampleIndex = index;
      return data;
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(samples));
    return;
  }

  // API 2: Get snapshot node tree & metadata
  const snapMatch = pathname.match(/^\/api\/snapshot\/(\d+)$/);
  if (req.method === 'GET' && snapMatch) {
    const snapshotId = snapMatch[1];
    const norm = getNormalizedSnapshot(snapshotId);
    if (!norm) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Snapshot not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(norm.raw));
    return;
  }

  // API 3: Get screenshot image
  const imgMatch = pathname.match(/^\/api\/screenshot\/(\d+)$/);
  if (req.method === 'GET' && imgMatch) {
    const snapshotId = imgMatch[1];
    const folder = path.join(SNAPSHOTS_DIR, snapshotId);
    const pngPath = path.join(folder, `${snapshotId}.png`);
    const webpPath = path.join(folder, `${snapshotId}.webp`);
    let imgFile = null;
    let mime = 'image/png';
    if (fs.existsSync(pngPath)) {
      imgFile = pngPath;
      mime = 'image/png';
    } else if (fs.existsSync(webpPath)) {
      imgFile = webpPath;
      mime = 'image/webp';
    }
    if (!imgFile) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Image not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(imgFile).pipe(res);
    return;
  }

  // API 4: Real-time selector matching
  if (req.method === 'POST' && pathname === '/api/match') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { snapshotId, selector } = payload;
        const result = evaluateSelector(snapshotId, selector);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON request' }));
      }
    });
    return;
  }

  // API 5: Few-shot 相似案例检索
  if (req.method === 'GET' && pathname === '/api/fewshot') {
    if (!ensureFewShotLoaded()) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'fewshot_library.jsonl 不存在，请先运行清洗脚本' }));
      return;
    }
    const snapshotId = urlObj.searchParams.get('snapshotId') || '';
    const targetId = urlObj.searchParams.get('targetId') || '';
    const k = Math.min(10, Math.max(1, Number(urlObj.searchParams.get('k') || 3)));
    const query = featureIndex.get(`${snapshotId}:${targetId}`);
    if (!query) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '该控件不在真值索引中' }));
      return;
    }
    const pool = fewShotLibrary.filter((record) => record.id !== query.id);
    const hits = retrieveFewShot(pool, query, k);
    const examples = hits.map((hit) => ({
      id: hit.record.id,
      score: Number(hit.score.toFixed(3)),
      appName: hit.record.appName,
      groupName: hit.record.groupName,
      selector: hit.record.selector,
      selectorKind: hit.record.selectorShape?.kind || 'unknown',
      target: hit.record.target,
      siblings: hit.record.context.siblings.slice(0, 3),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        query: {
          id: query.id,
          appName: query.appName,
          groupName: query.groupName,
          selector: query.selector,
          features: query.features,
        },
        examples,
        prompt: buildFewShotPrompt(query, hits),
      }),
    );
    return;
  }

  // Static files
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 GKD Rule Workbench Server running at:`);
  console.log(`👉 http://127.0.0.1:${PORT}`);
  console.log(`======================================================\n`);
});
