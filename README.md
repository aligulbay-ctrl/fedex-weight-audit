# Coolart Tekstil — FedEx Ağırlık Kontrolü

FedEx faturalarınızı (PDF) yükler, her gönderiyi FedEx **Track API**'den çektiği
gerçek ağırlıkla karşılaştırır ve faturada fazla/farklı ağırlıkla ücretlendirilmiş
gönderileri otomatik işaretler. Next.js (App Router) + Postgres, Vercel'e deploy
edilecek şekilde hazırlandı.

Bu proje, `870340499257` takip numaralı gerçek bir örnek üzerinden test edildi:
fatura 27,1 LB (12,29 kg) olarak ücretlendirmiş, FedEx'in kendi takip sayfası
"Total Shipment Weight" olarak 22 lbs / 9,98 kg gösteriyor — yaklaşık %23 fazla
ücretlendirme. Uygulama bu farkı otomatik yakalayıp kırmızı işaretliyor.

## Nasıl çalışır

1. **Fatura Yükle** sayfasından FedEx e-Fatura PDF'lerini yüklersiniz - tek
   seferde **birden fazla dosya** seçebilir veya sürükleyebilirsiniz. PDF'in
   metin ayrıştırması (takip no, tarih, alıcı, servis, referans, fatura
   ağırlığı, tutar) doğrudan **tarayıcınızda** yapılır; sunucuya gönderilen
   sadece ayrıştırılmış küçük bir JSON'dur, PDF dosyasının kendisi hiç
   yüklenmez. Bu bilinçli bir tasarım: bazı FedEx fatura PDF'leri (gömülü
   font/görsellerden dolayı) 5-7 MB'a kadar çıkabiliyor, Vercel Serverless
   Functions ise tek istekte kabul ettiği gövdeyi ~4,5 MB'la sınırlıyor - PDF
   dosyasının kendisini hiç göndermeyerek bu sınır tamamen devre dışı kalıyor
   (bkz. "Sınırlamalar" bölümü). Dosyalar yine sunucuya teker teker, ayrı
   isteklerle gönderilir (artık boyuttan değil, ilerleme göstergesi ve
   dosya başına yinelenen-fatura/hata sonucu basitliği için). Her dosyanın
   sonucu (başarılı / yinelenen fatura uyarısı / hata) kendi satırında, o
   dosya biter bitmez görünür. Faturanın kendi
   e-Fatura başlığındaki **Referans No** (ör. "508536319") de yakalanıp
   hem **Yüklenen Faturalar** listesinde fatura numarasının altında hem
   de gönderi tablosunun "Fatura" hücresinde gösterilir - arama kutusuna
   yazarak bu referans numarasına göre de gönderi arayabilirsiniz.
2. **Panel**'deki "FedEx ile senkronize et" butonu, ağırlığı henüz çekilmemiş
   her gönderi için FedEx Track API'yi çağırır, gerçek ağırlığı (kg) alır.
   Karşılaştırma her zaman kg üzerinden yapılır (eşik hesaplamaları da dahil),
   ama gönderi tablosunda **"FedEx Gerçek"** ve **"Fark"** sütunları, o
   satırın faturadaki birimine göre gösterilir - fatura LB ise FedEx'in
   gerçek ağırlığı da LB'ye çevrilip (yanında kg karşılığıyla) gösterilir,
   fatura KG ise kg olarak kalır. Böylece aynı satırdaki iki ağırlık her
   zaman aynı birimde, doğrudan karşılaştırılabilir görünür.
3. Fatura ağırlığı ile FedEx'in gerçek ağırlığı karşılaştırılır; fark hem
   mutlak (kg) hem yüzde eşiğini aşarsa gönderi "farklı ağırlık" olarak
   işaretlenir (bkz. `DISCREPANCY_THRESHOLD_KG` / `_PCT`).
4. Farklı ağırlıklı gönderileri filtreleyip CSV olarak indirebilir, her satıra
   not düşüp itiraz durumunu (İşaretlendi / İtiraz Edildi / Fark Faturası
   Kesildi / Çözüldü) takip edebilirsiniz. Gönderi tablosunu duruma, farka
   veya tarihe göre sıralayabilirsiniz.
5. Panelde **Yüklenen Faturalar** listesindeki bir faturaya tıklarsanız, o
   faturanın sadece farklı ağırlıklı gönderileri (detaylarıyla) üstteki
   tabloda filtrelenir - "Filtreyi kaldır" ile geri dönebilirsiniz. Aynı
   listedeki **"Sil"** ile yanlışlıkla yüklenmiş bir faturayı (ve içindeki
   tüm gönderi satırlarını) kaldırabilirsiniz - tıklayınca "N gönderiyle
   silinsin mi?" diye bir kez daha sorar, "Evet, sil" demeden hiçbir şey
   silinmez. O faturaya bağlı Gmail itiraz e-postaları (varsa) silinmez,
   sadece ilişkili gönderi kaydı kalktığı için "eşleşmemiş" duruma döner.
6. FedEx'in çok parçalı gönderilerde döndürdüğü **Toplam Parça** (Total
   Pieces) sayısı da gönderi tablosunda gösterilir.
7. **Ayarlar**'dan Gmail hesabınızı bağlarsanız (aligulbay@gmail.com), FedEx
   itiraz sisteminden gelen "Your dispute record" onay e-postalarını
   Panel'deki **"Gmail'i senkronize et"** butonuyla tarayabilirsiniz. E-posta
   içindeki Takip No (veya CQL referans no) eşleşen gönderi otomatik olarak
   **İtiraz Edildi** durumuna geçer, e-postadaki referans no gönderinin
   altında gösterilir ve gönderi satırındaki **"✉️ E-postalar"** butonuyla
   ilgili e-postanın tüm içeriğini (ve doğrudan Gmail'de açma linkini)
   görebilirsiniz. Bir gönderiyi siz veya bu senkronizasyon zaten daha ileri
   bir duruma (Fark Faturası Kesildi / Çözüldü) taşımışsa, senkronizasyon bu
   durumu **geri almaz** - sadece "İtiraz Edildi"ye ilerletir.
8. **Geciken itirazlar takibi.** "İtiraz Edildi" durumundaki bir gönderi,
   "Fark Faturası Kesildi" veya "Çözüldü"'ye geçmeden belirli bir süre (varsayılan
   **15 gün**, Ayarlar'dan değiştirilebilir) beklerse Panel'de ayrı bir
   **"Geciken İtirazlar"** aksiyon kartında ve filtresinde listelenir, gönderi
   satırında da kırmızı **"N gündür itirazda - takip edin!"** uyarısı çıkar -
   amaç, FedEx'i tekrar aramanız gerektiğini unutmamanız. Sayaç, gönderinin
   "İtiraz Edildi" durumuna geçtiği andan başlar: Gmail senkronizasyonu bir
   itiraz e-postası bulduğunda bu, o e-postanın kendi tarihidir (senkronizasyonu
   çalıştırdığınız an değil); durumu Panel'den elle "İtiraz Edildi" yaptığınızda
   ise o anki tarih/saattir. Aynı durumu tekrar kaydetmek (ör. sadece not
   eklemek) sayaç sıfırlamaz - sadece durum gerçekten değiştiğinde sıfırlanır.
   Eşik gün sayısı **Ayarlar → "İtiraz Yaşlandırma Eşiği"**'nden değiştirilebilir.
9. **Farklı ağırlıklı gönderiler için Excel / PDF rapor.** Panel'deki araç
   çubuğunda düz CSV indirmenin yanında **"Excel rapor indir"** ve **"PDF rapor
   indir"** butonları var - ikisi de aynı verinin biçimlendirilmiş, paylaşıma
   hazır bir sürümünü üretir:
   - **Excel (.xlsx):** "Özet" (toplam gönderi/fatura sayısı, toplam ağırlık
     farkı, ortalama fark %, para birimine ve itiraz durumuna göre dağılım) ve
     "Gönderiler" (tüm sütunlar, sabitlenmiş başlık satırı, otomatik filtre,
     %10 ve üzeri farklar turuncu, %20 ve üzeri farklar kırmızı vurgulu) olmak
     üzere iki sayfa içerir.
   - **PDF:** Aynı özet + tablo, A4 yatay, çok sayfalıysa her sayfada tablo
     başlığı tekrar eder - doğrudan yazdırılabilir veya e-postayla
     paylaşılabilir.
   - Her iki formatta da **Fatura Referans No** ayrı bir sütun olarak
     bulunur, ve **"FedEx Gerçek"** ile **"Fark"** o satırın fatura ağırlık
     birimiyle (KG/LB) eşleşecek şekilde gösterilir - Panel'deki gönderi
     tablosuyla birebir aynı mantık (bkz. madde 6). LB ile faturalanmış bir
     gönderi "22.00 LB (9.98 kg)" gibi hem LB hem kg karşılığını birlikte
     gösterir; Excel'de ayrıca her ikisi de (o satırın biriminde VE her
     zaman kg cinsinden) ayrı sayısal sütunlar olarak durur, böylece
     toplama/sıralama gibi Excel işlemleri için kg sütunları hâlâ
     kullanılabilir kalır.
   - Panel'de **"Rapor kapsamı"** açılır menüsüyle indirilecek raporun neyi
     kapsayacağını seçebilirsiniz - seçim hem Excel hem PDF linkine birden
     uygulanır: **Farklı ağırlıklar** (`only=discrepancy`, varsayılan - üçü
     birlikte), **İtiraz edilebilir** (`only=fedex_eligible`), **Eşik altı**
     (`only=below_threshold`), **Negatif fark** (`only=negative`) - madde
     10'daki aynı üçlü ayrım. Rapor başlığındaki "Kapsam: ..." satırı
     seçilen kapsamı yazar. CSV export'taki gibi `?only=all` ile tüm
     gönderileri de alabilirsiniz (`/api/export/xlsx?only=all`,
     `/api/export/pdf?only=all`), bu seçenek açılır menüde yok ama URL'yi
     elle değiştirerek kullanılabilir. Düz CSV export'taki **"FedEx Gerçek
     Ağırlık (kg)"** sütunu ise bilinçli olarak
     her zaman kg'da kalır - CSV'nin amacı ham, hesaplamaya hazır veri
     olduğu için birim karıştırmıyor.
10. **FedEx'in kabul ettiği eşiğe göre gruplama.** FedEx'in billing
    itirazlarını genelde belirli bir ağırlık farkının üzerinde kabul ettiği
    biliniyor (varsayılan **2 kg**, Ayarlar → "FedEx Minimum İtiraz
    Eşiği"'nden değiştirilebilir). "Farklı ağırlık" olarak işaretlenmiş
    gönderiler Panel'de bu eşiğe göre üçe ayrılır, hem filtre butonu hem
    Excel/PDF/CSV export'ta `only=` parametresi olarak:
    - **İtiraz edilebilir (≥2 kg)** (`only=fedex_eligible`) - fark eşiğin
      üzerinde, FedEx'e tek başına götürmeye değer.
    - **Eşik altı (0-2 kg)** (`only=below_threshold`) - gerçek bir fark var
      ama muhtemelen FedEx'in kabul edeceği asgarinin altında kalıyor.
    - **Negatif fark (eksik faturalandı)** (`only=negative`) - FedEx'in
      kendi ağırlığı faturadakinden **yüksek** çıktı; yani müşteri
      olağandışı biçimde eksik faturalandırılmış - bir itiraz vakası değil,
      sadece bilginize.
    Bu üç grup birbirini dışlar ve toplamda "Farklı ağırlıklı gönderiler"
    sayısına tam olarak eşittir.
11. **Filtre butonlarında sayaç ve sayfalama.** Panel'deki her filtre
    butonunun (Farklı ağırlıklar, İtiraz edilebilir, Eşik altı, Negatif
    fark, Takipte olanlar, Geciken itirazlar, Bekleyenler, Hatalılar, Tümü)
    yanında o filtreye kaç gönderi düştüğünü gösteren bir sayaç rozeti
    bulunur - bu sayılar her zaman güncel (o an ekrandaki arama/sayfa
    filtresinden bağımsız, veritabanındaki gerçek toplam) `stats`
    değerleridir. Gönderi listesi bir seferde **50 gönderi** gösterir;
    seçili filtre/arama 50'den fazla sonuç veriyorsa tablonun altında
    "1-50 / 123 gönderi gösteriliyor" yazısıyla birlikte bir sayfalama
    çubuğu (Önceki / sayfa numaraları / Sonraki) belirir. `GET
    /api/shipments` artık `page` parametresi de kabul eder (`limit`
    varsayılan olarak 50'ye düştü, en fazla 1000) ve yanıtta
    `matchingTotal`/`totalPages` alanlarını döner - bu, seçili filtreye göre
    değişen bir sayı olduğu için Panel'in üstündeki genel `stats`
    toplamlarından ayrıdır. Filtre, arama, sıralama veya fatura seçimi
    değiştiğinde sayfa otomatik olarak 1'e döner.
12. **FedEx'in kendi ağırlığına göre alt sınır filtresi.** Panel'deki arama
    kutusunun yanında **"FedEx gerçek ağırlık ≥ __ kg"** kutusuna bir sayı
    yazarak, FedEx Track API'den çekilen **gerçek ağırlığı** (faturadaki
    değil) o değerin üzerinde/eşit olan gönderileri görebilirsiniz - örn.
    "12" yazınca yalnızca FedEx sisteminde 12 kg ve üzeri çıkan gönderiler
    listelenir. Diğer filtrelerle (Farklı ağırlıklar, Tümü, arama vb.)
    birlikte çalışır - tümünü görmek isterseniz önce **Tümü** filtresine
    geçmeniz gerekir, yoksa sadece o an seçili filtreye (ör. sadece "Farklı
    ağırlıklar") uygulanır. Henüz FedEx'ten ağırlığı çekilmemiş (senkron
    bekleyen) gönderiler bu filtreyle hiç eşleşmez, çünkü onların henüz
    gerçek ağırlığı yok. API tarafında `GET /api/shipments`'a
    `minFedexWeightKg` parametresi olarak eklenir.
13. **Gönderi Geçmişi Karşılaştırma (ayrı modül).** Üstteki menüde yeni bir
    **"Gönderi Geçmişi Karşılaştır"** sekmesi var. Bu, fatura tabanlı
    karşılaştırmadan tamamen bağımsız, ikinci bir kontrol: FedEx Ship
    Manager'ın (fedex.com → Ship History → dışa aktar) verdiği Excel
    raporunu buraya yükleyip, rapordaki **totalShipmentWeight** sütununu
    doğrudan FedEx Track API'nin **gerçek ağırlığıyla** karşılaştırır - yani
    "ben fedex.com'da ne girdim" ile "FedEx sisteminde gerçekte ne çıktı"
    arasındaki farkı, faturadan hiç geçmeden gösterir.
    - Ship History dosyası da **tarayıcıda** ayrıştırılır (aynı 4,5 MB
      sınırı gerekçesiyle - bkz. madde 1/Sınırlamalar), sunucuya sadece
      ayrıştırılmış küçük bir JSON gider (`lib/shipmentHistoryParser.js`).
      FedEx'in bu raporu **çok parçalı (multi-piece) gönderilerde** her
      parça için ayrı satır üretir ve şirket-geneli toplam ağırlığı
      (`totalShipmentWeight`) sadece o grubun İLK satırına yazar - parser bu
      satırları takip numarasına göre gruplayıp doğru toplamı çıkarır.
      Etiketi hiç basılmamış/tamamlanmamış (`status != ALL_DOCS_PRINTED`)
      satırlar otomatik atlanır, çünkü bunların arkasında gerçek bir FedEx
      gönderisi yoktur.
    - Yükledikten sonra 5 tıklanabilir özet kart görürsünüz: **Yüklenen
      Toplam Gönderi**, **Aynı (fark yok)**, **Farklı**, **Henüz FedEx
      Takibinde Yok**, **Excel'de Olmayan (FedEx'te Var)**. Bir karta
      tıklamak altındaki tabloyu o kategoriye filtreler (her seferinde tek
      liste gösterilir, aktif kart mavi çerçeveyle işaretlenir):
      **Aynı**/**Farklı** ayrımı 0,1 kg toleransına göre yapılır (küçük
      yuvarlama farkları "Farklı" sayılmaz); **Henüz FedEx Takibinde Yok**
      bu gönderinin faturasının hiç yüklenmemiş ya da yüklenmiş ama "FedEx
      ile senkronize et" ile ağırlığının henüz çekilmemiş olduğu satırları
      ayrı ayrı etiketler; **Excel'de Olmayan (FedEx'te Var)** ters durumu
      gösterir - gerçek ağırlığı var ama yüklediğiniz Ship History
      dosyasında o takip numarası yok (ör. farklı bir tarih aralığı
      yüzünden).
    - Her kategori kendi sayfasında **50 gönderilik sayfalara** bölünür
      (panel'deki gönderi listesiyle aynı sayfalama bileşeni) ve kendi
      **"Excel indir"** butonuna sahiptir - indirilen dosya o kategorinin
      TÜM satırlarını içerir, ekrandaki sayfalamadan etkilenmez; "Farklı"
      kategorisinin Excel'inde fark satırları kırmızıyla vurgulanır.
    - Yeniden yükleme (ör. üst üste binen tarih aralıklarıyla dışa aktarım)
      güvenlidir - her gönderi takip numarasına göre upsert edilir, tekrar
      eden kayıt oluşmaz.
14. **"NaN kg (NaN%)" düzeltmesi + eksik fatura ağırlığı filtresi.** Bazı
    gönderilerde Fark sütunu "NaN kg (NaN%)" gösteriyordu - kök neden, o
    gönderinin fatura PDF'inden ağırlığının hiç okunamamış olması
    (`invoiced_weight_kg` veritabanında NULL), buna rağmen FedEx ile
    senkronize/yenile edildiğinde `parseFloat(null)`'ın JavaScript'te NaN
    döndürmesi ve bu NaN'ın "boş değer" kontrolünden kaçıp doğrudan
    Postgres'e yazılması (Postgres'in NUMERIC tipi 'NaN'ı geçerli bir değer
    olarak kabul ediyor). Düzeltildi: fark hesaplayan fonksiyon artık NaN'ı
    da "değer yok" sayıyor, uygulama ilk açıldığında veritabanındaki
    mevcut bozuk kayıtlar da otomatik olarak temizleniyor (bir kere,
    zararsız şekilde tekrar çalışır). Ayrıca Panel'e yeni bir filtre
    kartı eklendi: **Fatura ağırlığı eksik/0** (`only=missing_weight`) -
    fatura PDF'inde ağırlığı hiç okunamamış ya da 0 görünen gönderileri
    ayrı bir yerde listeler; bu satırlarda Fatura Ağırlığı sütununda
    "eksik" ve Fark sütununda "fatura ağırlığı eksik" rozeti görünür
    (yanlışlıkla "0.00 kg" / "NaN" gösterip gerçek veri gibi
    yanıltmak yerine). CSV/Excel/PDF rapor indirmelerinde de "Rapor
    kapsamı" seçeneği olarak mevcut.
15. **Yüklenen fatura PDF'lerini indirme.** "Yüklenen Faturalar"
    listesindeki her satırda bir **"İndir"** linki var - orijinal PDF'i
    açar. PDF, ayrıştırıldıktan sonra tarayıcıdan doğrudan Vercel Blob
    depolamaya yüklenir (kurulumu için bkz. "Kurulum → 5) Vercel Blob") -
    yalnızca fatura başarıyla içeri aktarıldıktan SONRA, ayrı bir adım
    olarak yapılır; reddedilen ya da onaylanmadan bırakılan yinelenen bir
    dosya için hiç PDF saklanmaz. Blob henüz kurulmadıysa (ya da o an bir
    sorun olursa) fatura yükleme yine de normal şekilde tamamlanır, sadece
    o satırda "İndir" yerine "—" görünür - bu opsiyonel özellik hiçbir
    zaman asıl veri aktarımını engellemez. Bir fatura silindiğinde PDF
    kopyası da Blob'dan otomatik silinir.
16. **Sıralanabilir sütun başlıkları.** Gönderi tablosundaki **Fatura
    Ağırlığı**, **FedEx Gerçek**, **Toplam Parça** ve **Fark** sütun
    başlıklarına tıklayarak o sütuna göre sıralayabilirsiniz - ilk tık
    büyükten küçüğe (▼), aynı başlığa ikinci tık küçükten büyüğe (▲) sıralar.
    Değeri olmayan satırlar (ör. henüz senkronize edilmemiş) sıralama
    yönünden bağımsız olarak her zaman en sona düşer. Bu, sayfanın
    üstündeki "Sırala" açılır menüsünden (Varsayılan / Duruma göre / Farka
    göre / Tarihe göre) bağımsız, ek bir sıralama yoludur.
17. **PDF ayrıştırıcıda satır kaymasından kaynaklanan eksik ağırlık
    düzeltmesi.** Bazı gerçek faturalarda (kullanıcının yüklediği örnek
    dosyada 3/49 satır) ağırlık hiç okunamıyordu - "Fatura ağırlığı
    eksik/0" filtresinin gösterdiği tam da bu satırlardı. Kök neden, PDF'ten
    metin çıkarılırken (`unpdf`/pdf.js) bazı satırların beklenmedik şekilde
    kaymasıydı, üç ayrı biçimde:
    - Alıcı adı ile servis/ağırlık/tutar satırı TEK satıra birleşiyordu
      (ör. `"Alıcı: FERNANDA MEZA FedEx Intl Priority 9485844 13,3 LB
      1.115,93 TL"`) - bu durumda eski kod tüm satırı yanlışlıkla alıcı adı
      sayıp ağırlığı hiç görmüyordu; genelde faturanın SON satırında
      görülüyor.
    - Çok parçalı gönderilerde uzun referans metni (birden fazla parça
      numarası) servis satırını ikiye bölüyordu (ör. `"FedEx Intl Priority
      8346601 2xW35"` / `"3xW31 37,2 LB 4.239,60 TL"`).
    - Servis adının kendisi ikiye bölünüyordu (ör. `"FedEx Express"` /
      `"Saver 870351493543 40 LB 22.087,56 TL"`).
    `lib/pdfParser.js`'e bu üç kalıbı fatura satırlarını bloklara ayırmadan
    ÖNCE tespit edip düzelten iki yeni normalizasyon adımı eklendi (mevcut
    "birleşik takip numarası satırı" düzeltmesiyle aynı yöntem - satırları
    olması gereken tek-alan-tek-satır haline getirip sonra ayrıştırmak).
    Kullanıcının paylaştığı gerçek faturayla doğrulandı: düzeltmeden önce 3
    gönderi ağırlıksız kalıyordu, düzeltmeden sonra 49 gönderinin 49'u da
    doğru ağırlıkla içeri aktarılıyor - hiçbir satır tahmin edilmiyor,
    beklenen kalıplardan biri kesin olarak eşleşmezse ağırlık yine boş
    bırakılıyor (rastgele/yanlış bir değer üretmek yerine).
18. **PDF ayrıştırıcıda ikinci tur düzeltme (madde 17'nin devamı).**
    Kullanıcı iki fatura daha paylaştı, ikisinde de ağırlık okunamıyordu -
    kök nedenler farklıydı:
    - Bir satır **"FedEx"** ile değil **`"Economy Service ..."`** ile
      başlıyordu - eski regex servis satırının mutlaka "FedEx" ile
      başlamasını şart koşuyordu, bu yüzden satır hiç tanınmıyordu.
      `SERVICE_LINE_RE` artık başta "FedEx" şartı aramıyor, sadece satırın
      sonunun `<ağırlık> <birim> <tutar> TL` şeklinde bitmesine bakıyor -
      bu, faturanın kendi toplam/vergi satırlarıyla (ör. `"Vergiler Dahil
      Toplam Tutar: 93.627,13 TL"`) hiç karışmıyor çünkü onlarda ağırlık
      birimi yok, tek bir sayı var.
    - `"FedEx Express\nSaver\nOLD TRCK#\n870975705425 40 LB 13.159,13
      TL"` gibi DÖRT satıra bölünen bir servis satırında, madde 17'deki
      "birleşik takip numarası" düzeltmesi bu sefer ZARAR veriyordu: "OLD
      TRCK#" satırından sonra gelen `"870975705425 40 LB 13.159,13 TL"`
      satırını (13,3 haneli bir sayıyla başladığı için) yanlışlıkla iki
      ayrı satırmış gibi bölüyor, bu da servis-satırı birleştirme
      mantığının ağırlık satırını bulmasını engelliyordu. Düzeltme:
      artık bu bölme SADECE takip numarasından sonraki metin gerçekten
      "Alıcı:"/"Gönderen:"/"İsim:"/"Adres:"/"Ülke:"/"Teslimat Tarihi:" ile
      başlıyorsa yapılıyor - bir ağırlık/tutar satırının BAŞINDA duran
      alakasız bir referans numarasını artık takip numarası sanıp
      bölmüyor.
    Kullanıcının paylaştığı iki faturayla doğrulandı (1 ve 57 gönderilik),
    ikisinde de hedeflenen gönderi artık doğru ağırlıkla geliyor, daha önce
    doğrulanmış 3 faturada da (49+26+25 gönderi) hiçbir bozulma yok.
19. **PDF ayrıştırıcıda üçüncü tur düzeltme + kalıcı regresyon testi
    (madde 17-18'in devamı).** Kullanıcı "Fatura ağırlığı eksik/0"
    filtresinde 23 gönderi daha gördü ve 10 gerçek fatura daha paylaştı.
    Bu sefer, madde 17-18'de olduğu gibi tek tek yeni kalıp yamalamak
    yerine sorunun kök sınıfını kapatacak şekilde genelleştirildi:
    - **Baskın neden (23 gönderinin 21'i):** madde 17'deki "Alıcı adı +
      servis satırı tek satıra birleşiyor" hatasının aynısı, ama servis
      adı "FedEx ..." değil **"Economy Service ..."** idi (ör. `"Alıcı:
      JOHN SEO Economy Service 0547430 4,4 KG 855,53 TL"`) - o düzeltme
      yalnızca "FedEx" ile başlayan kuyruğu tanıyordu. Çözüm: artık
      `lib/pdfParser.js` içinde bilinen servis adı kökleri ("FedEx Intl
      Priority", "Economy Service" vb.) TEK bir yerde
      (`SERVICE_NAME_ROOTS_SRC`) tanımlı - hem bu birleşik-satır
      düzeltmesi hem servis adını ayrıştıran kural hem de çok satıra
      bölünen servis satırlarını birleştiren kural aynı listeyi kullanıyor.
      İleride yeni bir servis adı (ör. "FedEx Ground Economy") aynı şekilde
      birleşik görünürse tek satırlık bir ekleme üç yeri birden düzeltecek.
    - **Yeni kalıp (2 gönderi):** servis/ağırlık/tutar satırının sonundaki
      "TL", boşluksuz şekilde bir sonraki alanın adına yapışıyordu (ör.
      `"...967,34 TLTeslimat Tarihi: 29-06-2026"` ya da `"...874,02
      TLÜlke:United States"`). Bu, madde 17'deki "alıcı adı servis
      satırına yapışıyor" hatasının ayna görüntüsü - bu sefer servis
      satırının SONU bir sonraki alana yapışıyor. Tek tek bu iki alan
      çifti için ayrı kural yazmak yerine, satır başında OLMAYAN herhangi
      bir alan etiketini (Gönderen:/İsim:/Adres:/Ülke:/Alıcı:/Teslimat
      Tarihi:) satırın ortasında bulursa oradan ikiye bölen genel bir
      normalizasyon adımı eklendi (`splitEmbeddedFieldLabels`) - bu sınıfa
      giren, henüz görülmemiş bir üçüncü alan-çifti kombinasyonu çıkarsa
      onu da otomatik yakalar.
    - **Kalıcı regresyon testi:** bu tür hatalar tekrar tekrar, her
      seferinde sadece en yeni 1-2 faturaya karşı doğrulanarak
      düzeltiliyordu - bu da bir düzeltmenin 3 fatura önce çalışan bir
      kalıbı sessizce bozabilmesine yol açtı (nitekim madde 18'deki bir
      düzeltme tam olarak buydu). Artık `scripts/check-invoices.mjs` adında
      kalıcı bir komut satırı aracı var: bir klasör dolusu gerçek fatura
      PDF'i verildiğinde gerçek ayrıştırıcıyı hepsine karşı çalıştırıp
      hangi gönderinin ağırlığının hâlâ eksik geldiğini (varsa, ham metin
      satırlarıyla birlikte) raporluyor. Bundan sonra `lib/pdfParser.js`'te
      yapılacak her değişiklik, o ana kadar karşılaşılmış TÜM gerçek
      faturaların biriktirildiği bir klasöre karşı bu araçla test
      edilmeli (`node scripts/check-invoices.mjs <klasör>>`) - tek bir
      yeni şikayet için tek bir dosyaya bakıp "düzeldi" demek yerine.
    Bu turda toplam 16 gerçek fatura, 2253 gönderi üzerinden doğrulandı:
    düzeltmeden önce 23 gönderi ağırlıksızdı, düzeltmeden sonra 0 - ve
    daha önce doğrulanmış hiçbir faturada bozulma yok.

## Tasarım

Renk paleti Amazon Seller Central'ın gerçek renklerine göre ayarlandı: bağlantılar
ve aktif sekme mavi (`#006ce0`), ana aksiyon butonları (Kaydet, senkronize et)
siyah/koyu (`#0f1111`), uyarı/"ORTA" rozetleri turuncu (`#e77600`), hata
kırmızısı (`#d13212`), başarı/"TAMAM" rozetleri yeşil-teal (`#067d62`) - hepsi
`app/globals.css`'teki CSS değişkenlerinden (`--brand`, `--btn-primary-bg`,
`--warn`, `--danger`, `--ok`) tek yerden yönetiliyor. Gönderi durumu (İşaretlendi
/ İtiraz Edildi / Fark Faturası Kesildi / Çözüldü) için ayrı bir renk seti
(`--status-*`) var, bu paletle karışmıyor.

Üst gezinme, Amazon Seller Central'ın "koyu üst bar + beyaz sekme şeridi"
görünümüne göre yeniden tasarlandı: logo/marka koyu barda (`app/TopNav.js`),
altında Panel / Fatura Yükle / Ayarlar sekmeleri aktif sayfaya göre alt
çizgiyle vurgulanıyor. Panel sayfasında solda gerçek verilerden üretilen
tıklanabilir bir **Aksiyonlar** paneli var (Farklı Ağırlıklı Gönderiler /
Takipte Olan İtirazlar / Senkron Bekleyen / FedEx Hatalı - her biri KRİTİK /
ORTA / TAMAM etiketiyle) - Amazon'daki "Actions" panelinin karşılığı,
tıklayınca ilgili filtreye geçer. Gönderi tablosunda her satırın sol
kenarında ve Takip No hücresinde, o gönderinin itiraz durumuna göre farklı
bir renk vurgusu var (İşaretlendi=turuncu, İtiraz Edildi=mavi, Fark Faturası
Kesildi=teal, Çözüldü=yeşil) - renk eşlemesi `lib/statusLabels.js` içinde
tek yerden yönetiliyor.

## Kurulum

```bash
npm install
cp .env.example .env.local   # değerleri doldurun
npm run dev                  # http://localhost:3000
```

### 1) Veritabanı

Herhangi bir Postgres (Vercel Postgres, Neon, Supabase) - `DATABASE_URL`
bağlantı dizesini `.env.local` / Vercel ortam değişkenlerine ekleyin. Tablolar
uygulama ilk istek geldiğinde otomatik oluşturulur (migration script'i
çalıştırmanıza gerek yok).

### 2) FedEx Developer Portal (Track API)

1. https://developer.fedex.com adresinde hesap açın / giriş yapın.
2. "My Projects" → yeni proje oluşturun, API listesinden **Track API**'yi
   seçin.
3. Önce **sandbox** kimlik bilgileriyle test edin (`FEDEX_API_BASE=https://apis-sandbox.fedex.com`).
   Gerçek gönderilerinizi görebilmek için FedEx'in **production** erişimini
   onaylaması gerekir - bu genelde FedEx hesap numaranızla proje bazında
   yapılan ayrı bir başvurudur (sandbox'ta gerçek takip numaralarınız
   dönmez, sadece FedEx'in test verileri döner).
4. Onaylanan proje size `Client ID` / `Client Secret` verir.

**Bu bilgileri nereye gireceksiniz:** iki yol var.

- **Uygulama üzerinden (önerilen, redeploy gerektirmez):** siteyi açın →
  **Ayarlar** sayfası → Client ID / Client Secret / Ortam (Production ya da
  Sandbox) alanlarını doldurup **Kaydet**'e basın. "Bağlantıyı test et"
  butonu, kaydetmeden önce bile FedEx'ten gerçekten token alınabildiğini
  anında doğrular. Bu bilgiler veritabanına yazılır ve hemen etkili olur -
  Vercel'de env değişkeni eklemenize/redeploy yapmanıza gerek kalmaz. Aynı
  sayfadan fark eşiğini (kg / %) de değiştirebilirsiniz.
- **Vercel ortam değişkeni olarak (alternatif):** `FEDEX_CLIENT_ID` /
  `FEDEX_CLIENT_SECRET` / `FEDEX_API_BASE`'i Vercel'in Environment
  Variables ekranına girip redeploy edersiniz. Ayarlar sayfasında bir
  değer girilmemişse uygulama bu env değişkenlerine döner - yani ikisi
  birlikte de kullanılabilir, Ayarlar sayfasındaki değer her zaman önceliklidir.

**Önemli not - ağırlık alanının doğrulanması:** FedEx'in genel takip sayfası
(fedex.com/fedextrack) "Package details" altında hem tek parça ağırlığını hem
(çok parçalı gönderilerde) "Total Shipment Weight" toplamını gösteriyor - bu
veri Track API'nin arkasındaki aynı sistemden geliyor. Ama FedEx'in API
yanıtındaki tam alan adı/iç içe yapı zaman içinde değişebiliyor ve halka açık
dokümantasyon üzerinden %100 doğrulanamadı. `lib/fedexClient.js` içindeki
`extractActualWeightKg()` bilinen/olası birkaç yolu sırayla dener (tek
parçalı gönderi → `packageDetails.weightAndDimensions`, çok parçalı gönderi →
parça ağırlıklarının toplamı, hiçbiri tutmazsa → yanıt içinde KG/LB birimli
herhangi bir `{value, unit}` alanını bulan son çare taraması) ve **her
durumda ham FedEx yanıtını veritabanına kaydeder**. Panelde bir gönderinin
"Detay"ını açtığınızda "Ham FedEx yanıtı" bölümünden bu JSON'u görüp
kullanılan alanın doğru olup olmadığını kontrol edebilirsiniz. Sandbox'ta
birkaç gerçek gönderi test ettikten sonra bana (veya projeyi sürdürecek
geliştiriciye) o ham yanıtı gösterirseniz, eşleştirmeyi kesinleştirebiliriz.
Aynı belirsizlik gönderi tablosundaki **Toplam Parça** sütunu için de
geçerli - `extractTotalPieces()` de birkaç olası alanı sırayla dener.

### 3) Gmail (İtiraz e-postaları)

Bu adım opsiyonel - sadece FedEx'e itiraz ettiğinizde gelen onay
e-postalarının uygulamaya otomatik yansımasını istiyorsanız gerekli. Gmail
hesabınıza (aligulbay@gmail.com) **salt-okunur** erişimle bağlanılır; hiçbir
e-posta silinmez/gönderilmez, sadece "dispute"/"itiraz" ile ilgili gelen
kutusu okunur.

1. https://console.cloud.google.com adresinde (Google hesabınızla) yeni bir
   proje oluşturun (ör. "Coolart FedEx Audit").
2. Sol menüden **APIs & Services → Library** → "Gmail API" arayın → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (kişisel Gmail hesabı için tek seçenek budur).
   - Uygulama adı, destek e-postası vb. temel bilgileri girin.
   - Scopes adımında ekstra bir şey eklemenize gerek yok (uygulama zaten
     `gmail.readonly` scope'unu OAuth başlatırken kendisi ister).
   - **Test users** adımında **aligulbay@gmail.com**'u ekleyin - bu adım
     zorunlu, eklenmezse Google bağlantıyı reddeder.
   - Uygulamayı "Testing" yayın durumunda bırakın (bkz. aşağıdaki önemli not
     - "Production"a almak Google'ın ayrı bir doğrulama incelemesini
     gerektirir).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs** alanına *tam olarak* şunları ekleyin:
     - `https://<vercel-alan-adiniz>/api/gmail/callback` (gerçek Vercel
       domaininizle, ör. `https://fedex-weight-audit-vercel.vercel.app/api/gmail/callback`)
     - Yerelde de test edecekseniz: `http://localhost:3000/api/gmail/callback`
   - Oluşturunca size bir **Client ID** ve **Client Secret** verir.
5. Uygulamada **Ayarlar** sayfası → "Gmail Bağlantısı (İtiraz E-postaları)"
   bölümüne bu Client ID / Client Secret'ı yapıştırıp **Kaydet**'e basın,
   ardından **"Gmail'e Bağlan"** butonuyla Google'ın izin ekranına
   yönlendirilip aligulbay@gmail.com ile onaylayın. Bağlandıktan sonra
   Panel'deki (veya Ayarlar'daki) **"Gmail'i senkronize et"** butonu ile
   manuel olarak tetiklersiniz - otomatik/zamanlanmış bir tarama yoktur.

**Önemli - 7 günlük bağlantı süresi:** Google, "Testing" durumundaki
uygulamalar için (Google'ın ayrı bir güvenlik incelemesinden geçmemiş,
kişisel Gmail hesaplarına `gmail.readonly` gibi kısıtlı bir scope ile
bağlanan uygulamalar) verdiği refresh token'ı **~7 gün sonra otomatik
geçersiz kılıyor**. Bu Google'ın genel bir kısıtlaması, kodda düzeltilebilecek
bir hata değil. Pratikte bu, yaklaşık haftada bir Ayarlar sayfasından
**"Gmail'e Bağlan"**a tekrar basıp izni yenilemeniz gerektiği anlamına gelir
- uygulama bağlantı süresi dolduğunda senkronizasyon sırasında bunu net bir
hata mesajıyla bildirir. Kalıcı bir bağlantı isterseniz, Google'ın "Verification"
sürecinden geçip uygulamayı "In production" durumuna almak gerekir (Google
tarafında haftalar sürebilen ayrı bir başvurudur, bu depoda yapılmadı).

### 4) Eşik değerleri

`DISCREPANCY_THRESHOLD_KG` (varsayılan 0.5) ve `DISCREPANCY_THRESHOLD_PCT`
(varsayılan 5): fark bu ikisini birden aşarsa gönderi işaretlenir - küçük
paketlerdeki yuvarlama farkları gürültü yaratmasın diye. İhtiyaca göre
Vercel ortam değişkenlerinden değiştirin.

### 5) Vercel Blob (yüklenen fatura PDF'lerini indirilebilir saklama) - opsiyonel

Bu adım opsiyonel - sadece Panel'deki "Yüklenen Faturalar" listesinden
orijinal PDF'i tekrar indirebilmek istiyorsanız gerekli; kurulmadan da
uygulamanın geri kalanı (fatura ayrıştırma, FedEx karşılaştırma, itiraz
takibi) normal çalışmaya devam eder - sadece "İndir" sütunu her satırda
"—" gösterir.

1. Vercel projenizin panelinde **Storage** sekmesine gidin → **Create
   Database** → **Blob** seçin, bir isim verin (ör. "fatura-pdfleri") ve
   projenize bağlayın.
2. Bağladığınızda Vercel, `BLOB_READ_WRITE_TOKEN` ortam değişkenini
   projenize **otomatik olarak** ekler - elle bir şey girmenize gerek yok,
   sadece bir sonraki deploy'da (bu zip'i yüklediğinizde) etkili olur.
3. Bundan sonra yüklenen her fatura PDF'i tarayıcıdan doğrudan Blob
   depolamaya kopyalanır (sunucu isteğinin içinden geçmez, yani 4,5 MB
   sınırına hiç takılmaz) ve Panel'deki fatura satırında bir **"İndir"**
   linki belirir. Bir fatura silindiğinde PDF kopyası da otomatik silinir.
   Blob kurulmadan önce yüklenmiş faturalarda bu link hiçbir zaman
   belirmez (o PDF'ler hiç saklanmadı) - yeniden yüklemeniz gerekir.

## Vercel'e deploy

1. Bu klasörü bir GitHub reposuna atın (veya `vercel` CLI ile doğrudan
   deploy edin).
2. vercel.com → New Project → repoyu seçin.
3. Environment Variables: `.env.example`'daki tüm değişkenleri girin.
4. Deploy edin. `vercel.json`, PDF yükleme ve senkronizasyon endpoint'lerine
   60 saniyelik fonksiyon süresi tanımlıyor (çok sayfalı faturalar / toplu
   senkronizasyon için).
5. Gmail entegrasyonunu kullanacaksanız, Google Cloud Console'daki OAuth
   client'ın **Authorized redirect URIs** listesine gerçek Vercel
   domaininizi (`https://<domain>/api/gmail/callback`) eklediğinizden emin
   olun - bkz. "Kurulum → 3) Gmail" bölümü. Domain değişirse (ör. custom
   domain bağlarsanız) bu URI'yi Google tarafında da güncellemeniz gerekir.

Not: Vercel Hobby planında cron job'lar günde bir kere ile sınırlı. Şu anki
tasarımda senkronizasyon panelden manuel tetikleniyor (buton, bekleyen
gönderileri küçük gruplar halinde işleyip bitene kadar kendini tekrarlıyor) -
isterseniz `vercel.json`'a günlük bir cron (`/api/sync`'i POST eden) ekleyip
otomatikleştirebiliriz.

## Sorun giderme

"Unexpected token '<', ... is not valid JSON" veya boş/başarısız bir yanıt
görürseniz, bu neredeyse her zaman sunucu tarafında bir yapılandırma
hatasıdır (kod hatası değil) - `/api/...` route'ları artık her hatayı
düzgün bir JSON mesajıyla döndürüyor (`lib/db.js` içindeki `apiHandler`
sarmalayıcısı sayesinde). Tarayıcıdan `sitenizin-adresi/api/invoices`
adresini doğrudan açarsanız gerçek hatayı görürsünüz - en sık nedenler:

- `DATABASE_URL` Vercel'de tanımlı değil / yanlış → "Veritabanı bağlantısı
  yapılandırılmamış" veya "kimlik doğrulaması başarısız" mesajı.
- Env değişkeni eklendi ama proje yeniden deploy edilmedi → Vercel'de
  Environment Variables eklemek otomatik redeploy tetiklemez, **Redeploy**
  demeniz gerekir.
- FedEx Client ID / Client Secret eksik (ne Ayarlar sayfasında ne env
  değişkeninde) → sadece senkronizasyon ("FedEx ile senkronize et")
  etkilenir, yükleme ve panel çalışmaya devam eder. **Ayarlar** sayfasındaki
  "Bağlantıyı test et" butonuyla hızlıca doğrulayabilirsiniz.

Daha ayrıntılı hata detayı için Vercel Dashboard → projeniz → **Deployments**
→ ilgili deployment → **Runtime Logs** sekmesine bakabilirsiniz.

## Sınırlamalar / bilinen notlar

- Vercel'in Serverless Functions'ları tek bir isteğin gövdesini yaklaşık
  **4,5 MB**'la sınırlar (bu platform sınırı, uygulama kodundan
  değiştirilemez). Bazı FedEx e-Fatura PDF'leri (gömülü font/görsellerden
  dolayı) tek başına 5-7 MB'a ulaşabildiği için, PDF'in kendisini
  yüklemek yerine **ayrıştırma tarayıcıda yapılır** (`lib/pdfParser.js`,
  `app/upload/page.js` içinden `unpdf` ile) ve sunucuya sadece
  ayrıştırılmış küçük bir JSON gönderilir (`app/api/invoices/upload/route.js`
  artık PDF değil, `{ filename, meta, rows }` JSON'u kabul ediyor) - dosya
  boyutu ne olursa olsun bu JSON birkaç yüz KB'ı geçmez, yani 4,5 MB sınırı
  pratikte hiç devreye girmez. Çoklu seçimde dosyalar yine **teker teker,
  ayrı isteklerle** işlenir (`uploadOneFile`), art arda - artık boyut
  sınırından değil, ilerleme göstergesi ve dosya başına yinelenen-fatura/hata
  sonucunu basit tutmak için. Olağandışı derecede çok gönderi satırı içeren
  tek bir faturanın JSON'u yine de 4,5 MB'ı aşarsa (binlerce satır gerekir,
  gerçekçi değil) arayüz bunu ayrı bir mesajla gösterir.
- PDF rapor (`/api/export/pdf`), Türkçe karakterleri (İ, ı, ğ, ş, ç, ö, ü)
  doğru basabilmek için `assets/fonts/DejaVuSans*.ttf` dosyalarını projenin
  içinde taşıyor ve çalışma anında okuyor - bunlar Vercel'in build/deploy
  sürecine `next.config.mjs`'deki `outputFileTracingIncludes` ayarıyla dahil
  ediliyor. Bu klasörü/ayarı silmeyin, aksi halde PDF export Vercel'de
  (yerelde değil, sadece deploy'da) "font bulunamadı" hatasıyla çalışmaz hale
  gelir.
- PDF ayrıştırıcı (`lib/pdfParser.js`), bu depoda test edilen FedEx Türkiye
  e-Fatura şablonuna göre yazıldı (satır etiketleri: `Alıcı:`, `Ülke:`,
  `Teslimat Tarihi:`, hizmet satırındaki `TL` sonu). FedEx şablonu değişirse
  ayrıştırılan satır sayısı 0 döner - yükleme ekranı bunu hata olarak
  gösterir, sessizce yanlış veri içeri almaz.
- Fatura satırındaki ağırlık birimi (**KG veya LB**) her satırda ayrı ayrı
  okunuyor - aynı faturada bazı gönderiler kg, bazıları lb (örn. ABD'ye giden
  gönderiler) cinsinden faturalandırılmış olabilir, bu normaldir. Ayrıştırıcı
  `KG`, `KGS`, `LB`, `LBS` yazımlarının hepsini tanıyor (büyük/küçük harf ve
  sondaki nokta fark etmez) ve hepsini karşılaştırma için **kg**'a çeviriyor;
  gönderi tablosunda hem faturadaki orijinal değer+birim (ör. "27,1 LB") hem
  de kg karşılığı (ör. "(12,29 kg)") birlikte gösteriliyor. Tanımadığı bir
  birim görürse (çok nadir, farklı bir şablon durumunda) o satırın ağırlığını
  boş bırakır - yanlış birimle yanlış hesaplama yapmaz.
- Bazı gerçek faturalarda, PDF'ten metin çıkarılırken bir gönderinin takip
  numarası satırı bir sonraki alanla (ör. `870571273142 Alıcı: NIKKO HOLZ`
  gibi) aynı satıra yapışabiliyor - bu, o satırı iki ayrı satırmış gibi
  yeniden bölen bir normalleştirme adımıyla düzeltiliyor
  (`lib/pdfParser.js` → `normalizeTrackingLines()`). Bu düzeltme
  olmadan, o gönderinin satır sınırı doğru tespit edilemiyor ve
  faturadaki iki ardışık gönderinin bilgileri (özellikle ağırlık) birbirine
  karışabiliyordu - artık her alan yalnızca ilk (doğru) eşleşmeyi kabul
  ediyor, sonradan sızan bir satır asla üzerine yazmıyor.
- Aynı fatura numarası tekrar yüklenmeye çalışılırsa uygulama bunu
  **otomatik olarak yüklemez** - "daha önce yüklenmiş" uyarısı gösterir ve
  "Yine de üzerine yaz" ile açıkça onaylamanızı bekler. Onaylarsanız
  satırlar güncellenir ama daha önce çekilmiş FedEx ağırlıkları silinmez.
- Bire bir aynı takip numarası birden fazla faturada farklı satır olarak
  geçebilir (örn. bir gönderi parçalara bölünüp ayrı ücretlendirilmişse) -
  bu normal kabul edilip her satır ayrı gönderi olarak tutulur.
- Gmail bağlantısı Google'ın "Testing" yayın durumunda çalışır, bu yüzden
  refresh token ~7 günde bir geçersiz oluyor ve Ayarlar sayfasından yeniden
  bağlanmanız gerekiyor (bkz. "Kurulum → 3) Gmail"). Kalıcı bağlantı,
  Google'ın ayrı bir doğrulama sürecini gerektiriyor.
- FedEx itiraz e-postasının gövdesi, Gmail'in size ilettiği HTML/metin
  şablonuna göre satır satır (etiket → değer) ayrıştırılıyor
  (`lib/gmailClient.js` → `parseDisputeEmail()`). FedEx bu şablonu
  değiştirirse bazı alanlar (tarih, tutar vb.) boş kalabilir, ama e-posta
  yine de ham haliyle kaydedilir ve Takip No / CQL referans no eşleşmesi
  ayrı bir aşamada, e-postanın konusundan ve gövdesinden regex ile
  bulunduğu için bu durumdan etkilenmez.
- "Geciken İtirazlar" sayacı sadece FedEx'e itirazın **ne zaman açıldığını**
  takip eder; FedEx'in itiraza **yanıt/sonuç** e-postasını (ör. itiraz kabul/
  red, fark faturası kesildi) otomatik algılayıp durumu ilerletmiyor veya
  sayacı durdurmuyor - bu, "Fark Faturası Kesildi" / "Çözüldü" durumuna
  geçişin şu an için elle yapılması gerektiği anlamına gelir. FedEx'in bu tür
  yanıt e-postalarından gerçek bir örnek paylaşılırsa ileride bu da Gmail
  senkronizasyonuna eklenebilir.
- Ayarlar sayfasının kendisi şifre korumalı değil - FedEx ve Gmail Client
  Secret'ları (ve Gmail refresh token'ı) veritabanında düz metin olarak
  tutuluyor. Bu, tek kullanıcılı dahili bir araç için bilinçli bir
  basitleştirme; uygulamayı herkese açık bir ortamda paylaşacaksanız önce
  bir giriş/kimlik doğrulama katmanı eklenmesini öneririz.
