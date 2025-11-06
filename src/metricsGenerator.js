// metricsGenerator.js
const config = require('./config');

// 构造 Basic Auth 头：base64("instanceId:glc_token")
const basic = Buffer.from(config.apiKey, 'utf8').toString('base64');

let requests = 0;
let latency = 0;

setInterval(() => {
  // 1) 随机 CPU（0~100），gauge 类型
  const cpuValue = Math.floor(Math.random() * 100) + 1;
  sendMetric('cpu', cpuValue, 'gauge', '%');

  // 2) 请求计数（单调递增），sum 类型（cumulative）
  requests += Math.floor(Math.random() * 200) + 1;
  sendMetric('requests', requests, 'sum', '1');

  // 3) 延迟累计（毫秒，单调递增），sum 类型（cumulative）
  latency += Math.floor(Math.random() * 200) + 1;
  sendMetric('latency', latency, 'sum', 'ms');
}, 1000);

function sendMetric(name, value, type, unit) {
  const nowNs = Date.now() * 1_000_000; // 纳秒时间戳
  const metric = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name,
                unit,
                [type]: {
                  dataPoints: [
                    {
                      asInt: value,
                      timeUnixNano: nowNs,
                      attributes: [
                        { key: 'source', value: { stringValue: 'jwt-pizza-service' } },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };

  if (type === 'sum') {
    const sum = metric.resourceMetrics[0].scopeMetrics[0].metrics[0].sum;
    sum.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    sum.isMonotonic = true;
  }

  fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 使用 Basic 与 curl 对齐（最可靠）
      Authorization: `Basic ${basic}`,
      // 如果你课堂示例要求 Bearer，也可以：Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(metric),
  })
    .then((res) => {
      if (!res.ok) {
        return res.text().then((t) => {
          console.error(`[${new Date().toISOString()}] FAIL ${name}: ${res.status} ${res.statusText}\n${t}`);
        });
      }
      console.log(`[${new Date().toISOString()}] OK   ${name}: ${value}`);
    })
    .catch((err) => console.error('Error pushing metrics:', err));
}
