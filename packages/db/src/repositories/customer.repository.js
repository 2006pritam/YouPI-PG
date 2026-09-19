import crypto from 'node:crypto';
import { hashPassword, verifyPassword, normalizeEmail, normalizeMobile, isValidEmail, isValidMobile, isValidPassword } from '@youpi/common';

export class CustomerRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Creates a new gateway customer.
   * @param {{
   *   id?: string,
   *   name?: string,
   *   fullName?: string,
   *   email?: string,
   *   mobileNumber?: string,
   *   phoneNumber?: string,
   *   password?: string,
   *   passwordHash?: string,
   *   status?: string
   * }} data
   */
  create(data) {
    const id = data.id || crypto.randomUUID();
    const name = String(data.name || data.fullName || '').trim();
    const mobileNumber = normalizeMobile(data.mobileNumber || data.phoneNumber);
    let email = normalizeEmail(data.email);
    const status = data.status || 'ACTIVE';

    if (!name) {
      throw new Error('Customer name is required.');
    }
    if (!mobileNumber || !isValidMobile(mobileNumber)) {
      throw new Error('Invalid mobile number format (must be a valid 10-digit number).');
    }
    if (!email) {
      email = `${mobileNumber}@customer.youpi.local`;
    } else if (!isValidEmail(email)) {
      throw new Error('Invalid email address format.');
    }

    let passwordHash = data.passwordHash;
    if (!passwordHash) {
      if (!isValidPassword(data.password)) {
        throw new Error('Password must be at least 6 characters long.');
      }
      passwordHash = hashPassword(data.password);
    }

    const now = new Date().toISOString();

    const sql = `
      INSERT INTO customers (id, name, email, mobile_number, password_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    this.db.execute(sql, [
      id,
      name,
      email,
      mobileNumber,
      passwordHash,
      status,
      now,
      now
    ]);

    return this.findById(id);
  }

  /**
   * Finds customer by unique ID.
   * @param {string} id
   * @returns {any | null}
   */
  findById(id) {
    if (!id) return null;
    const row = this.db.queryOne('SELECT * FROM customers WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Finds customer by normalized email.
   * @param {string} email
   * @returns {any | null}
   */
  findByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = this.db.queryOne('SELECT * FROM customers WHERE email = ?', [normalized]);
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Finds customer by normalized mobile number.
   * @param {string} mobileNumber
   * @returns {any | null}
   */
  findByMobile(mobileNumber) {
    const normalized = normalizeMobile(mobileNumber);
    if (!normalized) return null;
    const row = this.db.queryOne('SELECT * FROM customers WHERE mobile_number = ?', [normalized]);
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Alias for backwards compatibility with tests and callers expecting findByPhone.
   * @param {string} arg1 merchantId or phoneNumber
   * @param {string} [arg2] optional phoneNumber if merchantId was first
   * @returns {any | null}
   */
  findByPhone(arg1, arg2) {
    const phone = arg2 || arg1;
    return this.findByMobile(phone);
  }

  /**
   * Finds customer by either email or mobile number identifier.
   * @param {string} identifier
   * @returns {any | null}
   */
  findByIdentifier(identifier) {
    if (!identifier) return null;
    const trimmed = String(identifier).trim();
    if (trimmed.includes('@')) {
      return this.findByEmail(trimmed);
    }
    const asMobile = this.findByMobile(trimmed);
    if (asMobile) return asMobile;
    return this.findByEmail(trimmed);
  }

  /**
   * Verifies customer login credentials using email or mobile + password.
   * @param {string|any} arg1 Identifier or merchantId
   * @param {string} arg2 Password or phoneNumber
   * @param {string} [arg3] Optional password if merchantId was first
   * @returns {any | null} Safe customer profile or null
   */
  verifyCredentials(arg1, arg2, arg3) {
    let identifier = arg1;
    let password = arg2;
    if (arg3 !== undefined) {
      identifier = arg2;
      password = arg3;
    }

    if (!identifier || !password) return null;

    const customer = this.findByIdentifier(identifier);
    if (!customer) return null;

    if (customer.status !== 'ACTIVE') return null;

    const isValid = verifyPassword(password, customer.passwordHash);
    if (!isValid) return null;

    // Update last_login_at
    const now = new Date().toISOString();
    try {
      this.db.execute('UPDATE customers SET last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, customer.id]);
    } catch {}

    const { passwordHash, ...safeCustomer } = customer;
    safeCustomer.lastLoginAt = new Date(now);
    return safeCustomer;
  }

  /**
   * Returns count of customers in the database.
   * @returns {number}
   */
  count() {
    const row = this.db.queryOne('SELECT COUNT(*) as c FROM customers');
    return row?.c || 0;
  }

  /**
   * Maps SQLite row to camelCase domain model with backward-compatibility aliases.
   */
  mapRow(row) {
    return {
      id: row.id,
      name: row.name,
      fullName: row.name,
      email: row.email,
      mobileNumber: row.mobile_number,
      phoneNumber: row.mobile_number,
      passwordHash: row.password_hash,
      status: row.status,
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}
