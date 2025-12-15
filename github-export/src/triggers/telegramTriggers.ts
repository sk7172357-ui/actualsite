/**
 * Telegram Trigger - Webhook-based Workflow Triggering
 *
 * This module provides Telegram bot event handling for Mastra workflows.
 * When Telegram messages are received, this trigger starts your workflow.
 *
 * PATTERN:
 * 1. Import registerTelegramTrigger and your workflow
 * 2. Call registerTelegramTrigger with a triggerType and handler
 * 3. Spread the result into the apiRoutes array in src/mastra/index.ts
 *
 * USAGE in src/mastra/index.ts:
 *
 * ```typescript
 * import { registerTelegramTrigger } from "../triggers/telegramTriggers";
 * import { telegramBotWorkflow } from "./workflows/telegramBotWorkflow";
 * import { inngest } from "./inngest";
 *
 * // In the apiRoutes array:
 * ...registerTelegramTrigger({
 *   triggerType: "telegram/message",
 *   handler: async (mastra, triggerInfo) => {
 *     const run = await telegramBotWorkflow.createRunAsync();
 *     return await inngest.send({
 *       name: `workflow.${telegramBotWorkflow.id}`,
 *       data: {
 *         runId: run?.runId,
 *         inputData: {},
 *       },
 *     });
 *   }
 * })
 * ```
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";

import { registerApiRoute } from "../mastra/inngest";
import { Mastra } from "@mastra/core";
import pg from "pg";
import { updateOrderMessageStatus, answerCallbackQuery } from "../mastra/services/telegramAdminService";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.warn(
    "Trying to initialize Telegram triggers without TELEGRAM_BOT_TOKEN. Can you confirm that the Telegram integration is configured correctly?",
  );
}

// Handler for Telegram callback queries (button presses)
export function registerTelegramCallbackHandler() {
  return [
    registerApiRoute("/webhooks/telegram/callback", {
      method: "POST",
      handler: async (c) => {
        const logger = c.get("mastra")?.getLogger();
        try {
          const payload = await c.req.json();
          
          if (!payload.callback_query) {
            return c.text("No callback query", 200);
          }
          
          const callbackQuery = payload.callback_query;
          const callbackData = callbackQuery.data;
          const chatId = callbackQuery.message.chat.id;
          const messageId = callbackQuery.message.message_id;
          const adminUsername = callbackQuery.from.username;
          
          logger?.info("📝 [Telegram] Callback query:", callbackData);
          
          // Parse callback data: confirm_123 or reject_123
          const [action, orderIdStr] = callbackData.split("_");
          const orderId = parseInt(orderIdStr);
          
          if (!orderId || !["confirm", "reject"].includes(action)) {
            await answerCallbackQuery(callbackQuery.id, "Неизвестная команда");
            return c.text("OK", 200);
          }
          
          const dbUrl = process.env.DATABASE_URL;
          if (!dbUrl) {
            await answerCallbackQuery(callbackQuery.id, "Ошибка: база данных недоступна");
            return c.text("OK", 200);
          }
          
          const pool = new pg.Pool({ connectionString: dbUrl });
          
          try {
            // Get order info
            const orderResult = await pool.query(
              "SELECT order_code, status FROM orders WHERE id = $1",
              [orderId]
            );
            
            if (orderResult.rows.length === 0) {
              await answerCallbackQuery(callbackQuery.id, "Заказ не найден");
              await pool.end();
              return c.text("OK", 200);
            }
            
            const order = orderResult.rows[0];
            const newStatus = action === "confirm" ? "confirmed" : "rejected";
            
            // Update order status
            await pool.query(
              "UPDATE orders SET status = $1, payment_status = $2 WHERE id = $3",
              [newStatus, newStatus === "confirmed" ? "paid" : "failed", orderId]
            );
            
            await pool.end();
            
            // Update the Telegram message
            await updateOrderMessageStatus(
              chatId,
              messageId,
              order.order_code,
              newStatus,
              adminUsername
            );
            
            const responseText = action === "confirm" 
              ? "✅ Оплата подтверждена!" 
              : "❌ Заказ отклонён";
            
            await answerCallbackQuery(callbackQuery.id, responseText);
            
            logger?.info(`✅ [Telegram] Order ${order.order_code} ${newStatus}`);
            
          } catch (dbError) {
            logger?.error("Database error:", dbError);
            await answerCallbackQuery(callbackQuery.id, "Ошибка базы данных");
          }
          
          return c.text("OK", 200);
        } catch (error) {
          logger?.error("Error handling Telegram callback:", error);
          return c.text("Internal Server Error", 500);
        }
      },
    }),
  ];
}

export type TriggerInfoTelegramOnNewMessage = {
  type: "telegram/message";
  params: {
    userName: string;
    message: string;
  };
  payload: any;
};

export function registerTelegramTrigger({
  triggerType,
  handler,
}: {
  triggerType: string;
  handler: (
    mastra: Mastra,
    triggerInfo: TriggerInfoTelegramOnNewMessage,
  ) => Promise<void>;
}) {
  return [
    registerApiRoute("/webhooks/telegram/action", {
      method: "POST",
      handler: async (c) => {
        const mastra = c.get("mastra");
        const logger = mastra.getLogger();
        try {
          const payload = await c.req.json();

          logger?.info("📝 [Telegram] payload", payload);

          await handler(mastra, {
            type: triggerType,
            params: {
              userName: payload.message.from.username,
              message: payload.message.text,
            },
            payload,
          } as TriggerInfoTelegramOnNewMessage);

          return c.text("OK", 200);
        } catch (error) {
          logger?.error("Error handling Telegram webhook:", error);
          return c.text("Internal Server Error", 500);
        }
      },
    }),
  ];
}
