import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const sendTelegramNotificationTool = createTool({
  id: "send-telegram-notification",
  description:
    "Send a notification message to a Telegram chat or channel. Use this to notify admins about new orders, payment confirmations, or send updates to customers.",

  inputSchema: z.object({
    chatId: z
      .string()
      .describe("Telegram chat ID or channel ID to send the message to"),
    message: z.string().describe("The message text to send"),
    parseMode: z
      .enum(["HTML", "Markdown", "MarkdownV2"])
      .optional()
      .default("HTML")
      .describe("Parse mode for message formatting"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.number().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [sendTelegramNotificationTool] Sending to chat:", context.chatId);

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      logger?.error("❌ [sendTelegramNotificationTool] TELEGRAM_BOT_TOKEN not set");
      return {
        success: false,
        error: "Telegram bot token not configured",
      };
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chat_id: context.chatId,
            text: context.message,
            parse_mode: context.parseMode || "HTML",
          }),
        },
      );

      const data = await response.json();

      if (data.ok) {
        logger?.info("✅ [sendTelegramNotificationTool] Message sent, ID:", data.result.message_id);
        return {
          success: true,
          messageId: data.result.message_id,
        };
      } else {
        logger?.error("❌ [sendTelegramNotificationTool] Telegram API error:", data.description);
        return {
          success: false,
          error: data.description || "Failed to send message",
        };
      }
    } catch (error) {
      logger?.error("❌ [sendTelegramNotificationTool] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});
