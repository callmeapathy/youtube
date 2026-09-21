# YT Placements — MVP

Каталог YouTube-каналів з фільтрами, ручною оцінкою якості (1–5★),
статусом whitelist/blacklist та експортом у CSV/XLSX для Google Ads.

## Структура репозиторію

```
ytplacements/
├── site/                    ← фронтенд + API, деплоїться на Cloudflare Pages
│   ├── index.html           ← сам інтерфейс (таблиця, фільтри, експорт)
│   └── functions/api/       ← бекенд-функції (Pages Functions), працюють з D1
│       ├── channels.js
│       └── channels/[id].js
├── sync-worker/              ← окремий Worker, раз на добу оновлює метрики з YouTube API
│   ├── src/index.js
│   ├── wrangler.toml
│   └── package.json
├── schema.sql                ← структура таблиць D1
├── seed.sql                  ← 40 демо-каналів для першого тесту (2 з них — реальні: MrBeast, PewDiePie)
└── README.md                 ← цей файл
```

---

## Частина A — GitHub

1. Створи новий репозиторій на github.com (Public або Private — не важливо).
2. Заливаєш усю цю папку `ytplacements/` як корінь репозиторію:

```bash
cd ytplacements
git init
git add .
git commit -m "MVP: YT Placements catalog"
git branch -M main
git remote add origin https://github.com/ТВІЙ_ЛОГІН/ТВОЄ_РЕПО.git
git push -u origin main
```

Далі все відбувається на стороні Cloudflare — при кожному `git push` в `main`
Pages сам перезбирає й деплоїть сайт.

---

## Частина B — Cloudflare

Знадобиться безкоштовний акаунт на cloudflare.com і встановлений `wrangler`
(CLI-утиліта Cloudflare):

```bash
npm install -g wrangler
wrangler login    # відкриє браузер для авторизації
```

### Крок 1. Створити базу даних D1

```bash
npx wrangler d1 create ytplacements
```

Команда виведе щось на кшталт:

```
[[d1_databases]]
binding = "DB"
database_name = "ytplacements"
database_id = "a1b2c3d4-...."
```

Скопіюй `database_id` — він знадобиться у двох місцях (крок 2 і крок 5).

### Крок 2. Накатити схему і демо-дані

```bash
npx wrangler d1 execute ytplacements --remote --file=./schema.sql
npx wrangler d1 execute ytplacements --remote --file=./seed.sql
```

Перевірити, що дані залилися:

```bash
npx wrangler d1 execute ytplacements --remote --command="SELECT count(*) FROM channels"
```

Має показати 40.

### Крок 3. Підключити GitHub-репозиторій до Cloudflare Pages

1. Заходиш у Cloudflare Dashboard → **Workers & Pages** → **Create** → вкладка **Pages** → **Connect to Git**.
2. Обираєш свій щойно запушений репозиторій.
3. У налаштуваннях білда:
   - **Framework preset**: `None`
   - **Build command**: залиш порожнім
   - **Build output directory**: `site`
   - **Root directory**: `/` (корінь репо)
4. Тисни **Save and Deploy**. Через хвилину сайт буде доступний за адресою
   виду `https://ytplacements.pages.dev`.

### Крок 4. Прив'язати D1 до Pages (щоб API-функції бачили базу)

Це робиться окремо від деплою, через дашборд:

1. У проєкті Pages → **Settings** → **Functions** → розділ **D1 database bindings**.
2. **Add binding**:
   - **Variable name**: `DB` (саме так, великими літерами — код в `functions/api/*.js` звертається саме до `env.DB`)
   - **D1 database**: обираєш `ytplacements`
3. Зберігаєш і робиш **Retry deployment** (або просто новий `git push`), щоб binding застосувався.

Після цього відкриваєш `https://ytplacements.pages.dev` — таблиця повинна
завантажити всі 40 демо-каналів із D1, фільтри й експорт працюють одразу.

### Крок 5. Задеплоїти sync-worker (щоденне оновлення метрик з YouTube)

```bash
cd sync-worker
```

Відкрий `wrangler.toml` і встав туди `database_id` з кроку 1 замість
`PASTE_DATABASE_ID_HERE`.

Отримай YouTube Data API ключ (Google Cloud Console → APIs & Services →
Credentials → Create API key, і увімкни "YouTube Data API v3" для проєкту),
далі:

```bash
npm install
npx wrangler secret put YOUTUBE_API_KEY
# вставиш ключ у інтерактивному запиті

npx wrangler deploy
```

Cron вже прописаний у `wrangler.toml` (`0 3 * * *` — щодня о 03:00 UTC) і
активується автоматично при деплої.

Перевірити вручну, не чекаючи на ніч:

```bash
curl https://ytplacements-sync.ТВІЙ_САБДОМЕН.workers.dev/run
```

Побачиш JSON на кшталт `{"updated": 40, "total": 40, "errors": []}` —
і в таблиці на сайті оновляться перегляди/підписники.

---

## Що вже працює в цьому MVP

- Фільтри (країна, тип, тематика, мова, якість, перегляди, статус)
- Сортування по будь-якій колонці
- Оцінка 1–5★ і статус whitelist/blacklist — клікабельні прямо в таблиці,
  зміни одразу пишуться в D1 і в `rating_log` (лог для майбутнього навчання моделі)
- Експорт обраних рядків у CSV та XLSX з посиланнями `youtube.com/channel/UC...`
- Щоденне автооновлення підписників і середніх переглядів через YouTube Data API

## Що свідомо не входить в цей MVP (наступні кроки)

- **Автоматичний пошук нових каналів.** Зараз канали додаються вручну
  (через `seed.sql` або `POST /api/channels`). Підключення Google Sheet
  або звіту з Google Ads placements — окрема задача, для якої потрібна
  структура твоєї таблиці/звіту.
- **LLM-оцінка якості.** Зірочки поки виставляються вручну. Автоматична
  класифікація через Workers AI або Claude API підключається окремим
  кроком до цього ж Worker'а.
- **Навчання власної моделі на правках.** Таблиця `rating_log` вже
  накопичує дані для цього — коли назбирається кілька сотень записів,
  можна буде дообучити просту модель на цих прикладах.
- **Авторизація.** Зараз будь-хто з посиланням на сайт може редагувати
  оцінки. Для команди з кількох людей поки не критично, але варто мати
  на увазі.

## Квота YouTube Data API

Безкоштовна квота — 10 000 юнітів/добу. Пошук відео каналу (`search.list`)
коштує 100 юнітів за виклик — тому `sync-worker` навмисно обмежений
(`BATCH_LIMIT = 40` каналів за прогін), щоб не вибити квоту одним запуском.
Якщо база виросте до тисяч каналів, доведеться або збільшувати частоту
запусків cron і зменшувати `BATCH_LIMIT`, або переходити на платну квоту.
