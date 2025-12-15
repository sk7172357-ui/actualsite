# BILETIKS - Ticket Booking Platform

A ticket booking platform built with the Mastra framework. Features event browsing, order management, and Telegram bot notifications for administrators.

## Features

- Public website for browsing events and purchasing tickets
- Admin panel for managing events and orders
- Telegram bot notifications for order updates
- PostgreSQL database for persistent storage
- Inngest for durable workflow execution

## Tech Stack

- **Framework**: Mastra (TypeScript-first AI agent framework)
- **Database**: PostgreSQL
- **AI**: OpenAI GPT models via Vercel AI SDK
- **Messaging**: Telegram Bot API
- **Workflows**: Inngest for durable execution

## Prerequisites

- Node.js 20+
- PostgreSQL database
- OpenAI API key
- Telegram Bot (create via @BotFather)

## Local Development

1. **Clone and install dependencies:**
   ```bash
   git clone https://github.com/your-username/biletiks.git
   cd biletiks
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Set up the database:**
   ```bash
   npm run db:push
   ```

4. **Start the development server:**
   ```bash
   npm run dev
   ```

   The server will start at http://localhost:5000

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| DATABASE_URL | PostgreSQL connection string | Yes |
| PORT | Server port (default: 5000) | No |
| APP_URL | Public URL of the app | Yes (for webhooks) |
| OPENAI_API_KEY | OpenAI API key | Yes |
| OPENAI_BASE_URL | Custom OpenAI endpoint | No |
| TELEGRAM_GROUP_BOT_TOKEN | Telegram bot token | Yes |
| TELEGRAM_ADMIN_CHAT_ID | Admin chat ID for notifications | Yes |
| TELEGRAM_GROUP_ID | Group ID for channel notifications | Yes |
| ADMIN_PASSWORD | Admin panel password | Yes |

## Deployment on Railway

1. **Create a new project on Railway:**
   - Go to [railway.app](https://railway.app)
   - Create a new project from GitHub repo

2. **Add PostgreSQL:**
   - Click "New" -> "Database" -> "PostgreSQL"
   - Railway will automatically set DATABASE_URL

3. **Configure environment variables:**
   - Go to your service settings
   - Add all required environment variables from .env.example
   - Set APP_URL to your Railway domain (e.g., https://your-app.railway.app)

4. **Deploy:**
   - Railway will auto-deploy on push to main branch
   - Build command: `npm install && npm run build`
   - Start command: `npm start`

5. **Set up Telegram webhook:**
   - After deployment, the app will automatically configure the Telegram webhook
   - Verify by sending a test message to your bot

## Project Structure

```
src/
├── mastra/
│   ├── agents/         # AI agents (ticket bot, example)
│   ├── inngest/        # Inngest workflow configuration
│   ├── services/       # Business logic services
│   ├── tools/          # Agent tools
│   ├── workflows/      # Mastra workflows
│   └── index.ts        # Main Mastra configuration
├── triggers/           # Webhook triggers (Telegram)
└── public/             # Static frontend files
```

## API Endpoints

- `GET /` - Main website
- `GET /:city/event/show/:templateId` - Event page with new URL format
- `GET /e/:code` - Event page (legacy format)
- `POST /api/orders` - Create order
- `POST /webhooks/telegram/action` - Telegram webhook
- `GET /generator` - Link generator
- `GET /admin-events` - Admin panel

## License

MIT
