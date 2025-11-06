// src/metrics.js
const os = require('os');
const config = require('./config');

const basic = Buffer.from(config.metrics.apiKey, 'utf8').toString('base64');
const SOURCE = config.metrics.source || 'jwt-pizza-service';

// ── 累计状态 ─────────────────────────────────────────────────────────
const httpByKey = new Map();                // `${method}|${route}|${status}` → {count, latencyMs}
const auth = { success: 0, failure: 0 };    // 认证结果
let activeUsersSet = new Set();             // 周期内去重用户
let pizzasSold = 0;
let pizzaFailures = 0;
let revenueCents = 0;
let pizzaCreationLatencyTotalMs = 0;

function incHttp(method, route, status, latencyMs) {
  const k = `${method}|${route}|${status}`;
  const prev = httpByKey.get(k) || { count: 0, latencyMs: 0 };
  prev.count += 1;
  prev.latencyMs += latencyMs;
  httpByKey.set(k, prev);
}

// ── 对外 API ────────────────────────────────────────────────────────
function authAttempt(ok) {
  if (ok) auth.success += 1;
  else auth.failure += 1;
}

function pizzaPurchase(ok, latencyMs, priceCents) {
  if (ok) {
    pizzasSold += 1;
    revenueCents += Math.max(0, priceCents || 0);
  } else {
    pizzaFailures += 1;
  }
  if (latencyMs != null) pizzaCreationLatencyTotalMs += latencyMs;
}

// Express 中间件：请求追踪
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();

  // 如果 setAuthUser 放了 req.user，这里记录活跃用户
  if (req.user && (req.user.id || req.user.sub)) {
    activeUsersSet.add(String(req.user.id || req.user.sub));
  }

  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    const method = (req.method || 'GET').toUpperCase();
    const route = (req.route && req.route.path) || req.originalUrl || req.path || 'unknown';
    const status = res.statusCode || 0;
    incHttp(method, route, status, ms);

    // 把 /api/auth* 访问计入认证尝试
    if (/^\/api\/auth\b/i.test(route)) {
      authAttempt(status >= 200 && status < 300);
    }
  });

  next();
}

// ── 系统 gauge ──────────────────────────────────────────────────────
function getCpuPercent() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Math.round(cpuUsage * 100);
}
function getMemPercent() {
  const total = os.totalmem();
  const free = os.freemem();
  return Math.round(((total - free) / total) * 100);
}

// ── OTLP/HTTP JSON ──────────────────────────────────────────────────
function otlpGauge(name, value, unit = '') {
  return {
    name, unit,
    gauge: {
      dataPoints: [{
        asInt: value,
        timeUnixNano: Date.now() * 1e9,
        attributes: [{ key: 'source', value: { stringValue: SOURCE } }],
      }],
    },
  };
}
function otlpSum(name, value, unit = '', attrs = []) {
  return {
    name, unit,
    sum: {
      aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
      isMonotonic: true,
      dataPoints: [{
        asInt: value,
        timeUnixNano: Date.now() * 1e9,
        attributes: [{ key: 'source', value: { stringValue: SOURCE } }, ...attrs],
      }],
    },
  };
}

async function push(metricsArr) {
  if (process.env.NODE_ENV === 'test') return; // 测试阶段不外发
  const body = JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: metricsArr }] }] });
  const res = await fetch(config.metrics.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Failed to push metrics', res.status, text);
  }
}

// ── 周期上报 ────────────────────────────────────────────────────────
let timer = null;
function start(periodMs = 1000) {
  if (timer) return;
  timer = setInterval(() => {
    try {
      const arr = [];

      // 系统 & 活跃用户
      arr.push(otlpGauge('cpu_percent', getCpuPercent(), '%'));
      arr.push(otlpGauge('memory_percent', getMemPercent(), '%'));
      arr.push(otlpGauge('active_users', activeUsersSet.size, '1'));

      // HTTP 请求与端点总延迟（带维度）
      for (const [k, v] of httpByKey.entries()) {
        const [method, route, status] = k.split('|');
        const dims = [
          { key: 'method', value: { stringValue: method } },
          { key: 'route',  value: { stringValue: route } },
          { key: 'status', value: { stringValue: status } },
        ];
        arr.push(otlpSum('http_requests_total', v.count, '1', dims));
        arr.push(otlpSum('endpoint_latency_milliseconds_total', Math.round(v.latencyMs), 'ms', dims));
      }

      // 认证
      arr.push(otlpSum('auth_attempts_total', auth.success, '1', [{ key: 'outcome', value: { stringValue: 'success' } }]));
      arr.push(otlpSum('auth_attempts_total', auth.failure, '1', [{ key: 'outcome', value: { stringValue: 'failure' } }]));

      // 订单
      arr.push(otlpSum('pizzas_sold_total', pizzasSold, '1'));
      arr.push(otlpSum('pizza_failures_total', pizzaFailures, '1'));
      arr.push(otlpSum('revenue_cents_total', revenueCents, 'cents'));
      arr.push(otlpSum('pizza_creation_latency_milliseconds_total', Math.round(pizzaCreationLatencyTotalMs), 'ms'));

      push(arr).catch(console.error);

      // 活跃用户窗口清零（按周期统计）
      activeUsersSet = new Set();
      // 其余 counter 保持累计
    } catch (e) {
      console.error('Error building metrics', e);
    }
  }, periodMs);
}

module.exports = { start, requestTracker, authAttempt, pizzaPurchase };
