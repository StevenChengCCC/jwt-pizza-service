const express = require('express');
const { authRouter, setAuthUser } = require('./routes/authRouter.js');
const orderRouter = require('./routes/orderRouter.js');
const franchiseRouter = require('./routes/franchiseRouter.js');
const userRouter = require('./routes/userRouter.js');
const version = require('./version.json');
const config = require('./config.js');
const metrics = require('./metrics.js');

const app = express();
app.use(express.json());
app.use(setAuthUser);
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
});

app.use(metrics.requestTracker);

const apiRouter = express.Router();
app.use('/api', apiRouter);
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
  res.json({
    message: 'welcome to JWT Pizza',
    version: version.version,
  });
});

app.use('*', (req, res) => {
  res.status(404).json({
    message: 'unknown endpoint',
  });
});

// Default error handler for all exceptions and errors.
app.use((err, req, res, next) => {
  res.status(err.statusCode ?? 500).json({ message: err.message, stack: err.stack });
  next();
});

module.exports = app;
const { metrics: MC } = require('./config.js');
apiRouter.get('/metrics/ping', async (req, res) => {
  try {
    if (!MC?.url || !MC?.apiKey) return res.status(500).send('missing metrics config');
    const body = JSON.stringify({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{
        name: 'ping',
        unit: '1',
        gauge: { dataPoints: [{
          asInt: 1,
          timeUnixNano: (BigInt(Date.now())*1000000n).toString(),
          attributes: [{ key: 'source', value: { stringValue: MC.source || 'jwt-pizza-service' } }],
        }] }
      }] }]}]
    });
    const basic = Buffer.from(MC.apiKey.trim(), 'utf8').toString('base64');
    const r = await fetch(MC.url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization:`Basic ${basic}` },
      body
    });
    const txt = await r.text();
    res.status(r.ok ? 200 : 500).send(r.status + ' ' + txt);
  } catch (e) {
    res.status(500).send(String(e));
  }
});
