# BILETIKS - Платформа продажи билетов

Платформа для продажи билетов на мероприятия с Telegram-ботом для уведомлений.

## Возможности

- Публичный сайт для просмотра мероприятий и покупки билетов
- Админ-панель для управления мероприятиями и заказами
- Генератор уникальных ссылок на мероприятия
- Telegram-бот для уведомлений администратора
- PostgreSQL база данных

## Технологии

- **Фреймворк**: Mastra (TypeScript)
- **База данных**: PostgreSQL
- **AI**: OpenAI GPT via Vercel AI SDK
- **Уведомления**: Telegram Bot API
- **Workflows**: Inngest

## Быстрый старт

### 1. Клонируйте репозиторий

```bash
git clone https://github.com/your-username/biletiks.git
cd biletiks
```

### 2. Установите зависимости

```bash
npm install
```

### 3. Создайте файл .env

```bash
cp .env.example .env
```

Отредактируйте `.env` и укажите свои значения:

```env
# Обязательные переменные
DATABASE_URL=postgresql://user:password@localhost:5432/biletiks
TELEGRAM_BOT_TOKEN=ваш-токен-бота
ADMIN_TELEGRAM_ID=ваш-telegram-id
ADMIN_PASSWORD=пароль-админки
APP_URL=https://ваш-домен.com

# Опциональные
OPENAI_API_KEY=sk-ваш-ключ
TELEGRAM_GROUP_ID=id-группы-если-нужно
```

### 4. Запустите локально

Для разработки (с автоперезагрузкой):
```bash
npm run dev
```

Для продакшн-режима:
```bash
npm run build
npm run start
```

Сервер запустится на http://localhost:5000

## Переменные окружения

| Переменная | Описание | Обязательно |
|------------|----------|-------------|
| `DATABASE_URL` | Строка подключения PostgreSQL | Да |
| `PORT` | Порт сервера (по умолчанию 5000) | Нет |
| `APP_URL` | Публичный URL для webhook | Да |
| `TELEGRAM_BOT_TOKEN` | Токен бота от @BotFather | Да |
| `ADMIN_TELEGRAM_ID` | ID админа (узнать через @userinfobot) | Да |
| `TELEGRAM_GROUP_ID` | ID группы для уведомлений | Нет |
| `ADMIN_PASSWORD` | Пароль админ-панели | Да |
| `OPENAI_API_KEY` | Ключ OpenAI API | Нет |

## Деплой

### Railway

1. Создайте проект на [railway.app](https://railway.app)
2. Подключите GitHub репозиторий
3. Добавьте PostgreSQL: New → Database → PostgreSQL
4. Настройте переменные окружения (Settings → Variables):
   - `TELEGRAM_BOT_TOKEN`
   - `ADMIN_TELEGRAM_ID`
   - `ADMIN_PASSWORD`
   - `APP_URL` = ваш Railway домен (например `https://biletiks-production.up.railway.app`)
5. Deploy автоматически запустится

**Команды Railway:**
- Build: `npm install && npm run build`
- Start: `npm start`

### Render

1. Создайте Web Service на [render.com](https://render.com)
2. Подключите GitHub репозиторий
3. Настройки:
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
4. Добавьте PostgreSQL через Dashboard
5. Настройте Environment Variables

### Fly.io

1. Установите flyctl: `curl -L https://fly.io/install.sh | sh`
2. Авторизуйтесь: `fly auth login`
3. Создайте приложение:

```bash
fly launch
```

4. Создайте PostgreSQL:

```bash
fly postgres create
fly postgres attach --app your-app-name your-postgres-name
```

5. Установите секреты:

```bash
fly secrets set TELEGRAM_BOT_TOKEN=ваш-токен
fly secrets set ADMIN_TELEGRAM_ID=ваш-id
fly secrets set ADMIN_PASSWORD=ваш-пароль
fly secrets set APP_URL=https://your-app.fly.dev
```

6. Деплой:

```bash
fly deploy
```

### Heroku

1. Создайте приложение на [heroku.com](https://heroku.com)
2. Добавьте Heroku Postgres
3. Подключите GitHub или используйте Heroku CLI:

```bash
heroku login
heroku create your-app-name
heroku addons:create heroku-postgresql:essential-0
heroku config:set TELEGRAM_BOT_TOKEN=ваш-токен
heroku config:set ADMIN_TELEGRAM_ID=ваш-id
heroku config:set ADMIN_PASSWORD=ваш-пароль
heroku config:set APP_URL=https://your-app.herokuapp.com
git push heroku main
```

## Структура проекта

```
src/
├── mastra/
│   ├── agents/         # AI агенты
│   ├── inngest/        # Конфигурация Inngest
│   ├── public/         # Статические файлы (HTML, CSS)
│   ├── services/       # Бизнес-логика (Telegram и др.)
│   ├── tools/          # Инструменты агентов
│   ├── workflows/      # Mastra workflows
│   └── index.ts        # Главный файл конфигурации
└── triggers/           # Webhook триггеры (Telegram)
```

## Настройка Telegram бота

1. Создайте бота через [@BotFather](https://t.me/botfather):
   - Отправьте `/newbot`
   - Следуйте инструкциям
   - Скопируйте токен

2. Узнайте свой Telegram ID:
   - Напишите боту [@userinfobot](https://t.me/userinfobot)
   - Он покажет ваш ID

3. (Опционально) Для групповых уведомлений:
   - Добавьте бота в группу
   - Сделайте его администратором
   - Узнайте ID группы через API

## API Endpoints

- `GET /` - Главная страница
- `GET /show/:id/:lid` - Страница мероприятия
- `GET /generator` - Генератор ссылок
- `GET /admin-login` - Вход в админку
- `GET /admin-events` - Управление мероприятиями
- `POST /api/create-order` - Создание заказа
- `POST /webhooks/telegram/action` - Telegram webhook
- `GET /health` - Проверка здоровья сервера

## Лицензия

MIT
