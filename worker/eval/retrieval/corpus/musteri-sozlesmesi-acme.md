# Yazılım Hizmet Sözleşmesi

Sözleşme no: PRV-SOZ-2025-0187. Taraflar: Pervane Yazılım A.Ş. (Kadıköy / İstanbul, bundan sonra "Pervane") ile Acme Lojistik Hizmetleri A.Ş. (Gebze / Kocaeli, bundan sonra "Müşteri"). Sözleşme 1 Ekim 2025 tarihinde imzalanmıştır ve aynı tarihte yürürlüğe girer. Müşteri adına imza yetkilisi Hakan Ergin, Pervane adına imza yetkilisi Ayşe Demirtaş'tır. Bu sözleşmede geçen Acme Lojistik ve kişiler tamamen kurgusaldır.

## Madde 1. Tanımlar

1.1. "Hizmet", Pervane'nin Müşteri'ye sunduğu Pervane Rota bulut yazılımı, API erişimi ve ilgili destek hizmetlerini ifade eder.
1.2. "Kullanıcı", Müşteri tarafından Hizmet'e erişim yetkisi verilen gerçek kişidir. Sözleşme kapsamında en fazla 250 aktif Kullanıcı tanımlanabilir (Ek-1, PRV-ENT-0042 kodlu Enterprise Yıllık 250 planı).
1.3. "Müşteri Verisi", Müşteri'nin Hizmet'e yüklediği ya da Hizmet aracılığıyla ürettiği her türlü rota, araç, sürücü, teslimat ve müşteri kaydıdır.
1.4. "Hizmet Seviyesi", Madde 6'da tanımlanan kullanılabilirlik ve destek yanıt süresi taahhütleridir.
1.5. "Yıllık Ücret", Madde 4'te belirtilen, Hizmet için Müşteri'nin her sözleşme yılında ödediği toplam bedeldir.

## Madde 2. Sözleşmenin konusu ve kapsamı

2.1. Pervane, Müşteri'ye sözleşme süresince münhasır olmayan, devredilemeyen ve alt lisanslanamayan bir kullanım hakkı verir.
2.2. Hizmet'e ek modüller (SAML SSO, ek depolama, yüksek hacimli API paketi) yazılı sipariş formuyla eklenebilir. Her sipariş formu bu sözleşmenin ayrılmaz parçasıdır ve fiyatlar Pervane'nin sözleşme tarihindeki fiyat listesine göre belirlenir.
2.3. Müşteri, Hizmet'i yasalara aykırı amaçlarla, ters mühendislik yapmak için veya Pervane'nin rakibi olan bir ürünün geliştirilmesi için kullanamaz.

## Madde 3. Süre

3.1. Sözleşme 1 Ekim 2025'ten itibaren 24 ay süreyle geçerlidir.
3.2. Taraflardan biri, sürenin bitiminden en az 90 gün önce yazılı bildirimle yenilememe iradesini bildirmezse sözleşme 12 aylık dönemler halinde kendiliğinden yenilenir.
3.3. Yenileme dönemlerinde Yıllık Ücret, bir önceki yılın ücretinin TÜFE (TÜİK, 12 aylık ortalama) oranında, ancak en fazla %18 artırılabilir.

## Madde 4. Ücret ve ödeme koşulları

4.1. Yıllık Ücret 14.900 ABD Doları + KDV'dir. Ücret, her sözleşme yılının ilk 15 günü içinde peşin olarak fatura edilir.
4.2. Fatura, vade tarihinden itibaren 30 gün içinde ödenir. Ödeme, Pervane'nin faturada belirttiği Türk Lirası hesabına, fatura tarihindeki TCMB döviz satış kuru üzerinden yapılır. Vadesinde ödenmeyen tutara aylık %2 gecikme faizi uygulanır.
4.3. Ödeme 60 günü aşarsa Pervane, Müşteri'ye yazılı ihtar göndererek Hizmet'i askıya alabilir. Askıya alma sırasında Müşteri Verisi silinmez ve 45 gün boyunca saklanır.
4.4. Müşteri, faturaya itirazını fatura tarihinden itibaren 10 gün içinde yazılı olarak yapar. İtiraz edilmeyen fatura kabul edilmiş sayılır.
4.5. Ek modül ve aşım bedelleri (aylık API çağrısı 5 milyonu aşarsa her ek milyon için 60 ABD Doları) takip eden ayın faturasına eklenir.
4.6. Vergi, harç ve damga vergisi Müşteri'ye aittir.

## Madde 5. Müşteri'nin yükümlülükleri

5.1. Müşteri, Kullanıcı hesaplarının güvenliğinden sorumludur ve her Kullanıcı için iki adımlı doğrulamayı zorunlu tutar.
5.2. Müşteri, Hizmet'e yüklenen verinin hukuka uygun olduğunu ve üçüncü kişilerin haklarını ihlal etmediğini beyan eder.
5.3. Müşteri, Pervane'nin makul ölçüde talep ettiği bilgi ve belgeleri 5 iş günü içinde sağlar.

## Madde 6. Hizmet seviyesi (SLA)

6.1. Pervane, Hizmet'in aylık kullanılabilirliğini %99,9 olarak taahhüt eder. Planlı bakım süreleri ve Müşteri kaynaklı kesintiler hesaplamaya dahil edilmez.
6.2. Planlı bakım en fazla ayda 4 saattir ve en az 72 saat önceden e-postayla duyurulur; bakım hafta içi 22.00 ile 04.00 arasında yapılır.
6.3. Destek talepleri öncelik düzeyine göre yanıtlanır: Kritik (Hizmet tamamen kullanılamıyor) 30 dakika, Yüksek 2 saat, Normal 1 iş günü, Düşük 3 iş günü. Kritik talepler için 7/24 destek, PRV-SUP-0066 kodlu Premium Destek paketi kapsamındadır.
6.4. Aylık kullanılabilirlik %99,9'un altına düşerse Müşteri, ilgili ayın ücretinin orantılı kısmının şu oranlarda kredisini talep edebilir: %99,0 ile %99,9 arasında %5, %95,0 ile %99,0 arasında %15, %95,0'ın altında %30. Kredi talebi, kesintiyi izleyen 30 gün içinde yapılmalıdır.
6.5. Hizmet kredileri Müşteri'nin tek ve münhasır çözümüdür; kredi, nakit olarak ödenmez ve sonraki faturadan düşülür.

## Madde 7. Gizlilik

7.1. Taraflardan her biri, diğerinden öğrendiği ticari, teknik ve finansal bilgileri gizli tutar, yalnızca sözleşmenin ifası için kullanır ve üçüncü kişilere açıklamaz.
7.2. Gizlilik yükümlülüğü, sözleşmenin sona ermesinden sonra 5 yıl boyunca devam eder.
7.3. Aşağıdaki bilgiler gizli sayılmaz: kamuya açık olanlar, alıcı tarafından bağımsız geliştirilenler, yasal olarak üçüncü kişiden hak sahibi olarak edinilenler.
7.4. Yetkili makamlarca zorunlu kılınan açıklamalarda taraf, mümkün olduğunda diğer tarafı önceden bilgilendirir.
7.5. Gizlilik ihlali halinde ihlal eden taraf, ihlalden doğan doğrudan zararları karşılar; cezai şart öngörülmemiştir.

## Madde 8. Kişisel veriler

8.1. Pervane, Müşteri Verisi'ndeki kişisel veriler bakımından 6698 sayılı KVKK kapsamında "veri işleyen", Müşteri "veri sorumlusu" sıfatındadır.
8.2. Pervane, kişisel verileri yalnızca Müşteri'nin yazılı talimatlarıyla işler. Alt işleyiciler (barındırma, e-posta, ödeme) Pervane'nin internet sitesinde listelenir; değişiklik 30 gün önceden duyurulur.
8.3. Veri ihlali halinde Pervane, Müşteri'yi ihlali öğrendikten sonra en geç 48 saat içinde bilgilendirir.
8.4. Müşteri Verisi, sözleşmenin sona ermesinden sonra 30 gün boyunca dışa aktarılabilir; bu sürenin ardından 60 gün içinde kalıcı olarak silinir ve silme yazılı olarak teyit edilir.
8.5. Veriler Avrupa Birliği'ndeki veri merkezlerinde barındırılır; Müşteri'nin yazılı onayı olmadan Avrupa Ekonomik Alanı dışına aktarılmaz.

## Madde 9. Fikri mülkiyet

9.1. Hizmet'e, yazılıma, arayüzlere ve belgelere ilişkin tüm fikri mülkiyet hakları Pervane'ye aittir.
9.2. Müşteri Verisi üzerindeki haklar Müşteri'de kalır. Müşteri, Pervane'ye yalnızca Hizmet'i sunmak amacıyla Müşteri Verisi'ni işleme hakkı verir.
9.3. Müşteri'nin Hizmet hakkındaki geri bildirimleri Pervane tarafından bedelsiz kullanılabilir.

## Madde 10. Sorumluluk

10.1. Pervane'nin bu sözleşmeden doğan toplam sorumluluğu, olayın gerçekleştiği tarihten önceki 12 ayda Müşteri'nin ödediği Yıllık Ücret ile sınırlıdır.
10.2. Hiçbir taraf dolaylı zararlardan, kâr kaybından, itibar kaybından veya veri kaybından kaynaklanan ikincil zararlardan sorumlu değildir; kast ve ağır kusur halleri saklıdır.
10.3. Pervane, Müşteri'nin kendi sürücülerinin teslimat gecikmeleri ya da rota önerilerine uyulmamasından kaynaklanan zararlardan sorumlu tutulamaz.

## Madde 11. Mücbir sebep

11.1. Deprem, yangın, savaş, salgın, genel elektrik ve internet kesintisi, kamu otoritelerinin kararı gibi tarafların kontrolü dışında gelişen olaylar mücbir sebep sayılır.
11.2. Mücbir sebep halinde etkilenen taraf, durumu 5 iş günü içinde diğer tarafa bildirir. Mücbir sebep 60 günden uzun sürerse taraflar sözleşmeyi cezasız feshedebilir.

## Madde 12. Fesih

12.1. Taraflardan biri, diğer tarafın esaslı bir yükümlülüğünü ihlal etmesi ve yazılı ihtarın tebliğinden itibaren 30 gün içinde ihlali gidermemesi halinde sözleşmeyi derhal feshedebilir.
12.2. Müşteri, ilk 24 aylık süre içinde haklı bir neden olmaksızın sözleşmeyi feshederse, kalan aylara ait Yıllık Ücret'in %50'sini fesih tazminatı olarak öder. Bu tazminat, ceza niteliğinde değil, Pervane'nin ayrılan kapasite ve yatırım maliyetinin makul bir karşılığıdır.
12.3. Fesih bildirimi, noter aracılığıyla veya iadeli taahhütlü posta ile ya da kayıtlı elektronik posta (KEP) adresine gönderilir. Bildirim, karşı tarafın tebliğ aldığı tarihte hüküm doğurur. Kesin fesih bildirim süresi 60 gündür.
12.4. Müşteri'nin iflası, konkordato ilanı veya tasfiyesi halinde Pervane sözleşmeyi 15 gün önceden bildirerek feshedebilir.
12.5. Fesih halinde Müşteri, feshe kadar doğan ücretleri öder; peşin ödenen ve kullanılmayan ücretler yalnızca Pervane'nin ihlali nedeniyle yapılan fesihte iade edilir.
12.6. Madde 7 (gizlilik), Madde 8.4 (veri iadesi ve silme), Madde 9 (fikri mülkiyet) ve Madde 10 (sorumluluk) fesihten sonra da yürürlükte kalır.

## Madde 13. Bildirimler

13.1. Bildirimler, sözleşme başında belirtilen adreslere ve KEP adreslerine gönderilir. Operasyonel bildirimler (bakım duyuruları, kesinti raporları) e-postayla yapılabilir: Pervane tarafı destek@pervane.test, Müşteri tarafı bt@acme-lojistik.test.
13.2. Adres değişikliği 10 gün içinde bildirilmezse eski adrese yapılan bildirim geçerli sayılır.

## Madde 14. Uyuşmazlık ve yetki

14.1. Bu sözleşmeye Türk hukuku uygulanır.
14.2. Taraflar uyuşmazlıkları öncelikle 30 gün içinde müzakereyle çözmeye çalışır; çözülemezse İstanbul Anadolu Mahkemeleri ve İcra Daireleri yetkilidir.
14.3. Sözleşmenin bir hükmünün geçersiz sayılması diğer hükümleri etkilemez.

## Madde 15. Devir

15.1. Müşteri, Pervane'nin yazılı onayı olmadan sözleşmedeki hak ve yükümlülüklerini devredemez.
15.2. Pervane, sözleşmeyi birleşme, bölünme veya şirket varlıklarının devri durumunda Müşteri'ye 30 gün önceden bildirmek kaydıyla devredebilir.

## Ek-1. Fiyat ve kapsam

Plan: Enterprise Yıllık 250 (250 Kullanıcı). Yıllık Ücret: 14.900 ABD Doları. İsteğe bağlı eklentiler: SAML SSO Eklentisi aylık 4.250 TL, Ek Depolama 500 GB aylık 1.890 TL, API Çağrı Paketi 2M aylık 320 ABD Doları. Eklentiler Madde 2.2 uyarınca sipariş formuyla etkinleştirilir. Eğitim: kurulum sırasında 2 gün Yönetici Eğitimi ücretsizdir.

## Ek-2. Uygulama takvimi

Kurulum 15 Ekim 2025'te başlamıştır. Eski rota sisteminden veri aktarımı 3 Kasım 2025'e kadar tamamlanır. Pilot ekip (20 Kullanıcı) 10 Kasım 2025'te canlıya geçer; tüm Kullanıcılar için canlıya geçiş en geç 1 Aralık 2025'tir. Takvim gecikmesi Müşteri'nin veri sağlamadaki gecikmesinden kaynaklanıyorsa süre gecikme kadar uzar.
