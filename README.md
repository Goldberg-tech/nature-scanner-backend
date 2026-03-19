# Nature Scanner Backend

Backend для мини-приложения MAX/Telegram — определение грибов, растений, сорняков и болезней по фото с помощью Claude AI.

## Стек
- Node.js + Express
- Anthropic Claude (claude-sonnet-4) — vision + анализ
- Multer — загрузка фото
- Railway — деплой

## Режимы (`mode`)
| Режим | Описание |
|-------|----------|
| `mushroom` | Определение гриба: название, съедобность, признаки |
| `plant` | Определение растения: название, тип, безопасность |
| `weed` | Определение сорняка: опасность, как избавиться |
| `disease` | Болезни и вредители: симптомы, лечение |

## API

### `POST /scan`
Принимает фото и режим, возвращает результат анализа.

**Параметры (multipart/form-data или JSON):**
- `photo` — файл изображения (или `base64` — строка base64)
- `mode` — режим: `mushroom` | `plant` | `weed` | `disease`

**Ответ:**
```json
{
  "mode": "mushroom",
  "result": {
    "name": "Белый гриб",
    "latin": "Boletus edulis",
    "edible": "съедобный",
    "confidence": "высокая",
    "description": "...",
    "warning": null,
    "signs": ["..."]
  }
}
```

## Запуск

```bash
cp .env.example .env
# Заполни ANTHROPIC_API_KEY в .env
npm install
npm run dev
```

## Деплой на Railway
1. Создай новый проект на railway.app
2. Подключи этот репозиторий
3. Добавь переменную окружения `ANTHROPIC_API_KEY`
4. Railway автоматически запустит `npm start`
