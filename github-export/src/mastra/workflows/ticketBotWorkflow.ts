import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { ticketBotAgent } from "../agents/ticketBotAgent";

/**
 * Ticket Bot Workflow
 *
 * This workflow handles Telegram messages for the ticket booking bot.
 * It follows the required 2-step pattern:
 * Step 1: Process message with the AI agent
 * Step 2: Send response back to Telegram
 */

/**
 * Step 1: Process message with the ticket bot agent
 */
const processWithAgent = createStep({
  id: "process-with-agent",
  description: "Process the incoming Telegram message using the ticket bot AI agent",

  inputSchema: z.object({
    message: z.string().describe("The message from the Telegram user"),
    chatId: z.string().describe("Telegram chat ID for response"),
    username: z.string().optional().describe("Telegram username"),
    threadId: z.string().optional().describe("Thread ID for conversation memory"),
  }),

  outputSchema: z.object({
    response: z.string(),
    chatId: z.string(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🚀 [Step 1] Processing message with agent...", {
      message: inputData.message,
      chatId: inputData.chatId,
      username: inputData.username,
    });

    try {
      // Call the agent using generateLegacy for SDK v4 compatibility
      const result = await ticketBotAgent.generateLegacy(
        [{ role: "user", content: inputData.message }],
        {
          resourceId: `telegram-${inputData.chatId}`,
          threadId: inputData.threadId || `telegram-thread-${inputData.chatId}`,
          maxSteps: 10,
        },
      );

      logger?.info("✅ [Step 1] Agent response generated", {
        responseLength: result.text?.length || 0,
      });

      return {
        response: result.text || "Извините, произошла ошибка. Попробуйте ещё раз.",
        chatId: inputData.chatId,
        success: true,
      };
    } catch (error) {
      logger?.error("❌ [Step 1] Agent error:", error);
      return {
        response: "Произошла ошибка при обработке запроса. Пожалуйста, попробуйте позже.",
        chatId: inputData.chatId,
        success: false,
      };
    }
  },
});

/**
 * Step 2: Send response to Telegram
 */
const sendToTelegram = createStep({
  id: "send-to-telegram",
  description: "Send the agent's response back to the Telegram user",

  inputSchema: z.object({
    response: z.string(),
    chatId: z.string(),
    success: z.boolean(),
  }),

  outputSchema: z.object({
    messageSent: z.boolean(),
    messageId: z.number().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📤 [Step 2] Sending response to Telegram...", {
      chatId: inputData.chatId,
      responseLength: inputData.response.length,
    });

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      logger?.error("❌ [Step 2] TELEGRAM_BOT_TOKEN not configured");
      return {
        messageSent: false,
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
            chat_id: inputData.chatId,
            text: inputData.response,
            parse_mode: "HTML",
          }),
        },
      );

      const data = await response.json();

      if (data.ok) {
        logger?.info("✅ [Step 2] Message sent successfully", {
          messageId: data.result.message_id,
        });
        return {
          messageSent: true,
          messageId: data.result.message_id,
        };
      } else {
        logger?.error("❌ [Step 2] Telegram API error:", data.description);
        return {
          messageSent: false,
          error: data.description || "Failed to send message",
        };
      }
    } catch (error) {
      logger?.error("❌ [Step 2] Error sending to Telegram:", error);
      return {
        messageSent: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

/**
 * Create the workflow by chaining the two steps
 */
export const ticketBotWorkflow = createWorkflow({
  id: "ticket-bot-workflow",

  inputSchema: z.object({
    message: z.string().describe("The message from the Telegram user"),
    chatId: z.string().describe("Telegram chat ID for response"),
    username: z.string().optional().describe("Telegram username"),
    threadId: z.string().optional().describe("Thread ID for conversation memory"),
  }) as any,

  outputSchema: z.object({
    messageSent: z.boolean(),
    messageId: z.number().optional(),
    error: z.string().optional(),
  }),
})
  .then(processWithAgent as any)
  .then(sendToTelegram as any)
  .commit();
