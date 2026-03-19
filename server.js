require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const axios   = require('axios');

const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const YANDEX_API_KEY   = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;

// Правильный endpoint для мультимодальной модели с поддержкой изображений
const YANDEX_VISION_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
const VISION_MODEL      = `gpt://${YANDEX_FOLDER_ID}/yandexgpt-vision/latest`;

// ─── Промпты по режимам ──────────────────────────────────────────────────────
const PROMPTS = {
  mushroom: `Ты эксперт-миколог. Определи гриб на фото и ответь строго в формате JSON:
{
  "name": "Название гриба на русском",
  "latin": "Латинское название",
  "edible": "съедобный" | "условно съедобный" | "несъедобный" | "ядовитый" | "смертельно ядовитый",
  "confidence": "высокая" | "средняя" | "низкая",
  "description": "2-3 предложения: как выглядит, где растёт, особенности",
  "warning": "Предупреждение если гриб опасен, иначе null",
  "signs": ["отличительный признак 1", "отличительный признак 2", "отличительный признак 3"]
}
Если гриб не виден или фото нечёткое — верни {"error": "Гриб не распознан. Сделай более чёткое фото."}.
Отвечай ТОЛЬКО JSON, без лишнего текста.`,

  plant: `Ты эксперт-ботаник. Определи растение на фото и ответь строго в формате JSON:
{
  "name": "Название растения на русском",
  "latin": "Латинское название",
  "type": "дерево" | "кустарник" | "трава" | "цветок" | "овощ" | "фрукт" | "ягода" | "другое",
  "safe": true | false,
  "confidence": "высокая" | "средняя" | "низкая",
  "description": "2-3 предложения: как выглядит, где растёт, применение",
  "warning": "Предупреждение если растение ядовито или опасно, иначе null",
  "signs": ["отличительный признак 1", "отличительный признак 2", "отличительный признак 3"]
}
Если растение не видно или фото нечёткое — верни {"error": "Растение не распознано. Сделай более чёткое фото."}.
Отвечай ТОЛЬКО JSON, без лишнего текста.`,

  weed: `Ты эксперт-агроном. Определи сорняк на фото и ответь строго в формате JSON:
{
  "name": "Название сорняка на русском",
  "latin": "Латинское название",
  "danger": "низкая" | "средняя" | "высокая",
  "confidence": "высокая" | "средняя" | "низкая",
  "description": "2-3 предложения: как выглядит, почему вреден для огорода",
  "removal": "Как эффективно избавиться — 1-2 предложения",
  "signs": ["отличительный признак 1", "отличительный признак 2", "отличительный признак 3"]
}
Если сорняк не виден или фото нечёткое — верни {"error": "Сорняк не распознан. Сделай более чёткое фото."}.
Отвечай ТОЛЬКО JSON, без лишнего текста.`,

  disease: `Ты эксперт-фитопатолог. Определи болезнь или вредителя на растении по фото и ответь строго в формате JSON:
{
  "name": "Название болезни или вредителя на русском",
  "type": "болезнь" | "вредитель" | "дефицит питания" | "другое",
  "severity": "лёгкая" | "средняя" | "тяжёлая",
  "confidence": "высокая" | "средняя" | "низкая",
  "description": "2-3 предложения: симптомы, причины, как распространяется",
  "treatment": "Как лечить — 1-2 предложения с конкретными действиями",
  "signs": ["симптом 1", "симптом 2", "симптом 3"]
}
Если болезнь не видна или фото нечёткое — верни {"error": "Болезнь не распознана. Сделай более чёткое фото поражённого участка."}.
Отвечай ТОЛЬКО JSON, без лишнего текста.`
};

// ─── Хелпер: вытащить JSON из ответа ────────────────────────────────────────
function extractJSON(text) {
  const clean = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(clean);
}

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nature-scanner-backend', ai: 'yandexgpt-vision' });
});

// ─── Основной роут: распознавание по фото ───────────────────────────────────
app.post('/scan', upload.single('photo'), async (req, res) => {
  try {
    let imageBase64, mediaType;
    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64');
      mediaType   = req.file.mimetype || 'image/jpeg';
    } else if (req.body.base64) {
      const raw   = req.body.base64;
      const match = raw.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        mediaType   = match[1];
        imageBase64 = match[2];
      } else {
        imageBase64 = raw;
        mediaType   = 'image/jpeg';
      }
    } else {
      return res.status(400).json({ error: 'Нет изображения' });
    }

    const mode   = req.body.mode || 'mushroom';
    const prompt = PROMPTS[mode];
    if (!prompt) {
      return res.status(400).json({ error: 'Неизвестный режим: ' + mode });
    }

    // Запрос к YandexGPT Vision — мультимодальный формат с изображением
    const response = await axios.post(
      YANDEX_VISION_URL,
      {
        modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt-vision/latest`,
        completionOptions: {
          stream: false,
          temperature: 0.1,
          maxTokens: '1000'
        },
        messages: [
          {
            role: 'system',
            text: prompt
          },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mediaType};base64,${imageBase64}`
                }
              },
              {
                type: 'text',
                text: 'Определи что на фото согласно инструкции и верни только JSON.'
              }
            ]
          }
        ]
      },
      {
        headers: {
          'Authorization': `Api-Key ${YANDEX_API_KEY}`,
          'x-folder-id':   YANDEX_FOLDER_ID,
          'Content-Type':  'application/json'
        },
        timeout: 30000
      }
    );

    const rawText = response.data?.result?.alternatives?.[0]?.message?.text || '';

    let result;
    try {
      result = extractJSON(rawText);
    } catch (e) {
      console.error('JSON parse error:', rawText);
      return res.status(422).json({ error: 'Не удалось обработать ответ. Попробуй ещё раз.' });
    }

    if (result.error) {
      return res.status(422).json({ error: result.error });
    }

    res.json({ mode, result });

  } catch (err) {
    console.error('scan error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Ошибка сервера. Попробуй позже.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nature Scanner backend running on port ${PORT} (YandexGPT Vision)`));
