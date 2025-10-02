// authRouter.test.js
/* eslint-disable no-undef */
const request = require('supertest');
const app = require('../service');

const { Role, DB } = require('../database/database.js');
const { setAuth } = require('../routes/authRouter.js');

// ---------- helpers ----------
function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

async function createAdminUser() {
  // Create an admin directly in the DB (bootstrap)
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = `${user.name}@admin.com`;
  user = await DB.addUser(user);
  // setAuth() logs the user in (persists token signature to DB)
  const token = await setAuth(user);
  return { ...user, token };
}

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(60 * 1000 * 5); // 5 minutes when debugging
}

let diner = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let dinerToken;

let admin;
let adminToken;

let menuItem; // will hold the menu item we add as admin
let franchise; // created franchise
let store; // created store

// Mock the pizza factory for order fulfillment
beforeAll(async () => {
  // Unique diner each run
  diner.email = `${randomName()}@test.com`;
  const registerRes = await request(app).post('/api/auth').send(diner);
  dinerToken = registerRes.body.token;
  expectValidJwt(dinerToken);

  // Admin bootstrap + login
  admin = await createAdminUser();
  adminToken = admin.token;
  expectValidJwt(adminToken);

  // Global fetch mock for factory call in orderRouter
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ reportUrl: 'http://factory.example/report/123', jwt: 'factory-jwt-abc' }),
  }));
});

afterAll(() => {
  // Clean up fetch mock
  global.fetch && jest.restoreAllMocks();
});

// ---------- AUTH ----------
test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(diner);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...diner, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

test('logout revokes token', async () => {
  // logout current diner token
  const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${dinerToken}`);
  expect(logoutRes.status).toBe(200);
  expect(logoutRes.body).toMatchObject({ message: 'logout successful' });

  // after logout, /api/user/me should be 401
  const meAfterLogout = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerToken}`);
  expect(meAfterLogout.status).toBe(401);

  // log back in for remaining tests
  const loginRes = await request(app).put('/api/auth').send(diner);
  expect(loginRes.status).toBe(200);
  dinerToken = loginRes.body.token;
});

// ---------- ROOT & DOCS & 404 ----------
test('GET / responds with welcome + version', async () => {
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('message', 'welcome to JWT Pizza');
  expect(res.body).toHaveProperty('version');
});

test('GET /api/docs returns endpoint listing', async () => {
  const res = await request(app).get('/api/docs');
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('version');
  expect(Array.isArray(res.body.endpoints)).toBe(true);
  expect(res.body.config).toBeDefined();
});

test('unknown endpoint returns 404 JSON', async () => {
  const res = await request(app).get('/api/this/does/not/exist');
  expect(res.status).toBe(404);
  expect(res.body).toMatchObject({ message: 'unknown endpoint' });
});

// ---------- USER ----------
describe('User routes', () => {
  test('GET /api/user/me requires auth', async () => {
    const res = await request(app).get('/api/user/me');
    expect(res.status).toBe(401);
  });

  test('GET /api/user/me returns authenticated user', async () => {
    const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('email', diner.email);
  });

  test('PUT /api/user/:userId forbids updating someone else (non-admin)', async () => {
    // Try to update admin using diner token -> should 403
    const resMe = await request(app).get('/api/user/me').set('Authorization', `Bearer ${adminToken}`);
    const adminId = resMe.body.id;

    const res = await request(app)
      .put(`/api/user/${adminId}`)
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({ name: 'hacker' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: 'unauthorized' });
  });

  test('PUT /api/user/:userId lets user update self (and returns new token)', async () => {
    const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerToken}`);
    const myId = meRes.body.id;

    const newName = `diner-${randomName()}`;
    const updateRes = await request(app)
      .put(`/api/user/${myId}`)
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({ name: newName });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.user).toHaveProperty('name', newName);
    expectValidJwt(updateRes.body.token);
  });
});

// ---------- ORDER (menu + create order + list) ----------
describe('Order routes', () => {
  test('GET /api/order/menu returns an array (may be empty)', async () => {
    const res = await request(app).get('/api/order/menu');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('PUT /api/order/menu requires Admin (non-admin 403)', async () => {
    const res = await request(app)
      .put('/api/order/menu')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({
        title: 'Student',
        description: 'No topping, no sauce, just carbs',
        image: 'pizza9.png',
        price: 0.0001,
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: 'unable to add menu item' });
  });

  test('Admin can add menu item and it shows up in GET /menu', async () => {
    const payload = {
      title: `Veggie-${randomName()}`,
      description: 'A garden of delight',
      image: 'pizza1.png',
      price: 0.0038,
    };

    const putRes = await request(app)
      .put('/api/order/menu')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload);

    expect(putRes.status).toBe(200);
    expect(Array.isArray(putRes.body)).toBe(true);
    const found = putRes.body.find((m) => m.title === payload.title);
    expect(found).toBeTruthy();
    expect(found).toHaveProperty('id');
    menuItem = found;

    const getRes = await request(app).get('/api/order/menu');
    const again = getRes.body.find((m) => m.title === payload.title);
    expect(again).toBeTruthy();
  });
});

// ---------- FRANCHISE (list/create/store/user franchises) ----------
describe('Franchise routes', () => {
  test('GET /api/franchise returns list + more flag', async () => {
    const res = await request(app).get('/api/franchise?page=0&limit=10&name=*');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('franchises');
    expect(res.body).toHaveProperty('more');
  });

  test('POST /api/franchise requires Admin; Admin can create franchise', async () => {
    const name = `pizzaPocket-${randomName()}`;
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name,
        // make our diner a franchise admin to test role-based store creation later
        admins: [{ email: diner.email }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name', name);
    expect(Array.isArray(res.body.admins)).toBe(true);

    franchise = res.body;
  });

  test('POST /api/franchise/:franchiseId/store allows Admin or franchise admin', async () => {
    // As Admin
    const res = await request(app)
      .post(`/api/franchise/${franchise.id}/store`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ franchiseId: franchise.id, name: 'SLC' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name', 'SLC');
    store = res.body;
  });

  test("GET /api/franchise/:userId returns user's franchises (requires auth)", async () => {
    // Get diner id
    const me = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerToken}`);
    const dinerId = me.body.id;

    // As diner, should be able to see franchises where they're admin
    const res = await request(app)
      .get(`/api/franchise/${dinerId}`)
      .set('Authorization', `Bearer ${dinerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // At least the one we just created (admin added diner)
    const got = res.body.find((f) => f.id === franchise.id);
    expect(got).toBeTruthy();
    expect(Array.isArray(got.stores)).toBe(true);
  });

  test('DELETE /api/franchise/:franchiseId/store/:storeId authorizes Admin or franchise admin', async () => {
    // Delete as diner (should be authorized because diner is franchise admin)
    const res = await request(app)
      .delete(`/api/franchise/${franchise.id}/store/${store.id}`)
      .set('Authorization', `Bearer ${dinerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'store deleted' });
  });
});

// ---------- ORDERS end-to-end (create + list) ----------
describe('Orders end-to-end', () => {
  test('POST /api/order creates an order and returns factory jwt + link', async () => {
    // Need a store again (we deleted previous). Create as Admin:
    const resStore = await request(app)
      .post(`/api/franchise/${franchise.id}/store`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ franchiseId: franchise.id, name: 'Orem' });

    expect(resStore.status).toBe(200);
    store = resStore.body;

    // Create order as diner
    const res = await request(app)
      .post('/api/order')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({
        franchiseId: franchise.id,
        storeId: store.id,
        items: [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('order.id');
    expect(res.body).toHaveProperty('jwt', 'factory-jwt-abc');
    expect(res.body).toHaveProperty('followLinkToEndChaos');
  });

  test('GET /api/order lists diner orders (pagination supported)', async () => {
    const res = await request(app).get('/api/order?page=1').set('Authorization', `Bearer ${dinerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dinerId');
    expect(res.body).toHaveProperty('orders');
    expect(Array.isArray(res.body.orders)).toBe(true);
  });
});
