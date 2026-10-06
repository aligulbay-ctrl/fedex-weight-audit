"use client";

import { useEffect, useState, useCallback } from "react";
import { DISPUTE_STATUSES, disputeStatusColor } from "../lib/statusLabels.js";
import { formatWeightInInvoiceUnit, formatDiffInInvoiceUnit } from "../lib/weightUtils.js";

const SORT_OPTIONS = [
  { value: "default", label: "Varsayılan (farklı ağırlık önce)" },
  { value: "status", label: "Duruma göre" },
  { value: "diff_desc", label: "Farka göre (büyükten küçüğe)" },
  { value: "date_desc", label: "Tarihe göre (yeni önce)" },
  { value: "date_asc", label: "Tarihe göre (eski önce)" },
];

// Clickable-column-header sorts for the shipments table (Fatura Ağırlığı /
// FedEx Gerçek / Toplam Parça / Fark) - each `key` here matches a pair of
// `${key}_asc` / `${key}_desc` entries in the server's SORTS whitelist (see
// app/api/shipments/route.js). Kept separate from SORT_OPTIONS/the "Sırala"
// dropdown above, which are named presets rather than a single column.
const SORTABLE_COLUMNS = [
  { key: "invoiced_weight", label: "Fatura Ağırlığı" },
  { key: "actual_weight", label: "FedEx Gerçek" },
  { key: "pieces", label: "Toplam Parça" },
  { key: "diff_kg", label: "Fark" },
];

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [shipments, setShipments] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [filter, setFilter] = useState("discrepancy");
  const [search, setSearch] = useState("");
  const [minFedexWeightKg, setMinFedexWeightKg] = useState(""); // FedEx'in kendi sisteminden gelen GERÇEK ağırlığa göre alt sınır (faturadaki değil)
  const [sort, setSort] = useState("default");
  const [invoiceFilter, setInvoiceFilter] = useState(null); // {id, invoice_no} | null
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null); // invoice id awaiting a second click
  const [deletingId, setDeletingId] = useState(null); // invoice id whose DELETE request is in flight
  const [staleDays, setStaleDays] = useState(15); // Ayarlar'daki "İtiraz Yaşlandırma Eşiği" - only for row styling, the actual filtering happens server-side
  const [fedexMinDisputeKg, setFedexMinDisputeKg] = useState(2); // Ayarlar'daki "FedEx Minimum İtiraz Eşiği" - only for labels, the actual filtering happens server-side
  const [reportScope, setReportScope] = useState("discrepancy"); // Excel/PDF rapor indirme linklerinin ?only= kapsamı
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [matchingTotal, setMatchingTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    const q = new URLSearchParams();
    if (filter !== "all") q.set("only", filter);
    if (search) q.set("search", search);
    if (minFedexWeightKg) q.set("minFedexWeightKg", minFedexWeightKg);
    if (sort !== "default") q.set("sort", sort);
    if (invoiceFilter) q.set("invoiceId", invoiceFilter.id);
    q.set("page", page);
    const [shipRes, invRes] = await Promise.all([
      fetch(`/api/shipments?${q.toString()}`).then((r) => r.json()),
      fetch(`/api/invoices`).then((r) => r.json()),
    ]);
    setStats(shipRes.stats);
    setShipments(shipRes.shipments || []);
    setMatchingTotal(shipRes.matchingTotal ?? 0);
    setTotalPages(shipRes.totalPages ?? 1);
    setInvoices(invRes.invoices || []);
    setLoading(false);
  }, [filter, search, minFedexWeightKg, sort, invoiceFilter, page]);

  useEffect(() => {
    load();
  }, [load]);

  // Any change to what's being filtered/searched/sorted invalidates the
  // current page (a page 3 in "Tümü" may not exist in "Bekleyenler") - jump
  // back to page 1 rather than showing an empty or mismatched page. This
  // effect intentionally does NOT depend on `page` itself, or clicking
  // "Sonraki" would immediately reset back to page 1.
  useEffect(() => {
    setPage(1);
  }, [filter, search, minFedexWeightKg, sort, invoiceFilter]);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.disputeStaleDays != null) setStaleDays(d.disputeStaleDays);
        if (d.fedexMinDisputeKg != null) setFedexMinDisputeKg(d.fedexMinDisputeKg);
      })
      .catch(() => {});
  }, []);

  function openInvoice(inv) {
    setInvoiceFilter({ id: inv.id, invoice_no: inv.invoice_no });
    setFilter("discrepancy");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Deleting an invoice is destructive (it also removes every shipment row
  // that came from it - the DB cascades that), so this only fires on the
  // *second* click: the first click just arms confirmDeleteId and the row
  // swaps its "Sil" button for an inline "Silinsin mi? Evet / Vazgeç"
  // prompt, same "explicit second step" pattern as the duplicate-upload
  // "Yine de üzerine yaz" flow on the upload page.
  async function deleteInvoice(inv) {
    setDeletingId(inv.id);
    try {
      const res = await fetch(`/api/invoices/${inv.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        alert(data.error || "Fatura silinemedi.");
        return;
      }
      if (invoiceFilter?.id === inv.id) setInvoiceFilter(null);
      await load();
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  // Clicking a sortable column header: first click sorts that column
  // descending (biggest/heaviest first, the more common thing to want to
  // see), a second click on the SAME header flips to ascending, matching
  // typical spreadsheet column-header behavior.
  function toggleColumnSort(key) {
    setSort((current) => (current === `${key}_desc` ? `${key}_asc` : `${key}_desc`));
  }

  function columnSortIndicator(key) {
    if (sort === `${key}_desc`) return " ▼";
    if (sort === `${key}_asc`) return " ▲";
    return "";
  }

  // Used by the "Aksiyonlar" sidebar cards - jump straight to a filtered
  // view of the shipments table, clearing any invoice/search filter so the
  // count the user clicked on actually matches what they see.
  function goTo(newFilter) {
    setInvoiceFilter(null);
    setSearch("");
    setFilter(newFilter);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function syncAll() {
    setSyncing(true);
    let totalSucceeded = 0;
    let totalFailed = 0;
    try {
      // Calls /api/sync repeatedly (small batches) until nothing pending is left.
      for (let i = 0; i < 200; i++) {
        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 15 }),
        });
        const data = await res.json();
        if (data.error) {
          setSyncMsg(data.error);
          break;
        }
        totalSucceeded += data.succeeded;
        totalFailed += data.failed;
        setSyncMsg(`${totalSucceeded} gönderi güncellendi, ${totalFailed} hata, ${data.remaining} bekliyor...`);
        if (data.remaining === 0 || data.processed === 0) break;
      }
      setSyncMsg((m) => `${m} — tamamlandı.`);
    } finally {
      setSyncing(false);
      load();
    }
  }

  return (
    <div className="layout-with-sidebar">
      <ActionsPanel stats={stats} onGo={goTo} fedexMinDisputeKg={fedexMinDisputeKg} />

      <div>
      <h1>Gönderi Ağırlık Kontrol Paneli</h1>
      <p className="sub">Fatura PDF'lerinden çıkarılan ağırlıklar, FedEx Track API'den çekilen gerçek ağırlıkla karşılaştırılır.</p>

      <div className="cards">
        <Card label="Toplam Gönderi" value={stats?.total ?? "—"} />
        <Card label="Farklı Ağırlık" value={stats?.discrepancies ?? "—"} tone="danger" />
        <Card label="Senkron Bekliyor" value={stats?.pending ?? "—"} tone="warn" />
        <Card label="FedEx Hatası" value={stats?.errors ?? "—"} tone="warn" />
        <Card label="Fatura Sayısı" value={invoices.length} />
      </div>

      <div className="toolbar">
        <button className="primary" onClick={syncAll} disabled={syncing}>
          {syncing ? "Senkronize ediliyor…" : "FedEx ile senkronize et (bekleyenler)"}
        </button>
        <a className="btn" href="/api/export?only=discrepancy" target="_blank" rel="noopener">CSV indir (farklı ağırlıklar)</a>
        <a className="btn" href="/api/export?only=all" target="_blank" rel="noopener">CSV indir (tümü)</a>
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--muted)", fontSize: 12 }}>
          Rapor kapsamı:
          <select value={reportScope} onChange={(e) => setReportScope(e.target.value)}>
            <option value="discrepancy">Farklı ağırlıklar</option>
            <option value="fedex_eligible">{`İtiraz edilebilir (≥${fedexMinDisputeKg} kg)`}</option>
            <option value="below_threshold">{`Eşik altı (0-${fedexMinDisputeKg} kg)`}</option>
            <option value="negative">Negatif fark (eksik faturalandı)</option>
            <option value="missing_weight">Fatura ağırlığı eksik/0</option>
          </select>
        </label>
        <a className="btn" href={`/api/export/xlsx?only=${reportScope}`} target="_blank" rel="noopener">Excel rapor indir</a>
        <a className="btn" href={`/api/export/pdf?only=${reportScope}`} target="_blank" rel="noopener">PDF rapor indir</a>
        <div className="spacer" />
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--muted)", fontSize: 12 }}>
          FedEx gerçek ağırlık ≥
          <input
            type="number"
            min="0"
            step="0.1"
            placeholder="ör. 12"
            style={{ width: 64 }}
            value={minFedexWeightKg}
            onChange={(e) => setMinFedexWeightKg(e.target.value)}
          />
          kg
        </label>
        <input
          type="search"
          placeholder="Takip no / alıcı / referans ara…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {syncMsg && <p className="sub" style={{ marginTop: -8 }}>{syncMsg}</p>}

      <div className="toolbar">
        <div className="filters">
          <FilterBtn
            label="Farklı ağırlıklar"
            count={stats?.discrepancies}
            active={filter === "discrepancy"}
            onClick={() => setFilter("discrepancy")}
          />
          <FilterBtn
            label={`İtiraz edilebilir (≥${fedexMinDisputeKg} kg)`}
            count={stats?.fedex_eligible}
            active={filter === "fedex_eligible"}
            onClick={() => setFilter("fedex_eligible")}
          />
          <FilterBtn
            label={`Eşik altı (0-${fedexMinDisputeKg} kg)`}
            count={stats?.below_threshold}
            active={filter === "below_threshold"}
            onClick={() => setFilter("below_threshold")}
          />
          <FilterBtn
            label="Negatif fark (eksik faturalandı)"
            count={stats?.negative}
            active={filter === "negative"}
            onClick={() => setFilter("negative")}
          />
          <FilterBtn
            label="Takipte olanlar"
            count={stats?.review}
            active={filter === "review"}
            onClick={() => setFilter("review")}
          />
          <FilterBtn
            label="Geciken itirazlar"
            count={stats?.stale}
            active={filter === "stale"}
            onClick={() => setFilter("stale")}
          />
          <FilterBtn
            label="Bekleyenler"
            count={stats?.pending}
            active={filter === "pending"}
            onClick={() => setFilter("pending")}
          />
          <FilterBtn
            label="Hatalılar"
            count={stats?.errors}
            active={filter === "error"}
            onClick={() => setFilter("error")}
          />
          <FilterBtn
            label="Fatura ağırlığı eksik/0"
            count={stats?.missing_weight}
            active={filter === "missing_weight"}
            onClick={() => setFilter("missing_weight")}
          />
          <FilterBtn
            label="Tümü"
            count={stats?.total}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
        </div>
        <div className="spacer" />
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--muted)", fontSize: 12 }}>
          Sırala:
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      {invoiceFilter && (
        <div className="toolbar" style={{ marginTop: -8 }}>
          <span className="pill muted">
            Fatura <strong className="mono">{invoiceFilter.invoice_no}</strong> için filtrelendi
          </span>
          <button onClick={() => setInvoiceFilter(null)}>Filtreyi kaldır</button>
        </div>
      )}

      {loading ? (
        <div className="empty">Yükleniyor…</div>
      ) : shipments.length === 0 ? (
        <div className="empty">
          Bu filtrede gönderi yok. Henüz fatura yüklemediyseniz <a href="/upload">buradan</a> başlayın.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Takip No</th>
              <th>Fatura</th>
              <th>Alıcı</th>
              {SORTABLE_COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className="sortable"
                  title={`${c.label} - sıralamak için tıklayın`}
                  onClick={() => toggleColumnSort(c.key)}
                >
                  {c.label}{columnSortIndicator(c.key)}
                </th>
              ))}
              <th>Durum</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shipments.map((s) => (
              <ShipmentRow
                key={s.id}
                s={s}
                expanded={expanded === s.id}
                onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
                onRefreshed={load}
                staleDays={staleDays}
              />
            ))}
          </tbody>
        </table>
      )}

      {!loading && matchingTotal > PAGE_SIZE && (
        <Pager
          page={page}
          totalPages={totalPages}
          matchingTotal={matchingTotal}
          pageSize={PAGE_SIZE}
          onChange={(p) => {
            setPage(p);
            if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      )}

      <h2>Yüklenen Faturalar</h2>
      {invoices.length === 0 ? (
        <p className="sub">Henüz fatura yüklenmedi.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Fatura No</th>
              <th>Tarih</th>
              <th>Gönderi</th>
              <th>Senkron</th>
              <th>Farklı Ağırlık</th>
              <th>Tutar</th>
              <th>PDF</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr
                key={inv.id}
                onClick={() => openInvoice(inv)}
                title="Bu faturanın farklı ağırlıklı gönderilerini gör"
                style={{ cursor: "pointer" }}
              >
                <td className="mono">
                  {inv.invoice_no}
                  {inv.reference_no && (
                    <div className="sub" style={{ marginTop: 2, fontSize: 11 }}>
                      Ref: {inv.reference_no}
                    </div>
                  )}
                </td>
                <td>{inv.invoice_date}</td>
                <td>{inv.shipment_count}</td>
                <td>{inv.synced_count}/{inv.shipment_count}</td>
                <td>{Number(inv.discrepancy_count) > 0 ? <span className="pill danger">{inv.discrepancy_count}</span> : "—"}</td>
                <td className="mono">{formatMoney(inv.total_amount)} {inv.currency}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {inv.pdf_blob_url ? (
                    <a
                      className="btn-link"
                      href={inv.pdf_blob_url}
                      target="_blank"
                      rel="noopener"
                      title="Orijinal fatura PDF'ini indir"
                    >
                      İndir
                    </a>
                  ) : (
                    <span className="sub" title="Bu fatura için PDF kopyası saklanmamış (Blob Storage kurulu değildi ya da yükleme sırasında bir sorun oldu)">—</span>
                  )}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {confirmDeleteId === inv.id ? (
                    <span style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
                      <span className="sub">{inv.shipment_count} gönderiyle silinsin mi?</span>
                      <button
                        className="danger"
                        disabled={deletingId === inv.id}
                        onClick={() => deleteInvoice(inv)}
                      >
                        {deletingId === inv.id ? "Siliniyor…" : "Evet, sil"}
                      </button>
                      <button disabled={deletingId === inv.id} onClick={() => setConfirmDeleteId(null)}>
                        Vazgeç
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn-link-danger"
                      title="Bu faturayı ve içindeki tüm gönderi satırlarını sil"
                      onClick={() => setConfirmDeleteId(inv.id)}
                    >
                      Sil
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </div>
    </div>
  );
}

function ActionsPanel({ stats, onGo, fedexMinDisputeKg }) {
  const items = [
    {
      key: "discrepancy",
      title: "Farklı Ağırlıklı Gönderiler",
      count: stats?.discrepancies,
      detail: "faturayla FedEx gerçek ağırlığı uyuşmuyor",
      severity: "critical",
    },
    {
      key: "fedex_eligible",
      title: "İtiraz Edilebilir Farklar",
      count: stats?.fedex_eligible,
      detail: `≥${fedexMinDisputeKg} kg fark - FedEx'e itiraz etmeye değer`,
      severity: "critical",
    },
    {
      key: "review",
      title: "Takipte Olan İtirazlar",
      count: stats?.review,
      detail: "işaretlendi / itiraz edildi durumunda",
      severity: "medium",
    },
    {
      key: "stale",
      title: "Geciken İtirazlar",
      count: stats?.stale,
      detail: "uzun süredir itiraz edildi durumunda, takip gerekebilir",
      severity: "critical",
    },
    {
      key: "pending",
      title: "Senkron Bekleyen Gönderiler",
      count: stats?.pending,
      detail: "FedEx'ten henüz ağırlık çekilmedi",
      severity: "medium",
    },
    {
      key: "error",
      title: "FedEx Hatalı Gönderiler",
      count: stats?.errors,
      detail: "Track API'den hata döndü",
      severity: "medium",
    },
  ];
  const totalActionable = items.reduce((sum, it) => sum + (Number(it.count) > 0 ? Number(it.count) : 0), 0);

  return (
    <aside>
      <div className="actions-panel-title">
        Aksiyonlar
        {totalActionable > 0 && <span className="count-badge">{totalActionable}</span>}
      </div>
      {items.map((it) => {
        const n = Number(it.count) || 0;
        const badgeClass = n === 0 ? "ok" : it.severity;
        const badgeLabel = n === 0 ? "TAMAM" : it.severity === "critical" ? "KRİTİK" : "ORTA";
        return (
          <button key={it.key} className="action-card" onClick={() => onGo(it.key)}>
            <div className="ac-top">
              <span className="ac-title">{it.title}</span>
              <span className={`ac-badge ${badgeClass}`}>{badgeLabel}</span>
            </div>
            <div className="ac-detail">
              <strong>{it.count ?? "—"}</strong> gönderi {it.detail}
            </div>
          </button>
        );
      })}
    </aside>
  );
}

function Card({ label, value, tone }) {
  return (
    <div className={`card ${tone || ""}`}>
      <div className="n">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function FilterBtn({ label, count, active, onClick }) {
  return (
    <button className={active ? "active" : ""} onClick={onClick}>
      {label}
      {count != null && <span className="filter-count">{count}</span>}
    </button>
  );
}

// Page-number list with "…" gaps for large page counts - always shows page
// 1, the last page, and a small window around the current page, so jumping
// to either end or nearby pages never requires clicking "Sonraki" repeatedly.
function pageNumbersWithGaps(page, totalPages) {
  const pages = new Set([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push("…");
    out.push(sorted[i]);
  }
  return out;
}

function Pager({ page, totalPages, matchingTotal, pageSize, onChange }) {
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, matchingTotal);
  return (
    <div className="toolbar" style={{ marginTop: -6, justifyContent: "space-between" }}>
      <span className="sub" style={{ margin: 0 }}>
        {from}-{to} / {matchingTotal} gönderi gösteriliyor
      </span>
      <div className="pager" style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button disabled={page <= 1} onClick={() => onChange(page - 1)}>‹ Önceki</button>
        {pageNumbersWithGaps(page, totalPages).map((p, i) =>
          p === "…" ? (
            <span key={`gap-${i}`} className="sub" style={{ padding: "0 4px" }}>…</span>
          ) : (
            <button key={p} className={p === page ? "active" : ""} onClick={() => onChange(p)} disabled={p === page}>
              {p}
            </button>
          )
        )}
        <button disabled={page >= totalPages} onClick={() => onChange(page + 1)}>Sonraki ›</button>
      </div>
    </div>
  );
}

function ShipmentRow({ s, expanded, onToggle, onRefreshed, staleDays }) {
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState(s.notes || "");
  const [detail, setDetail] = useState(null);
  const [emailsOpen, setEmailsOpen] = useState(false);

  useEffect(() => {
    if (expanded && !detail) {
      fetch(`/api/shipments/${s.id}`).then((r) => r.json()).then((d) => setDetail(d.shipment));
    }
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    setBusy(true);
    await fetch(`/api/shipments/${s.id}/refresh`, { method: "POST" });
    setBusy(false);
    onRefreshed();
  }

  async function saveNotes() {
    await fetch(`/api/shipments/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
  }

  async function setDispute(status) {
    await fetch(`/api/shipments/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disputeStatus: status }),
    });
    onRefreshed();
  }

  const statusColor = disputeStatusColor(s.dispute_status);

  return (
    <>
      <tr className={`status-accent-${statusColor}`}>
        <td className="mono">
          <a
            className={`status-text-${statusColor}`}
            href={`https://www.fedex.com/fedextrack/?trknbr=${s.tracking_number}`}
            target="_blank"
            rel="noreferrer"
          >
            {s.tracking_number}
          </a>
        </td>
        <td className="mono">
          {s.invoice_no}
          {s.invoice_reference_no && (
            <div className="sub" style={{ marginTop: 2, fontSize: 11 }}>
              Ref: {s.invoice_reference_no}
            </div>
          )}
        </td>
        <td>{s.recipient_name}<br /><span className="sub" style={{ color: "var(--muted)" }}>{s.recipient_country}</span></td>
        <td className="mono">
          {/* invoiced_weight_kg is genuinely NULL when the PDF parser
              couldn't read a weight for this row at all - showing "0.00 kg"
              for that (Number(null) === 0) reads as real data when it's
              actually missing, so it gets its own "eksik" pill instead. A
              real literal 0 (rare, but a distinct case from "never parsed")
              still prints normally. */}
          {s.invoiced_weight_kg != null ? (
            <>{s.invoiced_weight_value} {s.invoiced_weight_unit} ({Number(s.invoiced_weight_kg).toFixed(2)} kg)</>
          ) : (
            <span className="pill muted">eksik</span>
          )}
        </td>
        <td className="mono">{formatWeightInInvoiceUnit(s.actual_weight_kg, s.invoiced_weight_unit)}</td>
        <td className="mono">{s.actual_total_pieces ?? "—"}</td>
        <td className="mono">
          {s.weight_diff_kg != null ? (
            <span className={s.is_discrepancy ? "pill danger" : "pill ok"}>
              {formatDiffInInvoiceUnit(s.weight_diff_kg, s.invoiced_weight_unit)}
              {s.weight_diff_pct != null ? ` (${s.weight_diff_pct > 0 ? "+" : ""}${Number(s.weight_diff_pct).toFixed(1)}%)` : ""}
            </span>
          ) : s.invoiced_weight_kg == null && s.actual_weight_kg != null ? (
            <span className="pill muted">fatura ağırlığı eksik</span>
          ) : s.fedex_error ? (
            <span className="pill warn">hata</span>
          ) : (
            <span className="pill muted">bekliyor</span>
          )}
        </td>
        <td>
          <select value={s.dispute_status} onChange={(e) => setDispute(e.target.value)}>
            {DISPUTE_STATUSES.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {s.dispute_ref && (
            <div className="sub" style={{ marginTop: 3, fontSize: 11 }}>
              Ref: <span className="mono">{s.dispute_ref}</span>
            </div>
          )}
          {s.dispute_status === "disputed" && s.days_in_dispute != null && (
            <div
              className={s.days_in_dispute >= staleDays ? "pill danger" : "sub"}
              style={{ marginTop: 3, fontSize: 11, display: "inline-block" }}
            >
              {s.days_in_dispute} gündür itirazda{s.days_in_dispute >= staleDays ? " - takip edin!" : ""}
            </div>
          )}
        </td>
        <td>
          <button onClick={refresh} disabled={busy}>{busy ? "…" : "Yenile"}</button>{" "}
          <button onClick={onToggle}>{expanded ? "Gizle" : "Detay"}</button>
          {Number(s.dispute_email_count) > 0 && (
            <>
              {" "}
              <button onClick={() => setEmailsOpen((v) => !v)}>
                ✉️ E-postalar ({s.dispute_email_count})
              </button>
            </>
          )}
        </td>
      </tr>
      {emailsOpen && <DisputeEmailsPanel shipmentId={s.id} />}
      {expanded && (
        <tr>
          <td colSpan={9}>
            <div style={{ display: "grid", gap: 8 }}>
              <div>
                <strong>Servis:</strong> {s.service} &nbsp; <strong>Referans:</strong> {s.reference || "—"} &nbsp;
                <strong>Gönderim:</strong> {s.ship_date} &nbsp; <strong>Teslimat:</strong> {s.delivery_date} &nbsp;
                <strong>Tutar:</strong> {formatMoney(s.amount)} {s.currency}
              </div>
              {s.fedex_status && <div><strong>FedEx Durumu:</strong> {s.fedex_status}</div>}
              {s.actual_weight_source && <div><strong>Ağırlık Kaynağı:</strong> {s.actual_weight_source}</div>}
              {s.fedex_error && <div style={{ color: "var(--danger)" }}><strong>Hata:</strong> {s.fedex_error}</div>}
              <div>
                <input
                  className="note-input"
                  placeholder="Not ekleyin…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={saveNotes}
                />
              </div>
              {detail?.fedex_raw_response && (
                <details className="raw">
                  <summary>Ham FedEx yanıtı (ağırlık alanını doğrulamak için)</summary>
                  <pre>{JSON.stringify(detail.fedex_raw_response, null, 2)}</pre>
                </details>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DisputeEmailsPanel({ shipmentId }) {
  const [loading, setLoading] = useState(true);
  const [emails, setEmails] = useState([]);

  useEffect(() => {
    fetch(`/api/shipments/${shipmentId}/dispute-emails`)
      .then((r) => r.json())
      .then((d) => {
        setEmails(d.emails || []);
        setLoading(false);
      });
  }, [shipmentId]);

  return (
    <tr>
      <td colSpan={9} style={{ background: "var(--bg)" }}>
        {loading ? (
          <div className="sub">Yükleniyor…</div>
        ) : emails.length === 0 ? (
          <div className="sub">İlişkili itiraz e-postası bulunamadı.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {emails.map((em) => (
              <div key={em.id} className="card" style={{ padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <strong>{em.subject}</strong>
                  {em.gmail_message_id && (
                    <a
                      className="btn"
                      href={`https://mail.google.com/mail/u/0/#all/${em.gmail_message_id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Gmail'de aç
                    </a>
                  )}
                </div>
                <div className="sub" style={{ margin: "6px 0 0" }}>
                  {em.ref_no && <>Ref: <span className="mono">{em.ref_no}</span> &nbsp; </>}
                  {em.dispute_date && <>Tarih: {em.dispute_date} &nbsp; </>}
                  {em.dispute_reason && <>Neden: {em.dispute_reason} &nbsp; </>}
                  {em.weight_value != null && <>Ağırlık: {em.weight_value} {em.weight_unit} &nbsp; </>}
                  {em.invoice_no && <>Fatura: <span className="mono">{em.invoice_no}</span></>}
                </div>
                {em.body_text && (
                  <details className="raw" style={{ marginTop: 6 }}>
                    <summary>E-posta içeriğini göster</summary>
                    <pre style={{ whiteSpace: "pre-wrap" }}>{em.body_text}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

function formatMoney(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// FedEx's Track API always comes back in kg (actual_weight_kg), but the
// invoice line can be billed in either KG or LB - showing "FedEx Gerçek"
// in kg next to an invoiced weight billed in LB makes the two numbers hard
// to compare at a glance. This mirrors the invoiced-weight cell's own
// formatWeightInInvoiceUnit / formatDiffInInvoiceUnit now live in
// lib/weightUtils.js so the xlsx/PDF report builders can share the exact
// same "match the invoice's own unit" formatting the dashboard uses.
