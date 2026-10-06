"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { parseShipmentHistoryXlsx } from "../../lib/shipmentHistoryParser.js";

function fmtKg(v) {
  return v == null ? "—" : `${Number(v).toFixed(2)} kg`;
}
function fmtDate(v) {
  return v || "—";
}

const CATEGORY_CARDS = [
  { key: "all", label: "Yüklenen Toplam Gönderi" },
  { key: "same", label: "Aynı (fark yok)", tone: "ok" },
  { key: "different", label: "Farklı", tone: "danger" },
  { key: "notYetTracked", label: "Henüz FedEx Takibinde Yok", tone: "warn" },
  { key: "fedexOnly", label: "Excel'de Olmayan (FedEx'te Var)", tone: "warn" },
];

const COLUMNS_BY_CATEGORY = {
  all: [
    { key: "master_tracking_number", label: "Takip No" },
    { key: "ship_date", label: "Tarih" },
    { key: "invoice_no", label: "Fatura" },
    { key: "total_shipment_weight_kg", label: "Ship History Ağırlığı" },
    { key: "actual_weight_kg", label: "FedEx Gerçek" },
    { key: "status", label: "Durum" },
  ],
  same: [
    { key: "master_tracking_number", label: "Takip No" },
    { key: "ship_date", label: "Tarih" },
    { key: "invoice_no", label: "Fatura" },
    { key: "total_shipment_weight_kg", label: "Ship History Ağırlığı" },
    { key: "actual_weight_kg", label: "FedEx Gerçek" },
  ],
  different: [
    { key: "master_tracking_number", label: "Takip No" },
    { key: "ship_date", label: "Tarih" },
    { key: "invoice_no", label: "Fatura" },
    { key: "total_shipment_weight_kg", label: "Ship History Ağırlığı" },
    { key: "actual_weight_kg", label: "FedEx Gerçek" },
    { key: "diff_kg", label: "Fark" },
  ],
  notYetTracked: [
    { key: "master_tracking_number", label: "Takip No" },
    { key: "ship_date", label: "Tarih" },
    { key: "reference", label: "Referans" },
    { key: "total_shipment_weight_kg", label: "Ship History Ağırlığı" },
    { key: "status", label: "Durum" },
  ],
  fedexOnly: [
    { key: "master_tracking_number", label: "Takip No" },
    { key: "ship_date", label: "Tarih" },
    { key: "invoice_no", label: "Fatura" },
    { key: "actual_weight_kg", label: "FedEx Gerçek" },
  ],
};

const CATEGORY_DESCRIPTIONS = {
  all: "Yüklenen Ship History dosyasındaki her gönderi, eşleşme durumuyla birlikte.",
  same: "Ship History ağırlığı ile FedEx Track API'nin gerçek ağırlığı 0,1 kg toleransı içinde eşleşiyor.",
  different: "Ship History'deki toplam gönderi ağırlığı ile FedEx Track API'nin gerçek ağırlığı arasında 0,1 kg'dan büyük fark var.",
  notYetTracked: "Ship History'de bu gönderiler var, ama henüz FedEx Track API'den gerçek ağırlığı çekilmemiş - ya fatura hiç yüklenmedi, ya da faturası yüklendi ama \"FedEx ile senkronize et\" ile ağırlığı henüz çekilmedi.",
  fedexOnly: "Bunların gerçek ağırlığı FedEx Track API'den çekilmiş, ama yüklediğiniz Ship History dosyasında bu takip numarası yok - farklı bir tarih aralığından mı, yoksa hiç bu hesaptan mı gönderildiğini kontrol edin.",
};

function statusLabel(row) {
  if (row.diff_kg == null) return row.has_invoice_line ? "Faturalı, senkron bekliyor" : "Fatura yüklenmedi";
  return row.diff_kg > 0.1 ? "Farklı" : "Aynı";
}

export default function ShipmentHistoryPage() {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const [category, setCategory] = useState("different");
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [matchingTotal, setMatchingTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const PAGE_SIZE = 50;
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/shipment-history/list?category=${category}&page=${page}`);
    const data = await res.json();
    setSummary(data.summary);
    setRows(data.rows || []);
    setMatchingTotal(data.matchingTotal ?? 0);
    setTotalPages(data.totalPages ?? 1);
    setLoading(false);
  }, [category, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [category]);

  async function handleFile(file) {
    setBusy(true);
    setUploadResult(null);
    try {
      const buf = await file.arrayBuffer();
      const parsed = await parseShipmentHistoryXlsx(buf);

      const res = await fetch("/api/shipment-history/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, records: parsed.records }),
      });
      const data = await res.json();

      if (!res.ok || data.ok === false) {
        setUploadResult({ ok: false, error: data.error || `Sunucu hatası (HTTP ${res.status})` });
      } else {
        setUploadResult({
          ok: true,
          filename: file.name,
          inserted: data.inserted,
          skippedNotPrinted: parsed.skippedNotPrinted,
        });
        await load();
      }
    } catch (err) {
      setUploadResult({ ok: false, error: err.message });
    } finally {
      setBusy(false);
    }
  }

  const columns = COLUMNS_BY_CATEGORY[category];

  return (
    <div>
      <h1>Gönderi Geçmişi Karşılaştırma</h1>
      <p className="sub">
        FedEx Ship Manager'ın (fedex.com → Ship History → dışa aktar) verdiği Excel raporunu buraya
        yükleyin. Rapordaki <strong>totalShipmentWeight</strong> sütunu, FedEx Track API'den çekilen{" "}
        <strong>FedEx gerçek ağırlığı</strong> ile karşılaştırılır - faturadan bağımsız, iki FedEx
        kaynağının birbiriyle tutup tutmadığını gösterir. Bu, Panel'deki fatura ↔ FedEx karşılaştırmasından
        ayrı, bağımsız bir kontrol modülüdür. Aynı takip numarası (masterTrackingNumber) birden fazla
        satırda geçiyorsa (çok parçalı gönderi), sadece toplam ağırlığın (totalShipmentWeight) yazılı
        olduğu satır kullanılır - diğerleri aynı gönderinin farklı paketleridir.
      </p>

      <div
        className={`dropzone ${dragging ? "drag" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
      >
        {busy
          ? "Yükleniyor ve ayrıştırılıyor…"
          : "Ship History Excel dosyasını buraya bırakın ya da seçmek için tıklayın"}
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
      </div>

      {uploadResult && (
        <div style={{ marginTop: 16 }}>
          {uploadResult.ok ? (
            <div className="result-row">
              <span>{uploadResult.filename}</span>
              <span className="pill ok">
                {uploadResult.inserted} gönderi işlendi
                {uploadResult.skippedNotPrinted > 0 ? ` (${uploadResult.skippedNotPrinted} etiket basılmamış/eksik gönderi atlandı)` : ""}
              </span>
            </div>
          ) : (
            <div className="result-row">
              <span>Hata</span>
              <span className="pill danger">{uploadResult.error}</span>
            </div>
          )}
        </div>
      )}

      {!summary || summary.totalUploaded === 0 ? (
        <p className="sub" style={{ marginTop: 20 }}>
          Henüz bir Ship History dosyası yüklenmedi. Yukarıdan yükleyerek karşılaştırmayı başlatabilirsiniz.
        </p>
      ) : (
        <>
          <div className="cards" style={{ marginTop: 20 }}>
            {CATEGORY_CARDS.map((c) => (
              <button
                key={c.key}
                className={`card ${c.tone || ""} card-btn`}
                onClick={() => setCategory(c.key)}
                style={{
                  cursor: "pointer",
                  border: category === c.key ? "2px solid var(--brand)" : "1px solid var(--border)",
                  background: "var(--surface)",
                  textAlign: "left",
                }}
              >
                <div className="n">{c.key === "all" ? summary.totalUploaded : summary[c.key]}</div>
                <div className="l">{c.label}</div>
              </button>
            ))}
          </div>

          <div className="toolbar" style={{ marginTop: 10 }}>
            <h2 style={{ margin: 0 }}>{CATEGORY_CARDS.find((c) => c.key === category)?.label}</h2>
            <div className="spacer" />
            <a className="btn" href={`/api/shipment-history/export?category=${category}`} target="_blank" rel="noopener">
              Excel indir
            </a>
          </div>
          <p className="sub" style={{ marginTop: -6 }}>{CATEGORY_DESCRIPTIONS[category]}</p>

          {loading ? (
            <p className="sub">Yükleniyor…</p>
          ) : rows.length === 0 ? (
            <p className="sub">Bu kategoride gönderi yok.</p>
          ) : (
            <>
              <table>
                <thead>
                  <tr>
                    {columns.map((c) => <th key={c.key}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.master_tracking_number}>
                      {columns.map((c) => (
                        <td key={c.key}>{renderCell(c.key, r)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>

              {matchingTotal > PAGE_SIZE && (
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
            </>
          )}
        </>
      )}
    </div>
  );
}

function renderCell(key, r) {
  switch (key) {
    case "master_tracking_number":
      return <a href={`https://www.fedex.com/fedextrack/?trknbr=${r.master_tracking_number}`} target="_blank" rel="noopener">{r.master_tracking_number}</a>;
    case "ship_date":
      return fmtDate(r.ship_date);
    case "reference":
      return r.reference || "—";
    case "invoice_no":
      return r.invoice_no || "—";
    case "total_shipment_weight_kg":
      return fmtKg(r.total_shipment_weight_kg);
    case "actual_weight_kg":
      return fmtKg(r.actual_weight_kg);
    case "diff_kg":
      return <span className="pill danger" style={{ display: "inline-block" }}>+{fmtKg(r.diff_kg)}</span>;
    case "status":
      return <span className="pill muted">{statusLabel(r)}</span>;
    default:
      return r[key] ?? "—";
  }
}

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
