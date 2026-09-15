// Run once: node db/seed.js
// Inserts users with properly hashed passwords into oremus_db.users

import bcrypt from 'bcrypt';
import pool from '../config/db.js';

const USERS = [
  { name: 'Admin User',        email: 'admin@oremus.com',        password: 'admin123',  role: 'admin',  client_id: null },
  { name: 'Maya Chen',         email: 'maya@oremus.com',          password: 'maya123',   role: 'admin',  client_id: null },
  { name: 'Acme Logistics',    email: 'finance@acmelogistics.in', password: 'acme123',   role: 'client', client_id: 'c-acme' },
  { name: 'Northbeam Studios', email: 'ops@northbeam.studio',     password: 'north123',  role: 'client', client_id: 'c-northbeam' },
];

const conn = await pool.getConnection();
for (const u of USERS) {
  const hash = await bcrypt.hash(u.password, 10);
  await conn.execute(
    `INSERT INTO users (name, email, password, role, client_id)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE password = VALUES(password)`,
    [u.name, u.email, hash, u.role, u.client_id]
  );
  console.log(`✓ ${u.email}`);
}
conn.release();
await pool.end();
console.log('Seed complete.');
