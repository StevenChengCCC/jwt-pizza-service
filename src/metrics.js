// src/metrics.js
const os = require('os');
const config = require('./config');

// ====== 基础配置（来自 CI 注入的 config.metrics）======
const SOURCE = (config.metrics && config.metrics.source) || 'jwt-pizza-service';
const URL = (config.metrics && config.metrics.url) || '';
// METRICS_API_KEY 形如 "1428600:glc_xxx"；Basic 认证时需 base64(id:token)
const BASIC = config.metrics ? Buffer.from(config.metrics.apiKey, 'utf8').toString('base64') : '';

// ====== 内部状态（累计）======
const state = {
  // HTTP - 方法/总量
  totalRequests: 0,
  getRequests: 0,
  postRequests: 0,
  putRequests: 0,
  deleteRequests: 0,

  // 认证
  successfulAuth: 0,
  failedAuth: 0,

  // 最近一次请求延迟（ms）
  msRequestLatency: 0,

  // 活跃用户（一个周期窗口）
  activeUsers: 0,

  // 端点维度累计：请求数 + 总延迟（用于平均延迟）
  // key = `${method}|${route}|${status}`
  endpoint: new Map(),

  // 订单
  pizzasSold: 0,
  pizzaFailures: 0,
  revenueCents: 0,
  pizzaCreationLatencyTotalMs: 0,
};

// ====== TA 风格：增量函数（按你助教示例命名）======
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

// 业务：下单指标
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

// ====== Express 中间件：端点统计 =======
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;

    // 总量/方法
    incrementTotalRequests();
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') incrementGetRequests();
    else if (method === 'POST') incrementPostRequests();
    else if (method === 'PUT') incrementPutRequests();
    else if (method === 'DELETE') incrementDeleteRequests();

    // 端点维度
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

// ====== 系统指标（gauge）======
function cpuPercent() {
  // loadavg(1m)/cpu核数 ≈ CPU 占用，转百分比
  const usage = os.loadavg()[0] / os.cpus().length;
  return Math.max(0, Math.round(usage * 100));
}
function memoryPercent() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = ((total - free) / total) * 100;
  return Math.max(0, Math.round(usedPct));
}

// ====== 时间戳（纳秒，字符串整数，避免浮点）======
function nsNow() {
  return (BigInt(Date.now()) * 1000000n).toString(); // ms → ns
}

// ====== OTLP/HTTP JSON builders =======
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

// ====== 组装所有必需指标 =======
function buildAllMetrics() {
  const arr = [];

  // A) HTTP by method + total
  arr.push(sumCounter('http_requests_total', state.totalRequests, '1', [{ key: 'method', value: { stringValue: 'ALL' } }]));
  arr.push(sumCounter('http_requests_total', state.getRequests,   '1', [{ key: 'method', value: { stringValue: 'GET' } }]));
  arr.push(sumCounter('http_requests_total', state.postRequests,  '1', [{ key: 'method', value: { stringValue: 'POST' } }]));
  arr.push(sumCounter('http_requests_total', state.putRequests,   '1', [{ key: 'method', value: { stringValue: 'PUT' } }]));
  arr.push(sumCounter('http_requests_total', state.deleteRequests,'1', [{ key: 'method', value: { stringValue: 'DELETE' } }]));

  // B) 端点维度：请求总数 + 总延迟
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

  // C) 活跃用户（gauge）
  arr.push(gauge('active_users', state.activeUsers, '1'));

  // D) 认证尝试（成功/失败）
  arr.push(sumCounter('auth_attempts_total', state.successfulAuth, '1', [{ key: 'outcome', value: { stringValue: 'success' } }]));
  arr.push(sumCounter('auth_attempts_total', state.failedAuth,     '1', [{ key: 'outcome', value: { stringValue: 'failure' } }]));

  // E) 系统（gauge）
  arr.push(gauge('cpu_percent', cpuPercent(), '%'));
  arr.push(gauge('memory_percent', memoryPercent(), '%'));

  // F) 订单（counter）
  arr.push(sumCounter('pizzas_sold_total', state.pizzasSold, '1'));
  arr.push(sumCounter('pizza_failures_total', state.pizzaFailures, '1'));
  arr.push(sumCounter('revenue_cents_total', state.revenueCents, 'cents'));
  arr.push(sumCounter('pizza_creation_latency_milliseconds_total', Math.round(state.pizzaCreationLatencyTotalMs), 'ms'));

  return arr;
}

// ====== 发送到 Grafana Cloud OTLP Gateway =======
async function send(metricsArr) {
  if (!URL || !BASIC) return;
  if (process.env.NODE_ENV === 'test') return; // 测试阶段跳过发送
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

// 仅清“活跃用户”窗口，其他 counter 累计保留（便于 rate()）
function clearWindow() {
  state.activeUsers = 0;
}

// 周期任务：收集并发送
function sendMetricsPeriodically(periodMs) {
  setInterval(() => {
    try {
      const m = buildAllMetrics();
      clearWindow();
      // fire and forget
      void send(m);
    } catch (e) {
      console.log('Error sending metrics', e);
    }
  }, periodMs);
}
console.log("[metrics] url=", config.metrics?.url, "enabled=", !!(config.metrics?.url && config.metrics?.apiKey));
// ====== 导出 API =======
module.exports = {
  // TA 风格函数
  incrementTotalRequests,
  incrementGetRequests,
  incrementPostRequests,
  incrementPutRequests,
  incrementDeleteRequests,
  incrementSuccessfulAuth,
  incrementFailedAuth,
  updateMsRequestLatency,
  incrementActiveUsers,

  // 业务
  pizzaPurchase,

  // 中间件 & 启动
  requestTracker,
  sendMetricsPeriodically,
  start(periodMs = 1000) {
    sendMetricsPeriodically(periodMs);
  },
};
