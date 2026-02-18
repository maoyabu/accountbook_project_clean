const express = require('express');
const router = express.Router();
const CategoryMapping = require('../../models/categoryMapping');

router.get('/category-mapping', async (req, res, next) => {
  try {
    const group = req.query.group;
    if (!group) return res.status(400).json({ error: 'group is required' });

    const doc = await CategoryMapping.findOne({ group });
    const mapping = doc?.mapping ? Object.fromEntries(doc.mapping) : {};
    return res.json({ mapping });
  } catch (err) {
    return next(err);
  }
});

router.put('/category-mapping', async (req, res, next) => {
  try {
    const { group, mapping } = req.body;
    if (!group || !mapping) return res.status(400).json({ error: 'group and mapping are required' });

    await CategoryMapping.findOneAndUpdate(
      { group },
      { mapping, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;