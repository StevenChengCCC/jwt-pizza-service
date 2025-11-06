const express = require('express');
const { asyncHandler } = require('../endpointHelper.js');
const metrics = require('../metrics.js');
// 按你项目的实际调用替换这行
const { placeOrder } = require('../pizzaFactoryClient'); // 假设有此模块

const router = express.Router();

router.docs = [
  { method: 'POST', path: '/api/order', description: 'Place an order' },
];

// 下单
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const t0 = process.hrtime.bigint();
    try {
      // 这里调用你真实的下单逻辑：
      // const result = await placeOrder(req.body)
      // 假设返回 { ok:boolean, priceCents:number, data:any }
      const result = await placeOrder(req.body);

      const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
      if (result.ok) {
        metrics.pizzaPurchase(true, latencyMs, result.priceCents || 0);
        return res.status(200).json(result.data);
      } else {
        metrics.pizzaPurchase(false, latencyMs, 0);
        return res.status(502).json({ message: 'factory failed' });
      }
    } catch (err) {
      const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
      metrics.pizzaPurchase(false, latencyMs, 0);
      throw err;
    }
  })
);

module.exports = router;
