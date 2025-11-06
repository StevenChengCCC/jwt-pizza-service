const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config.js');
const { asyncHandler } = require('../endpointHelper.js');
const { DB, Role } = require('../database/database.js');
const metrics = require('../metrics.js');

const authRouter = express.Router();

authRouter.docs = [
];

async function setAuthUser(req, res, next) {
  const token = readAuthToken(req);
  if (token) {
    try {
      if (await DB.isLoggedIn(token)) {
        req.user = jwt.verify(token, config.jwtSecret);
        req.user.isRole = (role) => !!req.user.roles.find((r) => r.role === role);
        metrics.incrementActiveUsers();
      }
    } catch {
      req.user = null;
    }
  }
  next();
}

authRouter.authenticateToken = (req, res, next) => {
  if (!req.user) {
    return res.status(401).send({ message: 'unauthorized' });
  }
  next();
};

// register
authRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const startTime = Date.now();
    metrics.incrementTotalRequests();
    metrics.incrementPostRequests();

    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      metrics.incrementFailedAuth();
      metrics.updateMsRequestLatency(Date.now() - startTime);
      return res.status(400).json({ message: 'name, email, and password are required' });
    }

    const user = await DB.addUser({ name, email, password, roles: [{ role: Role.Diner }] });
    const auth = await setAuth(user);

    metrics.incrementSuccessfulAuth();
    metrics.incrementActiveUsers();
    metrics.updateMsRequestLatency(Date.now() - startTime);

    res.json({ user: user, token: auth });
  })
);

// login
authRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const startTime = Date.now();
    metrics.incrementTotalRequests();
    metrics.incrementPutRequests();

    const { email, password } = req.body;
    try {
      const user = await DB.getUser(email, password);
      if (!user) {
        metrics.incrementFailedAuth();
        metrics.updateMsRequestLatency(Date.now() - startTime);
        return res.status(401).json({ message: 'invalid credentials' });
      }
      const auth = await setAuth(user);

      metrics.incrementSuccessfulAuth();
      metrics.incrementActiveUsers();
      metrics.updateMsRequestLatency(Date.now() - startTime);

      res.json({ user: user, token: auth });
    } catch (e) {
      metrics.incrementFailedAuth();
      metrics.updateMsRequestLatency(Date.now() - startTime);
      throw e;
    }
  })
);

authRouter.delete(
  '/',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    await clearAuth(req);
    res.json({ message: 'logout successful' });
  })
);

async function setAuth(user) {
  const token = jwt.sign(user, config.jwtSecret);
  await DB.loginUser(user.id, token);
  return token;
}

async function clearAuth(req) {
  const token = readAuthToken(req);
  if (token) {
    await DB.logoutUser(token);
  }
}

function readAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    return authHeader.split(' ')[1];
  }
  return null;
}

module.exports = { authRouter, setAuthUser, setAuth };
