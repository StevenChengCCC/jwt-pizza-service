const config = require('./config');

// ---- Loki config ----
const LOG_CONFIG = config.logging || {};
// 优先从环境变量读取
const LOKI_URL = process.env.LOGGING_URL || LOG_CONFIG.url || ''; 
const USER_ID = process.env.LOGGING_USER_ID || LOG_CONFIG.userId || '';
const API_KEY = process.env.LOGGING_API_KEY || LOG_CONFIG.apiKey || '';
const LOKI_BEARER = USER_ID && API_KEY ? `${USER_ID}:${API_KEY}` : '';

const FINAL_USER_ID = process.env.LOGGING_USER_ID || LOG_CONFIG.userId;
const FINAL_API_KEY = process.env.LOGGING_API_KEY || LOG_CONFIG.apiKey;
const FINAL_LOKI_BEARER = FINAL_USER_ID && FINAL_API_KEY ? `${FINAL_USER_ID}:${FINAL_API_KEY}` : '';

const SOURCE = process.env.LOGGING_SOURCE || LOG_CONFIG.source || 'jwt-pizza-service';
const ENV = process.env.NODE_ENV || 'production';

const QUEUE = [];
const MAX_BATCH = 500;
const FLUSH_MS = 1000;
let flushing = false;

function nsNow() {
  return (BigInt(Date.now()) * 1000000n).toString();
}

function truncate(v, max = 5000) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

function sanitize(objOrStr) {
  const mask = (s) =>
    String(s).replace(
      /(Bearer\s+[A-Za-z0-9._:-]+|api[-_]?key"?\s*[:=]\s*"?.*?"?|password"?\s*[:=]\s*"?.*?"?|authorization"?\s*:\s*".*?")/gi,
      '[REDACTED]'
    );

  if (objOrStr == null) return '';
  if (typeof objOrStr === 'string') return mask(objOrStr);
  try {
    return mask(JSON.stringify(objOrStr));
  } catch {
    return mask(String(objOrStr));
  }
}

function enqueue(streamLabels, lineObj) {
  const labels = {
    source: SOURCE,
    env: ENV,
    ...streamLabels,
  };

  const line = [nsNow(), JSON.stringify(lineObj)];
  QUEUE.push({ labels, line });
}

async function flush() {
  if (!LOKI_URL || !FINAL_LOKI_BEARER) return;
  if (flushing || QUEUE.length === 0) return;
  flushing = true;

  try {
    const batch = QUEUE.splice(0, MAX_BATCH);
    const map = new Map();

    for (const { labels, line } of batch) {
      const key = JSON.stringify(labels);
      if (!map.has(key)) {
        map.set(key, { stream: labels, values: [] });
      }
      map.get(key).values.push(line);
    }

    const payload = { streams: [...map.values()] };

    const res = await fetch(LOKI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Loki 的 Basic Auth header 格式
        Authorization: `Basic ${Buffer.from(FINAL_LOKI_BEARER, 'utf8').toString('base64')}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[loki] push failed', res.status, t);
    }
  } catch (e) {
    console.error('[loki] flush error', e);
  } finally {
    flushing = false;
  }
}

setInterval(flush, FLUSH_MS);


// 1) HTTP 日志中间件
function httpLogger(req, res, next) {
  const started = process.hrtime.bigint();

  const reqBody = req.is('application/json') && req.body ? req.body : undefined;
  const hasAuth = !!(req.headers && req.headers.authorization);

  const origSend = res.send.bind(res);
  let respBodyStr = '';

  res.send = (body) => {
    try {
      respBodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    } catch {
      respBodyStr = String(body);
    }
    respBodyStr = truncate(sanitize(respBodyStr), 3000);
    res.send = origSend;
    return res.send(body);
  };

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    enqueue(
      { stream: 'http' },
      {
        ts: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        hasAuth,
        reqBody: truncate(sanitize(reqBody), 2000),
        respBody: respBodyStr,
        latencyMs: Math.round(elapsedMs),
        ip: req.ip || req.headers['x-forwarded-for'] || '',
        ua: truncate(req.headers['user-agent'] || '', 300),
      }
    );
  });

  next();
}

// 2) DB 日志
function logDb(query, params = [], durationMs = undefined) {
  enqueue(
    { stream: 'db' },
    {
      ts: new Date().toISOString(),
      query: truncate(sanitize(query), 2000),
      params: truncate(sanitize(params), 1000),
      durationMs: durationMs != null ? Math.round(durationMs) : undefined,
    }
  );
}

// 3) 调用 pizza-factory 日志
function logFactoryRequest({ url, reqBody, status, respBody, latencyMs }) {
  enqueue(
    { stream: 'factory' },
    {
      ts: new Date().toISOString(),
      url,
      status,
      latencyMs: Math.round(latencyMs || 0),
      reqBody: truncate(sanitize(reqBody), 2000),
      respBody: truncate(sanitize(respBody), 2000),
    }
  );
}

// 4) 错误日志（全局 error handler 用）
function logError(err, ctx = {}) {
  enqueue(
    { stream: 'error' },
    {
      ts: new Date().toISOString(),
      name: err?.name || 'Error',
      message: truncate(sanitize(err?.message || ''), 2000),
      stack: truncate(String(err?.stack || ''), 4000),
      context: truncate(sanitize(ctx), 2000),
    }
  );
}

module.exports = {
  httpLogger,
  logDb,
  logFactoryRequest,
  logError,
};