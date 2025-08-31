const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// Настройки
const BOT_TOKEN = "8353683466:AAGXDOv_OjBs5BIdITVuAmF71sFoe2We29I"; // Замените на ваш токен бота
const API_KEY = "XGXVQZX24QKQ3YGL";
const API_BASE = "https://api.moneyplace.io";
const MOKKY_API = "https://e957a177cfe4e411.mokky.dev";

// Создание экземпляра бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Глобальные переменные
const trackingTasks = new Map(); // Кэш для быстрого доступа
const userStates = new Map(); // FSM состояния пользователей

// Конфигурация маркетплейсов
const MARKETPLACES = {
  wildberries: {
    name: "Wildberries",
    emoji: "🟣",
  },
  ozon: {
    name: "Ozon",
    emoji: "🔵",
  },
};

// Конфигурация периодов
const PERIODS = {
  "10s": { seconds: 10, name: "10 секунд" },
  "20s": { seconds: 20, name: "20 секунд" },
  "50s": { seconds: 50, name: "50 секунд" },
  "1h": { seconds: 3600, name: "1 час" },
  "2h": { seconds: 7200, name: "2 часа" },
  "5h": { seconds: 18000, name: "5 часов" },
  "10h": { seconds: 36000, name: "10 часов" },
  "12h": { seconds: 43200, name: "12 часов" },
};

// Добавляем новое состояние
const STATES = {
  IDLE: "idle",
  WAITING_ARTICLE: "waiting_article",
  SELECTING_MARKETPLACE: "selecting_marketplace",
  SELECTING_PERIOD: "selecting_period",
  SELECTING_NOTIFICATION: "selecting_notification",
  EDITING_PERIOD: "editing_period",
  EDITING_NOTIFY: "editing_notify", // Добавляем это
};

// Класс для отслеживания задач
class TrackingTask {
  constructor(userId, article, marketplace, periodSeconds, notifyAlways) {
    this.userId = userId;
    this.article = article;
    this.marketplace = marketplace;
    this.periodSeconds = periodSeconds;
    this.notifyAlways = notifyAlways;
    this.lastPrice = null;
    this.lastCheck = null;
    this.active = true;
    this.productName = "";
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }
}

// API функции для работы с Mokky
class MokkyAPI {
  // Получить все отслеживания пользователя
  static async getUserTrackings(userId) {
    try {
      const response = await axios.get(
        `${MOKKY_API}/trackings?userId=${userId}`
      );
      return response.data || [];
    } catch (error) {
      console.error("Error getting user trackings:", error.message);
      return [];
    }
  }

  // Создать новое отслеживание
  static async createTracking(trackingData) {
    try {
      const response = await axios.post(`${MOKKY_API}/trackings`, trackingData);
      return response.data;
    } catch (error) {
      console.error("Error creating tracking:", error.message);
      return null;
    }
  }

  // Обновить отслеживание
  static async updateTracking(id, updateData) {
    try {
      const response = await axios.patch(
        `${MOKKY_API}/trackings/${id}`,
        updateData
      );
      return response.data;
    } catch (error) {
      console.error("Error updating tracking:", error.message);
      return null;
    }
  }

  // Удалить отслеживание
  static async deleteTracking(id) {
    try {
      await axios.delete(`${MOKKY_API}/trackings/${id}`);
      return true;
    } catch (error) {
      console.error("Error deleting tracking:", error.message);
      return false;
    }
  }

  // Получить отслеживание по ID
  static async getTracking(id) {
    try {
      const response = await axios.get(`${MOKKY_API}/trackings/${id}`);
      return response.data;
    } catch (error) {
      console.error("Error getting tracking:", error.message);
      return null;
    }
  }

  // Получить все активные отслеживания
  static async getAllActiveTrackings() {
    try {
      const response = await axios.get(`${MOKKY_API}/trackings?active=true`);
      return response.data || [];
    } catch (error) {
      console.error("Error getting active trackings:", error.message);
      return [];
    }
  }

  // Сохранить состояние пользователя
  static async saveUserState(userId, state) {
    try {
      const response = await axios.get(
        `${MOKKY_API}/userStates?userId=${userId}`
      );
      const existingStates = response.data || [];

      if (existingStates.length > 0) {
        // Обновляем существующее состояние
        await axios.patch(`${MOKKY_API}/userStates/${existingStates[0].id}`, {
          state: state,
          updatedAt: new Date().toISOString(),
        });
      } else {
        // Создаем новое состояние
        await axios.post(`${MOKKY_API}/userStates`, {
          userId: userId,
          state: state,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error("Error saving user state:", error.message);
    }
  }

  // Получить состояние пользователя
  static async getUserState(userId) {
    try {
      const response = await axios.get(
        `${MOKKY_API}/userStates?userId=${userId}`
      );
      const states = response.data || [];
      return states.length > 0 ? states[0].state : { state: STATES.IDLE };
    } catch (error) {
      console.error("Error getting user state:", error.message);
      return { state: STATES.IDLE };
    }
  }
}

// Функция для выполнения запроса к API товаров
async function makeApiRequest(article, marketplace) {
  try {
    const params = new URLSearchParams({
      "q[sku][equal]": article,
      "q[mp][equal]": marketplace,
      expand: "category,seller,brand",
    });

    const response = await axios.get(`${API_BASE}/v1/product?${params}`, {
      headers: {
        Authorization: `Token ${API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    return null;
  } catch (error) {
    console.error("API Error:", error.message);
    return null;
  }
}

// Форматирование цены
function formatPrice(price) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 0,
  }).format(price);
}

// Форматирование чисел
function formatNumber(num) {
  return new Intl.NumberFormat("ru-RU").format(num);
}

// Форматирование информации о товаре
function formatProductInfo(product) {
  const marketplaceInfo = MARKETPLACES[product.mp] || {
    name: "Unknown",
    emoji: "❓",
  };

  let text = `${marketplaceInfo.emoji} **${
    product.name || "Неизвестный товар"
  }**\n\n`;
  text += `🏪 Маркетплейс: ${marketplaceInfo.name}\n`;
  text += `📦 Артикул: \`${product.sku || "N/A"}\`\n`;
  text += `💰 Цена: **${formatPrice(product.real_price || 0)}**\n`;

  if (product.discount > 0) {
    text += `🔥 Скидка: ${product.discount}%\n`;
    text += `💸 Цена без скидки: ~~${formatPrice(
      product.price_with_discount || 0
    )}~~\n`;
  }

  text += `📊 Наличие: ${product.amount || 0}\n`;

  if (product.rate) {
    text += `⭐ Рейтинг: ${product.rate}\n`;
  }

  if (product.comments_count) {
    text += `💬 Отзывы: ${formatNumber(product.comments_count)}\n`;
  }

  text += `🕒 Время проверки: ${new Date().toLocaleString("ru-RU")}`;

  return text;
}

// Создание главной клавиатуры
// Создание главной клавиатуры
function getStartKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ Добавить отслеживание", callback_data: "add_tracking" }],
      [{ text: "📋 Мои отслеживания", callback_data: "list_tracking" }],
      [
        { text: "📊 Статистика", callback_data: "statistics" },
        { text: "⚙️ Настройки", callback_data: "settings" },
      ],
      [{ text: "🔍 Найти товар", url: "https://t.me/search_wb_ozon_bot" }], // Новая кнопка
      [{ text: "ℹ️ Помощь", callback_data: "help" }],
    ],
  };
}

function getMainReplyKeyboard() {
  return {
    keyboard: [
      ["➕ Добавить", "📋 Мои отслеживания"],
      ["📊 Статистика", "🔍 Найти товар"],
      ["ℹ️ Помощь", "⚙️ Настройки"],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// Создание клавиатуры управления отслеживаниями
function getTrackingManagementKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "▶️ Запустить все", callback_data: "start_all" },
        { text: "⏸️ Остановить все", callback_data: "stop_all" },
      ],
      [
        { text: "🗑️ Удалить неактивные", callback_data: "delete_inactive" },
        { text: "🧹 Очистить все", callback_data: "delete_all" },
      ],
      [{ text: "🔙 Назад", callback_data: "back_to_main" }],
    ],
  };
}

// Создание клавиатуры выбора маркетплейса
function getMarketplaceKeyboard() {
  const keyboard = [];
  for (const [key, value] of Object.entries(MARKETPLACES)) {
    keyboard.push([
      { text: `${value.emoji} ${value.name}`, callback_data: `mp_${key}` },
    ]);
  }
  keyboard.push([{ text: "❌ Отмена", callback_data: "cancel" }]);

  return { inline_keyboard: keyboard };
}

// Создание клавиатуры выбора периода
function getPeriodKeyboard() {
  const keyboard = [];
  const periods = Object.entries(PERIODS);

  // Разбиваем на строки по 2 кнопки
  for (let i = 0; i < periods.length; i += 2) {
    const row = [];
    row.push({
      text: `⏱️ ${periods[i][1].name}`,
      callback_data: `period_${periods[i][0]}`,
    });
    if (periods[i + 1]) {
      row.push({
        text: `⏱️ ${periods[i + 1][1].name}`,
        callback_data: `period_${periods[i + 1][0]}`,
      });
    }
    keyboard.push(row);
  }

  keyboard.push([{ text: "❌ Отмена", callback_data: "cancel" }]);

  return { inline_keyboard: keyboard };
}

// Создание клавиатуры выбора типа уведомлений
function getNotificationKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🔔 Только при изменении цены",
          callback_data: "notify_changes",
        },
      ],
      [{ text: "📢 Всегда уведомлять", callback_data: "notify_always" }],
      [{ text: "❌ Отмена", callback_data: "cancel" }],
    ],
  };
}

// Создание клавиатуры со списком отслеживаний
async function getTrackingListKeyboard(userId) {
  const keyboard = [];
  const userTrackings = await MokkyAPI.getUserTrackings(userId);

  for (const tracking of userTrackings) {
    const mpEmoji = MARKETPLACES[tracking.marketplace]?.emoji || "❓";
    const status = tracking.active ? "🟢" : "🔴";
    const displayText = `${status} ${mpEmoji} ${tracking.article.substring(
      0,
      15
    )}...`;
    keyboard.push([
      {
        text: displayText,
        callback_data: `task_info_${tracking.id}`,
      },
    ]);
  }

  if (userTrackings.length === 0) {
    keyboard.push([{ text: "📭 Нет отслеживаний", callback_data: "no_tasks" }]);
  } else {
    keyboard.push([
      { text: "⚙️ Управление", callback_data: "manage_trackings" },
    ]);
  }

  keyboard.push([{ text: "🔙 Назад", callback_data: "back_to_main" }]);

  return { inline_keyboard: keyboard };
}

// Получение информации о задаче для клавиатуры действий
function getTaskActionsKeyboard(trackingId, isActive) {
  const keyboard = [];

  if (isActive) {
    keyboard.push([
      { text: "⏸️ Остановить", callback_data: `stop_${trackingId}` },
    ]);
  } else {
    keyboard.push([
      { text: "▶️ Запустить", callback_data: `start_${trackingId}` },
    ]);
  }

  keyboard.push([
    { text: "🔄 Проверить сейчас", callback_data: `check_${trackingId}` },
    { text: "✏️ Изменить период", callback_data: `edit_period_${trackingId}` },
  ]);

  keyboard.push([
    {
      text: "🔔 Настройки уведомлений",
      callback_data: `edit_notify_${trackingId}`,
    },
    { text: "🗑️ Удалить", callback_data: `delete_${trackingId}` },
  ]);

  keyboard.push([{ text: "🔙 К списку", callback_data: "list_tracking" }]);

  return { inline_keyboard: keyboard };
}

// Создание клавиатуры настроек
function getSettingsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "💾 Экспорт данных", callback_data: "export_data" }],
      [{ text: "🔙 Назад", callback_data: "back_to_main" }],
    ],
  };
}

// Загрузка отслеживаний из Mokky в кэш
async function loadTrackingsToCache() {
  try {
    const allTrackings = await MokkyAPI.getAllActiveTrackings();
    trackingTasks.clear();

    for (const tracking of allTrackings) {
      const task = new TrackingTask(
        tracking.userId,
        tracking.article,
        tracking.marketplace,
        tracking.periodSeconds,
        tracking.notifyAlways
      );
      task.lastPrice = tracking.lastPrice;
      task.lastCheck = tracking.lastCheck ? new Date(tracking.lastCheck) : null;
      task.active = tracking.active;
      task.productName = tracking.productName || "";

      const taskKey = `${tracking.userId}_${tracking.article}_${tracking.marketplace}`;
      trackingTasks.set(taskKey, { ...task, mokkyId: tracking.id });
    }

    console.log(`Loaded ${allTrackings.length} trackings to cache`);
  } catch (error) {
    console.error("Error loading trackings to cache:", error.message);
  }
}

// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from.first_name || "пользователь";
  await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });

  const text = `🤖 **Добро пожаловать, ${firstName}, в бот отслеживания цен!**

Этот бот поможет вам отслеживать изменения цен на товары в маркетплейсах Wildberries и Ozon.

**✨ Новые возможности:**
• 📊 Статистика отслеживаний
• ⚙️ Гибкие настройки уведомлений
• 📱 Удобное управление через кнопки
• 💾 Надежное хранение данных
• 📈 История изменений цен

**Основные функции:**
• 📊 Отслеживание цен по артикулу
• ⏰ Настраиваемые интервалы проверки
• 🔔 Умные уведомления
• 📋 Массовое управление отслеживаниями

Выберите действие:`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: getMainReplyKeyboard(),
  });

  // Отправляем второе сообщение с inline клавиатурой
  await bot.sendMessage(chatId, "Выберите действие:", {
    reply_markup: getStartKeyboard(),
  });
  try {
    await axios.post("https://c2e30b93457050ae.mokky.dev/users-price", {
      id: msg.from.id,
      name: msg.from.first_name || null,
    });
    console.log(`User ${msg.from.id} saved to mock API`);
  } catch (err) {
    console.error("Ошибка при сохранении пользователя:", err.message);
  }
});

// Обработчик callback запросов
bot.on("callback_query", async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  try {
    await bot.answerCallbackQuery(callbackQuery.id);

    // Добавление отслеживания
    if (data === "add_tracking") {
      await bot.editMessageText(
        "📦 **Добавление отслеживания**\n\nВведите артикул товара:\n\n💡 Не знаете артикул? Воспользуйтесь ботом поиска товаров - найдите нужный товар, скопируйте артикул и вернитесь сюда!",
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔍 Найти товар",
                  url: "https://t.me/search_wb_ozon_bot",
                },
              ],
              [{ text: "❌ Отмена", callback_data: "cancel" }],
            ],
          },
        }
      );
      await MokkyAPI.saveUserState(userId, { state: STATES.WAITING_ARTICLE });
    }

    // Обработка изменения периода
    else if (data.startsWith("edit_period_")) {
      const trackingId = data.replace("edit_period_", "");
      const tracking = await MokkyAPI.getTracking(trackingId);

      if (!tracking) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ Отслеживание не найдено",
        });
        return;
      }

      // Сохраняем ID отслеживания для последующего обновления
      await MokkyAPI.saveUserState(userId, {
        state: "editing_period",
        trackingId: trackingId,
      });

      const mpInfo = MARKETPLACES[tracking.marketplace];
      await bot.editMessageText(
        `📦 Товар: ${tracking.productName}\n🏪 ${mpInfo.emoji} ${mpInfo.name}\n\n⏱️ Выберите новый период проверки:`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getPeriodKeyboard(),
        }
      );
    }

    // Выбор маркетплейса
    else if (data.startsWith("mp_")) {
      const marketplace = data.replace("mp_", "");
      const userState = await MokkyAPI.getUserState(userId);
      userState.marketplace = marketplace;
      userState.state = STATES.SELECTING_PERIOD;
      await MokkyAPI.saveUserState(userId, userState);

      const mpInfo = MARKETPLACES[marketplace];
      await bot.editMessageText(
        `🏪 Маркетплейс: ${mpInfo.emoji} ${mpInfo.name}\n\n⏱️ Выберите период проверки:`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getPeriodKeyboard(),
        }
      );
    }

    // Выбор периода
    else if (data.startsWith("period_")) {
      const periodKey = data.replace("period_", "");
      const periodInfo = PERIODS[periodKey];
      const userState = await MokkyAPI.getUserState(userId);

      // Если это редактирование существующего отслеживания
      if (userState.state === "editing_period" && userState.trackingId) {
        // Обновляем период отслеживания
        await MokkyAPI.updateTracking(userState.trackingId, {
          periodSeconds: periodInfo.seconds,
          updatedAt: new Date().toISOString(),
        });

        await bot.editMessageText(`✅ Период обновлен на: ${periodInfo.name}`, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getStartKeyboard(),
        });

        await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });
        return;
      }

      // Оригинальный код для создания нового отслеживания
      userState.period = periodKey;
      userState.periodSeconds = periodInfo.seconds;
      userState.state = STATES.SELECTING_NOTIFICATION;
      await MokkyAPI.saveUserState(userId, userState);

      await bot.editMessageText(
        `⏱️ Период: ${periodInfo.name}\n\n🔔 Выберите тип уведомлений:`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getNotificationKeyboard(),
        }
      );
    }

    // Выбор типа уведомлений
    // Обработчик выбора типа уведомлений
    else if (data === "notify_changes" || data === "notify_always") {
      const notifyAlways = data === "notify_always";
      const userState = await MokkyAPI.getUserState(userId);

      // РЕДАКТИРОВАНИЕ существующего отслеживания
      if (userState.state === STATES.EDITING_NOTIFY && userState.trackingId) {
        // Обновляем настройки уведомлений
        await MokkyAPI.updateTracking(userState.trackingId, {
          notifyAlways: notifyAlways,
          updatedAt: new Date().toISOString(),
        });

        const notifyText = notifyAlways
          ? "всегда"
          : "только при изменении цены";

        // Получаем обновленное отслеживание
        const updatedTracking = await MokkyAPI.getTracking(
          userState.trackingId
        );
        if (updatedTracking) {
          const mpInfo = MARKETPLACES[updatedTracking.marketplace];
          const periodName =
            Object.values(PERIODS).find(
              (p) => p.seconds === updatedTracking.periodSeconds
            )?.name || "Неизвестно";
          const status = updatedTracking.active
            ? "🟢 Активно"
            : "🔴 Остановлено";

          let infoText = `✅ **Настройки уведомлений обновлены!**\n\n`;
          infoText += `📦 Товар: ${updatedTracking.productName}\n`;
          infoText += `🏪 Маркетплейс: ${mpInfo.emoji} ${mpInfo.name}\n`;
          infoText += `📋 Артикул: \`${updatedTracking.article}\`\n`;
          infoText += `⏱️ Период: ${periodName}\n`;
          infoText += `🔔 Уведомления: ${notifyText}\n`;
          infoText += `📈 Статус: ${status}\n`;

          await bot.editMessageText(infoText, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "Markdown",
            reply_markup: getTaskActionsKeyboard(
              userState.trackingId,
              updatedTracking.active
            ),
          });
        }

        // ВАЖНО: Сбрасываем состояние ПОСЛЕ редактирования
        await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });
        return; // Прерываем выполнение, чтобы не перейти к созданию нового
      }

      // СОЗДАНИЕ нового отслеживания (оригинальный код)
      else if (userState.state === STATES.SELECTING_NOTIFICATION) {
        await bot.editMessageText("🔍 Проверяю товар...", {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
        });

        const product = await makeApiRequest(
          userState.article,
          userState.marketplace
        );
        if (!product) {
          await bot.editMessageText(
            "❌ **Ошибка!**\n\nТовар с указанным артикулом не найден.\n\nПопробуйте еще раз.",
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "Markdown",
              reply_markup: getStartKeyboard(),
            }
          );
          await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });
          return;
        }

        // Создаем отслеживание в Mokky
        const trackingData = {
          userId: userId,
          article: userState.article,
          marketplace: userState.marketplace,
          periodSeconds: userState.periodSeconds,
          notifyAlways: notifyAlways,
          lastPrice: product.real_price,
          lastCheck: new Date().toISOString(),
          active: true,
          productName: product.name || "Неизвестный товар",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const savedTracking = await MokkyAPI.createTracking(trackingData);
        if (!savedTracking) {
          await bot.editMessageText("❌ Ошибка при сохранении отслеживания", {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: getStartKeyboard(),
          });
          return;
        }

        const mpInfo = MARKETPLACES[userState.marketplace];
        const periodInfo = PERIODS[userState.period];
        const notifyText = notifyAlways
          ? "всегда"
          : "только при изменении цены";

        const successText =
          `✅ **Отслеживание добавлено!**\n\n` +
          `📦 Товар: ${product.name || "Неизвестный товар"}\n` +
          `🏪 Маркетплейс: ${mpInfo.emoji} ${mpInfo.name}\n` +
          `📋 Артикул: \`${userState.article}\`\n` +
          `⏱️ Период проверки: ${periodInfo.name}\n` +
          `🔔 Уведомления: ${notifyText}\n` +
          `💰 Текущая цена: **${formatPrice(product.real_price || 0)}**\n\n` +
          `🚀 Отслеживание запущено!`;

        await bot.editMessageText(successText, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getStartKeyboard(),
        });

        await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });
      } else {
        // Неизвестное состояние - сбрасываем
        await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });
        await bot.editMessageText("❌ Произошла ошибка. Попробуйте снова.", {
          chat_id: chatId,
          message_id: msg.message_id,
          reply_markup: getStartKeyboard(),
        });
      }
    }
    // Список отслеживаний
    else if (data === "list_tracking") {
      const keyboard = await getTrackingListKeyboard(userId);
      await bot.editMessageText(
        "📋 **Ваши отслеживания:**\n\nВыберите отслеживание для подробной информации:",
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: keyboard,
        }
      );
    }

    // Управление отслеживаниями
    else if (data === "manage_trackings") {
      await bot.editMessageText(
        "⚙️ **Управление отслеживаниями**\n\nВыберите действие для массового управления:",
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getTrackingManagementKeyboard(),
        }
      );
    }

    // Массовые действия
    else if (data === "start_all" || data === "stop_all") {
      const userTrackings = await MokkyAPI.getUserTrackings(userId);
      const isStart = data === "start_all";
      let count = 0;

      for (const tracking of userTrackings) {
        if (tracking.active !== isStart) {
          await MokkyAPI.updateTracking(tracking.id, {
            active: isStart,
            updatedAt: new Date().toISOString(),
          });
          count++;
        }
      }

      const action = isStart ? "запущено" : "остановлено";
      await bot.editMessageText(`✅ **${count} отслеживаний ${action}**`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: getTrackingManagementKeyboard(),
      });
    } else if (data === "delete_inactive") {
      const userTrackings = await MokkyAPI.getUserTrackings(userId);
      const inactiveTrackings = userTrackings.filter((t) => !t.active);

      for (const tracking of inactiveTrackings) {
        await MokkyAPI.deleteTracking(tracking.id);
      }

      await bot.editMessageText(
        `🗑️ **Удалено ${inactiveTrackings.length} неактивных отслеживаний**`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getTrackingManagementKeyboard(),
        }
      );
    } else if (data === "delete_all") {
      const userTrackings = await MokkyAPI.getUserTrackings(userId);

      for (const tracking of userTrackings) {
        await MokkyAPI.deleteTracking(tracking.id);
      }

      await bot.editMessageText(
        `🧹 **Все отслеживания удалены (${userTrackings.length})**`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getStartKeyboard(),
        }
      );
    }

    // Информация о конкретном отслеживании
    else if (data.startsWith("task_info_")) {
      const trackingId = data.replace("task_info_", "");
      const tracking = await MokkyAPI.getTracking(trackingId);

      if (!tracking) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ Отслеживание не найдено",
        });
        return;
      }

      const mpInfo = MARKETPLACES[tracking.marketplace];
      const periodName =
        Object.values(PERIODS).find((p) => p.seconds === tracking.periodSeconds)
          ?.name || "Неизвестно";
      const notifyText = tracking.notifyAlways
        ? "всегда"
        : "только при изменении цены";
      const status = tracking.active ? "🟢 Активно" : "🔴 Остановлено";

      let infoText = `📊 **Информация об отслеживании**\n\n`;
      infoText += `📦 Товар: ${tracking.productName}\n`;
      infoText += `🏪 Маркетплейс: ${mpInfo.emoji} ${mpInfo.name}\n`;
      infoText += `📋 Артикул: \`${tracking.article}\`\n`;
      infoText += `⏱️ Период: ${periodName}\n`;
      infoText += `🔔 Уведомления: ${notifyText}\n`;
      infoText += `📈 Статус: ${status}\n`;

      if (tracking.lastPrice) {
        infoText += `💰 Последняя цена: **${formatPrice(
          tracking.lastPrice
        )}**\n`;
      }

      if (tracking.lastCheck) {
        infoText += `🕒 Последняя проверка: ${new Date(
          tracking.lastCheck
        ).toLocaleString("ru-RU")}\n`;
      }

      infoText += `📅 Создано: ${new Date(tracking.createdAt).toLocaleString(
        "ru-RU"
      )}\n`;

      await bot.editMessageText(infoText, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: getTaskActionsKeyboard(trackingId, tracking.active),
      });
    }

    // Действия с отслеживаниями
    else if (
      data.startsWith("stop_") ||
      data.startsWith("start_") ||
      data.startsWith("delete_") ||
      data.startsWith("check_")
    ) {
      const [action, trackingId] = data.split("_");
      const tracking = await MokkyAPI.getTracking(trackingId);

      if (!tracking) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ Отслеживание не найдено",
        });
        return;
      }

      if (action === "stop") {
        await MokkyAPI.updateTracking(trackingId, {
          active: false,
          updatedAt: new Date().toISOString(),
        });
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "⏸️ Отслеживание остановлено",
        });
      } else if (action === "start") {
        await MokkyAPI.updateTracking(trackingId, {
          active: true,
          updatedAt: new Date().toISOString(),
        });
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "▶️ Отслеживание запущено",
        });
      } else if (action === "delete") {
        await MokkyAPI.deleteTracking(trackingId);
        await bot.editMessageText("🗑️ **Отслеживание удалено**", {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getStartKeyboard(),
        });
        return;
      } else if (action === "check") {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "🔍 Проверяю товар...",
        });
        const product = await makeApiRequest(
          tracking.article,
          tracking.marketplace
        );
        if (product) {
          const infoText = `🔍 **Актуальная информация:**\n\n${formatProductInfo(
            product
          )}`;
          await bot.sendMessage(chatId, infoText, { parse_mode: "Markdown" });

          // Обновляем данные в базе
          await MokkyAPI.updateTracking(trackingId, {
            lastPrice: product.real_price,
            lastCheck: new Date().toISOString(),
            productName: product.name || tracking.productName,
            updatedAt: new Date().toISOString(),
          });
        } else {
          await bot.sendMessage(
            chatId,
            "❌ Не удалось получить информацию о товаре"
          );
        }
      }

      // Обновляем информацию об отслеживании для stop/start
      if (action === "stop" || action === "start") {
        const updatedTracking = await MokkyAPI.getTracking(trackingId);
        if (updatedTracking) {
          const mpInfo = MARKETPLACES[updatedTracking.marketplace];
          const periodName =
            Object.values(PERIODS).find(
              (p) => p.seconds === updatedTracking.periodSeconds
            )?.name || "Неизвестно";
          const notifyText = updatedTracking.notifyAlways
            ? "всегда"
            : "только при изменении цены";
          const status = updatedTracking.active
            ? "🟢 Активно"
            : "🔴 Остановлено";

          let infoText = `📊 **Информация об отслеживании**\n\n`;
          infoText += `📦 Товар: ${updatedTracking.productName}\n`;
          infoText += `🏪 Маркетплейс: ${mpInfo.emoji} ${mpInfo.name}\n`;
          infoText += `📋 Артикул: \`${updatedTracking.article}\`\n`;
          infoText += `⏱️ Период: ${periodName}\n`;
          infoText += `🔔 Уведомления: ${notifyText}\n`;
          infoText += `📈 Статус: ${status}\n`;

          if (updatedTracking.lastPrice) {
            infoText += `💰 Последняя цена: **${formatPrice(
              updatedTracking.lastPrice
            )}**\n`;
          }

          if (updatedTracking.lastCheck) {
            infoText += `🕒 Последняя проверка: ${new Date(
              updatedTracking.lastCheck
            ).toLocaleString("ru-RU")}\n`;
          }

          infoText += `📅 Создано: ${new Date(
            updatedTracking.createdAt
          ).toLocaleString("ru-RU")}\n`;

          await bot.editMessageText(infoText, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "Markdown",
            reply_markup: getTaskActionsKeyboard(
              trackingId,
              updatedTracking.active
            ),
          });
        }
      }
    }

    // Статистика
    else if (data === "statistics") {
      const userTrackings = await MokkyAPI.getUserTrackings(userId);
      const activeCount = userTrackings.filter((t) => t.active).length;
      const inactiveCount = userTrackings.length - activeCount;

      const marketplaceStats = {};
      userTrackings.forEach((t) => {
        marketplaceStats[t.marketplace] =
          (marketplaceStats[t.marketplace] || 0) + 1;
      });

      let statsText = `📊 **Ваша статистика**\n\n`;
      statsText += `📋 Всего отслеживаний: **${userTrackings.length}**\n`;
      statsText += `🟢 Активных: **${activeCount}**\n`;
      statsText += `🔴 Остановлено: **${inactiveCount}**\n\n`;

      if (Object.keys(marketplaceStats).length > 0) {
        statsText += `📈 **По маркетплейсам:**\n`;
        for (const [mp, count] of Object.entries(marketplaceStats)) {
          const mpInfo = MARKETPLACES[mp] || { emoji: "❓", name: "Unknown" };
          statsText += `${mpInfo.emoji} ${mpInfo.name}: ${count}\n`;
        }
      }

      if (userTrackings.length > 0) {
        const oldestTracking = userTrackings.reduce((oldest, current) =>
          new Date(current.createdAt) < new Date(oldest.createdAt)
            ? current
            : oldest
        );
        statsText += `\n📅 Первое отслеживание: ${new Date(
          oldestTracking.createdAt
        ).toLocaleDateString("ru-RU")}`;
      }

      await bot.editMessageText(statsText, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Назад", callback_data: "back_to_main" }],
          ],
        },
      });
    }

    // Обработка изменения уведомлений
    else if (data.startsWith("edit_notify_")) {
      const trackingId = data.replace("edit_notify_", "");
      const tracking = await MokkyAPI.getTracking(trackingId);

      if (!tracking) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ Отслеживание не найдено",
        });
        return;
      }

      // Сохраняем ID отслеживания
      await MokkyAPI.saveUserState(userId, {
        state: STATES.EDITING_NOTIFY,
        trackingId: trackingId,
      });

      const mpInfo = MARKETPLACES[tracking.marketplace];
      const currentNotify = tracking.notifyAlways
        ? "📢 Всегда уведомлять"
        : "🔔 Только при изменении цены";

      await bot.editMessageText(
        `📦 Товар: ${tracking.productName}\n🏪 ${mpInfo.emoji} ${mpInfo.name}\n\n🔔 Текущие настройки: ${currentNotify}\n\nВыберите новый тип уведомлений:`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getNotificationKeyboard(),
        }
      );
    }

    // Обновляем обработчик выбора уведомлений
    else if (data === "notify_changes" || data === "notify_always") {
      const notifyAlways = data === "notify_always";
      const userState = await MokkyAPI.getUserState(userId);

      // Если это редактирование существующего отслеживания
      if (userState.state === STATES.EDITING_NOTIFY && userState.trackingId) {
        // Обновляем настройки уведомлений
        await MokkyAPI.updateTracking(userState.trackingId, {
          notifyAlways: notifyAlways,
          updatedAt: new Date().toISOString(),
        });

        const notifyText = notifyAlways
          ? "всегда"
          : "только при изменении цены";

        // Получаем обновленное отслеживание для показа информации
        const updatedTracking = await MokkyAPI.getTracking(
          userState.trackingId
        );
        if (updatedTracking) {
          const mpInfo = MARKETPLACES[updatedTracking.marketplace];
          const periodName =
            Object.values(PERIODS).find(
              (p) => p.seconds === updatedTracking.periodSeconds
            )?.name || "Неизвестно";
          const status = updatedTracking.active
            ? "🟢 Активно"
            : "🔴 Остановлено";

          let infoText = `✅ **Настройки уведомлений обновлены!**\n\n`;
          infoText += `📦 Товар: ${updatedTracking.productName}\n`;
          infoText += `🏪 Маркетплейс: ${mpInfo.emoji} ${mpInfo.name}\n`;
          infoText += `📋 Артикул: \`${updatedTracking.article}\`\n`;
          infoText += `⏱️ Период: ${periodName}\n`;
          infoText += `🔔 Уведомления: ${notifyText}\n`;
          infoText += `📈 Статус: ${status}\n`;

          await bot.editMessageText(infoText, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "Markdown",
            reply_markup: getTaskActionsKeyboard(
              userState.trackingId,
              updatedTracking.active
            ),
          });
        }

        await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });
        return;
      }

      // Оригинальный код для создания нового отслеживания
      await bot.editMessageText("🔍 Проверяю товар...", {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "Markdown",
      });

      const product = await makeApiRequest(
        userState.article,
        userState.marketplace
      );
      if (!product) {
        await bot.editMessageText(
          "❌ **Ошибка!**\n\nТовар с указанным артикулом не найден.\n\nПопробуйте еще раз.",
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "Markdown",
            reply_markup: getStartKeyboard(),
          }
        );
        await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });
        return;
      }

      // Создаем отслеживание в Mokky
      const trackingData = {
        userId: userId,
        article: userState.article,
        marketplace: userState.marketplace,
        periodSeconds: userState.periodSeconds,
        notifyAlways: notifyAlways,
        lastPrice: product.real_price,
        lastCheck: new Date().toISOString(),
        active: true,
        productName: product.name || "Неизвестный товар",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const savedTracking = await MokkyAPI.createTracking(trackingData);
      if (!savedTracking) {
        await bot.editMessageText("❌ Ошибка при сохранении отслеживания", {
          chat_id: chatId,
          message_id: msg.message_id,
          reply_markup: getStartKeyboard(),
        });
        return;
      }

      const mpInfo = MARKETPLACES[userState.marketplace];
      const periodInfo = PERIODS[userState.period];
      const notifyText = notifyAlways ? "всегда" : "только при изменении цены";

      const successText =
        `✅ **Отслеживание добавлено!**\n\n` +
        `📦 Товар: ${product.name || "Неизвестный товар"}\n` +
        `🏪 Маркетплейс: ${mpInfo.emoji} ${mpInfo.name}\n` +
        `📋 Артикул: \`${userState.article}\`\n` +
        `⏱️ Период проверки: ${periodInfo.name}\n` +
        `🔔 Уведомления: ${notifyText}\n` +
        `💰 Текущая цена: **${formatPrice(product.real_price || 0)}**\n\n` +
        `🚀 Отслеживание запущено!`;

      await bot.editMessageText(successText, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: getStartKeyboard(),
      });

      await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });
    }

    // Настройки
    else if (data === "settings") {
      await bot.editMessageText(
        "⚙️ **Настройки бота**\n\nВыберите параметр для настройки:",
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: getSettingsKeyboard(),
        }
      );
    }

    // Экспорт данных
    else if (data === "export_data") {
      const userTrackings = await MokkyAPI.getUserTrackings(userId);

      if (userTrackings.length === 0) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "📭 Нет данных для экспорта",
        });
        return;
      }

      let exportText = `📊 Экспорт отслеживаний (${new Date().toLocaleString(
        "ru-RU"
      )})\n\n`;

      userTrackings.forEach((tracking, index) => {
        const mpInfo = MARKETPLACES[tracking.marketplace] || {
          emoji: "❓",
          name: "Unknown",
        };
        const status = tracking.active ? "🟢" : "🔴";
        const periodName =
          Object.values(PERIODS).find(
            (p) => p.seconds === tracking.periodSeconds
          )?.name || "Неизвестно";

        exportText += `${index + 1}. ${status} ${mpInfo.emoji} ${
          tracking.productName
        }\n`;
        exportText += `   Артикул: ${tracking.article}\n`;
        exportText += `   Маркетплейс: ${mpInfo.name}\n`;
        exportText += `   Период: ${periodName}\n`;
        exportText += `   Цена: ${
          tracking.lastPrice ? formatPrice(tracking.lastPrice) : "N/A"
        }\n`;
        exportText += `   Создано: ${new Date(
          tracking.createdAt
        ).toLocaleDateString("ru-RU")}\n\n`;
      });

      await bot.sendMessage(chatId, exportText);
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: "📤 Данные экспортированы",
      });
    }

    // Справка
    else if (data === "help") {
      const helpText = `ℹ️ **Справка по боту**

**🚀 Основные функции:**

**➕ Добавить отслеживание**
1️⃣ Введите артикул товара
2️⃣ Выберите маркетплейс
3️⃣ Установите период проверки
4️⃣ Настройте уведомления

**📋 Управление отслеживаниями**
• Просмотр подробной информации
• Запуск/остановка отслеживания
• Массовые операции
• Ручная проверка цен
• Удаление ненужных отслеживаний

**⚙️ Расширенные возможности**
• 📊 Подробная статистика
• 💾 Экспорт данных
• 🔔 Гибкие настройки уведомлений
• 📱 Удобное управление через кнопки

**⏰ Периоды проверки:**
От 10 секунд до 12 часов

**🔔 Типы уведомлений:**
• **Только при изменении** - экономит трафик
• **Всегда уведомлять** - полный контроль

**🏪 Поддерживаемые маркетплейсы:**
🟣 Wildberries
🔵 Ozon

**💡 Советы:**
• Используйте массовые операции для управления множеством отслеживаний
• Регулярно проверяйте статистику
• Экспортируйте данные для резервного копирования

**💁 Нужна помощь?**
• Если остались вопросы - напишите нашему администратору!
`;

      await bot.editMessageText(helpText, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "👨💻 Написать админу",
                url: "https://t.me/sult987",
              },
            ],
            [{ text: "🔙 Назад", callback_data: "back_to_main" }],
          ],
        },
      });
    }

    // Отмена или возврат в главное меню
    else if (data === "cancel" || data === "back_to_main") {
      await MokkyAPI.saveUserState(userId, { state: STATES.IDLE });
      const text = `🤖 **Бот отслеживания цен**\n\nВыберите действие:`;

      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: getStartKeyboard(),
      });
    }
  } catch (error) {
    console.error("Error handling callback query:", error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: "❌ Произошла ошибка",
    });
  }
});

// Обработчик текстовых сообщений
bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return; // Игнорируем команды

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();
  const userState = await MokkyAPI.getUserState(userId);

  // Обработка кнопок быстрого доступа
  switch (text) {
    case "➕ Добавить":
      await bot.sendMessage(
        chatId,
        "📦 **Добавление отслеживания**\n\nВведите артикул товара:\n\n💡 Не знаете артикул? Воспользуйтесь ботом поиска товаров!",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔍 Найти товар",
                  url: "https://t.me/search_wb_ozon_bot",
                },
              ],
              [{ text: "❌ Отмена", callback_data: "cancel" }],
            ],
          },
        }
      );
      await MokkyAPI.saveUserState(userId, { state: STATES.WAITING_ARTICLE });
      return;

    case "📋 Мои отслеживания":
      const keyboard = await getTrackingListKeyboard(userId);
      await bot.sendMessage(
        chatId,
        "📋 **Ваши отслеживания:**\n\nВыберите отслеживание для подробной информации:",
        {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        }
      );
      return;

    case "📊 Статистика":
      const userTrackings = await MokkyAPI.getUserTrackings(userId);
      const activeCount = userTrackings.filter((t) => t.active).length;
      const inactiveCount = userTrackings.length - activeCount;

      let statsText = `📊 **Ваша статистика**\n\n`;
      statsText += `📋 Всего отслеживаний: **${userTrackings.length}**\n`;
      statsText += `🟢 Активных: **${activeCount}**\n`;
      statsText += `🔴 Остановлено: **${inactiveCount}**`;

      await bot.sendMessage(chatId, statsText, {
        parse_mode: "Markdown",
        reply_markup: getStartKeyboard(),
      });
      return;

    case "🔍 Найти товар":
      await bot.sendMessage(
        chatId,
        "🔍 **Поиск товаров**\n\nДля поиска товаров по каталогам Wildberries и Ozon перейдите в специальный бот.\n\nВы сможете найти товар, скопировать артикул и вернуться сюда для добавления отслеживания!",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔍 Открыть бот поиска",
                  url: "https://t.me/search_wb_ozon_bot",
                },
              ],
            ],
          },
        }
      );
      return;

    case "ℹ️ Помощь":
      await bot.sendMessage(
        chatId,
        "ℹ️ **Помощь**\n\nИспользуйте кнопки меню для навигации по боту.",
        {
          parse_mode: "Markdown",
          reply_markup: getStartKeyboard(),
        }
      );
      return;

    case "⚙️ Настройки":
      await bot.sendMessage(
        chatId,
        "⚙️ **Настройки бота**\n\nВыберите параметр для настройки:",
        {
          parse_mode: "Markdown",
          reply_markup: getSettingsKeyboard(),
        }
      );
      return;
  }

  // Оригинальная логика для ввода артикула
  if (!userState || userState.state !== STATES.WAITING_ARTICLE) return;

  const article = text;
  userState.article = article;
  userState.state = STATES.SELECTING_MARKETPLACE;
  await MokkyAPI.saveUserState(userId, userState);

  await bot.sendMessage(
    chatId,
    `📦 Артикул: \`${article}\`\n\n🏪 Выберите маркетплейс:`,
    {
      parse_mode: "Markdown",
      reply_markup: getMarketplaceKeyboard(),
    }
  );
});

// Основной цикл проверки цен
async function priceCheckingLoop() {
  while (true) {
    try {
      // Загружаем актуальные отслеживания из Mokky
      const allActiveTrackings = await MokkyAPI.getAllActiveTrackings();
      const currentTime = new Date();
      const tasksToCheck = [];

      // Находим задачи, которые нужно проверить
      for (const tracking of allActiveTrackings) {
        if (!tracking.active) continue;

        if (!tracking.lastCheck) {
          tasksToCheck.push(tracking);
          continue;
        }

        const lastCheck = new Date(tracking.lastCheck);
        const timeDiff = (currentTime - lastCheck) / 1000;
        if (timeDiff >= tracking.periodSeconds) {
          tasksToCheck.push(tracking);
        }
      }

      console.log(`Checking ${tasksToCheck.length} trackings...`);

      // Проверяем каждую задачу
      for (const tracking of tasksToCheck) {
        try {
          const product = await makeApiRequest(
            tracking.article,
            tracking.marketplace
          );
          if (!product) {
            console.log(
              `Product not found: ${tracking.article} on ${tracking.marketplace}`
            );
            continue;
          }

          const currentPrice = product.real_price || 0;
          const priceChanged =
            tracking.lastPrice === null || tracking.lastPrice !== currentPrice;

          // Отправляем уведомление если нужно
          const shouldNotify =
            tracking.notifyAlways || (!tracking.notifyAlways && priceChanged);

          if (shouldNotify) {
            let messageText = "";

            if (priceChanged && tracking.lastPrice !== null) {
              if (currentPrice > tracking.lastPrice) {
                messageText += "📈 **ЦЕНА ВЫРОСЛА!**\n\n";
                messageText += `Было: **${formatPrice(tracking.lastPrice)}**\n`;
                messageText += `Стало: **${formatPrice(currentPrice)}**\n`;
                messageText += `Разница: +${formatPrice(
                  currentPrice - tracking.lastPrice
                )}\n\n`;
              } else {
                messageText += "📉 **ЦЕНА УПАЛА!**\n\n";
                messageText += `Было: **${formatPrice(tracking.lastPrice)}**\n`;
                messageText += `Стало: **${formatPrice(currentPrice)}**\n`;
                messageText += `Разница: -${formatPrice(
                  tracking.lastPrice - currentPrice
                )}\n\n`;
              }
            } else if (!priceChanged) {
              messageText += "📊 **Регулярное обновление**\n\n";
            }

            messageText += formatProductInfo(product);

            try {
              await bot.sendMessage(tracking.userId, messageText, {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "📊 Подробнее",
                        callback_data: `task_info_${tracking.id}`,
                      },
                      {
                        text: "📋 Все отслеживания",
                        callback_data: "list_tracking",
                      },
                    ],
                  ],
                },
              });
            } catch (error) {
              console.error(
                `Error sending message to user ${tracking.userId}:`,
                error.message
              );
            }
          }

          // Обновляем информацию о задаче в Mokky
          await MokkyAPI.updateTracking(tracking.id, {
            lastPrice: currentPrice,
            lastCheck: currentTime.toISOString(),
            productName: product.name || tracking.productName,
            updatedAt: currentTime.toISOString(),
          });

          // Небольшая задержка между запросами к API товаров
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(
            `Error checking tracking ${tracking.id}:`,
            error.message
          );
        }
      }

      // Ждем перед следующей итерацией (10 секунд)
      await new Promise((resolve) => setTimeout(resolve, 10000));
    } catch (error) {
      console.error("Error in price checking loop:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 30000)); // Увеличенная задержка при ошибке
    }
  }
}

// Команды бота
bot.onText(/\/stats/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const userTrackings = await MokkyAPI.getUserTrackings(userId);
  const activeCount = userTrackings.filter((t) => t.active).length;

  let statsText = `📊 **Быстрая статистика**\n\n`;
  statsText += `📋 Всего: ${userTrackings.length}\n`;
  statsText += `🟢 Активных: ${activeCount}\n`;
  statsText += `🔴 Остановлено: ${userTrackings.length - activeCount}`;

  bot.sendMessage(chatId, statsText, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Подробная статистика", callback_data: "statistics" },
          { text: "📋 Все отслеживания", callback_data: "list_tracking" },
        ],
      ],
    },
  });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "ℹ️ **Помощь**\n\nИспользуйте кнопки меню для навигации по боту.",
    {
      parse_mode: "Markdown",
      reply_markup: getStartKeyboard(),
    }
  );
});

// Обработка ошибок бота
bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

// Инициализация и запуск
async function initialize() {
  console.log("🤖 Bot starting...");

  // Загружаем отслеживания в кэш при запуске
  await loadTrackingsToCache();

  console.log("🤖 Bot started successfully");

  // Запускаем цикл проверки цен
  priceCheckingLoop();
}

// Запуск бота
initialize();

// Обработка graceful shutdown
process.on("SIGINT", () => {
  console.log("Bot stopping...");
  bot.stopPolling();
  process.exit();
});

process.on("SIGTERM", () => {
  console.log("Bot stopping...");
  bot.stopPolling();
  process.exit();
});
