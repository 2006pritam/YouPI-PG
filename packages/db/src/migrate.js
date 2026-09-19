import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getDatabase } from './database.js';
import { MerchantRepository } from './repositories/merchant.repository.js';
import { ReceivingAccountRepository } from './repositories/receiving-account.repository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Runs database migrations and applies base seeds.
 * @param {import('./database.js').Database} [targetDb]
 */
export function runMigrations(targetDb) {
  const db = targetDb || getDatabase();
  const schemaPath = path.join(__dirname, 'sqlite-schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Detect if customers table has obsolete schema (phone_number/merchant_id instead of email/mobile_number)
  try {
    const tableInfo = db.query ? db.query("PRAGMA table_info(customers)") : [];
    const colNames = (tableInfo || []).map(c => c.name);
    const hasOldColumns = colNames.length > 0 && (!colNames.includes('email') || colNames.includes('phone_number') || colNames.includes('merchant_id'));
    if (hasOldColumns) {
      try { db.exec("PRAGMA foreign_keys = OFF;"); } catch {}
      try { db.exec("UPDATE payment_sessions SET customer_id = NULL WHERE customer_id IS NOT NULL;"); } catch {}
      try { db.exec("DELETE FROM ticket_messages;"); } catch {}
      try { db.exec("DELETE FROM support_tickets;"); } catch {}
      try { db.exec("DROP TABLE IF EXISTS customer_sessions;"); } catch {}
      try { db.exec("DROP TABLE IF EXISTS customers;"); } catch {}
      try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}
    }
  } catch {
    try { db.exec("PRAGMA foreign_keys = OFF;"); } catch {}
    try { db.exec("DROP TABLE IF EXISTS customers;"); } catch {}
    try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}
  }

  // Fallback alter columns if customers table exists without email
  try { db.exec("ALTER TABLE customers ADD COLUMN email TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN mobile_number TEXT;"); } catch {}

  // Execute schema DDL
  db.exec(schemaSql);

  // Alter table columns if migrating existing databases
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_level INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_sources TEXT DEFAULT '[]';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_tag TEXT DEFAULT 'UNVERIFIED';"); } catch {}
  try { db.exec("ALTER TABLE payment_receiving_accounts ADD COLUMN is_merchant_enabled INTEGER NOT NULL DEFAULT 1;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_vpa_per_merchant ON payment_receiving_accounts (merchant_id) WHERE is_active = 1;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers (email);"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mobile ON customers (mobile_number);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions (token, is_active);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions (customer_id);"); } catch {}

  // Seed default merchant if empty
  const merchantRepo = new MerchantRepository(db);
  const existing = merchantRepo.findAll();

  let defaultMerchant;
  if (existing.length === 0) {
    defaultMerchant = merchantRepo.create({
      id: '00000000-0000-0000-0000-000000000001',
      businessName: 'YOUPI Demo Store',
      slug: 'demo-store',
      contactEmail: 'merchant@youpi.local',
      contactPhone: '9876543210',
      webhookUrl: 'http://localhost:5000/webhook',
      webhookSecret: crypto.randomBytes(32).toString('hex'),
      branding: {
        appName: 'YOUPI PG',
        primaryColor: '#2563eb',
        logoUrl: null
      }
    });
  } else {
    defaultMerchant = existing[0];
  }

  // Seed default UPI receiving account if none
  const accountRepo = new ReceivingAccountRepository(db);
  const accounts = accountRepo.findByMerchantId(defaultMerchant.id);
  if (accounts.length === 0) {
    accountRepo.create({
      id: '00000000-0000-0000-0000-000000000002',
      merchantId: defaultMerchant.id,
      upiId: 'merchant@upi',
      payeeName: defaultMerchant.businessName,
      isActive: true
    });
  }

  return {
    db,
    defaultMerchant
  };
}

// Auto-run if executed directly as script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Running YOUPI PG database migrations...');
  const result = runMigrations();
  console.log(`Migration completed successfully. Default merchant: ${result.defaultMerchant.businessName} (${result.defaultMerchant.id})`);
}
