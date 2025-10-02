const { jest, describe, test, expect, beforeEach } = require('@jest/globals');

// Mocks
jest.mock('../database/database.js', () => {
  const Role = { Admin: 'admin', Franchisee: 'franchisee', Diner: 'diner' };
  const DB = {
    // auth / user
    isLoggedIn: jest.fn(),
    addUser: jest.fn(),
    getUser: jest.fn(),
    loginUser: jest.fn(),
    logoutUser: jest.fn(),
    updateUser: jest.fn(),
    // order
    getMenu: jest.fn(),
    addMenuItem: jest.fn(),
    getOrders: jest.fn(),
    addDinerOrder: jest.fn(),
    // franchise
    getFranchises: jest.fn(),
    getUserFranchises: jest.fn(),
    getFranchise: jest.fn(),
    createFranchise: jest.fn(),
    deleteFranchise: jest.fn(),
    createStore: jest.fn(),
    deleteStore: jest.fn(),
  };
  return { DB, Role };
});

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'a.b.c'),
  verify: jest.fn(() => ({ id: 1, name: 'Admin', email: 'a@jwt.com', roles: [{ role: 'admin' }] })),
}));

const { DB, Role } = require('../database/database.js');
const jwt = require('jsonwebtoken');

const supertest = require('supertest');
const app = require('../service');

const authz = (token = 'a.b.c') => ({ Authorization: `Bearer ${token}` });

global.fetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  DB.isLoggedIn.mockResolvedValue(true);
});

//authRouter
describe('authRouter', () => {
  test('POST /api/auth registers diner and returns token', async () => {
    DB.addUser.mockResolvedValue({ id: 2, name: 'pizza diner', email: 'reg@test.com', roles: [{ role: Role.Diner }] });
    DB.loginUser.mockResolvedValue();

    const res = await supertest(app).post('/api/auth').send({ name: 'pizza diner', email: 'reg@test.com', password: 'a' });
    expect(res.status).toBe(200);
    expect(DB.addUser).toHaveBeenCalled();
    expect(DB.loginUser).toHaveBeenCalledWith(2, 'a.b.c');
    expect(res.body).toHaveProperty('user');
    expect(res.body).toHaveProperty('token', 'a.b.c');
  });

  test('PUT /api/auth logs in existing user and returns token', async () => {
    DB.getUser.mockResolvedValue({ id: 3, name: 'u', email: 'u@test.com', roles: [{ role: Role.Diner }] });

    const res = await supertest(app).put('/api/auth').send({ email: 'u@test.com', password: 'pw' });
    expect(res.status).toBe(200);
    expect(DB.getUser).toHaveBeenCalled();
    expect(DB.loginUser).toHaveBeenCalledWith(3, 'a.b.c');
    expect(res.body).toHaveProperty('token', 'a.b.c');
  });

  test('DELETE /api/auth without token -> 401', async () => {
    const res = await supertest(app).delete('/api/auth');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('message', 'unauthorized');
  });

  test('DELETE /api/auth with token logs out and returns message', async () => {
    DB.logoutUser.mockResolvedValue();
    const res = await supertest(app).delete('/api/auth').set(authz());
    expect(res.status).toBe(200);
    expect(DB.logoutUser).toHaveBeenCalled();
    expect(res.body).toHaveProperty('message', 'logout successful');
  });
});

//userRouter
describe('userRouter', () => {
  test('GET /api/user/me returns req.user', async () => {
    const res = await supertest(app).get('/api/user/me').set(authz());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1, email: 'a@jwt.com' });
  });

  test('PUT /api/user/:id unauthorized when not same user and not admin -> 403', async () => {
    jwt.verify.mockReturnValueOnce({ id: 2, email: 'd@test.com', name: 'Diner', roles: [{ role: Role.Diner }] });
    DB.updateUser.mockResolvedValue({ id: 1, name: 'X', email: 'x@test.com', roles: [{ role: Role.Diner }] });

    const res = await supertest(app).put('/api/user/1').set(authz()).send({ name: 'X' });
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('message', 'unauthorized');
  });

  test('PUT /api/user/:id as admin updates user and returns new token', async () => {
    DB.updateUser.mockResolvedValue({ id: 5, name: 'New', email: 'new@test.com', roles: [{ role: Role.Diner }] });
    DB.loginUser.mockResolvedValue();

    const res = await supertest(app).put('/api/user/5').set(authz()).send({ name: 'New', email: 'new@test.com' });
    expect(res.status).toBe(200);
    expect(DB.updateUser).toHaveBeenCalledWith(5, 'New', 'new@test.com', undefined);
    expect(DB.loginUser).toHaveBeenCalledWith(5, 'a.b.c');
    expect(res.body).toHaveProperty('user');
    expect(res.body).toHaveProperty('token', 'a.b.c');
  });
});

//orderRouter
describe('orderRouter', () => {
  test('GET /api/order/menu returns menu', async () => {
    DB.getMenu.mockResolvedValue([{ id: 1, title: 'Veggie', price: 9.99 }]);
    const res = await supertest(app).get('/api/order/menu');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, title: 'Veggie', price: 9.99 }]);
  });

  test('PUT /api/order/menu requires admin, diner gets 403', async () => {
    jwt.verify.mockReturnValueOnce({ id: 9, email: 'd@test.com', roles: [{ role: Role.Diner }] });
    const res = await supertest(app)
      .put('/api/order/menu')
      .set(authz())
      .send({ title: 'S', description: 'x', image: 'y', price: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('message', 'unable to add menu item');
  });

  test('PUT /api/order/menu admin can add item and returns full menu', async () => {
    DB.addMenuItem.mockResolvedValue({ id: 2, title: 'S', description: 'x', image: 'y', price: 1 });
    DB.getMenu.mockResolvedValue([{ id: 1, title: 'Veggie' }, { id: 2, title: 'S' }]);

    const res = await supertest(app)
      .put('/api/order/menu')
      .set(authz())
      .send({ title: 'S', description: 'x', image: 'y', price: 1 });
    expect(res.status).toBe(200);
    expect(DB.addMenuItem).toHaveBeenCalled();
    expect(res.body).toEqual([{ id: 1, title: 'Veggie' }, { id: 2, title: 'S' }]);
  });

  test('GET /api/order (protected) returns user orders', async () => {
    DB.getOrders.mockResolvedValue({ dinerId: 7, orders: [], page: 1 });
    const res = await supertest(app).get('/api/order').set(authz());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dinerId: 7, orders: [], page: 1 });
  });

  test('POST /api/order fulfills successfully at factory', async () => {
    jwt.verify.mockReturnValueOnce({ id: 4, name: 'Diner', email: 'd@test.com', roles: [{ role: Role.Diner }] });
    DB.addDinerOrder.mockResolvedValue({ id: 11, franchiseId: 1, storeId: 1, items: [] });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ reportUrl: 'http://report', jwt: 'JWT42' }),
    });

    const res = await supertest(app).post('/api/order').set(authz()).send({ franchiseId: 1, storeId: 1, items: [] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('order');
    expect(res.body).toHaveProperty('followLinkToEndChaos', 'http://report');
    expect(res.body).toHaveProperty('jwt', 'JWT42');
  });

  test('POST /api/order factory failure -> 500 with reportUrl', async () => {
    jwt.verify.mockReturnValueOnce({ id: 4, name: 'Diner', email: 'd@test.com', roles: [{ role: Role.Diner }] });
    DB.addDinerOrder.mockResolvedValue({ id: 12, franchiseId: 1, storeId: 1, items: [] });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ reportUrl: 'http://oops' }),
    });

    const res = await supertest(app).post('/api/order').set(authz()).send({ franchiseId: 1, storeId: 1, items: [] });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: 'http://oops' });
  });
});

//franchiseRouter
describe('franchiseRouter', () => {
  test('GET /api/franchise returns list + more flag', async () => {
    DB.getFranchises.mockResolvedValue([[{ id: 1, name: 'pizzaPocket', stores: [] }], true]);
    const res = await supertest(app).get('/api/franchise');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ franchises: [{ id: 1, name: 'pizzaPocket', stores: [] }], more: true });
  });

  test('GET /api/franchise/:userId returns user franchises if admin', async () => {
    DB.getUserFranchises.mockResolvedValue([{ id: 2, name: 'Chain' }]);
    const res = await supertest(app).get('/api/franchise/4').set(authz());
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 2, name: 'Chain' }]);
  });

  test('POST /api/franchise denies diner (403)', async () => {
    jwt.verify.mockReturnValueOnce({ id: 8, email: 'd@test.com', roles: [{ role: Role.Diner }] });
    const res = await supertest(app).post('/api/franchise').set(authz()).send({ name: 'X', admins: [] });
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('message', 'unable to create a franchise');
  });

  test('POST /api/franchise allows admin and returns franchise', async () => {
    DB.createFranchise.mockResolvedValue({ id: 9, name: 'pizzaPocket', admins: [] });
    const res = await supertest(app).post('/api/franchise').set(authz()).send({ name: 'pizzaPocket', admins: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 9, name: 'pizzaPocket', admins: [] });
  });

  test('DELETE /api/franchise/:id (no auth) deletes and returns message', async () => {
    DB.deleteFranchise.mockResolvedValue();
    const res = await supertest(app).delete('/api/franchise/1');
    expect(res.status).toBe(200);
    expect(DB.deleteFranchise).toHaveBeenCalledWith(1);
    expect(res.body).toEqual({ message: 'franchise deleted' });
  });

  test('POST /api/franchise/:id/store denies when not admin or franchise admin', async () => {
    jwt.verify.mockReturnValueOnce({ id: 10, email: 'user@test.com', roles: [{ role: Role.Diner }] });
    DB.getFranchise.mockResolvedValue({ id: 1, admins: [{ id: 2 }] }); // not this user
    const res = await supertest(app).post('/api/franchise/1/store').set(authz()).send({ name: 'SLC' });
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('message', 'unable to create a store');
  });

  test('POST /api/franchise/:id/store allows admin and returns store', async () => {
    DB.getFranchise.mockResolvedValue({ id: 1, admins: [{ id: 1 }] });
    DB.createStore.mockResolvedValue({ id: 7, franchiseId: 1, name: 'SLC' });

    const res = await supertest(app).post('/api/franchise/1/store').set(authz()).send({ name: 'SLC' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 7, franchiseId: 1, name: 'SLC' });
  });

  test('DELETE /api/franchise/:fid/store/:sid denies when not allowed', async () => {
    jwt.verify.mockReturnValueOnce({ id: 10, email: 'user@test.com', roles: [{ role: Role.Diner }] });
    DB.getFranchise.mockResolvedValue({ id: 1, admins: [{ id: 2 }] });
    const res = await supertest(app).delete('/api/franchise/1/store/2').set(authz());
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('message', 'unable to delete a store');
  });

  test('DELETE /api/franchise/:fid/store/:sid allows admin and deletes', async () => {
    DB.getFranchise.mockResolvedValue({ id: 1, admins: [{ id: 1 }] });
    DB.deleteStore.mockResolvedValue();
    const res = await supertest(app).delete('/api/franchise/1/store/2').set(authz());
    expect(res.status).toBe(200);
    expect(DB.deleteStore).toHaveBeenCalledWith(1, 2);
    expect(res.body).toEqual({ message: 'store deleted' });
  });
});
