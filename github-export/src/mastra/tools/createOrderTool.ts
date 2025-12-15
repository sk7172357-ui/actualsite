import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (pool) return pool;
  
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn("[createOrderTool] DATABASE_URL not set");
    return null;
  }
  
  try {
    pool = new Pool({ connectionString: dbUrl });
    return pool;
  } catch (error) {
    console.error("[createOrderTool] Failed to create pool:", error);
    return null;
  }
}

function generateOrderCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `ORD-${code}`;
}

async function withTransaction<T>(
  dbPool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const createOrderTool = createTool({
  id: "create-order",
  description:
    "Create a new order for an event ticket. Use this when the user wants to book or purchase a ticket for an event. Collects customer information and creates the order.",

  inputSchema: z.object({
    eventId: z.number().describe("The ID of the event to book"),
    customerName: z.string().describe("Full name of the customer"),
    customerPhone: z.string().describe("Customer phone number"),
    customerEmail: z.string().optional().describe("Customer email (optional)"),
    seatsCount: z.number().default(1).describe("Number of seats to book"),
    totalPrice: z.number().optional().describe("Total price from frontend (ticket type specific)"),
    telegramChatId: z.string().optional().describe("Telegram chat ID for notifications"),
    telegramUsername: z.string().optional().describe("Telegram username"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    orderCode: z.string().optional(),
    orderId: z.number().optional(),
    eventName: z.string().optional(),
    eventDate: z.string().optional(),
    eventTime: z.string().optional(),
    cityName: z.string().optional(),
    customerName: z.string().optional(),
    customerPhone: z.string().optional(),
    customerEmail: z.string().optional(),
    seatsCount: z.number().optional(),
    totalPrice: z.number().optional(),
    message: z.string(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [createOrderTool] Creating order with params:", context);

    const dbPool = getPool();
    
    if (!dbPool) {
      logger?.warn("⚠️ [createOrderTool] Database not available");
      return {
        success: false,
        message: "База данных недоступна. Попробуйте позже.",
      };
    }

    try {
      return await withTransaction(dbPool, async (client) => {
        const eventResult = await client.query(
          `SELECT e.*, c.name_ru as category_name, ci.name as city_name 
           FROM events e 
           JOIN categories c ON e.category_id = c.id 
           JOIN cities ci ON e.city_id = ci.id 
           WHERE e.id = $1
           FOR UPDATE`,
          [context.eventId],
        );

        if (eventResult.rows.length === 0) {
          logger?.warn("⚠️ [createOrderTool] Event not found:", context.eventId);
          return {
            success: false,
            message: "Мероприятие не найдено",
          };
        }

        const event = eventResult.rows[0];
        const seatsCount = context.seatsCount || 1;

        if (event.available_seats < seatsCount) {
          logger?.warn("⚠️ [createOrderTool] Not enough seats available");
          return {
            success: false,
            message: `Недостаточно мест. Доступно: ${event.available_seats}`,
          };
        }

        const orderCode = generateOrderCode();
        // Use provided totalPrice (from ticket type selection) or calculate from event price
        const totalPrice = context.totalPrice || (parseFloat(event.price) * seatsCount);

        logger?.info("📝 [createOrderTool] Inserting order with transaction...");
        const orderResult = await client.query(
          `INSERT INTO orders 
           (order_code, event_id, customer_name, customer_phone, customer_email, 
            telegram_chat_id, telegram_username, seats_count, total_price, status, payment_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'pending')
           RETURNING id`,
          [
            orderCode,
            context.eventId,
            context.customerName,
            context.customerPhone,
            context.customerEmail || null,
            context.telegramChatId || null,
            context.telegramUsername || null,
            seatsCount,
            totalPrice,
          ],
        );

        await client.query(
          "UPDATE events SET available_seats = available_seats - $1 WHERE id = $2",
          [seatsCount, context.eventId],
        );

        logger?.info("✅ [createOrderTool] Order created:", orderCode);

        return {
          success: true,
          orderCode,
          orderId: orderResult.rows[0].id,
          eventName: event.name,
          eventDate: event.date?.toISOString?.()?.split("T")[0] || String(event.date),
          eventTime: event.time || "00:00",
          cityName: event.city_name,
          customerName: context.customerName,
          customerPhone: context.customerPhone,
          customerEmail: context.customerEmail,
          seatsCount,
          totalPrice,
          message: `Заказ ${orderCode} успешно создан! Мероприятие: ${event.name}, ${event.city_name}. Сумма: ${totalPrice} руб.`,
        };
      });
    } catch (error) {
      logger?.error("❌ [createOrderTool] Error:", error);
      return {
        success: false,
        message: "Ошибка при создании заказа. Попробуйте позже.",
      };
    }
  },
});
