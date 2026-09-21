import Papa from 'papaparse';

const BATCH_LIMIT = 100;

// Маппинг категорий YouTube API ID -> Название на украинском/русском
const YOUTUBE_CATEGORIES = {
  "1": "Фільми та анімація",
  "2": "Авто та транспорт",
  "10": "Музика",
  "15": "Tварини",
  "17": "Спорт",
  "19": "Подорожі",
  "20": "Ігри",
  "22": "Блоги",
  "23": "Гумор",
  "24": "Розваги",
  "25": "Новини та політика",
  "26": "Стиль та мода",
  "27": "Освіта",
  "28": "Наука та технології"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const result = await syncChannels(env);
      return Response.json(result);
    }
    return new Response("YT Placements sync worker. GET /run to trigger manually.", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncChannels(env));
  },
};

async function syncChannels(env) {
  const result = {
    processedFromSheets: 0,
    addedOrUpdatedInDB: 0,
    errors: []
  };

  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    result.errors.push({ step: "init", error: "YOUTUBE_API_KEY secret is not set" });
    return result;
  }

  if (!env.GOOGLE_SHEET_CSV_URL) {
    result.errors.push({ step: "init", error: "GOOGLE_SHEET_CSV_URL secret is not set" });
    return result;
  }

  try {
    // 1. Загружаем Google Sheet
    const sheetRes = await fetch(env.GOOGLE_SHEET_CSV_URL);
    const csvText = await sheetRes.text();

    const { data: rows } = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true
    });

    // 2. Собираем уникальные каналы из таблицы (id -> { status, customType, customCategory })
    const pendingChannels = new Map();

    for (const row of rows) {
      const rawUrl = row['URL-адреса місця розташування'] || row['url'] || row['URL'] || Object.values(row)[0];
      const rawStatus = row['status'] || row['статус'] || 'black';
      const customType = row['type'] || row['тип'] || '';
      const customCategory = row['category'] || row['категорія'] || '';

      if (!rawUrl) continue;

      const channelId = parseChannelId(rawUrl);
      if (!channelId) continue;

      const statusValue = String(rawStatus).trim().toLowerCase() === 'white' ? 'white' : 'black';
      pendingChannels.set(channelId, { status: statusValue, customType, customCategory });
    }

    result.processedFromSheets = pendingChannels.size;

    // 3. Достаем существующие ID из D1
    const { results: existingRows } = await env.DB.prepare("SELECT id FROM channels").all();
    const existingIds = new Set((existingRows || []).map(r => r.id));

    // 4. Фильтруем только новые (необработанные) каналы
    const unparsedChannelIds = Array.from(pendingChannels.keys())
      .filter(id => !existingIds.has(id))
      .slice(0, BATCH_LIMIT);

    let targetIds = unparsedChannelIds;
    if (targetIds.length === 0) {
      const { results: staleRows } = await env.DB.prepare(
        "SELECT id FROM channels ORDER BY updated_at ASC LIMIT ?"
      ).bind(BATCH_LIMIT).all();
      targetIds = (staleRows || []).map(r => r.id);
    }

    if (targetIds.length === 0) {
      return result;
    }

    // 5. Пакетный запрос в YouTube API
    const updateBatch = [];

    for (let i = 0; i < targetIds.length; i += 50) {
      const chunkIds = targetIds.slice(i, i + 50);

      const chRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,topicDetails&id=${chunkIds.join(',')}&key=${apiKey}`
      );
      const chData = await chRes.json();

      if (!chData.items || chData.items.length === 0) continue;

      for (const item of chData.items) {
        const id = item.id;
        const snippet = item.snippet || {};
        const stats = item.statistics || {};
        const topicDetails = item.topicDetails || {};

        const name = snippet.title;
        if (!name) continue;

        const country = snippet.country || 'XX';
        const language = snippet.defaultLanguage || snippet.audioLanguage || 'uk';
        const subscribers = Number(stats.subscriberCount || 0);
        
        const sheetData = pendingChannels.get(id) || { status: 'black', customType: '', customCategory: '' };

        // Определяем ТИП канала
        const type = sheetData.customType || detectChannelType(name, snippet.description || '');

        // Определяем КАТЕГОРИЮ канала
        const category = sheetData.customCategory || detectChannelCategory(topicDetails);

        updateBatch.push(
          env.DB.prepare(`
            INSERT INTO channels (id, name, country, type, category, language, subscribers, status, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sheet_import', datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              country = excluded.country,
              type = COALESCE(NULLIF(excluded.type, ''), channels.type),
              category = COALESCE(NULLIF(excluded.category, ''), channels.category),
              language = excluded.language,
              subscribers = excluded.subscribers,
              status = excluded.status,
              updated_at = datetime('now')
          `).bind(id, name, country, type, category, language, subscribers, sheetData.status)
        );
      }
    }

    // 6. Сохраняем все обновленные записи в D1
    if (updateBatch.length > 0) {
      await env.DB.batch(updateBatch);
      result.addedOrUpdatedInDB = updateBatch.length;
    }

  } catch (e) {
    result.errors.push({ step: "sync_process", error: String(e) });
  }

  return result;
}

function parseChannelId(url) {
  if (!url) return null;
  const match = url.match(/channel\/([\w-]+)/) || url.match(/@([\w-]+)/);
  return match ? match[1] : null;
}

// Автоматическое определение типа канала
function detectChannelType(title, description) {
  const text = (title + " " + description).toLowerCase();
  
  if (/tv|тв|новини|новости|телеканал|радио|radio|24|канал|студія|studio|production|продакшн/.test(text)) {
    return 'Медіа';
  }
  if (/офіційний|official|brand|компанія|бренд|store|shop/.test(text)) {
    return 'Бренд';
  }
  if (/шоу|шоубіз|фильмы|кино|мультики|анекдоты|подборка|топ/.test(text)) {
    return 'Паблік';
  }
  return 'Блогер'; // По умолчанию
}

// Автоматическое определение категории по TopicDetails из YouTube API
function detectChannelCategory(topicDetails) {
  const categoriesMap = {
    'Gaming': 'Ігри',
    'Music': 'Музика',
    'Entertainment': 'Розваги',
    'Society': 'Новини та політика',
    'Lifestyle': 'Блоги',
    'Technology': 'Наука та технології',
    'Sport': 'Спорт',
    'Film': 'Фільми та анімація',
    'Knowledge': 'Освіта'
  };

  const topicCategories = topicDetails.topicCategories || [];
  for (const topicUrl of topicCategories) {
    for (const [key, label] of Object.entries(categoriesMap)) {
      if (topicUrl.includes(key)) {
        return label;
      }
    }
  }

  return 'Розваги'; // Категория по умолчанию
}
