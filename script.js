const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');

// Конфигурация
const API_KEY = "XGXVQZX24QKQ3YGL";
const API_BASE = "https://api.moneyplace.io";
const MOCK_API_BASE = "https://e957a177cfe4e411.mokky.dev";
const BOT_TOKEN = process.env.BOT_TOKEN || '8190479365:AAHnjDWn6sr_8SF6Cj_jw7HR2-Cu1fM_syA';

// Интервалы отслеживания (в секундах)
const INTERVALS = {
    '10 секунд': 10,
    '20 секунд': 20,
    '50 секунд': 50,
    '1 час': 3600,
    '2 часа': 7200,
    '5 часов': 18000,
    '10 часов': 36000,
    '12 часов': 43200
};

// Маркетплейсы
const MARKETPLACES = {
    'wildberries': 'Wildberries',
    'ozon': 'Ozon'
};

// Хранилище активных отслеживаний
const activeTrackings = new Map();

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN);

// Middleware для сессий
bot.use(session());

// Функции для работы с Mock API
async function getUserTrackings(userId) {
    try {
        const response = await axios.get(`${MOCK_API_BASE}/trackings`);
        // Фильтруем по user_id на клиенте, так как Mock API может не поддерживать query params
        return response.data.filter(tracking => tracking.user_id == userId);
    } catch (error) {
        console.error('Mock API Error (get):', error.message);
        return [];
    }
}

async function saveUserTracking(trackingData) {
    try {
        const response = await axios.post(`${MOCK_API_BASE}/trackings`, trackingData);
        return response.data;
    } catch (error) {
        console.error('Mock API Error (post):', error.message);
        // Если POST не работает, создаем локальный ID
        return { ...trackingData, id: Date.now().toString() };
    }
}

async function updateUserTracking(trackingId, updates) {
    try {
        // Для Mock API используем PUT вместо PATCH, так как PATCH может не поддерживаться
        const response = await axios.put(`${MOCK_API_BASE}/trackings/${trackingId}`, updates);
        return response.data;
    } catch (error) {
        console.error('Mock API Error (update):', error.message);
        // Если обновление не удалось, возвращаем обновленные данные локально
        return updates;
    }
}

async function deleteUserTracking(trackingId) {
    try {
        await axios.delete(`${MOCK_API_BASE}/trackings/${trackingId}`);
        return true;
    } catch (error) {
        console.error('Mock API Error (delete):', error.message);
        return false;
    }
}

// Функция для запроса к API
async function makeApiRequest(params) {
    try {
        const response = await axios.get(`${API_BASE}/v1/product`, {
            params: {
                'q[sku][equal]': params.article,
                'q[mp][equal]': params.marketplace,
                expand: 'category,seller,brand'
            },
            headers: {
                'Authorization': `Token ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('API Error:', error.message);
        throw new Error(`Ошибка API: ${error.message}`);
    }
}

// Форматирование цены
function formatPrice(price) {
    if (!price) return '0 ₽';
    return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        minimumFractionDigits: 0
    }).format(price);
}

// Функция отслеживания цены
async function trackPrice(ctx, trackingData) {
    const { article, marketplace, interval, notifyOnlyOnChange, chatId, id: trackingId } = trackingData;
    
    try {
        const data = await makeApiRequest({ article, marketplace });
        
        if (data && data.length > 0) {
            const product = data[0];
            const currentPrice = product.real_price;
            const previousPrice = trackingData.lastPrice;
            
            // Проверяем, изменилась ли цена
            const priceChanged = previousPrice !== null && currentPrice !== previousPrice;
            
            if (!notifyOnlyOnChange || priceChanged || previousPrice === null) {
                const message = `
📊 <b>Отслеживание цены</b>
🛍️ <b>Товар:</b> ${product.name || 'Не указано'}
📦 <b>Артикул:</b> ${article}
🏪 <b>Маркетплейс:</b> ${MARKETPLACES[marketplace]}
💰 <b>Текущая цена:</b> ${formatPrice(currentPrice)}
${previousPrice !== null ? `📈 <b>Предыдущая цена:</b> ${formatPrice(previousPrice)}` : ''}
${priceChanged ? `🚨 <b>Цена изменилась!</b>` : ''}
⏰ <b>Интервал:</b> ${Object.keys(INTERVALS).find(key => INTERVALS[key] === interval)}
                `;
                
                await ctx.telegram.sendMessage(chatId, message, { 
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🛑 Остановить это отслеживание', `stop_one_${trackingId}`)],
                        [Markup.button.callback('⏸️ Приостановить', `pause_${trackingId}`),
                         Markup.button.callback('▶️ Возобновить', `resume_${trackingId}`)]
                    ])
                });
            }
            
            // Обновляем последнюю цену
            trackingData.lastPrice = currentPrice;
            
            // Пытаемся обновить в Mock API, но не блокируем из-за ошибок
            try {
                await updateUserTracking(trackingId, { lastPrice: currentPrice });
            } catch (apiError) {
                console.log('Не удалось обновить цену в API, продолжаем локально');
            }
            
            // Обновляем локальное хранилище
            activeTrackings.set(trackingId, trackingData);
        }
    } catch (error) {
        console.error('Tracking error:', error);
        await ctx.telegram.sendMessage(chatId, `❌ Ошибка при отслеживании: ${error.message}`);
    }
}

// Функция для отображения списка трекеров
async function showTrackersList(ctx, trackings) {
    if (trackings.length === 0) {
        await ctx.reply('У вас нет активных отслеживаний.');
        return;
    }
    
    let message = '📋 <b>Ваши отслеживания:</b>\n\n';
    
    for (const tracking of trackings) {
        const status = tracking.isActive ? '✅ Активно' : '⏸️ Приостановлено';
        message += `🆔 <b>ID:</b> ${tracking.id || 'N/A'}\n`;
        message += `🛍️ <b>Артикул:</b> ${tracking.article}\n`;
        message += `🏪 <b>Маркетплейс:</b> ${MARKETPLACES[tracking.marketplace]}\n`;
        message += `💰 <b>Текущая цена:</b> ${formatPrice(tracking.lastPrice || 0)}\n`;
        message += `⏰ <b>Интервал:</b> ${Object.keys(INTERVALS).find(k => INTERVALS[k] === tracking.interval) || tracking.interval}\n`;
        message += `🔔 <b>Уведомления:</b> ${tracking.notifyOnlyOnChange ? 'Только при изменении' : 'Всегда'}\n`;
        message += `📊 <b>Статус:</b> ${status}\n`;
        message += '─'.repeat(20) + '\n';
    }
    
    // Добавляем кнопки управления под сообщением
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🛑 Остановить все', 'stop_all')],
        [Markup.button.callback('⏸️ Приостановить все', 'pause_all'),
         Markup.button.callback('▶️ Возобновить все', 'resume_all')],
        [Markup.button.callback('🔄 Обновить список', 'refresh_list')]
    ]);
    
    await ctx.reply(message, { parse_mode: 'HTML', ...keyboard });
}

// Команда старта
bot.start(async (ctx) => {
    await ctx.reply(
        `👋 Привет, ${ctx.from.first_name}!\n\nЯ бот для отслеживания цен товаров на маркетплейсах.`,
        Markup.keyboard([
            ['📊 Отслеживать цену'],
            ['📋 Мои отслеживания', '🛑 Остановить все']
        ]).resize()
    );
});

// Обработка текстовых сообщений
bot.hears('📊 Отслеживать цену', async (ctx) => {
    ctx.session = { step: 'enter_article' };
    await ctx.reply('Введите артикул товара:');
});

bot.hears('📋 Мои отслеживания', async (ctx) => {
    const userId = ctx.from.id;
    const trackings = await getUserTrackings(userId);
    await showTrackersList(ctx, trackings);
});

bot.hears('🛑 Остановить все', async (ctx) => {
    const userId = ctx.from.id;
    const trackings = await getUserTrackings(userId);
    
    if (trackings.length === 0) {
        await ctx.reply('У вас нет активных отслеживаний.');
        return;
    }
    
    // Останавливаем все трекеры
    let stoppedCount = 0;
    for (const tracking of trackings) {
        if (activeTrackings.has(tracking.id)) {
            const trackingData = activeTrackings.get(tracking.id);
            clearInterval(trackingData.intervalId);
            activeTrackings.delete(tracking.id);
            stoppedCount++;
        }
        try {
            await updateUserTracking(tracking.id, { isActive: false });
        } catch (error) {
            console.log('Не удалось обновить статус в API для трекера:', tracking.id);
        }
    }
    
    await ctx.reply(`✅ Остановлено ${stoppedCount} отслеживаний.`);
});

// Обработка ввода артикула
bot.on('text', async (ctx) => {
    if (ctx.session?.step === 'enter_article') {
        ctx.session.article = ctx.message.text;
        ctx.session.step = 'choose_marketplace';
        
        await ctx.reply(
            'Выберите маркетплейс:',
            Markup.keyboard([
                [MARKETPLACES.wildberries, MARKETPLACES.ozon]
            ]).resize()
        );
    } else if (ctx.session?.step === 'choose_marketplace') {
        const marketplaceName = ctx.message.text;
        const marketplaceKey = Object.keys(MARKETPLACES).find(key => 
            MARKETPLACES[key] === marketplaceName
        );
        
        if (marketplaceKey) {
            ctx.session.marketplace = marketplaceKey;
            ctx.session.step = 'choose_interval';
            
            await ctx.reply(
                'Выберите интервал отслеживания:',
                Markup.keyboard([
                    ['10 секунд', '20 секунд', '50 секунд'],
                    ['1 час', '2 часа', '5 часов'],
                    ['10 часов', '12 часов']
                ]).resize()
            );
        } else {
            await ctx.reply('Пожалуйста, выберите маркетплейс из предложенных вариантов.');
        }
    } else if (ctx.session?.step === 'choose_interval') {
        const intervalName = ctx.message.text;
        const interval = INTERVALS[intervalName];
        
        if (interval) {
            ctx.session.interval = interval;
            ctx.session.intervalName = intervalName;
            ctx.session.step = 'choose_notification_mode';
            
            await ctx.reply(
                'Выберите режим уведомлений:',
                Markup.keyboard([
                    ['Только при изменении', 'Всегда']
                ]).resize()
            );
        } else {
            await ctx.reply('Пожалуйста, выберите интервал из предложенных вариантов.');
        }
    } else if (ctx.session?.step === 'choose_notification_mode') {
        const mode = ctx.message.text;
        const notifyOnlyOnChange = mode === 'Только при изменении';
        
        ctx.session.notifyOnlyOnChange = notifyOnlyOnChange;
        ctx.session.step = 'confirm_tracking';
        
        await ctx.reply(
            `Подтвердите настройки отслеживания:\n\n` +
            `📦 Артикул: ${ctx.session.article}\n` +
            `🏪 Маркетплейс: ${MARKETPLACES[ctx.session.marketplace]}\n` +
            `⏰ Интервал: ${ctx.session.intervalName}\n` +
            `🔔 Уведомления: ${mode}\n\n` +
            `Начать отслеживание?`,
            Markup.keyboard([
                ['✅ Да, начать', '❌ Нет, отменить']
            ]).resize()
        );
    } else if (ctx.session?.step === 'confirm_tracking') {
        if (ctx.message.text === '✅ Да, начать') {
            const { article, marketplace, interval, intervalName, notifyOnlyOnChange } = ctx.session;
            
            // Сохраняем данные трекера
            const trackingData = {
                user_id: ctx.from.id,
                article,
                marketplace,
                interval,
                intervalName,
                notifyOnlyOnChange,
                chatId: ctx.chat.id,
                lastPrice: null,
                isActive: true,
                createdAt: new Date().toISOString()
            };
            
            let savedTracking;
            try {
                savedTracking = await saveUserTracking(trackingData);
            } catch (error) {
                // Если API не работает, создаем локальный ID
                savedTracking = { ...trackingData, id: Date.now().toString() };
            }
            
            // Создаем задание отслеживания
            const trackingWithId = { ...savedTracking, intervalId: null };
            
            // Запускаем немедленную проверку
            await trackPrice(ctx, trackingWithId);
            
            // Устанавливаем интервальную проверку
            const intervalMs = interval * 1000;
            trackingWithId.intervalId = setInterval(async () => {
                await trackPrice(ctx, trackingWithId);
            }, intervalMs);
            
            activeTrackings.set(savedTracking.id, trackingWithId);
            
            await ctx.reply(
                '✅ Отслеживание начато! Вы будете получать уведомления согласно выбранным настройкам.',
                Markup.keyboard([
                    ['📊 Отслеживать цену'],
                    ['📋 Мои отслеживания', '🛑 Остановить все']
                ]).resize()
            );
        } else {
            await ctx.reply(
                'Отслеживание отменено.',
                Markup.keyboard([
                    ['📊 Отслеживать цену'],
                    ['📋 Мои отслеживания', '🛑 Остановить все']
                ]).resize()
            );
        }
        
        // Очищаем сессию
        ctx.session = {};
    }
});

// Обработка callback-кнопок
bot.action(/stop_one_(.+)/, async (ctx) => {
    const trackingId = ctx.match[1];
    
    try {
        // Останавливаем отслеживание
        if (activeTrackings.has(trackingId)) {
            const tracking = activeTrackings.get(trackingId);
            clearInterval(tracking.intervalId);
            activeTrackings.delete(trackingId);
        }
        
        // Обновляем статус в Mock API
        try {
            await updateUserTracking(trackingId, { isActive: false });
        } catch (error) {
            console.log('Не удалось обновить статус в API');
        }
        
        await ctx.answerCbQuery('✅ Отслеживание остановлено');
        await ctx.editMessageText(`🛑 Отслеживание остановлено.`);
    } catch (error) {
        await ctx.answerCbQuery('❌ Ошибка при остановке отслеживания');
    }
});

bot.action(/pause_(.+)/, async (ctx) => {
    const trackingId = ctx.match[1];
    
    try {
        // Приостанавливаем отслеживание
        if (activeTrackings.has(trackingId)) {
            const tracking = activeTrackings.get(trackingId);
            clearInterval(tracking.intervalId);
            activeTrackings.delete(trackingId);
        }
        
        // Обновляем статус в Mock API
        try {
            await updateUserTracking(trackingId, { isActive: false });
        } catch (error) {
            console.log('Не удалось обновить статус в API');
        }
        
        await ctx.answerCbQuery('⏸️ Отслеживание приостановлено');
        await ctx.editMessageText(`⏸️ Отслеживание приостановлено.`);
    } catch (error) {
        await ctx.answerCbQuery('❌ Ошибка при приостановке отслеживания');
    }
});

bot.action(/resume_(.+)/, async (ctx) => {
    const trackingId = ctx.match[1];
    const userId = ctx.from.id;
    
    try {
        // Получаем данные из Mock API или локального хранилища
        let trackingData;
        try {
            const trackings = await getUserTrackings(userId);
            trackingData = trackings.find(t => t.id == trackingId);
        } catch (error) {
            // Если API не доступно, ищем в активных трекерах
            trackingData = Array.from(activeTrackings.values())
                .find(t => t.id == trackingId && t.user_id == userId);
        }
        
        if (trackingData) {
            // Возобновляем отслеживание
            const intervalMs = trackingData.interval * 1000;
            trackingData.intervalId = setInterval(async () => {
                await trackPrice(ctx, trackingData);
            }, intervalMs);
            
            activeTrackings.set(trackingId, trackingData);
            
            // Обновляем статус в Mock API
            try {
                await updateUserTracking(trackingId, { isActive: true });
            } catch (error) {
                console.log('Не удалось обновить статус в API');
            }
            
            await ctx.answerCbQuery('▶️ Отслеживание возобновлено');
            await ctx.editMessageText(`▶️ Отслеживание возобновлено.`);
        } else {
            await ctx.answerCbQuery('❌ Не удалось возобновить отслеживание');
        }
    } catch (error) {
        console.error('Resume error:', error);
        await ctx.answerCbQuery('❌ Ошибка при возобновлении отслеживания');
    }
});

bot.action('stop_all', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        const trackings = await getUserTrackings(userId);
        
        // Останавливаем все трекеры
        let stoppedCount = 0;
        for (const tracking of trackings) {
            if (activeTrackings.has(tracking.id)) {
                const trackingData = activeTrackings.get(tracking.id);
                clearInterval(trackingData.intervalId);
                activeTrackings.delete(tracking.id);
                stoppedCount++;
            }
            try {
                await updateUserTracking(tracking.id, { isActive: false });
            } catch (error) {
                console.log('Не удалось обновить статус в API для трекера:', tracking.id);
            }
        }
        
        await ctx.answerCbQuery(`✅ Остановлено ${stoppedCount} отслеживаний`);
        await ctx.editMessageText(`✅ Остановлено ${stoppedCount} отслеживаний.`);
    } catch (error) {
        await ctx.answerCbQuery('❌ Ошибка при остановке отслеживаний');
    }
});

bot.action('pause_all', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        const trackings = await getUserTrackings(userId);
        
        // Приостанавливаем все трекеры
        let pausedCount = 0;
        for (const tracking of trackings) {
            if (activeTrackings.has(tracking.id)) {
                const trackingData = activeTrackings.get(tracking.id);
                clearInterval(trackingData.intervalId);
                activeTrackings.delete(tracking.id);
                pausedCount++;
            }
            try {
                await updateUserTracking(tracking.id, { isActive: false });
            } catch (error) {
                console.log('Не удалось обновить статус в API для трекера:', tracking.id);
            }
        }
        
        await ctx.answerCbQuery(`⏸️ Приостановлено ${pausedCount} отслеживаний`);
        await ctx.editMessageText(`⏸️ Приостановлено ${pausedCount} отслеживаний.`);
    } catch (error) {
        await ctx.answerCbQuery('❌ Ошибка при приостановке отслеживаний');
    }
});

bot.action('resume_all', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        const trackings = await getUserTrackings(userId);
        
        // Возобновляем все трекеры
        let resumedCount = 0;
        for (const tracking of trackings) {
            if (!tracking.isActive) {
                const intervalMs = tracking.interval * 1000;
                tracking.intervalId = setInterval(async () => {
                    await trackPrice(ctx, tracking);
                }, intervalMs);
                
                activeTrackings.set(tracking.id, tracking);
                resumedCount++;
                
                try {
                    await updateUserTracking(tracking.id, { isActive: true });
                } catch (error) {
                    console.log('Не удалось обновить статус в API для трекера:', tracking.id);
                }
            }
        }
        
        await ctx.answerCbQuery(`▶️ Возобновлено ${resumedCount} отслеживаний`);
        await ctx.editMessageText(`▶️ Возобновлено ${resumedCount} отслеживаний.`);
    } catch (error) {
        await ctx.answerCbQuery('❌ Ошибка при возобновлении отслеживаний');
    }
});

bot.action('refresh_list', async (ctx) => {
    const userId = ctx.from.id;
    try {
        const trackings = await getUserTrackings(userId);
        await ctx.deleteMessage();
        await showTrackersList(ctx, trackings);
    } catch (error) {
        await ctx.answerCbQuery('❌ Ошибка при обновлении списка');
    }
});

// Обработка ошибок
bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
    ctx.reply('❌ Произошла ошибка. Пожалуйста, попробуйте еще раз.');
});

// Запуск бота
async function startBot() {
    console.log('Starting price tracking bot...');
    await bot.launch();
    console.log('Bot started successfully!');
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Запуск
startBot().catch(console.error);