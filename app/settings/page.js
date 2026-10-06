"use client";

import { useEffect, useState } from "react";

const API_BASES = [
  { label: "Production (apis.fedex.com)", value: "https://apis.fedex.com" },
  { label: "Sandbox (apis-sandbox.fedex.com)", value: "https://apis-sandbox.fedex.com" },
];

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState(""); // only a NEW value, never the saved one
  const [apiBase, setApiBase] = useState(API_BASES[0].value);
  const [thKg, setThKg] = useState("0.5");
  const [thPct, setThPct] = useState("5");
  const [staleDays, setStaleDays] = useState("15");
  const [fedexMinDisputeKg, setFedexMinDisputeKg] = useState("2");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [gmailClientId, setGmailClientId] = useState("");
  const [gmailClientSecret, setGmailClientSecret] = useState("");
  const [gmailSaving, setGmailSaving] = useState(false);
  const [gmailSaveMsg, setGmailSaveMsg] = useState("");
  const [gmailNotice, setGmailNotice] = useState(null); // {ok, text} from ?gmail=/?gmail_error= redirect
  const [gmailSyncing, setGmailSyncing] = useState(false);
  const [gmailSyncMsg, setGmailSyncMsg] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);

  function load() {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        setSettings(s);
        setClientId(s.fedexClientId || "");
        setApiBase(s.fedexApiBase || API_BASES[0].value);
        setThKg(String(s.discrepancyThresholdKg ?? "0.5"));
        setThPct(String(s.discrepancyThresholdPct ?? "5"));
        setStaleDays(String(s.disputeStaleDays ?? "15"));
        setFedexMinDisputeKg(String(s.fedexMinDisputeKg ?? "2"));
        setGmailClientId(s.gmailClientId || "");
        setLoading(false);
      });
  }

  useEffect(() => {
    load();

    // Surface the result of the OAuth redirect (app/api/gmail/callback
    // sends the browser back here with ?gmail=connected or ?gmail_error=...).
    const params = new URLSearchParams(window.location.search);
    const ok = params.get("gmail");
    const err = params.get("gmail_error");
    if (ok === "connected") {
      setGmailNotice({ ok: true, text: "Gmail hesabınız bağlandı." });
    } else if (err) {
      setGmailNotice({ ok: false, text: `Gmail bağlantısı başarısız: ${decodeURIComponent(err)}` });
    }
    if (ok || err) {
      window.history.replaceState({}, "", "/settings");
    }
  }, []);

  async function save() {
    setSaving(true);
    setSaveMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fedexClientId: clientId,
          fedexClientSecret: clientSecret || undefined,
          fedexApiBase: apiBase,
          discrepancyThresholdKg: thKg,
          discrepancyThresholdPct: thPct,
          disputeStaleDays: staleDays,
          fedexMinDisputeKg: fedexMinDisputeKg,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Kaydedilemedi");
      setSettings(data);
      setClientSecret("");
      setSaveMsg("Kaydedildi.");
    } catch (err) {
      setSaveMsg(`Hata: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fedexClientId: clientId,
          fedexClientSecret: clientSecret || undefined,
          fedexApiBase: apiBase,
        }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function saveGmail() {
    setGmailSaving(true);
    setGmailSaveMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gmailClientId,
          gmailClientSecret: gmailClientSecret || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Kaydedilemedi");
      setSettings(data);
      setGmailClientSecret("");
      setGmailSaveMsg("Kaydedildi. Şimdi 'Gmail ile bağlan'a tıklayabilirsiniz.");
    } catch (err) {
      setGmailSaveMsg(`Hata: ${err.message}`);
    } finally {
      setGmailSaving(false);
    }
  }

  async function disconnectGmail() {
    setDisconnecting(true);
    try {
      await fetch("/api/gmail/disconnect", { method: "POST" });
      load();
    } finally {
      setDisconnecting(false);
    }
  }

  async function syncGmail() {
    setGmailSyncing(true);
    setGmailSyncMsg("");
    try {
      const res = await fetch("/api/gmail/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxResults: 50 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setGmailSyncMsg(data.error || "Senkronizasyon başarısız.");
        return;
      }
      setGmailSyncMsg(
        `${data.scanned} e-posta tarandı, ${data.imported} yeni bulundu, ${data.statusUpdated} gönderi "İtiraz Edildi" yapıldı` +
          (data.alreadyKnown ? `, ${data.alreadyKnown} zaten kayıtlıydı` : "") +
          "."
      );
      load();
    } catch (err) {
      setGmailSyncMsg(`Hata: ${err.message}`);
    } finally {
      setGmailSyncing(false);
    }
  }

  if (loading) return <div className="empty">Yükleniyor…</div>;

  return (
    <div>
      <h1>Ayarlar</h1>
      <p className="sub">
        FedEx API bilgilerinizi burada girin - Vercel'e ortam değişkeni eklemenize gerek kalmaz,
        değişiklikler anında (redeploy gerekmeden) etkili olur.
      </p>

      <h2>FedEx Developer Portal Bilgileri</h2>
      <div style={{ display: "grid", gap: 14, maxWidth: 520 }}>
        <Field label="Client ID" hint={settings?.fedexClientIdSource === "env" ? "şu an Vercel ortam değişkeninden geliyor" : null}>
          <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="developer.fedex.com projenizden" />
        </Field>

        <Field
          label="Client Secret"
          hint={
            settings?.fedexClientSecretSet
              ? `kayıtlı (${settings.fedexClientSecretSource === "env" ? "Vercel ortam değişkeni" : "ayarlardan girildi"}) - değiştirmek için yeni bir değer yazın`
              : "henüz girilmedi"
          }
        >
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={settings?.fedexClientSecretSet ? "•••••••• (değiştirmek için yazın)" : "developer.fedex.com projenizden"}
          />
        </Field>

        <Field label="Ortam">
          <select value={apiBase} onChange={(e) => setApiBase(e.target.value)}>
            {API_BASES.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
            {!API_BASES.some((b) => b.value === apiBase) && (
              <option value={apiBase}>Özel: {apiBase}</option>
            )}
          </select>
        </Field>
      </div>

      <div className="toolbar" style={{ marginTop: 16 }}>
        <button className="primary" onClick={save} disabled={saving}>{saving ? "Kaydediliyor…" : "Kaydet"}</button>
        <button onClick={testConnection} disabled={testing}>{testing ? "Test ediliyor…" : "Bağlantıyı test et"}</button>
      </div>
      {saveMsg && <p className="sub" style={{ marginTop: -6 }}>{saveMsg}</p>}
      {testResult && (
        <p style={{ marginTop: -6 }}>
          {testResult.ok ? (
            <span className="pill ok">Bağlantı başarılı - FedEx token verdi.</span>
          ) : (
            <span className="pill danger">{testResult.error}</span>
          )}
        </p>
      )}

      <h2>Fark Eşiği</h2>
      <p className="sub" style={{ marginTop: -6 }}>
        Fatura ağırlığı ile FedEx'in gerçek ağırlığı arasındaki fark, aşağıdaki HER İKİ eşiği de
        aşarsa gönderi "farklı ağırlık" olarak işaretlenir - küçük paketlerdeki yuvarlama farkları
        gürültü yaratmasın diye.
      </p>
      <div style={{ display: "grid", gap: 14, maxWidth: 320 }}>
        <Field label="Minimum fark (kg)">
          <input type="number" step="0.1" value={thKg} onChange={(e) => setThKg(e.target.value)} />
        </Field>
        <Field label="Minimum fark (%)">
          <input type="number" step="1" value={thPct} onChange={(e) => setThPct(e.target.value)} />
        </Field>
      </div>

      <h2>FedEx Minimum İtiraz Eşiği</h2>
      <p className="sub" style={{ marginTop: -6 }}>
        FedEx'in itirazları genelde yalnızca belirli bir ağırlık farkının üzerinde kabul ettiği
        biliniyor. Yukarıdaki "Fark Eşiği"nden geçip "farklı ağırlık" olarak işaretlenen bir
        gönderi, burada girdiğiniz kg'ın altında kalırsa Panel'de "İtiraz edilebilir" listesine
        değil "Eşik altı" listesine düşer - hâlâ gerçek bir fark, ama FedEx'e tek başına
        götürmeye değmeyebilir.
      </p>
      <div style={{ display: "grid", gap: 14, maxWidth: 320 }}>
        <Field label="Minimum fark (kg)">
          <input
            type="number"
            step="0.1"
            min="0"
            value={fedexMinDisputeKg}
            onChange={(e) => setFedexMinDisputeKg(e.target.value)}
          />
        </Field>
      </div>

      <h2>İtiraz Yaşlandırma Eşiği</h2>
      <p className="sub" style={{ marginTop: -6 }}>
        "İtiraz Edildi" durumundaki bir gönderi, "Fark Faturası Kesildi" veya "Çözüldü"'ye
        geçmeden bu kadar gün beklerse Panel'de "Geciken İtirazlar" olarak ayrıca işaretlenir -
        FedEx'i tekrar aramanız gerektiğini unutmayın diye. Sayaç, itiraz durumuna geçtiği tarihten
        (Gmail'den otomatik yakalanan itiraz e-postasının tarihinden, ya da durumu elle
        değiştirdiğiniz andan) başlar.
      </p>
      <div style={{ display: "grid", gap: 14, maxWidth: 320 }}>
        <Field label="Gün">
          <input type="number" step="1" min="1" value={staleDays} onChange={(e) => setStaleDays(e.target.value)} />
        </Field>
      </div>

      <div className="toolbar" style={{ marginTop: 16 }}>
        <button className="primary" onClick={save} disabled={saving}>{saving ? "Kaydediliyor…" : "Kaydet"}</button>
      </div>

      <p className="sub" style={{ marginTop: 28 }}>
        Not: Client Secret veritabanında düz metin olarak saklanır - bu projenin veritabanına
        erişimi olan herkes görebilir. İç kullanım için bir sorun değildir, ama veritabanı
        erişimini paylaşmadığınızdan emin olun.
      </p>

      <h2>Gmail Bağlantısı (İtiraz E-postaları)</h2>
      <p className="sub" style={{ marginTop: -6 }}>
        FedEx'e itiraz ettiğinizde gelen "Your dispute record" onay e-postalarını Gmail'inizden
        okuyup, e-postadaki Tracking ID'yi ilgili gönderiyle eşleştirerek durumu otomatik
        "İtiraz Edildi" yapar ve e-postayı o gönderide gösterir. Önce aşağıya Google Cloud
        Console'dan aldığınız OAuth Client ID / Secret'ı girin, kaydedin, sonra "Gmail ile
        bağlan"a tıklayın. Adım adım kurulum için README'ye bakın.
      </p>

      {gmailNotice && (
        <p>
          <span className={gmailNotice.ok ? "pill ok" : "pill danger"}>{gmailNotice.text}</span>
        </p>
      )}

      <div style={{ display: "grid", gap: 14, maxWidth: 520 }}>
        <Field label="Gmail OAuth Client ID">
          <input
            type="text"
            value={gmailClientId}
            onChange={(e) => setGmailClientId(e.target.value)}
            placeholder="....apps.googleusercontent.com"
          />
        </Field>
        <Field
          label="Gmail OAuth Client Secret"
          hint={settings?.gmailClientSecretSet ? "kayıtlı - değiştirmek için yeni bir değer yazın" : "henüz girilmedi"}
        >
          <input
            type="password"
            value={gmailClientSecret}
            onChange={(e) => setGmailClientSecret(e.target.value)}
            placeholder={settings?.gmailClientSecretSet ? "•••••••• (değiştirmek için yazın)" : "GOCSPX-..."}
          />
        </Field>
      </div>

      <div className="toolbar" style={{ marginTop: 16 }}>
        <button className="primary" onClick={saveGmail} disabled={gmailSaving}>
          {gmailSaving ? "Kaydediliyor…" : "Kaydet"}
        </button>
        {settings?.gmailConnected ? (
          <button onClick={disconnectGmail} disabled={disconnecting}>
            {disconnecting ? "Kaldırılıyor…" : "Bağlantıyı kaldır"}
          </button>
        ) : (
          <a
            className="btn"
            href="/api/gmail/auth"
            onClick={(e) => {
              if (!gmailClientId && !settings?.gmailClientId) {
                e.preventDefault();
                setGmailSaveMsg("Önce Client ID / Secret girip kaydedin.");
              }
            }}
          >
            Gmail ile bağlan
          </a>
        )}
        {settings?.gmailConnected && (
          <button onClick={syncGmail} disabled={gmailSyncing}>
            {gmailSyncing ? "Taranıyor…" : "İtiraz e-postalarını şimdi senkronize et"}
          </button>
        )}
      </div>
      {gmailSaveMsg && <p className="sub" style={{ marginTop: -6 }}>{gmailSaveMsg}</p>}
      {settings?.gmailConnected && (
        <p className="sub" style={{ marginTop: -6 }}>
          Bağlı hesap: <strong className="mono">{settings.gmailEmail}</strong>
          {settings.gmailLastSyncedAt && <> — son senkronizasyon: {new Date(settings.gmailLastSyncedAt).toLocaleString("tr-TR")}</>}
        </p>
      )}
      {gmailSyncMsg && <p className="sub" style={{ marginTop: -6 }}>{gmailSyncMsg}</p>}

      <p className="sub" style={{ marginTop: 20 }}>
        Not: Kişisel (Workspace olmayan) bir Gmail hesabı için bu bağlantı Google'ın "Testing"
        modunda çalışır - Google, doğrulanmamış uygulamalarda verilen erişim belgesini ~7 günde
        bir geçersiz kılabilir. Süresi dolarsa senkronizasyon "Gmail bağlantısının süresi dolmuş"
        hatası verir; "Gmail ile bağlan"a tekrar tıklamanız yeterlidir.
      </p>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".03em" }}>
        {label}
      </span>
      {children}
      {hint && <span style={{ fontSize: 12, color: "var(--muted)" }}>{hint}</span>}
    </label>
  );
}
