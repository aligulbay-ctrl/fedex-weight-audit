"use client";

import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Panel" },
  { href: "/upload", label: "Fatura Yükle" },
  { href: "/shipment-history", label: "Gönderi Geçmişi Karşılaştır" },
  { href: "/settings", label: "Ayarlar" },
];

export default function TopNav() {
  const pathname = usePathname();

  return (
    <>
      <header className="topbar-dark">
        <div className="topbar-dark-inner">
          <a href="/" className="brand-block">
            <img src="/coolart-logo.jpg" alt="Coolart Tekstil" style={{ height: 34, borderRadius: 4 }} />
            <span className="brand-company">Coolart Tekstil</span>
            <span className="brand-sep">|</span>
            <span className="brand-app">FedEx Ağırlık Kontrolü</span>
          </a>
          <div className="tb-spacer" />
          <a href="/settings" className="tb-icon-link">⚙️ Ayarlar</a>
        </div>
      </header>
      <nav className="subnav">
        <div className="subnav-inner">
          {TABS.map((t) => (
            <a key={t.href} href={t.href} className={pathname === t.href ? "active" : ""}>
              {t.label}
            </a>
          ))}
        </div>
      </nav>
    </>
  );
}
