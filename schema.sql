-- Основна таблиця каналів
CREATE TABLE IF NOT EXISTS channels (
  id               TEXT PRIMARY KEY,      -- YouTube channelId, напр. UCxxxxxxxxxxxxxxxxxxxxxx
  name             TEXT NOT NULL,
  country          TEXT DEFAULT 'XX',     -- ISO-код країни походження
  type             TEXT DEFAULT '',       -- Блогер / Медіа / Мережа / Бренд / Продакшн / Освітній / Агрегатор
  category         TEXT DEFAULT '',       -- тематика контенту
  language         TEXT DEFAULT '',       -- код мови
  subscribers      INTEGER DEFAULT 0,
  avg_views_month  INTEGER DEFAULT 0,     -- середні перегляди на відео за останні 30 днів
  videos_month     INTEGER DEFAULT 0,     -- кількість відео за останні 30 днів
  quality          INTEGER DEFAULT 3,     -- 1..5, оцінка якості
  status           TEXT DEFAULT '',       -- '' | 'white' | 'black'
  source           TEXT DEFAULT 'manual', -- звідки взявся канал: manual / sheet / ads_report
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);

-- Лог усіх ручних правок — це майбутній тренувальний датасет
CREATE TABLE IF NOT EXISTS rating_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  TEXT NOT NULL,
  field       TEXT NOT NULL,   -- 'quality' | 'status'
  old_value   TEXT,
  new_value   TEXT,
  changed_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channels_country ON channels(country);
CREATE INDEX IF NOT EXISTS idx_channels_status  ON channels(status);
CREATE INDEX IF NOT EXISTS idx_channels_quality ON channels(quality);
CREATE INDEX IF NOT EXISTS idx_rating_log_channel ON rating_log(channel_id);
