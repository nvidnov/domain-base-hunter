# Domain Scout

Веб-приложение для поиска, фильтрации и проверки доменов из базы данных PostgreSQL. Позволяет находить истёкшие/освободившиеся домены по множеству критериев и проверять их репутацию через внешние сервисы.

## Возможности

- **Поиск по базе доменов** — фильтрация по TLD, возрасту, дате регистрации, началу/окончанию имени
- **Чекбокс «Только .com»** — быстрая выборка только `.com` доменов
- **Диапазон возраста** — указать минимальный и максимальный возраст домена (в годах)
- **Диапазон дат регистрации** — выборка по дате создания (от / до)
- **Поиск по ключевым словам** — домен начинается на… / заканчивается на…
- **Проверка Spamhaus** — по нажатию кнопки «Проверить» для каждого домена отправляется запрос в Spamhaus Intelligence API (показывает OK / LISTED)
- **Проверка Wayback Machine** — количество снапшотов в Internet Archive (чем больше — тем активнее был домен)
- **Пагинация** — настраиваемый лимит (25 / 50 / 100 / 200 / 500 на страницу)
- **Динамическое определение схемы** — сервер автоматически адаптируется к колонкам вашей таблицы

## Технологии

| Компонент | Технология |
|-----------|-----------|
| Фронтенд | Vue 3 (Composition API, `<script setup>`), Vite |
| Бэкенд | Node.js, Express 5 |
| База данных | PostgreSQL (через `pg`) |
| Внешние API | Spamhaus Intelligence API, Wayback Machine CDX / Availability API |

## Структура проекта

```
domains-db-app/
├── client/                  # Фронтенд (Vue 3 + Vite)
│   ├── src/
│   │   ├── App.vue          # Главный компонент
│   │   ├── components/
│   │   │   ├── SearchForm.vue    # Форма фильтров
│   │   │   └── ResultsTable.vue  # Таблица результатов
│   │   ├── api/
│   │   │   └── domains.js   # API-клиент
│   │   ├── main.js
│   │   └── style.css
│   ├── package.json
│   └── vite.config.js
├── server/                  # Бэкенд (Express)
│   ├── index.js             # API-сервер (маршруты, БД, внешние проверки)
│   ├── .env                 # Переменные окружения (не в git)
│   ├── .env.example         # Шаблон переменных окружения
│   └── package.json
├── package.json             # Корневой (concurrently для запуска)
├── .gitignore
└── README.md
```

## Установка

### Требования

- **Node.js** >= 18
- **PostgreSQL** с таблицей доменов (например, `expired_domains`)

### 1. Клонировать репозиторий

```bash
git clone <repo-url>
cd domains-db-app
```

### 2. Установить зависимости

```bash
npm run install:all
```

Эта команда установит зависимости для корня, `server/` и `client/`.

### 3. Настроить переменные окружения

```bash
cp server/.env.example server/.env
```

Отредактируйте `server/.env`:

```env
# Порт API-сервера
PORT=3010

# Подключение к PostgreSQL
DB_URL=postgresql://postgres:postgres@localhost:5432/domains
DB_POOL_SIZE=10

# Таблица с доменами (схема.таблица или просто имя таблицы)
DOMAINS_TABLE=expired_domains

# Spamhaus Intelligence API (опционально, для проверки репутации)
# SPAMHAUS_INTEL_API_KEY=your_api_key_here
# SPAMHAUS_INTEL_BASE_URL=https://api.spamhaus.com
```

### 4. Запустить

```bash
npm run dev
```

Запускает **сервер** (порт 3010) и **клиент** (порт 5173) одновременно.

Откройте в браузере: **http://localhost:5173**

## API-эндпоинты

| Метод | URL | Описание |
|-------|-----|----------|
| `GET` | `/api/capabilities` | Доступные колонки и поддерживаемые фильтры |
| `POST` | `/api/domains/search` | Поиск доменов по критериям |
| `POST` | `/api/domains/check` | Проверка домена (Spamhaus + Wayback Machine) |
| `GET` | `/api/db/tables` | Список таблиц в базе данных |
| `GET` | `/api/db/columns?table=...` | Колонки указанной таблицы |

### Пример запроса поиска

```json
POST /api/domains/search
{
  "criteria": {
    "tld": "com",
    "ageYearsFrom": "3",
    "ageYearsTo": "10",
    "domainStartsWith": "shop"
  },
  "page": 1,
  "pageSize": 50
}
```

### Пример запроса проверки

```json
POST /api/domains/check
{
  "domain": "example.com"
}
```

Ответ:

```json
{
  "domain": "example.com",
  "cached": false,
  "spamhaus": {
    "supported": true,
    "source": "spamhaus_intel",
    "listed": false
  },
  "wayback": {
    "supported": true,
    "hasSnapshots": true,
    "snapshots": 278,
    "lastSnapshot": "2026-02-12",
    "link": "https://web.archive.org/web/*/example.com"
  }
}
```

## Внешние сервисы

### Spamhaus Intelligence API

Проверяет, находится ли домен в чёрных списках Spamhaus.

- **Endpoint:** `GET /api/intel/v2/byobject/domain/{DOMAIN}`
- **Авторизация:** API-ключ (Bearer token)
- **Результат:** OK (не в списках) или LISTED (в чёрном списке)
- Ключ указывается в `SPAMHAUS_INTEL_API_KEY`

### Wayback Machine

Проверяет наличие и количество архивных снапшотов домена в Internet Archive.

- **Availability API:** `https://archive.org/wayback/available` — быстрая проверка наличия
- **CDX API:** `https://web.archive.org/cdx/search/cdx` — подсчёт снапшотов
- **Бесплатный**, ключ не требуется
- Результат кликабелен — ведёт на страницу архива домена

## Скрипты

| Команда | Описание |
|---------|----------|
| `npm run dev` | Запуск сервера и клиента в режиме разработки |
| `npm run start` | Запуск для продакшена (сервер + preview клиента) |
| `npm run build` | Сборка клиента |
| `npm run install:all` | Установка всех зависимостей (корень + server + client) |

## Лицензия

ISC
