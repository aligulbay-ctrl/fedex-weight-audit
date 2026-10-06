"use client";

import { useState, useRef } from "react";
import { upload } from "@vercel/blob/client";
import { parseFedexInvoicePdf } from "../../lib/pdfParser.js";

export default function UploadPage() {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total } while a multi-file batch is uploading
  const [results, setResults] = useState(null);
  // Filename -> File, kept around so a flagged duplicate can be force-retried
  // later without asking the user to re-select/re-drop the file.
  const [pendingFiles, setPendingFiles] = useState({});
  const [forcing, setForcing] = useState({});
  const inputRef = useRef(null);

  // The PDF is parsed right here in the browser (same parser the server used
  // to run) and only the extracted shipment data - a small JSON payload, a
  // few hundred KB at most regardless of the source PDF's size - is sent to
  // the server. A FedEx invoice PDF itself is often 5-7MB (embedded
  // fonts/images from FedEx's own PDF generator), well past Vercel
  // Serverless Functions' hard ~4.5MB request-body limit; parsing
  // client-side sidesteps that limit entirely instead of just working
  // around it one file at a time.
  async function uploadOneFile(file, { force } = {}) {
    let parsed;
    try {
      const buf = await file.arrayBuffer();
      parsed = await parseFedexInvoicePdf(buf);
    } catch (err) {
      return {
        filename: file.name,
        ok: false,
        error: `PDF okunamadı - dosya bozuk olabilir veya beklenen FedEx fatura formatında değil (${err.message}).`,
      };
    }

    if (!parsed.meta.invoiceNo) {
      return { filename: file.name, ok: false, error: "Fatura numarası okunamadı - bu PDF beklenen FedEx fatura formatında olmayabilir." };
    }
    if (parsed.rows.length === 0) {
      return { filename: file.name, ok: false, error: "Hiç gönderi satırı bulunamadı - PDF formatı değişmiş olabilir." };
    }

    let res;
    try {
      res = await fetch("/api/invoices/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, meta: parsed.meta, rows: parsed.rows, force: force || "" }),
      });
    } catch (err) {
      return { filename: file.name, ok: false, error: `Ağ hatası: ${err.message}` };
    }

    if (res.status === 413) {
      return {
        filename: file.name,
        ok: false,
        error: "Bu faturadaki gönderi sayısı olağandışı yüksek - sunucu isteği çok büyük buldu.",
      };
    }

    const raw = await res.text();
    let result;
    try {
      const data = JSON.parse(raw);
      result = (data.results || [])[0] || { filename: file.name, ok: false, error: data.error || "Bilinmeyen hata" };
    } catch {
      // Server crashed before returning JSON (deploy/config problem) -
      // surface the HTTP status instead of a cryptic parse error.
      return {
        filename: file.name,
        ok: false,
        error: `Sunucu hatası (HTTP ${res.status}) - muhtemelen DATABASE_URL veya FEDEX_* ortam değişkenleri eksik/yanlış. Vercel proje ayarlarını kontrol edin.`,
      };
    }

    // Only bother uploading the original PDF once the invoice+shipments
    // are actually committed (result.ok, with an id to attach to) - a
    // rejected file or an unconfirmed duplicate never gets a PDF copy
    // stored, so nothing is wasted in Blob storage for those. This is a
    // second, independent step: if Blob isn't set up on this Vercel
    // project yet (or the upload/attach call fails for any reason), the
    // invoice import itself has already succeeded either way - result.ok
    // stays true, just result.pdfStored is false so the UI can say so.
    if (result.ok && result.invoiceId) {
      result.pdfStored = await storeOriginalPdf(file, result.invoiceId);
    }
    return result;
  }

  async function storeOriginalPdf(file, invoiceId) {
    try {
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/invoices/blob-upload",
      });
      const patchRes = await fetch(`/api/invoices/${invoiceId}/pdf`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfUrl: blob.url }),
      });
      return patchRes.ok;
    } catch (err) {
      // Most common cause: this Vercel project doesn't have a Blob store
      // linked yet (see README) - not a reason to show the invoice import
      // itself as failed.
      console.error("[pdf store failed]", err);
      return false;
    }
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (files.length === 0) return;

    setPendingFiles((prev) => {
      const next = { ...prev };
      files.forEach((f) => { next[f.name] = f; });
      return next;
    });

    setBusy(true);
    setResults([]);
    // Sequential, not Promise.all: uploads share the same Postgres
    // connection pool and each does its own multi-row transaction, so
    // running many at once just contends for connections without actually
    // finishing faster - one at a time also keeps the progress counter and
    // per-file duplicate/error results simple to reason about.
    const collected = [];
    for (let i = 0; i < files.length; i++) {
      setProgress({ done: i, total: files.length });
      const file = files[i];
      const result = await uploadOneFile(file);
      collected.push(result);
      setResults([...collected]);
    }
    setProgress(null);
    setBusy(false);
  }

  async function forceRetry(r) {
    const file = pendingFiles[r.filename];
    if (!file) return;
    setForcing((prev) => ({ ...prev, [r.filename]: true }));
    try {
      const newResult = await uploadOneFile(file, { force: r.invoiceNo });
      setResults((prev) => prev.map((x) => (x === r ? newResult : x)));
    } catch (err) {
      setResults((prev) => prev.map((x) => (x === r ? { ...r, ok: false, error: err.message } : x)));
    } finally {
      setForcing((prev) => ({ ...prev, [r.filename]: false }));
    }
  }

  return (
    <div>
      <h1>Fatura Yükle</h1>
      <p className="sub">
        FedEx e-Fatura PDF'lerini buraya sürükleyin veya seçin. Aynı fatura numarası daha önce
        yüklendiyse uygulama uyarır - onaylamadan üzerine yazmaz, yanlışlıkla tekrar yükleme
        yapamazsınız.
      </p>

      <div
        className={`dropzone ${dragging ? "drag" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        {busy
          ? progress && progress.total > 1
            ? `Yükleniyor ve ayrıştırılıyor… (${progress.done + 1}/${progress.total})`
            : "Yükleniyor ve ayrıştırılıyor…"
          : "PDF fatura(lar)ı buraya bırakın ya da seçmek için tıklayın (birden fazla dosya seçebilirsiniz)"}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {results && results.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h2>Sonuç{results.length > 1 ? ` (${results.length} dosya)` : ""}</h2>
          {results.map((r, i) => (
            <div className="result-row" key={i}>
              <span>{r.filename}</span>
              {r.ok ? (
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="pill ok">{r.invoiceNo} — {r.rows} gönderi içeri aktarıldı</span>
                  {r.pdfStored === false && (
                    <span className="pill muted" title="Vercel Blob Storage bağlı değil olabilir - bkz. README">
                      PDF kopyası saklanamadı
                    </span>
                  )}
                </span>
              ) : r.duplicate ? (
                <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <span className="pill warn">{r.error}</span>
                  <button onClick={() => forceRetry(r)} disabled={forcing[r.filename]}>
                    {forcing[r.filename] ? "Yükleniyor…" : "Yine de üzerine yaz"}
                  </button>
                </span>
              ) : (
                <span className="pill danger">{r.error}</span>
              )}
            </div>
          ))}
          <p className="sub" style={{ marginTop: 14 }}>
            Şimdi <a href="/">panele</a> gidip "FedEx ile senkronize et" ile gerçek ağırlıkları çekebilirsiniz.
          </p>
        </div>
      )}
    </div>
  );
}
