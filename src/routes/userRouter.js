const express = require('express');
const { asyncHandler } = require('../endpointHelper.js');
const { DB, Role } = require('../database/database.js');
const { authRouter, setAuth } = require('./authRouter.js');

const userRouter = express.Router();

/**
 * API Docs (used by your /api/docs aggregator, presumably)
 */
userRouter.docs = [
  {
    method: 'GET',
    path: '/api/user?page=1&limit=10&name=*',
    requiresAuth: true,
    description: 'Gets a paginated list of users (admin-only). Optional case-insensitive name filter.',
    example: `curl -X GET localhost:3000/api/user -H 'Authorization: Bearer tttttt'`,
    response: {
      users: [
        { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] },
      ],
      page: 1,
      limit: 10,
      total: 1,
      pages: 1,
    },
  },
  {
    method: 'GET',
    path: '/api/user/me',
    requiresAuth: true,
    description: 'Get authenticated user',
    example: `curl -X GET localhost:3000/api/user/me -H 'Authorization: Bearer tttttt'`,
    response: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] },
  },
  {
    method: 'PUT',
    path: '/api/user/:userId',
    requiresAuth: true,
    description: 'Update user (self, or admin). Returns updated user + fresh token.',
    example: `curl -X PUT localhost:3000/api/user/1 -d '{"name":"常用名字","email":"a@jwt.com","password":"admin"}' -H 'Content-Type: application/json' -H 'Authorization: Bearer tttttt'`,
    response: { user: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] }, token: 'tttttt' },
  },
];

/**
 * GET /api/user  — list users (admin only), with pagination and optional name filter
 */
userRouter.get(
  '/',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const requester = req.user;

    if (!requester.isRole || !requester.isRole(Role.Admin)) {
      return res.status(403).json({ message: 'admin only' });
    }

    const page = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '10', 10) || 10));
    const nameFilter = (req.query.name ?? '').toString().trim().toLowerCase();
    const offset = (page - 1) * limit;

    // Try multiple DB shapes gracefully
    let allUsers = [];
    if (typeof DB.listUsers === 'function') {
      // Expect listUsers to return an array of users
      allUsers = await DB.listUsers();
    } else if (typeof DB.getUsers === 'function') {
      allUsers = await DB.getUsers();
    } else {
      // Fallback: if DB has no suitable method, respond empty but not crash
      allUsers = [];
    }

    // Optional in-memory filter by name (case-insensitive substring)
    let filtered = allUsers;
    if (nameFilter) {
      filtered = allUsers.filter(u =>
        (u.name ?? '').toString().toLowerCase().includes(nameFilter)
      );
    }

    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const users = filtered.slice(offset, offset + limit);

    res.json({ users, page, limit, total, pages });
  })
);

/**
 * GET /api/user/me — return the authenticated user object
 */
userRouter.get(
  '/me',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    res.json(req.user);
  })
);

/**
 * PUT /api/user/:userId — update self (or admin can update anyone).
 * Returns { user, token } with a refreshed auth token for the updated user.
 */
userRouter.put(
  '/:userId',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body ?? {};
    const userId = Number(req.params.userId);
    const requester = req.user;

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: 'invalid userId' });
    }

    // AuthZ: same user or admin
    if (requester.id !== userId && !(requester.isRole && requester.isRole(Role.Admin))) {
      return res.status(403).json({ message: 'unauthorized' });
    }

    // Update — your DB.updateUser(name,email,password) signature is assumed from your snippet
    const updatedUser = await DB.updateUser(userId, name, email, password);

    // Issue a fresh token that encodes new claims (e.g., updated name/email/roles)
    const token = await setAuth(updatedUser);

    res.json({ user: updatedUser, token });
  })
);

module.exports = { userRouter };
