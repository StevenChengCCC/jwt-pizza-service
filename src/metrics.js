// src/metrics.js
const os = require('os');
const config = require('./config');

// 读取 CI 注入的 metrics 配置：source / url / apiKey
// apiKey = "实例ID:glc_token" —— 直接 Base64 后走 Basic 认证（等价于 curl -u）
const SOURCE = (config.metrics && config.metrics.source) || 'jwt-pizza-service';
const URL = (config.metrics && config.metrics.url) || '';
const BASIC = config.metrics ? Buffer.from(config.metrics.apiKey, 'utf8').toString('base64') : '';

// ===== 计数与状态（TA 风格字段 + 扩展）=====
const state = {
  // TA 风格（方法/总量/认证/延迟/活跃用户）
  totalRequests: 0,
  getRequests: 0,
  postRequests: 0,
  putRequests: 0,
  deleteRequests: 0,

  successfulAuth: 0,
  failedAuth: 0,

  msRequestLatency: 0,  // 最近一次请求延迟（ms）
  activeUsers: 0,       // 周期窗口内活跃人数（gauge）

  // 端点维度累计（用于计算“服务端点平均延迟”）
  // key = `${method}|${route}|${status}`
  endpoint: new Map(),

  // 订单（销量/失败/营收/制作总延迟）
  pizzasSold: 0,
  pizzaFailures: 0,
  revenueCents: 0,
  pizzaCreationLatencyTotalMs: 0,
};

// ===== 提供给业务/路由调用的函数（与 TA 示例一致）=====
function incrementTotalRequests() { state.totalRequests++; }
function incrementGetRequests()   { state.getRequests++; }
function incrementPostRequests()  { state.postRequests++; }
function incrementPutRequests()   { state.putRequests++; }
function incrementDeleteRequests(){ state.deleteRequests++; }

function incrementSuccessfulAuth(){ state.successfulAuth++; }
function incrementFailedAuth()    { state.failedAuth++; }

function updateMsRequestLatency(ms) {
  if (ms && ms !== 0) state.msRequestLatency = ms;
}
function incrementActiveUsers()   { state.activeUsers++; }

// 订单指标
function pizzaPurchase(success, latencyMs, priceCents) {
  if (success) {
    state.pizzasSold += 1;
    state.revenueCents += Math.max(0, priceCents || 0);
  } else {
    state.pizzaFailures += 1;
  }
  if (latencyMs != null) state.pizzaCreationLatencyTotalMs += latencyMs;
}

// ===== Express 中间件：端点维度统计 =====
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;

    // 总量/方法
    incrementTotalRequests();
    const m = (req.method || 'GET').toUpperCase();
    if (m === 'GET') incrementGetRequests();
    else if (m === 'POST') incrementPostRequests();
    else if (m === 'PUT') incrementPutRequests();
    else if (m === 'DELETE') incrementDeleteRequests();

    // 端点维度（路由/状态）
    const route = (req.route && req.route.path) || req.originalUrl || req.path || 'unknown';
    const status = res.statusCode || 0;
    const key = `${m}|${route}|${status}`;
    const prev = state.endpoint.get(key) || { count: 0, latencyMs: 0 };
    prev.count += 1;
    prev.latencyMs += ms;
    state.endpoint.set(key, prev);

    updateMsRequestLatency(ms);
  });

  next();
}

// ===== 系统 gauge 指标 =====
function cpuPercent() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Math.round(cpuUsage * 100);
}
function memoryPercent() {
  const total = os.totalmem();
  const free = os.freemem();
  return Math.round(((total - free) / total) * 100);
}

// ===== OTLP/HTTP JSON builders =====
function gauge(name, value, unit = '', attrs = []) {
  return {
    name, unit,
    gauge: {
      dataPoints: [{
        asInt: Math.max(0, Math.round(value)),
        timeUnixNano: Date.now() * 1e9,
        attributes: [{ key: 'source', value: { stringValue: SOURCE } }, ...attrs],
      }],
    },
  };
}

function sumCounter(name, value, unit = '', attrs = []) {
  return {
    name, unit,
    sum: {
      aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
      isMonotonic: true,
      dataPoints: [{
        asInt: Math.max(0, Math.round(value)),
        timeUnixNano: Date.now() * 1e9,
        attributes: [{ key: 'source', value: { stringValue: SOURCE } }, ...attrs],
      }],
    },
  };
}

function buildAllMetrics() {
  const arr = [];

  // HTTP by method + total（按 required 指标）
  arr.push(sumCounter('http_requests_total', state.totalRequests, '1', [{ key: 'method', value: { stringValue: 'ALL' } }]));
  arr.push(sumCounter('http_requests_total', state.getRequests,   '1', [{ key: 'method', value: { stringValue: 'GET' } }]));
  arr.push(sumCounter('http_requests_total', state.postRequests,  '1', [{ key: 'method', value: { stringValue: 'POST' } }]));
  arr.push(sumCounter('http_requests_total', state.putRequests,   '1', [{ key: 'method', value: { stringValue: 'PUT' } }]));
  arr.push(sumCounter('http_requests_total', state.deleteRequests,'1', [{ key: 'method', value: { stringValue: 'DELETE' } }]));

  // 端点维度：请求总数 + 端点累计延迟（用于平均延迟）
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

  // 活跃用户（gauge）
  arr.push(gauge('active_users', state.activeUsers, '1'));

  // 认证尝试
  arr.push(sumCounter('auth_attempts_total', state.successfulAuth, '1', [{ key: 'outcome', value: { stringValue: 'success' } }]));
  arr.push(sumCounter('auth_attempts_total', state.failedAuth,     '1', [{ key: 'outcome', value: { stringValue: 'failure' } }]));

  // 系统 gauge
  arr.push(gauge('cpu_percent', cpuPercent(), '%'));
  arr.push(gauge('memory_percent', memoryPercent(), '%'));

  // 订单
  arr.push(sumCounter('pizzas_sold_total', state.pizzasSold, '1'));
  arr.push(sumCounter('pizza_failures_total', state.pizzaFailures, '1'));
  arr.push(sumCounter('revenue_cents_total', state.revenueCents, 'cents'));
  arr.push(sumCounter('pizza_creation_latency_milliseconds_total', Math.round(state.pizzaCreationLatencyTotalMs), 'ms'));

  return arr;
}

async function send(metricsArr) {
  if (!URL || !BASIC) return;
  if (process.env.NODE_ENV === 'test') return; // 测试阶段不外发
  const body = JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: metricsArr }] }] });

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${BASIC}` },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('Failed to push metrics', res.status, t);
  }
}

// 仅清“活跃用户窗口”，其余 counter 为 cumulative
function clearWindow() {
  state.activeUsers = 0;
}

function sendMetricsPeriodically(periodMs) {
  setInterval(() => {
    try {
      const arr = buildAllMetrics();
      clearWindow();
      send(arr).catch(() => {});
    } catch (e) {
      console.log('Error sending metrics', e);
    }
  }, periodMs);
}

module.exports = {
  // TA 风格 API
  incrementTotalRequests,
  incrementGetRequests,
  incrementPostRequests,
  incrementPutRequests,
  incrementDeleteRequests,
  incrementSuccessfulAuth,
  incrementFailedAuth,
  updateMsRequestLatency,
  incrementActiveUsers,

  // 订单
  pizzaPurchase,

  // 中间件 & 启动
  requestTracker,
  sendMetricsPeriodically,
  start(periodMs = 1000) {
    this.sendMetricsPeriodically(periodMs);
  },
};
