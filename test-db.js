require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

client.connect()
  .then(() => {
    console.log('✅ Database connected successfully!');
    return client.query('SELECT * FROM active_positions LIMIT 1');
  })
  .then(() => {
    console.log('✅ Tables are accessible!');
    client.end();
  })
  .catch(err => {
    console.error('❌ Connection failed:', err.message);
  });
