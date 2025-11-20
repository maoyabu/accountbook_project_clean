const mongoose = require('mongoose');
const Finance = require('../models/finance');

updateMonthAndDay();

const dburl = process.env.DB_URL || 'mongodb://localhost:27017/finance';
mongoose.connect(dburl, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function updateMonthAndDay() {
  try {
    const finances = await Finance.find({ date: { $exists: true } });

    for (const doc of finances) {
      const date = new Date(doc.date);
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();

      await Finance.updateOne(
        { _id: doc._id },
        { $set: { month, day } }
      );

      console.log(`✅ Updated ${doc._id}: ${month}/${day}`);
    }

    console.log('✅ All documents updated.');
    mongoose.connection.close();
  } catch (err) {
    console.error('❌ Error:', err);
    mongoose.connection.close();
  }
}