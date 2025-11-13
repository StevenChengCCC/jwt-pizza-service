const express = require('express');
const { authRouter, setAuthUser } = require('./routes/authRouter.js');
const orderRouter = require('./routes/orderRouter.js');
const franchiseRouter = require('./routes/franchiseRouter.js');
const userRouter = require('./routes/userRouter.js');
const version = require('./version.json');
const config = require('./config.js');
const metrics = require('./metrics.js');
const logger = require('./logger.js');

const app = express();
app.use(express.json());
app.use(setAuthUser);

console.log(
  '[metrics] url=',
  config.metrics?.url,
  'enabled=',
  !!(config.metrics?.url && config.metrics?.apiKey),
  'source=',
  config.metrics?.source
);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
});

app.use(logger.httpLogger);

app.use(metrics.requestTracker);

metrics.start(1000);

const apiRouter = express.Router();
app.use('/api', apiRouter);

apiRouter.get('/metrics/ping', async (req, res) => {
  try {
    const MC = config.metrics;
    if (!MC?.url || !MC?.apiKey) return res.status(500).send('missing metrics config');

    const body = JSON.stringify({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'ping',
                  unit: '1',
                  gauge: {
                    dataPoints: [
                      {
                        asInt: 1,
                        timeUnixNano: (BigInt(Date.now()) * 1000000n).toString(),
                        attributes: [{ key: 'source', value: { stringValue: MC.source || 'jwt-pizza-service' } }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const basic = Buffer.from(MC.apiKey.trim(), 'utf8').toString('base64');
    const r = await fetch(MC.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
      body,
    });
    const txt = await r.text();
    res.status(r.ok ? 200 : 500).send(r.status + ' ' + txt);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/user', userRouter);
apiRouter.use('/order', orderRouter);
apiRouter.use('/franchise', franchiseRouter);

apiRouter.use('/docs', (req, res) => {
  res.json({
    version: version.version,
    endpoints: [...authRouter.docs, ...userRouter.docs, ...orderRouter.docs, ...franchiseRouter.docs],
    config: { factory: config.factory.url, db: config.db.connection.host },
  });
});

app.get('/', (req, res) => {
  res.json({ message: 'welcome to JWT Pizza', version: version.version });
});

app.use('*', (req, res) => {
  res.status(404).json({ message: 'unknown endpoint' });
});

app.use((err, req, res, next) => {
  try {
    logger.logError(err, {
      path: req.originalUrl,
      method: req.method,
      statusCode: err.statusCode ?? 500,
    });
  } catch (e) {
    console.error('[logger] error while logging error', e);
  }

  res.status(err.statusCode ?? 500).json({ message: err.message, stack: err.stack });
  next();
});

module.exports = app;
