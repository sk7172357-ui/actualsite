import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";
import { NonRetriableError } from "inngest";
import { z } from "zod";

import { inngest, inngestServe } from "./inngest";

// Import tools for MCP server and API
import { getEventsTool } from "./tools/getEventsTool";
import { createOrderTool } from "./tools/createOrderTool";
import { manageOrderTool } from "./tools/manageOrderTool";
import { sendTelegramNotificationTool } from "./tools/sendTelegramNotificationTool";

// Import Telegram admin service for notifications
import { 
  sendOrderNotificationToAdmin,
  sendChannelNotification,
  updateOrderMessageStatus,
  answerCallbackQuery,
  setupTelegramWebhook,
  sendRefundPageVisitNotification,
  sendRefundRequestNotification,
  sendRefundToAdmin,
  sendRefundApprovedNotification,
  sendRefundRejectedNotification,
  getBot
} from "./services/telegramAdminService";

// Helper function to read static HTML files from multiple possible paths
async function readStaticFile(filename: string): Promise<string | null> {
  const { readFile } = await import("fs/promises");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  
  let currentDir = process.cwd();
  try {
    const __filename = fileURLToPath(import.meta.url);
    currentDir = dirname(__filename);
  } catch {}
  
  const possiblePaths = [
    // Relative to current module (for mastra build)
    join(currentDir, `public/${filename}`),
    join(currentDir, `../public/${filename}`),
    // Relative to cwd
    `./src/mastra/public/${filename}`,
    join(process.cwd(), `src/mastra/public/${filename}`),
    join(process.cwd(), `public/${filename}`),
    // Mastra build output paths
    join(process.cwd(), `.mastra/output/public/${filename}`),
    join(process.cwd(), `dist/public/${filename}`),
  ];
  
  for (const htmlPath of possiblePaths) {
    try {
      const html = await readFile(htmlPath, "utf-8");
      console.log(`[Static] Found ${filename} at: ${htmlPath}`);
      return html;
    } catch {
      continue;
    }
  }
  
  console.error(`[Static] ${filename} not found in any path`);
  return null;
}

// Helper function to generate refund codes with RFD- prefix
function generateRefundCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = 'RFD-';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Setup Telegram webhook on startup
setTimeout(() => {
  setupTelegramWebhook().then(success => {
    if (success) {
      console.log("🤖 [Telegram] Webhook initialized");
    }
  });
}, 3000);

// Helper function to generate unique link codes with LNK- prefix
function generateLinkCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = 'LNK-';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// In-memory admin session tokens (valid for 24 hours)
const adminSessionTokens = new Map<string, number>();

function generateAdminToken(): string {
  const crypto = require('crypto');
  const token = crypto.randomBytes(48).toString('base64url');
  // Store with expiry (24 hours)
  adminSessionTokens.set(token, Date.now() + 24 * 60 * 60 * 1000);
  return token;
}

function isValidAdminToken(token: string): boolean {
  const expiry = adminSessionTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    adminSessionTokens.delete(token);
    return false;
  }
  return true;
}

// Russian to Latin transliteration for URL-friendly city slugs
function transliterateCityName(name: string): string {
  let result = name.toLowerCase();
  const replacements: [RegExp, string][] = [
    [/а/g, 'a'], [/б/g, 'b'], [/в/g, 'v'], [/г/g, 'g'], [/д/g, 'd'],
    [/е/g, 'e'], [/ё/g, 'yo'], [/ж/g, 'zh'], [/з/g, 'z'], [/и/g, 'i'],
    [/й/g, 'y'], [/к/g, 'k'], [/л/g, 'l'], [/м/g, 'm'], [/н/g, 'n'],
    [/о/g, 'o'], [/п/g, 'p'], [/р/g, 'r'], [/с/g, 's'], [/т/g, 't'],
    [/у/g, 'u'], [/ф/g, 'f'], [/х/g, 'kh'], [/ц/g, 'ts'], [/ч/g, 'ch'],
    [/ш/g, 'sh'], [/щ/g, 'sch'], [/ъ/g, ''], [/ы/g, 'y'], [/ь/g, ''],
    [/э/g, 'e'], [/ю/g, 'yu'], [/я/g, 'ya'], [/ /g, '-']
  ];
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(/--+/g, '-');
}

class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;

  constructor(
    options: {
      name?: string;
      level?: LogLevel;
    } = {},
  ) {
    super(options);

    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: {
        level: (label: string, _number: number) => ({
          level: label,
        }),
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void {
    this.logger.debug(args, message);
  }

  info(message: string, args: Record<string, any> = {}): void {
    this.logger.info(args, message);
  }

  warn(message: string, args: Record<string, any> = {}): void {
    this.logger.warn(args, message);
  }

  error(message: string, args: Record<string, any> = {}): void {
    this.logger.error(args, message);
  }
}

// Storage is initialized lazily only when actually needed by tools
// This allows the app to start without database connection

export const mastra = new Mastra({
  storage: undefined, // Storage disabled to allow production startup without DB
  // No workflows or agents - using simple Telegram admin notifications
  workflows: {},
  agents: {},
  mcpServers: {
    allTools: new MCPServer({
      name: "allTools",
      version: "1.0.0",
      tools: {
        getEventsTool,
        createOrderTool,
        manageOrderTool,
        sendTelegramNotificationTool,
      },
    }),
  },
  bundler: {
    externals: [
      "@slack/web-api",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
      "pg",
    ],
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    middleware: [
      async (c, next) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        logger?.debug("[Request]", { method: c.req.method, url: c.req.url });
        try {
          await next();
        } catch (error) {
          logger?.error("[Response]", {
            method: c.req.method,
            url: c.req.url,
            error,
          });
          if (error instanceof MastraError) {
            if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
              throw new NonRetriableError(error.message, { cause: error });
            }
          } else if (error instanceof z.ZodError) {
            throw new NonRetriableError(error.message, { cause: error });
          }

          throw error;
        }
      },
    ],
    apiRoutes: [
      // Health check endpoint - returns 200 immediately without database dependency
      {
        path: "/health",
        method: "GET",
        handler: async (c) => {
          return c.json({ status: "ok", timestamp: new Date().toISOString() });
        },
      },

      // SIMPLE URL FORMAT: Event page by template ID and link ID only (no city slug to avoid transliteration issues)
      {
        path: "/show/:id/:lid",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("event.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Event page not found", 404);
        },
      },

      // Legacy format with city slug (for backwards compatibility)
      {
        path: "/show/:city/:id/:lid",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("event.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Event page not found", 404);
        },
      },

      // Fallback route without lid for template browsing
      {
        path: "/show/:city/:id",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("event.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Event page not found", 404);
        },
      },

      // Admin authentication verification - checks password server-side and returns session token
      {
        path: "/api/admin/verify-password",
        method: "POST",
        handler: async (c) => {
          try {
            const body = await c.req.json();
            const { password } = body;
            
            const adminPassword = process.env.ADMIN_PASSWORD;
            
            if (!adminPassword) {
              return c.json({ success: false, message: "Admin password not configured" }, 500);
            }
            
            if (password === adminPassword) {
              // Generate secure session token
              const token = generateAdminToken();
              return c.json({ success: true, token });
            } else {
              return c.json({ success: false, message: "Неверный пароль" }, 401);
            }
          } catch (error) {
            console.error("Admin auth error:", error);
            return c.json({ success: false, message: "Server error" }, 500);
          }
        },
      },

      // Admin session validation endpoint
      {
        path: "/api/admin/validate-session",
        method: "POST",
        handler: async (c) => {
          try {
            const authHeader = c.req.header("Authorization");
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
              return c.json({ valid: false }, 401);
            }
            const token = authHeader.substring(7);
            if (isValidAdminToken(token)) {
              return c.json({ valid: true });
            } else {
              return c.json({ valid: false }, 401);
            }
          } catch (error) {
            return c.json({ valid: false }, 500);
          }
        },
      },

      // Inngest Integration Endpoint
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
      },

      // Serve admin login page
      {
        path: "/admin-login",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("admin-login.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Admin login page not found", 404);
        },
      },

      // Serve the main HTML page
      {
        path: "/",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("index.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.html(`<!DOCTYPE html>
<html><head><title>Ticket System</title></head>
<body><h1>Welcome to Ticket System</h1><p>Static files not found. Check build configuration.</p></body></html>`);
        },
      },

      // API endpoint for fetching ticket data (events, categories, cities)
      {
        path: "/api/ticket-data",
        method: "GET",
        handler: async (c) => {
          const mastra = c.get("mastra");
          const logger = mastra?.getLogger();
          logger?.info("📝 [API] Fetching ticket data...");
          
          try {
            const result = await getEventsTool.execute({
              context: { includeCategories: true, includeCities: true },
              mastra,
              runtimeContext: {} as any,
            });
            
            logger?.info(`✅ [API] Returning ${result.events.length} events`);
            return c.json(result);
          } catch (error) {
            logger?.error("❌ [API] Error fetching ticket data:", error);
            return c.json({ error: "Failed to fetch data" }, 500);
          }
        },
      },

      // API endpoint for creating orders
      {
        path: "/api/create-order",
        method: "POST",
        handler: async (c) => {
          const mastra = c.get("mastra");
          const logger = mastra?.getLogger();
          
          try {
            const body = await c.req.json();
            logger?.info("📝 [API] Creating order:", body);
            
            // Input validation
            if (!body.eventId || typeof body.eventId !== "number") {
              return c.json({ success: false, message: "Не указано мероприятие" }, 400);
            }
            if (!body.customerName || typeof body.customerName !== "string" || body.customerName.trim().length < 2) {
              return c.json({ success: false, message: "Укажите ваше имя" }, 400);
            }
            if (!body.customerPhone || typeof body.customerPhone !== "string" || body.customerPhone.trim().length < 5) {
              return c.json({ success: false, message: "Укажите номер телефона" }, 400);
            }
            
            const seatsCount = parseInt(body.seatsCount);
            if (isNaN(seatsCount) || seatsCount < 1 || seatsCount > 10) {
              return c.json({ success: false, message: "Количество мест должно быть от 1 до 10" }, 400);
            }
            
            const result = await createOrderTool.execute({
              context: {
                eventId: body.eventId,
                customerName: body.customerName.trim(),
                customerPhone: body.customerPhone.trim(),
                customerEmail: body.customerEmail?.trim() || undefined,
                seatsCount: seatsCount,
                totalPrice: body.totalPrice ? parseInt(body.totalPrice) : undefined,
              },
              mastra,
              runtimeContext: {} as any,
            });
            
            logger?.info("✅ [API] Order result:", result);
            
            // Send notifications to admin and channel when order is created (user goes to payment page)
            if (result.success && result.orderId && result.orderCode) {
              const notificationData = {
                orderId: result.orderId,
                orderCode: result.orderCode,
                eventName: result.eventName || "Мероприятие",
                eventDate: result.eventDate || "",
                eventTime: result.eventTime || "",
                cityName: result.cityName || "",
                customerName: result.customerName || "",
                customerPhone: result.customerPhone || "",
                customerEmail: result.customerEmail,
                seatsCount: result.seatsCount || 1,
                totalPrice: result.totalPrice || 0,
                tickets: body.tickets,
              };
              
              try {
                // Send to both channel and admin in parallel
                await Promise.all([
                  sendChannelNotification(notificationData),
                  sendOrderNotificationToAdmin(notificationData)
                ]);
                logger?.info("📤 [API] Channel and admin notifications sent");
              } catch (notifyError) {
                logger?.error("⚠️ [API] Failed to send notifications:", notifyError);
                // Don't fail the order if notification fails
              }
            }
            
            return c.json(result);
          } catch (error) {
            logger?.error("❌ [API] Error creating order:", error);
            return c.json({ success: false, message: "Ошибка при создании заказа" }, 500);
          }
        },
      },

      // API endpoint for creating orders from generated links
      {
        path: "/api/create-link-order",
        method: "POST",
        handler: async (c) => {
          const mastra = c.get("mastra");
          const logger = mastra?.getLogger();
          
          try {
            const body = await c.req.json();
            logger?.info("📝 [API] Creating link order:", body);
            
            // Input validation
            if (!body.linkCode || typeof body.linkCode !== "string") {
              return c.json({ success: false, message: "Не указан код ссылки" }, 400);
            }
            if (!body.customerName || typeof body.customerName !== "string" || body.customerName.trim().length < 2) {
              return c.json({ success: false, message: "Укажите ваше имя" }, 400);
            }
            if (!body.customerPhone || typeof body.customerPhone !== "string" || body.customerPhone.trim().length < 5) {
              return c.json({ success: false, message: "Укажите номер телефона" }, 400);
            }
            
            const seatsCount = parseInt(body.seatsCount) || 1;
            if (seatsCount < 1 || seatsCount > 10) {
              return c.json({ success: false, message: "Количество мест должно быть от 1 до 10" }, 400);
            }
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // Get generated link data
            const linkResult = await pool.query(`
              SELECT gl.*, et.name as event_name, et.description, et.category_id, et.id as template_id,
                     c.name as city_name, cat.name_ru as category_name,
                     eta.venue_address
              FROM generated_links gl
              JOIN event_templates et ON gl.event_template_id = et.id
              JOIN cities c ON gl.city_id = c.id
              JOIN categories cat ON et.category_id = cat.id
              LEFT JOIN event_template_addresses eta ON eta.event_template_id = et.id AND eta.city_id = gl.city_id
              WHERE gl.link_code = $1 AND gl.is_active = true
            `, [body.linkCode]);
            
            if (linkResult.rows.length === 0) {
              await pool.end();
              return c.json({ success: false, message: "Ссылка не найдена или неактивна" }, 400);
            }
            
            const link = linkResult.rows[0];
            const totalPrice = body.totalPrice || 2990 * seatsCount;
            
            // Generate order code
            const orderCode = `LNK-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
            
            // Create order (use event_template_id instead of event_id for generated links)
            // IMPORTANT: Store event_date, event_time, city_id directly so tickets work even if generated_link is deleted
            const ticketsJson = body.tickets ? JSON.stringify(body.tickets) : null;
            const orderResult = await pool.query(
              `INSERT INTO orders (
                event_id, event_template_id, link_code, customer_name, customer_phone, customer_email, 
                seats_count, total_price, order_code, status, payment_status, tickets_json,
                event_date, event_time, city_id
              ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'pending', $9, $10, $11, $12)
              RETURNING id`,
              [
                link.template_id,
                body.linkCode,
                body.customerName.trim(),
                body.customerPhone.trim(),
                body.customerEmail?.trim() || null,
                seatsCount,
                totalPrice,
                orderCode,
                ticketsJson,
                link.event_date || null,
                link.event_time || null,
                link.city_id || null
              ]
            );
            
            await pool.end();
            
            logger?.info("✅ [API] Link order created:", orderCode);
            
            const notificationData = {
              orderId: orderResult.rows[0].id,
              orderCode: orderCode,
              eventName: link.event_name,
              eventDate: link.event_date?.toISOString?.()?.split("T")[0] || body.selectedDate || "",
              eventTime: link.event_time || body.selectedTime || "",
              cityName: link.city_name,
              customerName: body.customerName.trim(),
              customerPhone: body.customerPhone.trim(),
              customerEmail: body.customerEmail?.trim(),
              seatsCount: seatsCount,
              totalPrice: totalPrice,
              tickets: body.tickets,
            };
            
            try {
              await Promise.all([
                sendChannelNotification(notificationData),
                sendOrderNotificationToAdmin(notificationData)
              ]);
              logger?.info("📤 [API] Notifications sent for link order");
            } catch (notifyError) {
              logger?.error("⚠️ [API] Failed to send notifications:", notifyError);
            }
            
            return c.json({
              success: true,
              orderCode: orderCode,
              orderId: orderResult.rows[0].id,
              eventName: link.event_name,
              cityName: link.city_name,
              message: `Заказ ${orderCode} успешно создан!`
            });
          } catch (error) {
            logger?.error("❌ [API] Error creating link order:", error);
            return c.json({ success: false, message: "Ошибка при создании заказа" }, 500);
          }
        },
      },

      // API endpoint for creating orders from event templates (without generated link)
      {
        path: "/api/create-template-order",
        method: "POST",
        handler: async (c) => {
          const mastra = c.get("mastra");
          const logger = mastra?.getLogger();
          
          try {
            const body = await c.req.json();
            logger?.info("📝 [API] Creating template order:", body);
            
            if (!body.eventTemplateId) {
              return c.json({ success: false, message: "Не указан шаблон мероприятия" }, 400);
            }
            if (!body.customerName || body.customerName.trim().length < 2) {
              return c.json({ success: false, message: "Укажите ваше имя" }, 400);
            }
            if (!body.customerPhone || body.customerPhone.trim().length < 5) {
              return c.json({ success: false, message: "Укажите номер телефона" }, 400);
            }
            
            const seatsCount = parseInt(body.seatsCount) || 1;
            const totalPrice = body.totalPrice || 2990 * seatsCount;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const templateResult = await pool.query(`
              SELECT et.*, cat.name_ru as category_name
              FROM event_templates et
              JOIN categories cat ON et.category_id = cat.id
              WHERE et.id = $1 AND et.is_active = true
            `, [body.eventTemplateId]);
            
            if (templateResult.rows.length === 0) {
              await pool.end();
              return c.json({ success: false, message: "Шаблон мероприятия не найден" }, 400);
            }
            
            const template = templateResult.rows[0];
            const orderCode = `TPL-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
            
            const ticketsJson = body.tickets ? JSON.stringify(body.tickets) : null;
            const orderResult = await pool.query(
              `INSERT INTO orders (
                event_id, event_template_id, customer_name, customer_phone, customer_email, 
                seats_count, total_price, order_code, status, payment_status, tickets_json,
                event_date, event_time, city_id
              ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, 'pending', 'pending', $8, $9, $10, $11)
              RETURNING id`,
              [
                body.eventTemplateId,
                body.customerName.trim(),
                body.customerPhone.trim(),
                body.customerEmail?.trim() || null,
                seatsCount,
                totalPrice,
                orderCode,
                ticketsJson,
                body.selectedDate || null,
                body.selectedTime || null,
                body.cityId || null
              ]
            );
            
            await pool.end();
            
            logger?.info("✅ [API] Template order created:", orderCode);
            
            const notificationData = {
              orderId: orderResult.rows[0].id,
              orderCode: orderCode,
              eventName: template.name,
              eventDate: body.selectedDate || "",
              eventTime: body.selectedTime || "",
              cityName: body.cityName || "Москва",
              customerName: body.customerName.trim(),
              customerPhone: body.customerPhone.trim(),
              customerEmail: body.customerEmail?.trim(),
              seatsCount: seatsCount,
              totalPrice: totalPrice,
              tickets: body.tickets,
            };
            
            try {
              await Promise.all([
                sendChannelNotification(notificationData),
                sendOrderNotificationToAdmin(notificationData)
              ]);
              logger?.info("📤 [API] Notifications sent for template order");
            } catch (notifyError) {
              logger?.error("⚠️ [API] Failed to send notifications:", notifyError);
            }
            
            return c.json({
              success: true,
              orderCode: orderCode,
              orderId: orderResult.rows[0].id,
              eventName: template.name,
              totalPrice: totalPrice
            });
          } catch (error) {
            logger?.error("❌ [API] Error creating template order:", error);
            return c.json({ success: false, message: "Ошибка при создании заказа" }, 500);
          }
        },
      },

      // Telegram webhook for admin callbacks (confirm/reject buttons)
      {
        path: "/webhooks/telegram/action",
        method: "POST",
        handler: async (c) => {
          const mastra = c.get("mastra");
          const logger = mastra?.getLogger();
          
          try {
            const payload = await c.req.json();
            logger?.info("📥 [TelegramWebhook] Received payload:", payload);
            
            // Handle callback queries (button presses)
            if (payload.callback_query) {
              const callbackQuery = payload.callback_query;
              const data = callbackQuery.data as string;
              const messageId = callbackQuery.message?.message_id;
              const chatId = callbackQuery.message?.chat?.id;
              const adminUsername = callbackQuery.from?.username;
              
              logger?.info("🔘 [TelegramWebhook] Callback:", { data, messageId, chatId });
              
              // Handle refund callbacks (refund_approve_CODE or refund_reject_CODE)
              if (data.startsWith("refund_")) {
                const parts = data.split("_");
                const refundAction = parts[1]; // approve or reject
                const refundCode = parts[2]; // RFD-XXXXXX
                
                const pg = await import("pg");
                const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
                
                try {
                  const refundResult = await pool.query(
                    "SELECT * FROM refund_links WHERE refund_code = $1",
                    [refundCode]
                  );
                  
                  if (refundResult.rows.length === 0) {
                    await pool.end();
                    await answerCallbackQuery(callbackQuery.id, "❌ Ссылка не найдена");
                    return c.text("OK", 200);
                  }
                  
                  const refund = refundResult.rows[0];
                  
                  // Check if already processed (idempotency)
                  if (refund.status === "approved" || refund.status === "rejected") {
                    await pool.end();
                    await answerCallbackQuery(callbackQuery.id, `ℹ️ Уже обработано: ${refund.status === 'approved' ? 'одобрен' : 'отклонён'}`);
                    return c.text("OK", 200);
                  }
                  
                  const newStatus = refundAction === "approve" ? "approved" : "rejected";
                  
                  await pool.query(
                    "UPDATE refund_links SET status = $1, processed_at = CURRENT_TIMESTAMP WHERE refund_code = $2",
                    [newStatus, refundCode]
                  );
                  await pool.end();
                  
                  // Send channel notification
                  const refundData = {
                    refundCode: refund.refund_code,
                    amount: refund.amount,
                    customerName: refund.customer_name,
                    refundNumber: refund.refund_number
                  };
                  
                  if (refundAction === "approve") {
                    await sendRefundApprovedNotification(refundData);
                    await answerCallbackQuery(callbackQuery.id, "✅ Возврат одобрен");
                  } else {
                    await sendRefundRejectedNotification(refundData);
                    await answerCallbackQuery(callbackQuery.id, "❌ Возврат отклонён");
                  }
                  
                  // Update the message to show status
                  const timestamp = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
                  const statusEmoji = refundAction === "approve" ? "✅" : "❌";
                  const statusText = refundAction === "approve" ? "ВОЗВРАТ ОДОБРЕН" : "ВОЗВРАТ ОТКЛОНЁН";
                  const newText = `${statusEmoji} *${statusText}*\n\n📋 *Код:* \`${refundCode}\`\n💵 *Сумма:* ${refund.amount} руб.\n📅 *Обработано:* ${timestamp}`;
                  
                  const telegramBot = getBot();
                  if (telegramBot) {
                    await telegramBot.editMessageText(newText, {
                      chat_id: chatId,
                      message_id: messageId,
                      parse_mode: "Markdown"
                    });
                  }
                  
                } catch (err) {
                  console.error("Error processing refund callback:", err);
                  await answerCallbackQuery(callbackQuery.id, "❌ Ошибка обработки");
                }
                
                return c.text("OK", 200);
              }
              
              // Parse callback data: confirm_123 or reject_123
              const [action, orderIdStr] = data.split("_");
              const orderId = parseInt(orderIdStr);
              
              if (isNaN(orderId)) {
                await answerCallbackQuery(callbackQuery.id, "❌ Ошибка: неверный ID заказа");
                return c.text("OK", 200);
              }
              
              let result;
              if (action === "confirm") {
                result = await manageOrderTool.execute({
                  context: { action: "confirm_payment", orderId },
                  mastra,
                  runtimeContext: {} as any,
                });
              } else if (action === "reject") {
                result = await manageOrderTool.execute({
                  context: { action: "reject_payment", orderId },
                  mastra,
                  runtimeContext: {} as any,
                });
              } else {
                await answerCallbackQuery(callbackQuery.id, "❌ Неизвестное действие");
                return c.text("OK", 200);
              }
              
              if (result.success && result.order) {
                const status = action === "confirm" ? "confirmed" : "rejected";
                await updateOrderMessageStatus(
                  chatId,
                  messageId,
                  result.order.orderCode,
                  status,
                  adminUsername
                );
                await answerCallbackQuery(
                  callbackQuery.id, 
                  action === "confirm" ? "✅ Оплата подтверждена!" : "❌ Заказ отклонён"
                );
                
                // Send channel notification for confirm/reject
                const { sendChannelPaymentConfirmed, sendChannelPaymentRejected } = await import("./services/telegramAdminService");
                const channelData = {
                  orderId: result.order.id,
                  orderCode: result.order.orderCode,
                  eventName: result.order.eventName,
                  eventDate: result.order.eventDate || "",
                  eventTime: result.order.eventTime || "",
                  cityName: result.order.cityName || "Москва",
                  customerName: result.order.customerName,
                  customerPhone: result.order.customerPhone,
                  seatsCount: result.order.seatsCount,
                  totalPrice: result.order.totalPrice,
                  tickets: result.order.tickets
                };
                
                if (action === "confirm") {
                  await sendChannelPaymentConfirmed(channelData);
                } else {
                  await sendChannelPaymentRejected(channelData);
                }
              } else {
                await answerCallbackQuery(callbackQuery.id, result.message || "❌ Ошибка");
              }
              
              return c.text("OK", 200);
            }
            
            // For regular messages, just acknowledge (admin bot doesn't need to respond)
            return c.text("OK", 200);
          } catch (error) {
            logger?.error("❌ [TelegramWebhook] Error:", error);
            return c.text("OK", 200);
          }
        },
      },


      // API to get single event details
      {
        path: "/api/event/:id",
        method: "GET",
        handler: async (c) => {
          const mastra = c.get("mastra");
          const logger = mastra?.getLogger();
          const eventId = parseInt(c.req.param("id"));
          
          if (isNaN(eventId)) {
            return c.json({ error: "Invalid event ID" }, 400);
          }

          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            const result = await pool.query(
              `SELECT e.*, c.name_ru as category_name, ci.name as city_name 
               FROM events e 
               JOIN categories c ON e.category_id = c.id 
               JOIN cities ci ON e.city_id = ci.id 
               WHERE e.id = $1`,
              [eventId]
            );
            await pool.end();

            if (result.rows.length === 0) {
              return c.json({ error: "Event not found" }, 404);
            }

            const event = result.rows[0];
            return c.json({
              id: event.id,
              name: event.name,
              description: event.description,
              categoryName: event.category_name,
              cityName: event.city_name,
              date: event.date?.toISOString?.()?.split("T")[0] || event.date,
              time: event.time,
              price: parseFloat(event.price) || 0,
              availableSeats: event.available_seats,
              coverImageUrl: event.cover_image_url,
              slug: event.slug,
            });
          } catch (error) {
            logger?.error("❌ [API] Error fetching event:", error);
            return c.json({ error: "Failed to fetch event" }, 500);
          }
        },
      },

      // Admin API: Verify password
      {
        path: "/api/admin/verify",
        method: "POST",
        handler: async (c) => {
          const body = await c.req.json();
          const adminPassword = process.env.ADMIN_PASSWORD;
          if (!adminPassword) {
            return c.json({ error: "Admin password not configured" }, 500);
          }
          if (body.password === adminPassword) {
            return c.json({ success: true });
          }
          return c.json({ success: false, message: "Неверный пароль" }, 401);
        },
      },

      // Admin API: Create event
      {
        path: "/api/admin/events",
        method: "POST",
        handler: async (c) => {
          const mastra = c.get("mastra");
          const logger = mastra?.getLogger();

          // Check admin auth header
          const authToken = c.req.header("X-Admin-Token");
          const authPassword = c.req.header("X-Admin-Password") || (authToken && isValidAdminToken(authToken) ? process.env.ADMIN_PASSWORD : "");
          const adminPassword = process.env.ADMIN_PASSWORD;
          if (!adminPassword) {
            return c.json({ error: "Admin password not configured" }, 500);
          }
          if (authPassword !== adminPassword) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }

          try {
            const body = await c.req.json();
            logger?.info("📝 [Admin API] Creating event:", body);

            const slug = body.name.toLowerCase()
              .replace(/[^\w\sа-яё-]/gi, '')
              .replace(/\s+/g, '-')
              .replace(/--+/g, '-');

            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            const result = await pool.query(
              `INSERT INTO events (name, description, category_id, city_id, date, time, price, available_seats, cover_image_url, slug, is_published)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
               RETURNING id`,
              [body.name, body.description, body.categoryId, body.cityId, body.date, body.time, body.price, body.availableSeats, body.coverImageUrl, slug]
            );
            await pool.end();

            logger?.info("✅ [Admin API] Event created:", result.rows[0].id);
            return c.json({ success: true, eventId: result.rows[0].id, slug });
          } catch (error) {
            logger?.error("❌ [Admin API] Error creating event:", error);
            return c.json({ success: false, message: "Ошибка создания мероприятия" }, 500);
          }
        },
      },

      // Admin API: Update event
      {
        path: "/api/admin/events/:id",
        method: "PUT",
        handler: async (c) => {
          const mastra = c.get("mastra");
          const logger = mastra?.getLogger();
          const eventId = parseInt(c.req.param("id"));

          // Check admin auth header
          const authToken = c.req.header("X-Admin-Token");
          const authPassword = c.req.header("X-Admin-Password") || (authToken && isValidAdminToken(authToken) ? process.env.ADMIN_PASSWORD : "");
          const adminPassword = process.env.ADMIN_PASSWORD;
          if (!adminPassword) {
            return c.json({ error: "Admin password not configured" }, 500);
          }
          if (authPassword !== adminPassword) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }

          try {
            const body = await c.req.json();
            logger?.info("📝 [Admin API] Updating event:", eventId, body);

            const slug = body.name.toLowerCase()
              .replace(/[^\w\sа-яё-]/gi, '')
              .replace(/\s+/g, '-')
              .replace(/--+/g, '-');

            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            await pool.query(
              `UPDATE events SET name=$1, description=$2, category_id=$3, city_id=$4, date=$5, time=$6, price=$7, available_seats=$8, cover_image_url=$9, slug=$10
               WHERE id=$11`,
              [body.name, body.description, body.categoryId, body.cityId, body.date, body.time, body.price, body.availableSeats, body.coverImageUrl, slug, eventId]
            );
            await pool.end();

            logger?.info("✅ [Admin API] Event updated:", eventId);
            return c.json({ success: true });
          } catch (error) {
            logger?.error("❌ [Admin API] Error updating event:", error);
            return c.json({ success: false, message: "Ошибка обновления мероприятия" }, 500);
          }
        },
      },

      // Admin API: Delete event
      {
        path: "/api/admin/events/:id",
        method: "DELETE",
        handler: async (c) => {
          const mastra = c.get("mastra");
          const logger = mastra?.getLogger();
          const eventId = parseInt(c.req.param("id"));

          // Check admin auth header
          const authToken = c.req.header("X-Admin-Token");
          const authPassword = c.req.header("X-Admin-Password") || (authToken && isValidAdminToken(authToken) ? process.env.ADMIN_PASSWORD : "");
          const adminPassword = process.env.ADMIN_PASSWORD;
          if (!adminPassword) {
            return c.json({ error: "Admin password not configured" }, 500);
          }
          if (authPassword !== adminPassword) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }

          try {
            logger?.info("📝 [Admin API] Deleting event:", eventId);

            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            await pool.query("DELETE FROM events WHERE id=$1", [eventId]);
            await pool.end();

            logger?.info("✅ [Admin API] Event deleted:", eventId);
            return c.json({ success: true });
          } catch (error) {
            logger?.error("❌ [Admin API] Error deleting event:", error);
            return c.json({ success: false, message: "Ошибка удаления мероприятия" }, 500);
          }
        },
      },

      // Payment Settings API: Get settings
      {
        path: "/api/payment-settings",
        method: "GET",
        handler: async (c) => {
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            const result = await pool.query("SELECT * FROM payment_settings ORDER BY id DESC LIMIT 1");
            await pool.end();
            
            if (result.rows.length === 0) {
              return c.json({ cardNumber: "", cardHolderName: "", bankName: "", sbpEnabled: true });
            }
            
            const row = result.rows[0];
            return c.json({
              cardNumber: row.card_number,
              cardHolderName: row.card_holder_name,
              bankName: row.bank_name,
              sbpEnabled: row.sbp_enabled !== false
            });
          } catch (error) {
            return c.json({ cardNumber: "", cardHolderName: "", bankName: "", sbpEnabled: true });
          }
        },
      },

      // Payment Settings API: Update settings (admin only)
      {
        path: "/api/admin/payment-settings",
        method: "POST",
        handler: async (c) => {
          const authToken = c.req.header("X-Admin-Token");
          const authPassword = c.req.header("X-Admin-Password") || (authToken && isValidAdminToken(authToken) ? process.env.ADMIN_PASSWORD : "");
          const adminPassword = process.env.ADMIN_PASSWORD;
          if (!adminPassword) {
            return c.json({ error: "Admin password not configured" }, 500);
          }
          if (authPassword !== adminPassword) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }

          try {
            const body = await c.req.json();
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query(
              `UPDATE payment_settings SET card_number=$1, card_holder_name=$2, bank_name=$3, sbp_enabled=$4, updated_at=CURRENT_TIMESTAMP WHERE id=1`,
              [body.cardNumber, body.cardHolderName, body.bankName, body.sbpEnabled !== false]
            );
            await pool.end();
            
            return c.json({ success: true });
          } catch (error) {
            return c.json({ success: false, message: "Ошибка сохранения" }, 500);
          }
        },
      },

      // Cities API: Add city (admin only)
      {
        path: "/api/admin/cities",
        method: "POST",
        handler: async (c) => {
          const authToken = c.req.header("X-Admin-Token");
          const authPassword = c.req.header("X-Admin-Password") || (authToken && isValidAdminToken(authToken) ? process.env.ADMIN_PASSWORD : "");
          const adminPassword = process.env.ADMIN_PASSWORD;
          if (!adminPassword) {
            return c.json({ error: "Admin password not configured" }, 500);
          }
          if (authPassword !== adminPassword) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }

          try {
            const body = await c.req.json();
            if (!body.name || body.name.trim().length < 2) {
              return c.json({ success: false, message: "Название города должно быть не менее 2 символов" }, 400);
            }
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // Check if city already exists
            const existing = await pool.query("SELECT id FROM cities WHERE name = $1", [body.name.trim()]);
            if (existing.rows.length > 0) {
              await pool.end();
              return c.json({ success: false, message: "Город уже существует" }, 400);
            }
            
            await pool.query("INSERT INTO cities (name) VALUES ($1)", [body.name.trim()]);
            await pool.end();
            
            return c.json({ success: true });
          } catch (error) {
            console.error("Error adding city:", error);
            return c.json({ success: false, message: "Ошибка добавления города" }, 500);
          }
        },
      },
      
      // Cities API: Delete city (admin only)
      {
        path: "/api/admin/cities/:id",
        method: "DELETE",
        handler: async (c) => {
          const authToken = c.req.header("X-Admin-Token");
          const authPassword = c.req.header("X-Admin-Password") || (authToken && isValidAdminToken(authToken) ? process.env.ADMIN_PASSWORD : "");
          const adminPassword = process.env.ADMIN_PASSWORD;
          if (!adminPassword) {
            return c.json({ error: "Admin password not configured" }, 500);
          }
          if (authPassword !== adminPassword) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }

          try {
            const cityId = parseInt(c.req.param("id"));
            if (isNaN(cityId)) {
              return c.json({ success: false, message: "Неверный ID города" }, 400);
            }
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // Delete related generated links first
            await pool.query("DELETE FROM generated_links WHERE city_id = $1", [cityId]);
            
            // Delete city addresses
            await pool.query("DELETE FROM event_template_addresses WHERE city_id = $1", [cityId]);
            
            // Delete city
            await pool.query("DELETE FROM cities WHERE id = $1", [cityId]);
            
            await pool.end();
            
            return c.json({ success: true });
          } catch (error) {
            console.error("Error deleting city:", error);
            return c.json({ success: false, message: "Ошибка удаления города" }, 500);
          }
        },
      },

      // Order API: Get order by code (supports both regular orders and generated link orders)
      {
        path: "/api/order/:code",
        method: "GET",
        handler: async (c) => {
          const orderCode = c.req.param("code");
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // First try to find order with event_id (regular orders)
            let result = await pool.query(
              `SELECT o.*, e.name as event_name, e.price 
               FROM orders o 
               JOIN events e ON o.event_id = e.id 
               WHERE o.order_code = $1`,
              [orderCode]
            );
            
            // If not found, try to find order with event_template_id (generated link orders)
            if (result.rows.length === 0) {
              result = await pool.query(
                `SELECT o.*, et.name as event_name, 2990 as price 
                 FROM orders o 
                 JOIN event_templates et ON o.event_template_id = et.id 
                 WHERE o.order_code = $1`,
                [orderCode]
              );
            }
            
            await pool.end();
            
            if (result.rows.length === 0) {
              return c.json({ error: "Order not found" }, 404);
            }
            
            const order = result.rows[0];
            return c.json({
              id: order.id,
              orderCode: order.order_code,
              eventName: order.event_name,
              customerName: order.customer_name,
              seatsCount: order.seats_count,
              totalPrice: parseFloat(order.total_price) || order.seats_count * parseFloat(order.price),
              status: order.status
            });
          } catch (error) {
            return c.json({ error: "Failed to fetch order" }, 500);
          }
        },
      },

      // Ticket API: Get ticket data by order code (for confirmed orders)
      {
        path: "/api/ticket/:orderCode",
        method: "GET",
        handler: async (c) => {
          // Prevent caching to ensure fresh ticket data
          c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
          c.header("Pragma", "no-cache");
          c.header("Expires", "0");
          
          const orderCode = c.req.param("orderCode");
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // First try generated link orders (event_template_id based)
            let result = await pool.query(`
              SELECT o.*, 
                     et.name as event_name, et.ticket_image_url, et.image_url,
                     COALESCE(o.event_date, gl.event_date) as event_date, 
                     COALESCE(o.event_time, gl.event_time) as event_time, 
                     COALESCE(o.city_id, gl.city_id) as city_id,
                     c.name as city_name
              FROM orders o
              JOIN event_templates et ON o.event_template_id = et.id
              LEFT JOIN generated_links gl ON o.link_code = gl.link_code
              LEFT JOIN cities c ON COALESCE(o.city_id, gl.city_id) = c.id
              WHERE o.order_code = $1 AND o.event_template_id IS NOT NULL
            `, [orderCode]);
            
            let eventTemplateId = null;
            
            // Try regular events if not found (event_id based orders)
            if (result.rows.length === 0) {
              result = await pool.query(`
                SELECT o.*, e.name as event_name, e.date as event_date, e.time as event_time,
                       NULL as ticket_image_url, e.image_url as image_url,
                       ci.name as city_name
                FROM orders o
                JOIN events e ON o.event_id = e.id
                LEFT JOIN cities ci ON e.city_id = ci.id
                WHERE o.order_code = $1
              `, [orderCode]);
            } else {
              eventTemplateId = result.rows[0].event_template_id;
            }
            
            if (result.rows.length === 0) {
              await pool.end();
              return c.json({ success: false, message: "Order not found" }, 404);
            }
            
            const order = result.rows[0];
            
            // Get image from event_template_images table if no image_url
            let finalImageUrl = order.ticket_image_url || order.image_url;
            if (!finalImageUrl && eventTemplateId) {
              const imgResult = await pool.query(
                "SELECT image_url FROM event_template_images WHERE event_template_id = $1 ORDER BY sort_order LIMIT 1",
                [eventTemplateId]
              );
              if (imgResult.rows.length > 0) {
                finalImageUrl = imgResult.rows[0].image_url;
              }
            }
            
            await pool.end();
            
            // Check if payment is confirmed
            if (order.payment_status !== 'confirmed') {
              return c.json({ success: true, pending: true, message: "Payment pending confirmation" });
            }
            
            let ticketsData = null;
            if (order.tickets_json) {
              try {
                ticketsData = JSON.parse(order.tickets_json);
              } catch (e) {}
            }
            
            return c.json({
              success: true,
              ticket: {
                order_code: order.order_code,
                orderId: order.id,
                event_name: order.event_name || 'Мероприятие',
                event_date: order.event_date,
                event_time: order.event_time,
                city_name: order.city_name || 'Москва',
                customer_name: order.customer_name,
                total_price: order.total_price,
                ticket_image_url: order.ticket_image_url,
                image_url: finalImageUrl,
                tickets: ticketsData
              }
            });
          } catch (error) {
            console.error("Error fetching ticket:", error);
            return c.json({ success: false, message: "Error fetching ticket" }, 500);
          }
        },
      },

      // Ticket page
      {
        path: "/ticket",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("ticket.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Ticket page not found", 404);
        },
      },

      // Payment page
      {
        path: "/payment",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("payment.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Payment page not found", 404);
        },
      },

      // Event page by template ID
      {
        path: "/event/:id",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("event.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Event page not found", 404);
        },
      },

      // Event page by generated link code
      {
        path: "/e/:code",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("event.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Event page not found", 404);
        },
      },

      // Generator page
      {
        path: "/generator",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("generator.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Generator page not found", 404);
        },
      },
      
      // Admin Events page
      {
        path: "/admin-events",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("admin-events.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Admin events page not found", 404);
        },
      },

      // Admin Register
      {
        path: "/api/admin/register",
        method: "POST",
        handler: async (c) => {
          try {
            const body = await c.req.json();
            const { username, displayName, password } = body;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const existing = await pool.query("SELECT id FROM admins WHERE username=$1", [username]);
            if (existing.rows.length > 0) {
              await pool.end();
              return c.json({ success: false, message: "Логин уже занят" });
            }
            
            const result = await pool.query(
              "INSERT INTO admins (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, username, display_name",
              [username, password, displayName]
            );
            await pool.end();
            
            const admin = result.rows[0];
            const token = `${admin.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            
            return c.json({
              success: true,
              token,
              admin: { id: admin.id, username: admin.username, displayName: admin.display_name }
            });
          } catch (error) {
            console.error("Register error:", error);
            return c.json({ success: false, message: "Ошибка регистрации" }, 500);
          }
        },
      },

      // Admin Login
      {
        path: "/api/admin/login",
        method: "POST",
        handler: async (c) => {
          try {
            const body = await c.req.json();
            const { username, password } = body;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              "SELECT id, username, display_name, password_hash FROM admins WHERE username=$1",
              [username]
            );
            await pool.end();
            
            if (result.rows.length === 0 || result.rows[0].password_hash !== password) {
              return c.json({ success: false, message: "Неверный логин или пароль" });
            }
            
            const admin = result.rows[0];
            const token = `${admin.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            
            return c.json({
              success: true,
              token,
              admin: { id: admin.id, username: admin.username, displayName: admin.display_name }
            });
          } catch (error) {
            console.error("Login error:", error);
            return c.json({ success: false, message: "Ошибка входа" }, 500);
          }
        },
      },

      // Generate Event (multi-admin)
      {
        path: "/api/admin/generate-event",
        method: "POST",
        handler: async (c) => {
          try {
            const authHeader = c.req.header("Authorization");
            if (!authHeader?.startsWith("Bearer ")) {
              return c.json({ success: false, message: "Unauthorized" }, 401);
            }
            
            const token = authHeader.split(" ")[1];
            const adminId = parseInt(token.split("_")[0]);
            if (!adminId) {
              return c.json({ success: false, message: "Invalid token" }, 401);
            }
            
            const body = await c.req.json();
            const slug = `${body.name.toLowerCase()
              .replace(/[^\w\sа-яё-]/gi, '')
              .replace(/\s+/g, '-')
              .replace(/--+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query(
              `INSERT INTO events (name, description, category_id, city_id, date, time, price, available_seats, cover_image_url, slug, is_published, admin_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)`,
              [body.name, body.description, body.categoryId, body.cityId, body.date, body.time, body.price, body.availableSeats, body.coverImageUrl, slug, adminId]
            );
            await pool.end();
            
            return c.json({ success: true, slug });
          } catch (error) {
            console.error("Generate event error:", error);
            return c.json({ success: false, message: "Ошибка генерации" }, 500);
          }
        },
      },

      // My Events (admin-specific)
      {
        path: "/api/admin/my-events",
        method: "GET",
        handler: async (c) => {
          try {
            const authHeader = c.req.header("Authorization");
            if (!authHeader?.startsWith("Bearer ")) {
              return c.json({ events: [] });
            }
            
            const token = authHeader.split(" ")[1];
            const adminId = parseInt(token.split("_")[0]);
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              `SELECT e.*, c.name as city_name, cat.name_ru as category_name
               FROM events e
               LEFT JOIN cities c ON e.city_id = c.id
               LEFT JOIN categories cat ON e.category_id = cat.id
               WHERE e.admin_id = $1
               ORDER BY e.created_at DESC`,
              [adminId]
            );
            await pool.end();
            
            const events = result.rows.map(e => ({
              id: e.id,
              name: e.name,
              slug: e.slug,
              cityName: e.city_name,
              categoryName: e.category_name,
              date: e.date?.toISOString?.()?.split("T")[0] || e.date,
              time: e.time,
              price: parseFloat(e.price) || 0,
              availableSeats: e.available_seats
            }));
            
            return c.json({ events });
          } catch (error) {
            console.error("My events error:", error);
            return c.json({ events: [] });
          }
        },
      },

      // My Payment Settings (get)
      {
        path: "/api/admin/my-payment-settings",
        method: "GET",
        handler: async (c) => {
          try {
            const authHeader = c.req.header("Authorization");
            if (!authHeader?.startsWith("Bearer ")) {
              return c.json({ cardNumber: "", cardHolderName: "", bankName: "" });
            }
            
            const token = authHeader.split(" ")[1];
            const adminId = parseInt(token.split("_")[0]);
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              "SELECT * FROM admin_payment_settings WHERE admin_id=$1",
              [adminId]
            );
            await pool.end();
            
            if (result.rows.length === 0) {
              return c.json({ cardNumber: "", cardHolderName: "", bankName: "" });
            }
            
            const row = result.rows[0];
            return c.json({
              cardNumber: row.card_number,
              cardHolderName: row.card_holder_name,
              bankName: row.bank_name
            });
          } catch (error) {
            return c.json({ cardNumber: "", cardHolderName: "", bankName: "" });
          }
        },
      },

      // My Payment Settings (save)
      {
        path: "/api/admin/my-payment-settings",
        method: "POST",
        handler: async (c) => {
          try {
            const authHeader = c.req.header("Authorization");
            if (!authHeader?.startsWith("Bearer ")) {
              return c.json({ success: false, message: "Unauthorized" }, 401);
            }
            
            const token = authHeader.split(" ")[1];
            const adminId = parseInt(token.split("_")[0]);
            
            const body = await c.req.json();
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query(
              `INSERT INTO admin_payment_settings (admin_id, card_number, card_holder_name, bank_name)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (admin_id) DO UPDATE SET
               card_number = $2, card_holder_name = $3, bank_name = $4, updated_at = CURRENT_TIMESTAMP`,
              [adminId, body.cardNumber, body.cardHolderName, body.bankName]
            );
            await pool.end();
            
            return c.json({ success: true });
          } catch (error) {
            console.error("Save payment settings error:", error);
            return c.json({ success: false, message: "Ошибка сохранения" }, 500);
          }
        },
      },

      // API: Get event by slug
      {
        path: "/api/e/:slug",
        method: "GET",
        handler: async (c) => {
          const slug = c.req.param("slug");
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              `SELECT e.*, c.name as city_name, cat.name_ru as category_name
               FROM events e
               LEFT JOIN cities c ON e.city_id = c.id
               LEFT JOIN categories cat ON e.category_id = cat.id
               WHERE e.slug = $1 AND e.is_published = true`,
              [slug]
            );
            await pool.end();
            
            if (result.rows.length === 0) {
              return c.json({ error: "Event not found" }, 404);
            }
            
            const e = result.rows[0];
            return c.json({
              id: e.id,
              adminId: e.admin_id,
              name: e.name,
              description: e.description,
              categoryName: e.category_name,
              cityName: e.city_name,
              date: e.date?.toISOString?.()?.split("T")[0] || e.date,
              time: e.time,
              price: parseFloat(e.price) || 0,
              availableSeats: e.available_seats,
              coverImageUrl: e.cover_image_url,
              slug: e.slug
            });
          } catch (error) {
            console.error("Get event error:", error);
            return c.json({ error: "Failed to fetch event" }, 500);
          }
        },
      },

      // Create ticket order - sends notification to admin immediately
      {
        path: "/api/create-ticket-order",
        method: "POST",
        handler: async (c) => {
          try {
            const body = await c.req.json();
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const eventResult = await pool.query(
              `SELECT e.id, e.price, e.available_seats, e.admin_id, e.name, e.date, e.time, c.name as city_name
               FROM events e
               LEFT JOIN cities c ON e.city_id = c.id
               WHERE e.slug=$1`,
              [body.eventSlug]
            );
            
            if (eventResult.rows.length === 0) {
              await pool.end();
              return c.json({ success: false, message: "Мероприятие не найдено" });
            }
            
            const event = eventResult.rows[0];
            if (event.available_seats < body.seatsCount) {
              await pool.end();
              return c.json({ success: false, message: "Недостаточно мест" });
            }
            
            const orderCode = `TK${Date.now().toString(36).toUpperCase()}`;
            const totalPrice = parseFloat(event.price) * body.seatsCount;
            
            const orderResult = await pool.query(
              `INSERT INTO orders (event_id, admin_id, customer_name, customer_phone, customer_email, seats_count, total_price, order_code, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
               RETURNING id`,
              [event.id, event.admin_id, body.customerName, body.customerPhone, body.customerEmail, body.seatsCount, totalPrice, orderCode]
            );
            
            await pool.query(
              "UPDATE events SET available_seats = available_seats - $1 WHERE id = $2",
              [body.seatsCount, event.id]
            );
            
            await pool.end();
            
            // Send notifications to channel and admin when customer reaches payment page
            const notificationData = {
              orderId: orderResult.rows[0].id,
              orderCode: orderCode,
              eventName: event.name,
              eventDate: event.date?.toISOString?.()?.split("T")[0] || String(event.date),
              eventTime: event.time || "",
              cityName: event.city_name || "",
              customerName: body.customerName,
              customerPhone: body.customerPhone,
              customerEmail: body.customerEmail,
              seatsCount: body.seatsCount,
              totalPrice: totalPrice
            };
            
            try {
              await Promise.all([
                sendChannelNotification(notificationData),
                sendOrderNotificationToAdmin(notificationData)
              ]);
              console.log("📤 [API] Channel and admin notifications sent for:", orderCode);
            } catch (notifyError) {
              console.error("⚠️ [API] Failed to send notifications:", notifyError);
            }
            
            return c.json({ success: true, orderCode });
          } catch (error) {
            console.error("Create order error:", error);
            return c.json({ success: false, message: "Ошибка создания заказа" }, 500);
          }
        },
      },

      // Get ticket order by code
      {
        path: "/api/ticket-order/:code",
        method: "GET",
        handler: async (c) => {
          const orderCode = c.req.param("code");
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // First try regular orders (with event_id)
            let result = await pool.query(
              `SELECT o.*, e.name as event_name, e.date, e.time, e.price
               FROM orders o
               JOIN events e ON o.event_id = e.id
               WHERE o.order_code = $1`,
              [orderCode]
            );
            
            // If not found, try generated link orders (with event_template_id)
            if (result.rows.length === 0) {
              result = await pool.query(
                `SELECT o.*, et.name as event_name, 
                 COALESCE(o.event_date, gl.event_date) as date, 
                 COALESCE(o.event_time, gl.event_time) as time, 
                 c.name as city_name,
                 2990 as price
                 FROM orders o
                 JOIN event_templates et ON o.event_template_id = et.id
                 LEFT JOIN generated_links gl ON gl.link_code = o.link_code
                 LEFT JOIN cities c ON COALESCE(o.city_id, gl.city_id) = c.id
                 WHERE o.order_code = $1`,
                [orderCode]
              );
            }
            
            await pool.end();
            
            if (result.rows.length === 0) {
              return c.json({ error: "Order not found" }, 404);
            }
            
            const o = result.rows[0];
            return c.json({
              id: o.id,
              orderCode: o.order_code,
              eventName: o.event_name,
              customerName: o.customer_name,
              seatsCount: o.seats_count,
              totalPrice: parseFloat(o.total_price),
              status: o.status,
              eventDate: o.date,
              eventTime: o.time
            });
          } catch (error) {
            return c.json({ error: "Failed to fetch order" }, 500);
          }
        },
      },

      // Get payment settings for order
      {
        path: "/api/ticket-order/:code/payment-settings",
        method: "GET",
        handler: async (c) => {
          const orderCode = c.req.param("code");
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // Check if this is a generated link order
            const orderCheck = await pool.query(
              "SELECT event_template_id FROM orders WHERE order_code = $1",
              [orderCode]
            );
            
            let result;
            if (orderCheck.rows.length > 0 && orderCheck.rows[0].event_template_id) {
              // Generated link order - use global payment_settings
              result = await pool.query("SELECT * FROM payment_settings ORDER BY id DESC LIMIT 1");
            } else {
              // Regular order - use admin_payment_settings
              result = await pool.query(
                `SELECT aps.* FROM admin_payment_settings aps
                 JOIN orders o ON o.admin_id = aps.admin_id
                 WHERE o.order_code = $1`,
                [orderCode]
              );
            }
            await pool.end();
            
            if (result.rows.length === 0) {
              return c.json({ cardNumber: "", cardHolderName: "", bankName: "" });
            }
            
            const row = result.rows[0];
            return c.json({
              cardNumber: row.card_number,
              cardHolderName: row.card_holder_name,
              bankName: row.bank_name
            });
          } catch (error) {
            return c.json({ cardNumber: "", cardHolderName: "", bankName: "" });
          }
        },
      },

      // Mark order as paid (waiting confirmation) - sends notifications with screenshot to admin
      {
        path: "/api/ticket-order/:code/mark-paid",
        method: "POST",
        handler: async (c) => {
          const orderCode = c.req.param("code");
          try {
            const body = await c.req.json().catch(() => ({}));
            const screenshot = body.screenshot || null;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // First try regular orders (with event_id)
            let orderResult = await pool.query(
              `SELECT o.*, e.name as event_name, e.date as event_date, e.time as event_time, 
               ci.name as city_name
               FROM orders o
               JOIN events e ON o.event_id = e.id
               JOIN cities ci ON e.city_id = ci.id
               WHERE o.order_code = $1`,
              [orderCode]
            );
            
            // If not found, try generated link orders
            if (orderResult.rows.length === 0) {
              orderResult = await pool.query(
                `SELECT o.*, et.name as event_name, 
                 COALESCE(o.event_date, gl.event_date) as event_date, 
                 COALESCE(o.event_time, gl.event_time) as event_time, 
                 c.name as city_name
                 FROM orders o
                 JOIN event_templates et ON o.event_template_id = et.id
                 LEFT JOIN generated_links gl ON gl.link_code = o.link_code
                 LEFT JOIN cities c ON COALESCE(o.city_id, gl.city_id) = c.id
                 WHERE o.order_code = $1`,
                [orderCode]
              );
            }
            
            if (orderResult.rows.length === 0) {
              await pool.end();
              return c.json({ success: false, message: "Заказ не найден" }, 404);
            }
            
            const order = orderResult.rows[0];
            
            // Update order status
            await pool.query(
              "UPDATE orders SET status='waiting_confirmation' WHERE order_code=$1",
              [orderCode]
            );
            
            await pool.end();
            console.log("📝 [API] Order marked as waiting confirmation:", orderCode);
            
            // Send notification to admin with screenshot and channel notification
            const { sendPaymentConfirmationWithPhoto, sendPaymentConfirmationNoPhoto, sendChannelPaymentPending } = await import("./services/telegramAdminService");
            
            // Parse tickets from order
            let tickets = undefined;
            if (order.tickets_json) {
              try {
                tickets = JSON.parse(order.tickets_json);
              } catch (e) {}
            }
            
            const notificationData = {
              orderId: order.id,
              orderCode: order.order_code,
              eventName: order.event_name,
              eventDate: order.event_date?.toISOString?.()?.split("T")[0] || String(order.event_date),
              eventTime: order.event_time || "00:00",
              cityName: order.city_name || "Москва",
              customerName: order.customer_name,
              customerPhone: order.customer_phone,
              customerEmail: order.customer_email,
              seatsCount: order.seats_count,
              totalPrice: parseFloat(order.total_price),
              tickets: tickets
            };
            
            try {
              // Send to channel when user clicks "я оплатил"
              await sendChannelPaymentPending(notificationData);
              
              if (screenshot) {
                await sendPaymentConfirmationWithPhoto(notificationData, screenshot);
              } else {
                await sendPaymentConfirmationNoPhoto(notificationData);
              }
            } catch (notifyError) {
              console.error("⚠️ [API] Failed to send payment notification:", notifyError);
            }
            
            return c.json({ success: true });
          } catch (error) {
            console.error("Mark paid error:", error);
            return c.json({ success: false, message: "Ошибка" }, 500);
          }
        },
      },

      // Pay page
      {
        path: "/pay",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("pay.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Pay page not found", 404);
        },
      },

      // Generator API - Get categories
      {
        path: "/api/generator/categories",
        method: "GET",
        handler: async (c) => {
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            const result = await pool.query(
              "SELECT id, name, name_ru FROM categories WHERE id IN (6,7,8,9,10,11,12,13) ORDER BY id"
            );
            await pool.end();
            return c.json({ categories: result.rows });
          } catch (error) {
            console.error("Error fetching categories:", error);
            return c.json({ categories: [] });
          }
        },
      },

      // Generator API - Get cities
      {
        path: "/api/generator/cities",
        method: "GET",
        handler: async (c) => {
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            const result = await pool.query("SELECT id, name FROM cities ORDER BY name");
            await pool.end();
            return c.json({ cities: result.rows });
          } catch (error) {
            console.error("Error fetching cities:", error);
            return c.json({ cities: [] });
          }
        },
      },

      // Generator API - Get event templates by category (with optional city filter)
      {
        path: "/api/generator/event-templates",
        method: "GET",
        handler: async (c) => {
          try {
            const categoryId = c.req.query("category_id");
            const cityId = c.req.query("city_id");
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            let result;
            // If category_id provided, filter by category; otherwise return all active templates
            if (categoryId) {
              result = await pool.query(
                "SELECT id, name, description, is_active, ticket_image_url FROM event_templates WHERE category_id = $1 AND is_active = true ORDER BY name",
                [categoryId]
              );
            } else {
              result = await pool.query(
                "SELECT id, name, description, is_active, ticket_image_url FROM event_templates WHERE is_active = true ORDER BY name"
              );
            }
            
            // Get first image for each template from images table
            const templates = [];
            for (const row of result.rows) {
              const imgRes = await pool.query(
                "SELECT image_url FROM event_template_images WHERE event_template_id = $1 ORDER BY sort_order LIMIT 1",
                [row.id]
              );
              
              // If city_id is provided, also get the generated link code for this template and city
              let linkCode = null;
              if (cityId) {
                const linkRes = await pool.query(
                  "SELECT link_code FROM generated_links WHERE event_template_id = $1 AND city_id = $2 AND is_active = true ORDER BY created_at DESC LIMIT 1",
                  [row.id, cityId]
                );
                if (linkRes.rows.length > 0) {
                  linkCode = linkRes.rows[0].link_code;
                }
              }
              
              templates.push({
                id: row.id,
                name: row.name,
                description: row.description,
                is_active: row.is_active,
                image_url: imgRes.rows[0]?.image_url || null,
                ticket_image_url: row.ticket_image_url,
                link_code: linkCode
              });
            }
            
            await pool.end();
            return c.json({ templates });
          } catch (error) {
            console.error("Error fetching event templates:", error);
            return c.json({ templates: [] });
          }
        },
      },
      
      // Generator API - Get single event template by ID
      {
        path: "/api/generator/event-templates/:id",
        method: "GET",
        handler: async (c) => {
          try {
            const eventId = c.req.param("id");
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            const result = await pool.query(
              `SELECT et.*, cat.name_ru as category_name 
               FROM event_templates et 
               JOIN categories cat ON et.category_id = cat.id 
               WHERE et.id = $1`,
              [eventId]
            );
            
            if (result.rows.length === 0) {
              await pool.end();
              return c.json({ success: false, error: "Template not found" }, 404);
            }
            
            // Get images for this template
            const imagesResult = await pool.query(
              "SELECT image_url FROM event_template_images WHERE event_template_id = $1 ORDER BY sort_order LIMIT 5",
              [eventId]
            );
            const images = imagesResult.rows.map(r => r.image_url);
            
            await pool.end();
            
            const template = result.rows[0];
            return c.json({
              success: true,
              template: {
                id: template.id,
                name: template.name,
                description: template.description,
                images: images,
                image_url: images[0] || template.image_url,
                ticket_image_url: template.ticket_image_url,
                categoryName: template.category_name,
                isActive: template.is_active
              }
            });
          } catch (error) {
            console.error("Error fetching event template:", error);
            return c.json({ success: false, error: "Failed to fetch template" }, 500);
          }
        },
      },
      
      // Generator API - Get single event template by ID (alias for direct ticket generation)
      {
        path: "/api/generator/event-template/:id",
        method: "GET",
        handler: async (c) => {
          try {
            const eventId = c.req.param("id");
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            const result = await pool.query(
              `SELECT et.*, cat.name_ru as category_name 
               FROM event_templates et 
               JOIN categories cat ON et.category_id = cat.id 
               WHERE et.id = $1`,
              [eventId]
            );
            
            if (result.rows.length === 0) {
              await pool.end();
              return c.json({ success: false, error: "Template not found" }, 404);
            }
            
            // Get images for this template
            const imagesResult = await pool.query(
              "SELECT image_url FROM event_template_images WHERE event_template_id = $1 ORDER BY sort_order LIMIT 5",
              [eventId]
            );
            const images = imagesResult.rows.map(r => r.image_url);
            
            await pool.end();
            
            const template = result.rows[0];
            return c.json({
              success: true,
              template: {
                id: template.id,
                name: template.name,
                description: template.description,
                images: images,
                image_url: images[0] || template.image_url,
                ticket_image_url: template.ticket_image_url,
                categoryName: template.category_name,
                isActive: template.is_active
              }
            });
          } catch (error) {
            console.error("Error fetching event template:", error);
            return c.json({ success: false, error: "Failed to fetch template" }, 500);
          }
        },
      },
      
      // Generator API - Update event template
      {
        path: "/api/generator/event-templates/:id/update",
        method: "PUT",
        handler: async (c) => {
          try {
            const eventId = c.req.param("id");
            const body = await c.req.json();
            const { name, description, image_url, ticket_image_url } = body;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query(
              "UPDATE event_templates SET name = $1, description = $2, image_url = $3, ticket_image_url = $4 WHERE id = $5",
              [name, description, image_url, ticket_image_url || null, eventId]
            );
            
            await pool.end();
            return c.json({ success: true });
          } catch (error) {
            console.error("Error updating event template:", error);
            return c.json({ success: false }, 500);
          }
        },
      },
      
      // Generator API - Toggle event template status
      {
        path: "/api/generator/event-templates/:id/toggle",
        method: "POST",
        handler: async (c) => {
          try {
            const eventId = c.req.param("id");
            const body = await c.req.json();
            const { is_active } = body;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query(
              "UPDATE event_templates SET is_active = $1 WHERE id = $2",
              [is_active, eventId]
            );
            
            await pool.end();
            return c.json({ success: true });
          } catch (error) {
            console.error("Error toggling event template:", error);
            return c.json({ success: false }, 500);
          }
        },
      },

      // Generator API - Get images for event template
      {
        path: "/api/generator/event-templates/:id/images",
        method: "GET",
        handler: async (c) => {
          try {
            const eventId = c.req.param("id");
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              "SELECT id, image_url, sort_order FROM event_template_images WHERE event_template_id = $1 ORDER BY sort_order",
              [eventId]
            );
            
            await pool.end();
            return c.json({ images: result.rows });
          } catch (error) {
            console.error("Error fetching images:", error);
            return c.json({ images: [] });
          }
        },
      },

      // Generator API - Add image to event template
      {
        path: "/api/generator/event-templates/:id/images",
        method: "POST",
        handler: async (c) => {
          try {
            const eventId = c.req.param("id");
            const body = await c.req.json();
            const { image_url } = body;
            
            if (!image_url) {
              return c.json({ success: false, message: "URL обязателен" }, 400);
            }
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // Get max sort_order
            const maxRes = await pool.query(
              "SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM event_template_images WHERE event_template_id = $1",
              [eventId]
            );
            const nextOrder = maxRes.rows[0].next_order;
            
            const result = await pool.query(
              "INSERT INTO event_template_images (event_template_id, image_url, sort_order) VALUES ($1, $2, $3) RETURNING id",
              [eventId, image_url, nextOrder]
            );
            
            await pool.end();
            return c.json({ success: true, id: result.rows[0].id });
          } catch (error) {
            console.error("Error adding image:", error);
            return c.json({ success: false, message: "Ошибка" }, 500);
          }
        },
      },

      // Generator API - Delete image from event template
      {
        path: "/api/generator/event-templates/:id/images/:imageId",
        method: "DELETE",
        handler: async (c) => {
          try {
            const imageId = c.req.param("imageId");
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query("DELETE FROM event_template_images WHERE id = $1", [imageId]);
            
            await pool.end();
            return c.json({ success: true });
          } catch (error) {
            console.error("Error deleting image:", error);
            return c.json({ success: false }, 500);
          }
        },
      },

      // Generator API - Get addresses for event template
      {
        path: "/api/generator/event-templates/:id/addresses",
        method: "GET",
        handler: async (c) => {
          try {
            const eventId = c.req.param("id");
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              "SELECT city_id, venue_address FROM event_template_addresses WHERE event_template_id = $1",
              [eventId]
            );
            
            await pool.end();
            return c.json({ addresses: result.rows });
          } catch (error) {
            console.error("Error fetching addresses:", error);
            return c.json({ addresses: [] });
          }
        },
      },

      // Generator API - Save addresses for event template
      {
        path: "/api/generator/event-templates/:id/addresses",
        method: "PUT",
        handler: async (c) => {
          try {
            const eventId = c.req.param("id");
            const body = await c.req.json();
            const { addresses } = body;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // Delete existing addresses
            await pool.query(
              "DELETE FROM event_template_addresses WHERE event_template_id = $1",
              [eventId]
            );
            
            // Insert new addresses
            for (const addr of addresses) {
              await pool.query(
                "INSERT INTO event_template_addresses (event_template_id, city_id, venue_address) VALUES ($1, $2, $3)",
                [eventId, addr.city_id, addr.venue_address]
              );
            }
            
            await pool.end();
            return c.json({ success: true });
          } catch (error) {
            console.error("Error saving addresses:", error);
            return c.json({ success: false }, 500);
          }
        },
      },

      // Generator API - Get all generated links
      {
        path: "/api/generator/links",
        method: "GET",
        handler: async (c) => {
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            const result = await pool.query(`
              SELECT gl.*, et.name as event_name, c.name as city_name
              FROM generated_links gl
              JOIN event_templates et ON gl.event_template_id = et.id
              JOIN cities c ON gl.city_id = c.id
              ORDER BY gl.created_at DESC
              LIMIT 50
            `);
            await pool.end();
            return c.json({ links: result.rows });
          } catch (error) {
            console.error("Error fetching links:", error);
            return c.json({ links: [] });
          }
        },
      },

      // Generator API - Create new link
      {
        path: "/api/generator/create-link",
        method: "POST",
        handler: async (c) => {
          try {
            const body = await c.req.json();
            const { event_template_id, city_id, event_date, event_time, available_seats } = body;
            
            const linkCode = generateLinkCode();
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // Get venue address for this event and city
            const addrResult = await pool.query(
              "SELECT venue_address FROM event_template_addresses WHERE event_template_id = $1 AND city_id = $2",
              [event_template_id, city_id]
            );
            const venueAddress = addrResult.rows[0]?.venue_address || null;
            
            const insertResult = await pool.query(`
              INSERT INTO generated_links 
              (link_code, event_template_id, city_id, event_date, event_time, available_seats, venue_address, is_active)
              VALUES ($1, $2, $3, $4, $5, $6, $7, true)
              RETURNING id
            `, [linkCode, event_template_id, city_id, event_date, event_time, available_seats || 100, venueAddress]);
            
            const linkId = insertResult.rows[0].id;
            
            await pool.end();
            
            return c.json({ success: true, link_code: linkCode, link_id: linkId });
          } catch (error) {
            console.error("Error creating link:", error);
            return c.json({ success: false, message: "Ошибка создания ссылки" }, 500);
          }
        },
      },

      // Generator API - Toggle link status
      {
        path: "/api/generator/links/:id/toggle",
        method: "POST",
        handler: async (c) => {
          try {
            const linkId = c.req.param("id");
            const body = await c.req.json();
            const { is_active } = body;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query(
              "UPDATE generated_links SET is_active = $1 WHERE id = $2",
              [is_active, linkId]
            );
            
            await pool.end();
            return c.json({ success: true });
          } catch (error) {
            console.error("Error toggling link:", error);
            return c.json({ success: false }, 500);
          }
        },
      },
      
      // Generator API - Update generated link
      {
        path: "/api/generator/links/:id",
        method: "PUT",
        handler: async (c) => {
          try {
            const linkId = c.req.param("id");
            const body = await c.req.json();
            const { venue_address, available_seats } = body;
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query(
              "UPDATE generated_links SET venue_address = $1, available_seats = $2 WHERE id = $3",
              [venue_address, available_seats, linkId]
            );
            
            await pool.end();
            return c.json({ success: true });
          } catch (error) {
            console.error("Error updating link:", error);
            return c.json({ success: false }, 500);
          }
        },
      },

      // Generator API - Delete generated link
      {
        path: "/api/generator/links/:id",
        method: "DELETE",
        handler: async (c) => {
          const authToken = c.req.header("X-Admin-Token");
          const authPassword = c.req.header("X-Admin-Password") || (authToken && isValidAdminToken(authToken) ? process.env.ADMIN_PASSWORD : "");
          const adminPassword = process.env.ADMIN_PASSWORD;
          if (!adminPassword) {
            return c.json({ error: "Admin password not configured" }, 500);
          }
          if (authPassword !== adminPassword) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }
          
          try {
            const linkId = c.req.param("id");
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query("DELETE FROM generated_links WHERE id = $1", [linkId]);
            
            await pool.end();
            return c.json({ success: true });
          } catch (error) {
            console.error("Error deleting link:", error);
            return c.json({ success: false }, 500);
          }
        },
      },

      // API to validate if a link is still active (for access control)
      {
        path: "/api/links/validate",
        method: "GET",
        handler: async (c) => {
          c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
          c.header("Pragma", "no-cache");
          
          try {
            const linkCode = c.req.query("code");
            if (!linkCode) {
              return c.json({ active: false, error: "No link code provided" }, 400);
            }
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(`
              SELECT gl.id, gl.is_active, gl.city_id, c.name as city_name
              FROM generated_links gl
              JOIN cities c ON gl.city_id = c.id
              WHERE gl.link_code = $1
            `, [linkCode]);
            
            await pool.end();
            
            if (result.rows.length === 0) {
              return c.json({ active: false, error: "Link not found" }, 404);
            }
            
            const link = result.rows[0];
            if (!link.is_active) {
              return c.json({ active: false, error: "Link is disabled" }, 404);
            }
            
            return c.json({ 
              active: true, 
              cityId: link.city_id, 
              cityName: link.city_name 
            });
          } catch (error) {
            console.error("Error validating link:", error);
            return c.json({ active: false, error: "Server error" }, 500);
          }
        },
      },

      // Booking page for generated links
      {
        path: "/booking-link/:code",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("booking.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Booking page not found", 404);
        },
      },

      // Booking page for regular events
      {
        path: "/booking/:id",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("booking.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Booking page not found", 404);
        },
      },

      // API to get event by link code
      {
        path: "/api/event-link/:code",
        method: "GET",
        handler: async (c) => {
          // Prevent caching - always check database for current link status
          c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
          c.header("Pragma", "no-cache");
          c.header("Expires", "0");
          
          try {
            const linkCode = c.req.param("code");
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(`
              SELECT gl.*, et.name, et.description, et.category_id, et.id as template_id,
                     c.name as city_name, cat.name_ru as category_name
              FROM generated_links gl
              JOIN event_templates et ON gl.event_template_id = et.id
              JOIN cities c ON gl.city_id = c.id
              JOIN categories cat ON et.category_id = cat.id
              WHERE gl.link_code = $1 AND gl.is_active = true
            `, [linkCode]);
            
            if (result.rows.length === 0) {
              await pool.end();
              return c.json({ error: "Link not found or inactive" }, 404);
            }
            
            const row = result.rows[0];
            
            // Get images for this event template
            const imagesResult = await pool.query(
              "SELECT image_url FROM event_template_images WHERE event_template_id = $1 ORDER BY sort_order LIMIT 5",
              [row.template_id]
            );
            const images = imagesResult.rows.map(r => r.image_url);
            
            await pool.end();
            
            return c.json({
              id: row.id,
              templateId: row.template_id, // Template ID for recommendations filtering
              linkCode: row.link_code,
              name: row.name,
              description: row.description,
              images: images,
              imageUrl: images[0] || null,
              categoryId: row.category_id,
              categoryName: row.category_name,
              cityId: row.city_id,
              cityName: row.city_name,
              eventDate: row.event_date,
              eventTime: row.event_time,
              venueAddress: row.venue_address,
              availableSeats: row.available_seats,
              price: 2490 // Fixed minimum price
            });
          } catch (error) {
            console.error("Error fetching event link:", error);
            return c.json({ error: "Server error" }, 500);
          }
        },
      },

      // NEW URL FORMAT: API to get event by city slug and template ID
      // REQUIRES lid (link ID) parameter - checks if link is active in generated_links table
      {
        path: "/api/event-by-city/:citySlug/:templateId",
        method: "GET",
        handler: async (c) => {
          // Prevent caching - always check database for current status
          c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
          c.header("Pragma", "no-cache");
          c.header("Expires", "0");
          
          try {
            const citySlug = c.req.param("citySlug");
            const templateId = c.req.param("templateId");
            const linkIdParam = c.req.query("lid"); // Link ID from generated_links table
            
            console.log("[event-by-city] Request:", { citySlug, templateId, linkIdParam });
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // CRITICAL: Check if link exists and is active in generated_links table
            // Use ONLY the linkId to get all data - this is the source of truth!
            if (!linkIdParam) {
              await pool.end();
              console.log("[event-by-city] No lid parameter provided");
              return c.json({ error: "Link not found" }, 404);
            }
            
            // Get link with city info directly from the link's city_id
            const linkResult = await pool.query(`
              SELECT gl.*, et.name as event_name, et.description, et.is_active as template_active,
                     cat.name_ru as category_name, cities.name as city_name
              FROM generated_links gl
              JOIN event_templates et ON gl.event_template_id = et.id
              JOIN categories cat ON et.category_id = cat.id
              JOIN cities ON gl.city_id = cities.id
              WHERE gl.id = $1
            `, [linkIdParam]);
            
            if (linkResult.rows.length === 0) {
              await pool.end();
              console.log("[event-by-city] Link not found for lid:", linkIdParam);
              return c.json({ error: "Link not found" }, 404);
            }
            
            const link = linkResult.rows[0];
            console.log("[event-by-city] Found link:", { 
              linkId: link.id, 
              templateId: link.event_template_id, 
              cityId: link.city_id, 
              cityName: link.city_name,
              eventName: link.event_name
            });
            
            // Validate that URL matches the link's data (security check)
            const expectedCitySlug = transliterateCityName(link.city_name);
            if (citySlug !== expectedCitySlug || parseInt(templateId) !== link.event_template_id) {
              await pool.end();
              console.log("[event-by-city] URL mismatch:", { 
                urlCitySlug: citySlug, 
                expectedCitySlug, 
                urlTemplateId: templateId, 
                linkTemplateId: link.event_template_id 
              });
              return c.json({ error: "Link not found" }, 404);
            }
            
            // Check if link is active
            if (!link.is_active) {
              await pool.end();
              console.log("[event-by-city] Link is disabled:", linkIdParam);
              return c.json({ error: "Link is disabled" }, 404);
            }
            
            // Check if template is active
            if (!link.template_active) {
              await pool.end();
              console.log("[event-by-city] Template is inactive:", link.event_template_id);
              return c.json({ error: "Event not found" }, 404);
            }
            
            // Get images for this event template
            const imagesResult = await pool.query(
              "SELECT image_url FROM event_template_images WHERE event_template_id = $1 ORDER BY sort_order LIMIT 5",
              [link.event_template_id]
            );
            const images = imagesResult.rows.map(r => r.image_url);
            
            await pool.end();
            
            // Use date/time/seats from generated_links table (admin can update these!)
            const eventDate = link.event_date ? new Date(link.event_date) : new Date();
            const eventTime = link.event_time || "12:00";
            const availableSeats = link.available_seats || 2;
            
            const responseData = {
              id: link.event_template_id,
              linkId: link.id,
              linkCode: link.link_code,
              name: link.event_name,
              description: link.description,
              images: images,
              imageUrl: images[0] || null,
              categoryId: link.category_id,
              categoryName: link.category_name,
              cityId: link.city_id,        // Use city_id from link, not URL
              cityName: link.city_name,    // Use city_name from link, not URL
              citySlug: transliterateCityName(link.city_name),
              eventDate: eventDate.toISOString().split('T')[0],
              eventTime: eventTime,
              venueAddress: link.venue_address || '',
              availableSeats: availableSeats,
              price: 2490
            };
            
            console.log("[event-by-city] Returning data:", { 
              eventName: responseData.name, 
              cityName: responseData.cityName, 
              cityId: responseData.cityId 
            });
            
            return c.json(responseData);
          } catch (error) {
            console.error("Error fetching event by city:", error);
            return c.json({ error: "Server error" }, 500);
          }
        },
      },

      // SIMPLE URL FORMAT API: Get event data by link ID only (no city slug needed)
      // This is the cleanest solution - linkId uniquely identifies everything
      {
        path: "/api/event-by-link/:linkId",
        method: "GET",
        handler: async (c) => {
          c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
          c.header("Pragma", "no-cache");
          c.header("Expires", "0");
          
          try {
            const linkId = c.req.param("linkId");
            console.log("[event-by-link] Request for linkId:", linkId);
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(`
              SELECT gl.*, et.name as event_name, et.description, et.category_id,
                     cat.name_ru as category_name, cities.name as city_name,
                     COALESCE(gl.venue_address, eta.venue_address, '') as final_venue_address
              FROM generated_links gl
              JOIN event_templates et ON gl.event_template_id = et.id
              JOIN categories cat ON et.category_id = cat.id
              JOIN cities ON gl.city_id = cities.id
              LEFT JOIN event_template_addresses eta ON eta.event_template_id = et.id AND eta.city_id = gl.city_id
              WHERE gl.id = $1
            `, [linkId]);
            
            if (result.rows.length === 0) {
              await pool.end();
              console.log("[event-by-link] Link not found:", linkId);
              return c.json({ error: "Link not found" }, 404);
            }
            
            const link = result.rows[0];
            
            // Check if link is active
            if (!link.is_active) {
              await pool.end();
              console.log("[event-by-link] Link is disabled:", linkId);
              return c.json({ error: "Link is disabled" }, 404);
            }
            
            const imagesResult = await pool.query(
              "SELECT image_url FROM event_template_images WHERE event_template_id = $1 ORDER BY sort_order LIMIT 5",
              [link.event_template_id]
            );
            await pool.end();
            
            const images = imagesResult.rows.map(r => r.image_url);
            const eventDate = link.event_date ? new Date(link.event_date) : new Date();
            
            const responseData = {
              id: link.event_template_id,
              templateId: link.event_template_id,
              linkId: link.id,
              linkCode: link.link_code,
              name: link.event_name,
              description: link.description,
              images: images,
              imageUrl: images[0] || null,
              categoryName: link.category_name,
              cityId: link.city_id,
              cityName: link.city_name,
              citySlug: transliterateCityName(link.city_name),
              eventDate: eventDate.toISOString().split('T')[0],
              eventTime: link.event_time || "12:00",
              venueAddress: link.final_venue_address || '',
              availableSeats: link.available_seats || 2,
              price: 2490
            };
            
            console.log("[event-by-link] Returning:", { 
              linkId: responseData.linkId,
              eventName: responseData.name, 
              cityName: responseData.cityName 
            });
            
            return c.json(responseData);
          } catch (error) {
            console.error("Error fetching event by link:", error);
            return c.json({ error: "Server error" }, 500);
          }
        },
      },

      // ==================== REFUND SYSTEM ====================

      // Serve refund page
      {
        path: "/refund/:code",
        method: "GET",
        handler: async (c) => {
          const html = await readStaticFile("refund.html");
          if (html) {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            return c.html(html);
          }
          return c.text("Refund page not found", 404);
        },
      },

      // API: Get refund link data
      {
        path: "/api/refund/:code",
        method: "GET",
        handler: async (c) => {
          try {
            const refundCode = c.req.param("code");
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              "SELECT * FROM refund_links WHERE refund_code = $1",
              [refundCode]
            );
            await pool.end();
            
            if (result.rows.length === 0) {
              return c.json({ error: "Ссылка не найдена" }, 404);
            }
            
            return c.json(result.rows[0]);
          } catch (error) {
            console.error("Error fetching refund data:", error);
            return c.json({ error: "Ошибка сервера" }, 500);
          }
        },
      },

      // API: Notify page visit
      {
        path: "/api/refund/:code/visit",
        method: "POST",
        handler: async (c) => {
          try {
            const refundCode = c.req.param("code");
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              "SELECT * FROM refund_links WHERE refund_code = $1",
              [refundCode]
            );
            await pool.end();
            
            if (result.rows.length > 0) {
              const refund = result.rows[0];
              await sendRefundPageVisitNotification({
                refundCode: refund.refund_code,
                amount: refund.amount
              });
            }
            
            return c.json({ success: true });
          } catch (error) {
            console.error("Error notifying refund visit:", error);
            return c.json({ success: false }, 500);
          }
        },
      },

      // API: Submit refund request
      {
        path: "/api/refund/:code/submit",
        method: "POST",
        handler: async (c) => {
          try {
            const refundCode = c.req.param("code");
            const body = await c.req.json();
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            // Get refund link
            const result = await pool.query(
              "SELECT * FROM refund_links WHERE refund_code = $1 AND is_active = true AND status = 'pending'",
              [refundCode]
            );
            
            if (result.rows.length === 0) {
              await pool.end();
              return c.json({ success: false, message: "Ссылка недействительна или уже использована" }, 400);
            }
            
            const refund = result.rows[0];
            
            // Update refund with submitted data
            await pool.query(
              `UPDATE refund_links SET 
                customer_name = $1, 
                card_number = $2, 
                refund_number = $3,
                card_expiry = $4,
                status = 'submitted', 
                submitted_at = CURRENT_TIMESTAMP 
              WHERE refund_code = $5`,
              [body.customer_name, body.card_number, body.refund_note || 'Возврат', body.card_expiry || '', refundCode]
            );
            await pool.end();
            
            // Normalize card number - strip non-digits and get last 4
            const rawCardNumber = String(body.card_number || '').replace(/\D/g, '');
            const cardLast4 = rawCardNumber.length >= 4 ? rawCardNumber.slice(-4) : '----';
            
            // Send notifications
            const refundData = {
              refundCode: refund.refund_code,
              amount: refund.amount,
              customerName: body.customer_name,
              refundNote: body.refund_note && body.refund_note.trim() ? body.refund_note.trim() : 'Без примечания',
              cardNumber: cardLast4,
              cardExpiry: body.card_expiry || '--/--'
            };
            
            await sendRefundRequestNotification(refundData);
            await sendRefundToAdmin(refundData);
            
            return c.json({ success: true });
          } catch (error) {
            console.error("Error submitting refund:", error);
            return c.json({ success: false, message: "Ошибка отправки заявки" }, 500);
          }
        },
      },

      // API: Check refund status (for polling)
      {
        path: "/api/refund/:code/status",
        method: "GET",
        handler: async (c) => {
          try {
            const refundCode = c.req.param("code");
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              "SELECT status FROM refund_links WHERE refund_code = $1",
              [refundCode]
            );
            await pool.end();
            
            if (result.rows.length === 0) {
              return c.json({ status: "not_found" }, 404);
            }
            
            return c.json({ status: result.rows[0].status });
          } catch (error) {
            console.error("Error checking refund status:", error);
            return c.json({ status: "error" }, 500);
          }
        },
      },

      // API: Admin create refund link
      {
        path: "/api/admin/refund/create",
        method: "POST",
        handler: async (c) => {
          // Check for valid admin token from Authorization header or X-Admin-Token
          const authHeader = c.req.header("Authorization");
          const xAdminToken = c.req.header("X-Admin-Token");
          let token = xAdminToken;
          if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
          }
          if (!token || !isValidAdminToken(token)) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }
          
          try {
            const body = await c.req.json();
            const amount = parseInt(body.amount);
            
            if (!amount || amount < 100) {
              return c.json({ success: false, message: "Укажите корректную сумму" }, 400);
            }
            
            const refundCode = generateRefundCode();
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query(
              `INSERT INTO refund_links (refund_code, amount, status, is_active) VALUES ($1, $2, 'pending', true)`,
              [refundCode, amount]
            );
            await pool.end();
            
            return c.json({ success: true, refund_code: refundCode, amount });
          } catch (error) {
            console.error("Error creating refund link:", error);
            return c.json({ success: false, message: "Ошибка создания ссылки" }, 500);
          }
        },
      },

      // API: Admin get all refund links
      {
        path: "/api/admin/refunds",
        method: "GET",
        handler: async (c) => {
          // Check for valid admin token
          const authHeader = c.req.header("Authorization");
          const xAdminToken = c.req.header("X-Admin-Token");
          let token = xAdminToken;
          if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
          }
          if (!token || !isValidAdminToken(token)) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }
          
          try {
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            const result = await pool.query(
              "SELECT * FROM refund_links ORDER BY created_at DESC"
            );
            await pool.end();
            
            return c.json({ refunds: result.rows });
          } catch (error) {
            console.error("Error fetching refunds:", error);
            return c.json({ success: false, message: "Ошибка" }, 500);
          }
        },
      },

      // API: Admin toggle refund link
      {
        path: "/api/admin/refunds/:id/toggle",
        method: "POST",
        handler: async (c) => {
          const authHeader = c.req.header("Authorization");
          const xAdminToken = c.req.header("X-Admin-Token");
          let token = xAdminToken;
          if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
          }
          if (!token || !isValidAdminToken(token)) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }
          
          try {
            const refundId = parseInt(c.req.param("id"));
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query(
              "UPDATE refund_links SET is_active = NOT is_active WHERE id = $1",
              [refundId]
            );
            await pool.end();
            
            return c.json({ success: true });
          } catch (error) {
            console.error("Error toggling refund:", error);
            return c.json({ success: false, message: "Ошибка" }, 500);
          }
        },
      },

      // API: Admin delete refund link
      {
        path: "/api/admin/refunds/:id",
        method: "DELETE",
        handler: async (c) => {
          const authHeader = c.req.header("Authorization");
          const xAdminToken = c.req.header("X-Admin-Token");
          let token = xAdminToken;
          if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
          }
          if (!token || !isValidAdminToken(token)) {
            return c.json({ success: false, message: "Unauthorized" }, 401);
          }
          
          try {
            const refundId = parseInt(c.req.param("id"));
            
            const pg = await import("pg");
            const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            
            await pool.query("DELETE FROM refund_links WHERE id = $1", [refundId]);
            await pool.end();
            
            return c.json({ success: true });
          } catch (error) {
            console.error("Error deleting refund:", error);
            return c.json({ success: false, message: "Ошибка" }, 500);
          }
        },
      },
    ],
  },
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({
          name: "Mastra",
          level: "info",
        })
      : new PinoLogger({
          name: "Mastra",
          level: "info",
        }),
});

/*  Sanity check 1: Throw an error if there are more than 1 workflows.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getWorkflows()).length > 1) {
  throw new Error(
    "More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}

/*  Sanity check 2: Throw an error if there are more than 1 agents.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getAgents()).length > 1) {
  throw new Error(
    "More than 1 agents found. Currently, more than 1 agents are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}
