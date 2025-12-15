import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (pool) return pool;
  
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn("[manageOrderTool] DATABASE_URL not set");
    return null;
  }
  
  try {
    pool = new Pool({ connectionString: dbUrl });
    return pool;
  } catch (error) {
    console.error("[manageOrderTool] Failed to create pool:", error);
    return null;
  }
}

export const manageOrderTool = createTool({
  id: "manage-order",
  description:
    "Manage existing orders - confirm payment, reject payment, cancel order, or get order details. Use this when admin needs to approve/reject a payment or when checking order status.",

  inputSchema: z.object({
    action: z
      .enum(["get", "confirm_payment", "reject_payment", "cancel", "list_pending"])
      .describe("Action to perform on the order"),
    orderCode: z
      .string()
      .optional()
      .describe("Order code (required for get, confirm, reject, cancel actions)"),
    orderId: z
      .number()
      .optional()
      .describe("Order ID (alternative to orderCode for confirm/reject)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    order: z
      .object({
        id: z.number(),
        orderCode: z.string(),
        eventName: z.string(),
        categoryName: z.string(),
        cityName: z.string(),
        eventDate: z.string().nullable(),
        eventTime: z.string().nullable(),
        customerName: z.string(),
        customerPhone: z.string(),
        customerEmail: z.string().nullable(),
        telegramUsername: z.string().nullable(),
        seatsCount: z.number(),
        totalPrice: z.number(),
        status: z.string(),
        paymentStatus: z.string(),
        createdAt: z.string(),
        tickets: z.record(z.number()).optional(),
      })
      .optional(),
    orders: z
      .array(
        z.object({
          id: z.number(),
          orderCode: z.string(),
          eventName: z.string(),
          customerName: z.string(),
          totalPrice: z.number(),
          status: z.string(),
          paymentStatus: z.string(),
        }),
      )
      .optional(),
    message: z.string(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [manageOrderTool] Action:", context.action, "OrderCode:", context.orderCode);

    const dbPool = getPool();
    
    if (!dbPool) {
      logger?.warn("⚠️ [manageOrderTool] Database not available");
      return {
        success: false,
        message: "База данных недоступна",
      };
    }

    try {
      if (context.action === "list_pending") {
        logger?.info("📝 [manageOrderTool] Listing pending orders...");
        const result = await dbPool.query(
          `SELECT o.id, o.order_code, e.name as event_name, o.customer_name, 
                  o.total_price::numeric, o.status, o.payment_status
           FROM orders o
           JOIN events e ON o.event_id = e.id
           WHERE o.payment_status = 'pending'
           ORDER BY o.created_at DESC
           LIMIT 20`,
        );

        const orders = result.rows.map((row) => ({
          id: row.id,
          orderCode: row.order_code,
          eventName: row.event_name,
          customerName: row.customer_name,
          totalPrice: parseFloat(row.total_price),
          status: row.status,
          paymentStatus: row.payment_status,
        }));

        logger?.info(`✅ [manageOrderTool] Found ${orders.length} pending orders`);
        return {
          success: true,
          orders,
          message: `Найдено ${orders.length} заказов, ожидающих подтверждения`,
        };
      }

      if (!context.orderCode && !context.orderId) {
        return {
          success: false,
          message: "Код заказа или ID заказа обязателен для этого действия",
        };
      }

      let orderResult;
      const whereClause = context.orderId ? "o.id = $1" : "o.order_code = $1";
      const whereValue = context.orderId || context.orderCode;
      
      // First try regular orders (with event_id)
      orderResult = await dbPool.query(
        `SELECT o.*, e.name as event_name, e.date::text as event_date, e.time::text as event_time,
                c.name_ru as category_name, ci.name as city_name
         FROM orders o
         JOIN events e ON o.event_id = e.id
         JOIN categories c ON e.category_id = c.id
         JOIN cities ci ON e.city_id = ci.id
         WHERE ${whereClause}`,
        [whereValue],
      );
      
      // If not found, try generated link orders (with event_template_id)
      if (orderResult.rows.length === 0) {
        orderResult = await dbPool.query(
          `SELECT o.*, et.name as event_name, gl.event_date::text as event_date, gl.event_time::text as event_time,
                  cat.name_ru as category_name, ci.name as city_name
           FROM orders o
           JOIN event_templates et ON o.event_template_id = et.id
           JOIN categories cat ON et.category_id = cat.id
           LEFT JOIN generated_links gl ON gl.link_code = o.link_code
           LEFT JOIN cities ci ON gl.city_id = ci.id
           WHERE ${whereClause}`,
          [whereValue],
        );
      }

      if (orderResult.rows.length === 0) {
        logger?.warn("⚠️ [manageOrderTool] Order not found:", context.orderCode || context.orderId);
        return {
          success: false,
          message: `Заказ ${context.orderCode || context.orderId} не найден`,
        };
      }

      const row = orderResult.rows[0];
      
      let ticketsData: Record<string, number> | undefined = undefined;
      if (row.tickets_json) {
        try {
          ticketsData = JSON.parse(row.tickets_json);
        } catch (e) {}
      }
      
      const order = {
        id: row.id,
        orderCode: row.order_code,
        eventName: row.event_name,
        categoryName: row.category_name,
        cityName: row.city_name,
        eventDate: row.event_date,
        eventTime: row.event_time,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        customerEmail: row.customer_email,
        telegramUsername: row.telegram_username,
        seatsCount: row.seats_count,
        totalPrice: parseFloat(row.total_price),
        status: row.status,
        paymentStatus: row.payment_status,
        createdAt: row.created_at?.toISOString() || "",
        tickets: ticketsData,
      };

      if (context.action === "get") {
        logger?.info("✅ [manageOrderTool] Order found:", order.orderCode);
        return {
          success: true,
          order,
          message: `Заказ ${order.orderCode} найден`,
        };
      }

      if (context.action === "confirm_payment") {
        await dbPool.query(
          "UPDATE orders SET payment_status = 'confirmed', status = 'confirmed', updated_at = NOW() WHERE id = $1",
          [order.id],
        );
        order.paymentStatus = "confirmed";
        order.status = "confirmed";
        logger?.info("✅ [manageOrderTool] Payment confirmed:", order.orderCode);
        return {
          success: true,
          order,
          message: `✅ Оплата заказа ${order.orderCode} подтверждена! Клиент: ${order.customerName}, Сумма: ${order.totalPrice} руб.`,
        };
      }

      if (context.action === "reject_payment") {
        await dbPool.query(
          "UPDATE orders SET payment_status = 'rejected', status = 'rejected', updated_at = NOW() WHERE id = $1",
          [order.id],
        );
        
        await dbPool.query(
          "UPDATE events SET available_seats = available_seats + $1 WHERE id = $2",
          [row.seats_count, row.event_id],
        );
        
        order.paymentStatus = "rejected";
        order.status = "rejected";
        logger?.info("❌ [manageOrderTool] Payment rejected:", order.orderCode);
        return {
          success: true,
          order,
          message: `❌ Оплата заказа ${order.orderCode} отклонена. Места возвращены в продажу.`,
        };
      }

      if (context.action === "cancel") {
        await dbPool.query(
          "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
          [order.id],
        );
        
        if (row.payment_status !== "rejected") {
          await dbPool.query(
            "UPDATE events SET available_seats = available_seats + $1 WHERE id = $2",
            [row.seats_count, row.event_id],
          );
        }
        
        order.status = "cancelled";
        logger?.info("🚫 [manageOrderTool] Order cancelled:", order.orderCode);
        return {
          success: true,
          order,
          message: `Заказ ${order.orderCode} отменён`,
        };
      }

      return {
        success: false,
        message: "Неизвестное действие",
      };
    } catch (error) {
      logger?.error("❌ [manageOrderTool] Error:", error);
      return {
        success: false,
        message: "Ошибка при обработке заказа",
      };
    }
  },
});
