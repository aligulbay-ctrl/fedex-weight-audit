import "./globals.css";
import TopNav from "./TopNav.js";

export const metadata = {
  title: "Coolart Tekstil | FedEx Ağırlık Kontrolü",
  description: "Coolart Tekstil - FedEx faturalarındaki gönderi ağırlıklarını gerçek (Track API) ağırlıkla karşılaştırır.",
  icons: { icon: "/coolart-logo.jpg" },
};

export default function RootLayout({ children }) {
  return (
    <html lang="tr">
      <body>
        <TopNav />
        <div className="shell">
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
