require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const axios    = require('axios');
const { Pool } = require('pg');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ══ КОНФИГ ════════════════════════════════════════════════════
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const BOT_TOKEN      = process.env.BOT_TOKEN;
const BOT_API        = 'https://platform-api.max.ru';
const BOT_NICK       = process.env.BOT_NICK || 'id770702125100_bot';
const IMAGE_TOKEN    = 'xrypqisDoIjF2rXfnTP6mAJVUX+aL5U3YM3x1KnwIytZVlGSdFpOH3HGOEbRDI08pyZ4RPR/0KbZj3XRrwCWVZ7XJXX8uEBBBHO8aKgGKnn7CIaEE0UROI7SyaB2CnLzZCG97+7EGHFiw9tRM7Nzk/HTRqvxc//P';

// ══ POSTGRESQL ════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id     BIGINT PRIMARY KEY,
      name        TEXT,
      username    TEXT,
      source      TEXT DEFAULT 'direct',
      first_seen  TIMESTAMP DEFAULT NOW(),
      last_seen   TIMESTAMP DEFAULT NOW(),
      scan_count  INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scans (
      id         SERIAL PRIMARY KEY,
      user_id    BIGINT,
      mode       TEXT,
      result     TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('БД инициализирована');
}

async function upsertUser(userId, name, username, source) {
  await pool.query(`
    INSERT INTO users (user_id, name, username, source)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id) DO UPDATE SET
      last_seen = NOW(),
      name      = COALESCE($2, users.name),
      username  = COALESCE($3, users.username)
  `, [userId, name, username, source]);
}

async function incrementScans(userId) {
  await pool.query(`
    UPDATE users SET scan_count = scan_count + 1, last_seen = NOW()
    WHERE user_id = $1
  `, [userId]);
}

async function insertScan(userId, mode, result) {
  await pool.query(`
    INSERT INTO scans (user_id, mode, result) VALUES ($1, $2, $3)
  `, [userId, mode, result]);
}

// ══ BOT HELPERS ════════════════════════════════════════════════
async function setupWebhook() {
  if (!BOT_TOKEN) return;
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('WEBHOOK_URL не задан — вебхук не установлен');
    return;
  }
  try {
    await axios.post(
      `${BOT_API}/subscriptions`,
      { url: webhookUrl, update_types: ['bot_started', 'message_created'] },
      { headers: { 'Authorization': BOT_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('Вебхук установлен:', webhookUrl);
  } catch (e) {
    console.error('Ошибка установки вебхука:', e.response?.data || e.message);
  }
}

async function sendWelcome(userId, userName, source) {
  if (!BOT_TOKEN) return;
  const firstName = userName || 'друг';
  const shareText = encodeURIComponent('Попробуй Атлас — определитель растений, грибов, животных и всего живого за секунду! https://max.ru/id770702125100_bot?startapp');
  const text = `${firstName}, добро пожаловать в **Атлас** — личный определитель всего живого и не только. Сфотографируйте растение, гриб, животное, камень или вообще что угодно и узнайте, что это за секунду.\n\n📌 Закрепите **Атлас** в чатах, чтобы он был рядом на даче, в лесу или на прогулке.`;
  try {
    const response = await axios.post(
      `${BOT_API}/messages?user_id=${userId}`,
      {
        text,
        format: 'markdown',
        attachments: [
          {
            type: 'image',
            payload: { token: IMAGE_TOKEN }
          },
          {
            type: 'inline_keyboard',
            payload: {
              buttons: [
                [{
                  type: 'link',
                  text: '📖 Открыть Атлас',
                  url: `https://max.ru/${BOT_NICK}?startapp`
                }],
                [{
                  type: 'link',
                  text: '👥 Поделись с друзьями в чатах',
                  url: `https://max.ru/:share?text=${shareText}`
                }]
              ]
            }
          }
        ]
      },
      { headers: { 'Authorization': BOT_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('Приветствие отправлено:', response.data?.message?.body?.mid);
  } catch (e) {
    console.error('Ошибка отправки приветствия:', e.response?.data || e.message);
  }
}

// ══ WEBHOOK HANDLER ════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.status(200).json({ ok: true });

  const update = req.body;
  console.log('WEBHOOK UPDATE:', JSON.stringify(update, null, 2));
  if (!update) return;

  if (update.update_type === 'bot_started') {
    const userId   = update.user_id;
    const userObj  = update.user || {};
    const name     = userObj.name || userObj.first_name || null;
    const username = userObj.username || null;
    const source   = update.payload || 'direct';

    console.log('bot_started userId:', userId, 'name:', name);

    if (userId) {
      try { await upsertUser(userId, name, username, source); }
      catch (e) { console.error('DB upsert error:', e.message); }
      await sendWelcome(userId, name, source);
    }
  }
});

// ══ ANALYTICS API ══════════════════════════════════════════════
function adminAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next();
  if (req.headers['x-admin-secret'] === secret) return next();
  res.status(403).json({ error: 'Forbidden' });
}

app.get('/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers   = await pool.query('SELECT COUNT(*) as count FROM users');
    const activeToday  = await pool.query(`SELECT COUNT(*) as count FROM users WHERE last_seen >= NOW() - INTERVAL '1 day'`);
    const activeWeek   = await pool.query(`SELECT COUNT(*) as count FROM users WHERE last_seen >= NOW() - INTERVAL '7 days'`);
    const totalScans   = await pool.query('SELECT COUNT(*) as count FROM scans');
    const scansToday   = await pool.query(`SELECT COUNT(*) as count FROM scans WHERE created_at >= NOW() - INTERVAL '1 day'`);
    const topModes     = await pool.query(`SELECT mode, COUNT(*) as count FROM scans GROUP BY mode ORDER BY count DESC`);
    const topSources   = await pool.query(`SELECT source, COUNT(*) as count FROM users GROUP BY source ORDER BY count DESC`);
    const newUsersWeek = await pool.query(`SELECT DATE(first_seen) as day, COUNT(*) as count FROM users WHERE first_seen >= NOW() - INTERVAL '7 days' GROUP BY day ORDER BY day`);

    res.json({
      users: {
        total:        parseInt(totalUsers.rows[0].count),
        active_today: parseInt(activeToday.rows[0].count),
        active_week:  parseInt(activeWeek.rows[0].count),
      },
      scans: {
        total:    parseInt(totalScans.rows[0].count),
        today:    parseInt(scansToday.rows[0].count),
        by_mode:  topModes.rows,
      },
      sources:          topSources.rows,
      new_users_by_day: newUsersWeek.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/users', adminAuth, async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const users  = await pool.query('SELECT * FROM users ORDER BY last_seen DESC LIMIT $1 OFFSET $2', [limit, offset]);
    const total  = await pool.query('SELECT COUNT(*) as count FROM users');
    res.json({ total: parseInt(total.rows[0].count), users: users.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══ PROMPTS ════════════════════════════════════════════════════
const PROMPTS = {

  plant: `Ты эксперт-ботаник. Посмотри на фото.
Если на фото НЕ растение (например животное, предмет, еда, человек) — определи что это и ответь в JSON:
{"wrong_category":"На фото не растение — это [что именно]. Выбери подходящую категорию на главном экране.","name":"[что на фото]","description":"Краткое описание что изображено на фото.","signs":["факт 1","факт 2"]}
Если растение — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","type":"дерево"|"кустарник"|"трава"|"цветок"|"другое","safe":true|false,"confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","warning":"предупреждение или null","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  mushroom: `Ты эксперт-миколог. Посмотри на фото.
Если на фото НЕ гриб — определи что это и ответь в JSON:
{"wrong_category":"На фото не гриб — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если гриб — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","edible":"съедобный"|"условно съедобный"|"несъедобный"|"ядовитый"|"смертельно ядовитый","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","warning":"предупреждение или null","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  tree: `Ты эксперт-дендролог. Посмотри на фото.
Если на фото НЕ дерево или кустарник — определи что это и ответь в JSON:
{"wrong_category":"На фото не дерево — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если дерево — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","type":"дерево"|"кустарник"|"хвойное"|"лиственное"|"плодовое","safe":true|false,"confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","warning":"если ядовито или null","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  berry: `Ты эксперт-ботаник. Посмотри на фото.
Если на фото НЕ ягода — определи что это и ответь в JSON:
{"wrong_category":"На фото не ягода — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если ягода — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","edible":"съедобная"|"условно съедобная"|"несъедобная"|"ядовитая"|"смертельно ядовитая","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","warning":"если ядовита или null","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  weed: `Ты эксперт-агроном. Посмотри на фото.
Если на фото НЕ сорное растение — определи что это и ответь в JSON:
{"wrong_category":"На фото не сорняк — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если сорняк — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","danger":"низкая"|"средняя"|"высокая","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","removal":"Как избавиться","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  disease: `Ты эксперт-фитопатолог. Посмотри на фото.
Если на фото НЕ больное растение — определи что это и ответь в JSON:
{"wrong_category":"На фото не болезнь растения — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если болезнь — ответь в JSON:
{"name":"Название болезни","type":"болезнь"|"вредитель"|"дефицит питания"|"другое","severity":"лёгкая"|"средняя"|"тяжёлая","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","treatment":"Как лечить","signs":["симптом 1","симптом 2","симптом 3"]}
Отвечай ТОЛЬКО JSON.`,

  seed: `Ты эксперт-ботаник. Посмотри на фото.
Если на фото НЕ семена — определи что это и ответь в JSON:
{"wrong_category":"На фото не семена — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если семена — ответь в JSON:
{"name":"Название растения","latin":"Латинское название","type":"овощ"|"цветок"|"трава"|"дерево"|"другое","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения: когда сеять, особенности","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  vegetable: `Ты эксперт-кулинар. Посмотри на фото.
Если на фото НЕ овощ — определи что это и ответь в JSON:
{"wrong_category":"На фото не овощ — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если овощ — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","usage":"Как использовать в кулинарии","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  fruit: `Ты эксперт-кулинар и ботаник. Посмотри на фото.
Если на фото НЕ фрукт — определи что это и ответь в JSON:
{"wrong_category":"На фото не фрукт — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если фрукт — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","usage":"Как использовать","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  bird: `Ты эксперт-орнитолог. Посмотри на фото.
Если на фото НЕ птица — определи что это и ответь в JSON:
{"wrong_category":"На фото не птица — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если птица — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  insect: `Ты эксперт-энтомолог. Посмотри на фото.
Если на фото НЕ насекомое — определи что это и ответь в JSON:
{"wrong_category":"На фото не насекомое — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если насекомое — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","dangerous":true|false,"confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","warning":"если опасно или null","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  animal: `Ты эксперт-зоолог. Посмотри на фото.
Если на фото НЕ животное — определи что это и ответь в JSON:
{"wrong_category":"На фото не животное — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если животное — ответь в JSON:
{"name":"Название на русском","latin":"Латинское название","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","warning":"если опасно или null","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  track: `Ты эксперт-следопыт. Посмотри на фото.
Если на фото НЕ следы животного — определи что это и ответь в JSON:
{"wrong_category":"На фото не следы — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если следы — ответь в JSON:
{"name":"Название животного","latin":"Латинское название","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","warning":"если опасно или null","signs":["признак следа 1","признак следа 2","признак следа 3"]}
Отвечай ТОЛЬКО JSON.`,

  rock: `Ты эксперт-геолог. Посмотри на фото.
Если на фото НЕ камень или минерал — определи что это и ответь в JSON:
{"wrong_category":"На фото не камень — это [что именно]. Выбери подходящую категорию.","name":"[что на фото]","description":"Краткое описание.","signs":["факт 1","факт 2"]}
Если камень — ответь в JSON:
{"name":"Название на русском","latin":"Научное название","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения","signs":["признак 1","признак 2","признак 3"]}
Отвечай ТОЛЬКО JSON.`,

  mystery: `Ты универсальный эксперт. Определи что на фото и ответь в JSON:
{"name":"Что это — название на русском","category":"растение"|"гриб"|"ягода"|"дерево"|"сорняк"|"болезнь"|"семена"|"овощ"|"фрукт"|"птица"|"насекомое"|"животное"|"следы"|"камень"|"другое","confidence":"высокая"|"средняя"|"низкая","description":"2-3 предложения: что это такое и основные факты","suggestion":"Если это входит в одну из категорий приложения — предложи выбрать нужную категорию для подробного анализа. Иначе null.","signs":["факт 1","факт 2","факт 3"]}
Отвечай ТОЛЬКО JSON.`

};

function extractJSON(text) {
  const clean = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(clean);
}

// ══ SCAN ENDPOINT ══════════════════════════════════════════════
app.get('/', (req, res) => res.json({ status: 'ok', service: 'atlas-backend', ai: 'gemini-2.5-flash' }));

app.post('/scan', upload.single('photo'), async (req, res) => {
  try {
    let imageBase64, mediaType;
    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64');
      mediaType   = req.file.mimetype || 'image/jpeg';
    } else if (req.body.base64) {
      const raw = req.body.base64;
      const m   = raw.match(/^data:(image\/\w+);base64,(.+)$/);
      if (m) { mediaType = m[1]; imageBase64 = m[2]; }
      else   { imageBase64 = raw; mediaType = 'image/jpeg'; }
    } else {
      return res.status(400).json({ error: 'Нет изображения' });
    }

    const mode   = req.body.mode || 'plant';
    const userId = req.body.user_id ? parseInt(req.body.user_id) : null;
    const prompt = PROMPTS[mode];
    if (!prompt) return res.status(400).json({ error: 'Неизвестный режим: ' + mode });

    const response = await axios.post(
      GEMINI_URL,
      {
        contents: [{ parts: [
          { inline_data: { mime_type: mediaType, data: imageBase64 } },
          { text: prompt }
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1000 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let result;
    try { result = extractJSON(rawText); }
    catch (e) {
      console.error('JSON parse error:', rawText);
      return res.status(422).json({ error: 'Не удалось обработать ответ. Попробуй ещё раз.' });
    }

    if (result.error) return res.status(422).json({ error: result.error });

    if (userId) {
      try {
        await insertScan(userId, mode, result.name || '');
        await incrementScans(userId);
      } catch (e) {
        console.error('DB scan save error:', e.message);
      }
    }

    res.json({ mode, result });

  } catch (err) {
    console.error('scan error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Ошибка сервера. Попробуй позже.' });
  }
});

// ══ ЗАПУСК ════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Atlas Backend running on port ${PORT}`);
  await initDB();
  await setupWebhook();
});
