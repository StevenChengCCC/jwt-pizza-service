const os = require('os');
const config = require('./config');

const METRICS_CONFIG = config.metrics || {};
const SOURCE = process.env.METRICS_SOURCE || METRICS_CONFIG.source || 'jwt-pizza-service';
const URL = process.env.METRICS_URL || METRICS_CONFIG.url || '';
const API_KEY = process.env.METRICS_API_KEY || METRICS_CONFIG.apiKey || '';
const BASIC = API_KEY ? Buffer.from(API_KEY, 'utf8').toString('base64') : '';

const state = {
  totalRequests: 0,
  getRequests: 0,
  postRequests: 0,
// ... [rest of state remains unchanged]
  putRequests: 0,
  deleteRequests: 0,

  successfulAuth: 0,
  failedAuth: 0,

  msRequestLatency: 0,

  activeUsers: 0,

  endpoint: new Map(),

  pizzasSold: 0,
  pizzaFailures: 0,
  revenueCents: 0,
  pizzaCreationLatencyTotalMs: 0,
};

// 确保这里的 console.log 也使用新的变量名
console.log("[metrics] url=", URL, 
            "enabled=", !!(URL && API_KEY),
            "source=", SOURCE);
function incrementTotalRequests() { state.totalRequests += 1; }
function incrementGetRequests()   { state.getRequests   += 1; }
function incrementPostRequests()  { state.postRequests  += 1; }
function incrementPutRequests()   { state.putRequests   += 1; }
function incrementDeleteRequests(){ state.deleteRequests+= 1; }

function incrementSuccessfulAuth(){ state.successfulAuth += 1; }
function incrementFailedAuth()    { state.failedAuth     += 1; }

function updateMsRequestLatency(ms) {
  if (typeof ms === 'number' && ms > 0) state.msRequestLatency = ms;
}
function incrementActiveUsers()   { state.activeUsers    += 1; }

function pizzaPurchase(success, latencyMs, priceCents) {
  if (success) {
    state.pizzasSold += 1;
    state.revenueCents += Math.max(0, priceCents || 0);
  } else {
    state.pizzaFailures += 1;
  }
  if (typeof latencyMs === 'number' && latencyMs >= 0) {
    state.pizzaCreationLatencyTotalMs += latencyMs;
  }
}

function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;

    incrementTotalRequests();
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') incrementGetRequests();
    else if (method === 'POST') incrementPostRequests();
    else if (method === 'PUT') incrementPutRequests();
    else if (method === 'DELETE') incrementDeleteRequests();

    const route = (req.route && req.route.path) || req.originalUrl || req.path || 'unknown';
    const status = res.statusCode || 0;
    const key = `${method}|${route}|${status}`;
    const prev = state.endpoint.get(key) || { count: 0, latencyMs: 0 };
    prev.count += 1;
    prev.latencyMs += ms;
    state.endpoint.set(key, prev);

    updateMsRequestLatency(ms);
  });
  next();
}

function cpuPercent() {
  const usage = os.loadavg()[0] / os.cpus().length;
  return Math.max(0, Math.round(usage * 100));
}
function memoryPercent() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = ((total - free) / total) * 100;
  return Math.max(0, Math.round(usedPct));
}

function nsNow() {
  return (BigInt(Date.now()) * 1000000n).toString(); // ms → ns
}

function gauge(name, value, unit = '', attrs = []) {
  return {
    name,
    unit,
    gauge: {
      dataPoints: [{
        asInt: Math.max(0, Math.round(value)),
        timeUnixNano: nsNow(), // 字符串整数
        attributes: [{ key: 'source', value: { stringValue: SOURCE } }, ...attrs],
      }],
    },
  };
}

function sumCounter(name, value, unit = '', attrs = []) {
  return {
    name,
    unit,
    sum: {
      aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
      isMonotonic: true,
      dataPoints: [{
        asInt: Math.max(0, Math.round(value)),
        timeUnixNano: nsNow(), // 字符串整数
        attributes: [{ key: 'source', value: { stringValue: SOURCE } }, ...attrs],
      }],
    },
  };
}

function buildAllMetrics() {
  const arr = [];

  arr.push(sumCounter('http_requests_total', state.totalRequests, '1', [{ key: 'method', value: { stringValue: 'ALL' } }]));
  arr.push(sumCounter('http_requests_total', state.getRequests,   '1', [{ key: 'method', value: { stringValue: 'GET' } }]));
  arr.push(sumCounter('http_requests_total', state.postRequests,  '1', [{ key: 'method', value: { stringValue: 'POST' } }]));
  arr.push(sumCounter('http_requests_total', state.putRequests,   '1', [{ key: 'method', value: { stringValue: 'PUT' } }]));
  arr.push(sumCounter('http_requests_total', state.deleteRequests,'1', [{ key: 'method', value: { stringValue: 'DELETE' } }]));

  for (const [key, v] of state.endpoint.entries()) {
    const [method, route, status] = key.split('|');
    const dims = [
      { key: 'method', value: { stringValue: method } },
      { key: 'route',  value: { stringValue: route } },
      { key: 'status', value: { stringValue: status } },
    ];
    arr.push(sumCounter('http_requests_total', v.count, '1', dims));
    arr.push(sumCounter('endpoint_latency_milliseconds_total', Math.round(v.latencyMs), 'ms', dims));
  }

  arr.push(gauge('active_users', state.activeUsers, '1'));

  arr.push(sumCounter('auth_attempts_total', state.successfulAuth, '1', [{ key: 'outcome', value: { stringValue: 'success' } }]));
  arr.push(sumCounter('auth_attempts_total', state.failedAuth,     '1', [{ key: 'outcome', value: { stringValue: 'failure' } }]));

  arr.push(gauge('cpu_percent', cpuPercent(), '%'));
  arr.push(gauge('memory_percent', memoryPercent(), '%'));

  arr.push(sumCounter('pizzas_sold_total', state.pizzasSold, '1'));
  arr.push(sumCounter('pizza_failures_total', state.pizzaFailures, '1'));
  arr.push(sumCounter('revenue_cents_total', state.revenueCents, 'cents'));
  arr.push(sumCounter('pizza_creation_latency_milliseconds_total', Math.round(state.pizzaCreationLatencyTotalMs), 'ms'));

  return arr;
}

async function send(metricsArr) {
  if (!URL || !BASIC) return;
  if (process.env.NODE_ENV === 'test') return;
  const body = JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: metricsArr }] }] });

  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${BASIC}`,
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('Failed to push metrics', res.status, txt);
  }
}

function clearWindow() {
  state.activeUsers = 0;
}

function sendMetricsPeriodically(periodMs) {
  setInterval(() => {
    try {
      const m = buildAllMetrics();
      clearWindow();
      void send(m);
    } catch (e) {
      console.log('Error sending metrics', e);
    }
  }, periodMs);
}
module.exports = {
  incrementTotalRequests,
  incrementGetRequests,
  incrementPostRequests,
  incrementPutRequests,
  incrementDeleteRequests,
  incrementSuccessfulAuth,
  incrementFailedAuth,
  updateMsRequestLatency,
  incrementActiveUsers,
  pizzaPurchase,
  requestTracker,
  sendMetricsPeriodically,
  start(periodMs = 10000) {
    sendMetricsPeriodically(periodMs);
  },
};