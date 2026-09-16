-- RAHMA MALL — DEAL DONE & PURCHASE TRACKING SYSTEM
-- Adds branch visits, purchases (with line items and refunds), and a small
-- branch/product catalog. Deal Status (NO_PURCHASE/BRANCH_VISIT/COMPLETED/
-- CANCELLED/REFUNDED/PARTIALLY_REFUNDED) is intentionally NOT a stored column
-- on customers — it is always computed live from customer_branch_visits +
-- purchase_transactions (same "never let it go stale" principle used
-- elsewhere), and it is completely separate from customers.status (the
-- call-team pipeline status). Nothing existing is modified or removed.

PRAGMA foreign_keys = ON;

-- =====================================================================
-- BRANCH MASTER DATA (Branch is never free text — section 9)
-- =====================================================================
CREATE TABLE IF NOT EXISTS branches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO branches (name) VALUES ('فرع 1');
INSERT OR IGNORE INTO branches (name) VALUES ('فرع 2');
INSERT OR IGNORE INTO branches (name) VALUES ('فرع 3');

-- =====================================================================
-- PRODUCT CATALOG (lightweight; purchase_items also stores a denormalized
-- product_name so a one-off/free-typed product never blocks a sale — but
-- linking product_id lets Product Revenue Analytics work over the catalog).
-- =====================================================================
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  sku         TEXT UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

-- Seed the catalog from whatever products already appear on customers, so it
-- isn't empty on first use and existing data isn't orphaned.
INSERT OR IGNORE INTO products (name)
SELECT DISTINCT product FROM customer_products;

-- =====================================================================
-- BRANCH VISITS ("customer physically came to the branch" — does NOT imply
-- a purchase happened; append-only)
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_branch_visits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id  INTEGER REFERENCES employees(id),
  branch_id    INTEGER NOT NULL REFERENCES branches(id),
  visit_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_branchvisits_customer ON customer_branch_visits(customer_id);
CREATE INDEX IF NOT EXISTS idx_branchvisits_branch ON customer_branch_visits(branch_id);
CREATE INDEX IF NOT EXISTS idx_branchvisits_visitat ON customer_branch_visits(visit_at);

-- =====================================================================
-- PURCHASE TRANSACTIONS ("Deal Done"). A customer can have many.
-- status: COMPLETED counts toward revenue; CANCELLED never does; REFUNDED /
-- PARTIALLY_REFUNDED are derived automatically from purchase_refunds and
-- still net into revenue via (total_amount - refunded_amount).
-- attributed_employee_id defaults to the customer's currently-assigned
-- employee at creation time but the Team Leader may explicitly reassign
-- attribution afterward (see purchase_attribution_history — never overwritten
-- silently).
-- =====================================================================
CREATE TABLE IF NOT EXISTS purchase_transactions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id           TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  attributed_employee_id INTEGER REFERENCES employees(id),
  branch_id             INTEGER NOT NULL REFERENCES branches(id),
  purchase_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  invoice_number        TEXT UNIQUE,   -- optional; NULLs don't collide in SQLite UNIQUE
  order_id              TEXT UNIQUE,   -- optional; reserved for future POS/e-commerce linkage
  subtotal              REAL NOT NULL DEFAULT 0,
  discount_total        REAL NOT NULL DEFAULT 0,
  tax_total             REAL NOT NULL DEFAULT 0,
  total_amount          REAL NOT NULL DEFAULT 0,   -- subtotal - discount_total + tax_total
  refunded_amount        REAL NOT NULL DEFAULT 0,   -- sum of purchase_refunds, kept in sync on every refund
  payment_method        TEXT NOT NULL DEFAULT 'CASH',
  status                TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED')),
  notes                 TEXT,
  source                TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','POS')),  -- MANUAL today; POS reserved (section 61)
  created_by             INTEGER REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cancelled_at           TEXT,
  cancelled_by           INTEGER REFERENCES users(id),
  cancel_reason          TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_customer ON purchase_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_purchases_employee ON purchase_transactions(attributed_employee_id);
CREATE INDEX IF NOT EXISTS idx_purchases_branch ON purchase_transactions(branch_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchase_transactions(status);
CREATE INDEX IF NOT EXISTS idx_purchases_purchaseat ON purchase_transactions(purchase_at);

CREATE TABLE IF NOT EXISTS purchase_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id  INTEGER NOT NULL REFERENCES purchase_transactions(id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,   -- denormalized so a free-typed / deleted-catalog product still reads correctly
  sku          TEXT,
  quantity     REAL NOT NULL DEFAULT 1,
  unit_price   REAL NOT NULL DEFAULT 0,
  discount     REAL NOT NULL DEFAULT 0,
  subtotal     REAL NOT NULL DEFAULT 0   -- (quantity * unit_price) - discount, computed server-side
);
CREATE INDEX IF NOT EXISTS idx_purchaseitems_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchaseitems_product ON purchase_items(product_id);

-- Append-only; a purchase's refunded_amount/status are recomputed from this.
CREATE TABLE IF NOT EXISTS purchase_refunds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id   INTEGER NOT NULL REFERENCES purchase_transactions(id) ON DELETE CASCADE,
  refund_amount REAL NOT NULL,
  refund_reason TEXT,
  refund_notes  TEXT,
  refunded_by   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_purchaserefunds_purchase ON purchase_refunds(purchase_id);

-- Attribution changes are never silent overwrites (section 27/64).
CREATE TABLE IF NOT EXISTS purchase_attribution_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id         INTEGER NOT NULL REFERENCES purchase_transactions(id) ON DELETE CASCADE,
  previous_employee_id INTEGER REFERENCES employees(id),
  new_employee_id     INTEGER REFERENCES employees(id),
  changed_by          INTEGER REFERENCES users(id),
  changed_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason              TEXT
);
CREATE INDEX IF NOT EXISTS idx_attributionhist_purchase ON purchase_attribution_history(purchase_id);

-- Field-level purchase edit audit (amount/products/employee/branch/status
-- changes — section 42). Generic activity_logs also gets a summary row;
-- this table keeps the structured old/new value pair for the Purchases tab.
CREATE TABLE IF NOT EXISTS purchase_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id   INTEGER NOT NULL REFERENCES purchase_transactions(id) ON DELETE CASCADE,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  changed_by    INTEGER REFERENCES users(id),
  changed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason        TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchaseaudit_purchase ON purchase_audit_log(purchase_id);
