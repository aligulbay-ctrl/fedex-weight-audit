import pg from "pg";

const { Pool, types } = pg;
// Return DATE columns as plain "YYYY-MM-DD" strings instead of JS Date
// objects (which shift by timezone and stringify ugly in CSV/JSON output).
types.setTypeParser(1082, (val) => val);

let pool;
let schemaReady = null;

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function db() {
  if (!databaseConfigured()) throw new Error("DATABASE_URL is not configured.");
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes("localhost") ? undefined : { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

export async function queryDb(text, params = []) {
  return db().query(text, params);
}

export async function getClient() {
  return db().connect();
}

// Wraps a route handler so a config/DB problem (or anything else that
// throws) comes back as a readable JSON error instead of a bare 500 -
// without this, a missing DATABASE_URL (or FedEx env vars) crashes the
// serverless function and the browser sees an empty body / Vercel's
// generic HTML error page, which is very hard to debug from the outside.
export function apiHandler(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error("[api error]", err);
      return Response.json({ error: friendlyDbError(err) }, { status: 500 });
    }
  };
}

function friendlyDbError(err) {
  const msg = err?.message || String(err);
  if (msg.includes("DATABASE_URL")) {
    return "Veritabanı bağlantısı yapılandırılmamış: Vercel'de DATABASE_URL ortam değişkenini kontrol edin.";
  }
  if (err?.code === "ECONNREFUSED" || err?.code === "ENOTFOUND" || /connect/i.test(msg)) {
    return `Veritabanına bağlanılamadı (DATABASE_URL'i kontrol edin): ${msg}`;
  }
  if (/password authentication failed|SASL/i.test(msg)) {
    return `Veritabanı kimlik doğrulaması başarısız (DATABASE_URL'deki kullanıcı/şifreyi kontrol edin): ${msg}`;
  }
  return msg;
}

// Idempotent schema setup - safe to call on every request (cached after first success).
export async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const client = await db().connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS invoices (
          id SERIAL PRIMARY KEY,
          invoice_no TEXT UNIQUE NOT NULL,
          invoice_date DATE,
          due_date DATE,
          customer_name TEXT,
          total_amount NUMERIC(14,2),
          currency TEXT DEFAULT 'TL',
          shipment_count INTEGER DEFAULT 0,
          filename TEXT,
          uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS shipments (
          id SERIAL PRIMARY KEY,
          invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
          row_no INTEGER,
          tracking_number TEXT NOT NULL,
          ship_date DATE,
          delivery_date DATE,
          recipient_name TEXT,
          recipient_country TEXT,
          recipient_address TEXT,
          service TEXT,
          reference TEXT,

          invoiced_weight_value NUMERIC(10,2),
          invoiced_weight_unit TEXT,
          invoiced_weight_kg NUMERIC(10,3),
          amount NUMERIC(14,2),
          currency TEXT,

          actual_weight_kg NUMERIC(10,3),
          actual_weight_source TEXT,
          actual_weight_fetched_at TIMESTAMPTZ,
          actual_total_pieces INTEGER,
          fedex_status TEXT,
          fedex_raw_response JSONB,
          fedex_error TEXT,

          weight_diff_kg NUMERIC(10,3),
          weight_diff_pct NUMERIC(10,2),
          is_discrepancy BOOLEAN,
          dispute_status TEXT NOT NULL DEFAULT 'none',
          notes TEXT,

          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (invoice_id, row_no)
        );

        CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments (tracking_number);
        CREATE INDEX IF NOT EXISTS idx_shipments_discrepancy ON shipments (is_discrepancy);
        CREATE INDEX IF NOT EXISTS idx_shipments_invoice ON shipments (invoice_id);

        ALTER TABLE shipments ADD COLUMN IF NOT EXISTS dispute_status TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE shipments ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE shipments ADD COLUMN IF NOT EXISTS fedex_error TEXT;
        ALTER TABLE shipments ADD COLUMN IF NOT EXISTS actual_total_pieces INTEGER;
        -- FedEx dispute reference number (e.g. "CQL 49134122"), filled in
        -- automatically when a matching Gmail "Your dispute record" email is
        -- found for this tracking number (see lib/gmailClient.js).
        ALTER TABLE shipments ADD COLUMN IF NOT EXISTS dispute_ref TEXT;

        -- The e-Fatura header's own "Referans No:" field (see
        -- lib/pdfParser.js -> parseInvoiceMeta) - a single reference number
        -- per invoice issued by the Turkish e-Fatura system, separate from
        -- both invoice_no (FedEx's own invoice number) and each shipment's
        -- per-row "Servis Referans" (shipments.reference).
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reference_no TEXT;

        -- URL of the original uploaded invoice PDF in Vercel Blob storage
        -- (see app/api/invoices/blob-upload/route.js + app/upload/page.js),
        -- so the exact file that was parsed can be re-downloaded later from
        -- the "Yüklenen Faturalar" list. Attached in a second step AFTER
        -- the invoice row already exists (see app/api/invoices/[id]/pdf/
        -- route.js) - best-effort, so a Blob-storage hiccup (or Blob simply
        -- not being set up yet on this Vercel project) never blocks the
        -- actual invoice import, just leaves this NULL for that invoice.
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_blob_url TEXT;

        -- When dispute_status last changed (see app/api/shipments/[id]/route.js
        -- and app/api/gmail/sync/route.js, both of which stamp this on every
        -- real transition). Used to flag "İtiraz Edildi" shipments that have
        -- sat too long without moving to credit_note/resolved - see
        -- only=stale in app/api/shipments/route.js. Backfilled further
        -- down, once dispute_emails exists (needs it to backfill accurately).
        ALTER TABLE shipments ADD COLUMN IF NOT EXISTS dispute_status_changed_at TIMESTAMPTZ;

        -- Single-row table so FedEx credentials / thresholds can be set from
        -- the app's Settings page instead of Vercel env vars. Values here
        -- take priority; env vars (FEDEX_CLIENT_ID etc.) remain a fallback
        -- for anyone who prefers configuring via Vercel.
        CREATE TABLE IF NOT EXISTS app_settings (
          id INTEGER PRIMARY KEY DEFAULT 1,
          fedex_client_id TEXT,
          fedex_client_secret TEXT,
          fedex_api_base TEXT,
          discrepancy_threshold_kg NUMERIC(10,2),
          discrepancy_threshold_pct NUMERIC(10,2),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT app_settings_single_row CHECK (id = 1)
        );

        ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gmail_client_id TEXT;
        ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gmail_client_secret TEXT;
        ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gmail_refresh_token TEXT;
        ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gmail_email TEXT;
        ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gmail_connected_at TIMESTAMPTZ;
        ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gmail_last_synced_at TIMESTAMPTZ;
        -- Days an "İtiraz Edildi" (disputed) shipment can sit without moving
        -- to credit_note/resolved before it's flagged as stale/geciken. No
        -- env-var fallback (see lib/settings.js) - defaults to 15 if never set.
        ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS dispute_stale_days INTEGER;

        -- Minimum |fark| (kg) a discrepancy needs before it's worth actually
        -- filing with FedEx - FedEx's billing dispute process is understood
        -- to only accept/act on differences at or above this floor, so
        -- smaller flagged discrepancies are real but not worth pursuing.
        -- Used by only=fedex_eligible / below_threshold in
        -- app/api/shipments/route.js (see lib/settings.js for the default).
        ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS fedex_min_dispute_kg NUMERIC(10,2);

        -- FedEx "Your dispute record" confirmation emails pulled from Gmail
        -- (see lib/gmailClient.js + app/api/gmail/sync). Matched to a
        -- shipment by tracking_number (not a hard FK - the same tracking
        -- number can legitimately appear on more than one invoice line, see
        -- README), so matched_shipment_id is only the first/primary match
        -- and the UI looks emails up by tracking_number.
        CREATE TABLE IF NOT EXISTS dispute_emails (
          id SERIAL PRIMARY KEY,
          gmail_message_id TEXT UNIQUE NOT NULL,
          gmail_thread_id TEXT,
          subject TEXT,
          from_address TEXT,
          received_at TIMESTAMPTZ,
          ref_no TEXT,
          invoice_no TEXT,
          tracking_number TEXT,
          account_number TEXT,
          dispute_date DATE,
          contact_name TEXT,
          contact_email TEXT,
          weight_value NUMERIC(10,2),
          weight_unit TEXT,
          dispute_reason TEXT,
          snippet TEXT,
          body_text TEXT,
          matched_shipment_id INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_dispute_emails_tracking ON dispute_emails (tracking_number);

        -- One-time backfill for shipments already in a non-'none' status
        -- before dispute_status_changed_at existed (so the aging feature
        -- isn't blind to disputes already in flight): use the earliest
        -- matching dispute email's received date if we have one (the most
        -- accurate signal for "when was this actually filed with FedEx"),
        -- else fall back to the shipment row's own created_at. Safe to
        -- re-run on every deploy - only touches rows still missing a value.
        UPDATE shipments s SET dispute_status_changed_at = COALESCE(
          (SELECT MIN(de.received_at) FROM dispute_emails de WHERE de.tracking_number = s.tracking_number),
          s.created_at
        )
        WHERE s.dispute_status <> 'none' AND s.dispute_status_changed_at IS NULL;

        -- FedEx Ship Manager's own "Ship History" export (fedex.com -> Ship
        -- History -> export), uploaded from app/shipment-history/page.js -
        -- a separate module from the invoice-based comparison above. This
        -- holds the "totalShipmentWeight" the shipper's own system recorded
        -- per shipment, so it can be checked against FedEx Track API's
        -- actual_weight_kg (on shipments) independently of any invoice.
        -- One row per shipment (master tracking number), upserted on
        -- re-upload so overlapping date-range exports stay idempotent.
        CREATE TABLE IF NOT EXISTS fedex_shipment_history (
          id SERIAL PRIMARY KEY,
          master_tracking_number TEXT UNIQUE NOT NULL,
          ship_date DATE,
          reference TEXT,
          number_of_packages INTEGER,
          total_shipment_weight NUMERIC(12,3),
          weight_unit TEXT,
          total_shipment_weight_kg NUMERIC(12,3),
          status TEXT,
          source_filename TEXT,
          uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fedex_shipment_history_tracking ON fedex_shipment_history (master_tracking_number);

        -- One-time repair for a fixed bug: evaluateDiscrepancy() used to
        -- accept NaN (from parseFloat(null) on a shipment with no invoiced
        -- weight) as if it were a real number, and Postgres NUMERIC happily
        -- stores a literal 'NaN' - so any such row shows "NaN kg (NaN%)" on
        -- the dashboard forever until reset. Safe to re-run on every
        -- deploy - a no-op once no NaN rows are left (see lib/weightUtils.js).
        UPDATE shipments
        SET weight_diff_kg = NULL, weight_diff_pct = NULL, is_discrepancy = NULL
        WHERE weight_diff_kg = 'NaN'::numeric OR weight_diff_pct = 'NaN'::numeric;
      `);
    } finally {
      client.release();
    }
  })();
  return schemaReady;
}
