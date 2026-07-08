require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'okcfk9902';
const TON_WALLET_ADDRESS = process.env.TON_WALLET_ADDRESS;
const PUBLIC_URL = process.env.PUBLIC_URL;
const DEFAULT_GOAL = Number(process.env.GOAL_AMOUNT) || 4750;
const DEFAULT_TON_RUB_RATE = Number(process.env.TON_RUB_RATE) || 400;
const PLATEGA_MERCHANT_ID = process.env.PLATEGA_MERCHANT_ID;
const PLATEGA_SECRET = process.env.PLATEGA_SECRET;
const PLATEGA_BASE_URL = 'https://app.platega.io';
const TONAPI_KEY = process.env.TONAPI_KEY; // необязательно, но повышает лимиты запросов
const TONAPI_BASE = 'https://tonapi.io/v2';
const PORT = process.env.PORT || 3000;

// ---- Upstash Redis (постоянное хранилище) ----
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DB_KEY = 'pushpepe:db';

if (!BOT_TOKEN) {
  console.error('Ошибка: не задан BOT_TOKEN в переменных окружения (.env)');
  process.exit(1);
}

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn('⚠️ UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN не заданы — используется локальный файл db.json (данные будут теряться при перезапуске на Render!)');
}

// =========================================================
// ПРОВЕРКА initData (защита от подделки userId на клиенте)
// =========================================================
// Официальный алгоритм Telegram: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const pairs = [];
    for (const [key, value] of params.entries()) {
      pairs.push(`${key}=${value}`);
    }
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) {
      return null; // подпись не совпадает — initData подделан или устарел формат
    }

    const authDate = Number(params.get('auth_date'));
    const ageSeconds = Date.now() / 1000 - authDate;
    if (!authDate || ageSeconds > 86400) {
      return null; // старше 24 часов — просим переоткрыть мини-апп
    }

    const userJson = params.get('user');
    if (!userJson) return null;
    const user = JSON.parse(userJson);

    return {
      id: user.id,
      username: user.username || user.first_name || 'без имени'
    };
  } catch (e) {
    console.error('Ошибка валидации initData:', e.message);
    return null;
  }
}

// =========================================================
// ПРОВЕРКА ДОНАТА ПО БЛОКЧЕЙНУ (через TonAPI)
// =========================================================
// Ищем среди последних входящих транзакций на наш кошелёк ту, что соответствует
// заявленной сумме и произошла недавно. Засчитываем донат только если нашли реальную
// транзакцию в блокчейне, и запоминаем её хэш, чтобы нельзя было "переиспользовать" один платёж дважды.
async function findMatchingIncomingTx(amountTon, notBeforeMs, alreadyUsedHashes) {
  const amountNano = Math.round(amountTon * 1e9);
  const tolerance = 2000000; // допуск ~0.002 TON на комиссии/округления

  const headers = {};
  if (TONAPI_KEY) headers['Authorization'] = `Bearer ${TONAPI_KEY}`;

  const maxAttempts = 6;
  const delayMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(
        `${TONAPI_BASE}/blockchain/accounts/${TON_WALLET_ADDRESS}/transactions?limit=20`,
        { headers }
      );

      if (res.ok) {
        const data = await res.json();
        const transactions = data.transactions || [];

        for (const tx of transactions) {
          const inMsg = tx.in_msg;
          if (!inMsg || !inMsg.value) continue;

          const value = Number(inMsg.value);
          const utimeMs = (tx.utime || 0) * 1000;

          const amountMatches = Math.abs(value - amountNano) <= tolerance;
          const timeMatches = utimeMs >= notBeforeMs - 30000; // небольшой запас на рассинхрон часов
          const notUsedYet = !alreadyUsedHashes.includes(tx.hash);

          if (amountMatches && timeMatches && notUsedYet) {
            return tx.hash;
          }
        }
      } else {
        console.warn('TonAPI вернул ошибку:', res.status);
      }
    } catch (e) {
      console.error('Ошибка запроса к TonAPI:', e.message);
    }

    await new Promise(r => setTimeout(r, delayMs));
  }

  return null; // не нашли подтверждённую транзакцию за отведённое время
}

// ---------- Слой хранения данных ----------
const DB_PATH = path.join(__dirname, 'db.json');

function defaultDB() {
  return {
    users: {},
    donations: [],
    totalAmount: 0,
    goal: DEFAULT_GOAL,
    tonRubRate: DEFAULT_TON_RUB_RATE,
    pendingPayments: {},
    usedTonTxHashes: []
  };
}

function ensureDefaults(db) {
  if (typeof db.goal !== 'number') db.goal = DEFAULT_GOAL;
  if (typeof db.tonRubRate !== 'number') db.tonRubRate = DEFAULT_TON_RUB_RATE;
  if (!db.pendingPayments) db.pendingPayments = {};
  if (!db.users) db.users = {};
  if (!db.donations) db.donations = [];
  if (typeof db.totalAmount !== 'number') db.totalAmount = 0;
  if (!db.usedTonTxHashes) db.usedTonTxHashes = [];
  return db;
}

async function loadDB() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const res = await fetch(`${UPSTASH_URL}/get/${DB_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const data = await res.json();
      if (data.result) {
        return ensureDefaults(JSON.parse(data.result));
      }
    } catch (e) {
      console.error('Ошибка чтения из Upstash:', e.message);
    }
    const initial = defaultDB();
    await saveDB(initial);
    return initial;
  }

  if (!fs.existsSync(DB_PATH)) {
    const initial = defaultDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return ensureDefaults(JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')));
}

async function saveDB(db) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      await fetch(`${UPSTASH_URL}/set/${DB_KEY}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'text/plain'
        },
        body: JSON.stringify(db)
      });
    } catch (e) {
      console.error('Ошибка записи в Upstash:', e.message);
    }
    return;
  }

  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

async function registerUser(userId, username) {
  const db = await loadDB();
  if (!db.users[userId]) {
    db.users[userId] = { username: username || 'без имени', firstSeen: Date.now() };
    await saveDB(db);
  } else if (username && db.users[userId].username !== username) {
    db.users[userId].username = username;
    await saveDB(db);
  }
}

async function addDonation(userId, username, amountTon, txHash, meta) {
  meta = meta || {};
  const db = await loadDB();
  db.donations.push({
    userId: userId,
    username: username || 'без имени',
    amountTon: amountTon,
    txHash: txHash || null,
    date: Date.now(),
    currency: meta.currency || 'TON',
    amountOriginal: meta.amountOriginal !== undefined ? meta.amountOriginal : amountTon
  });
  db.totalAmount = (db.totalAmount || 0) + amountTon;
  if (txHash && meta.currency !== 'RUB') {
    db.usedTonTxHashes.push(txHash);
  }
  if (!db.users[userId]) {
    db.users[userId] = { username: username || 'без имени', firstSeen: Date.now() };
  } else {
    db.users[userId].username = username || db.users[userId].username;
  }
  await saveDB(db);
}

async function setTonRubRate(rate) {
  const db = await loadDB();
  db.tonRubRate = rate;
  await saveDB(db);
}

async function savePendingPayment(transactionId, data) {
  const db = await loadDB();
  db.pendingPayments[transactionId] = data;
  await saveDB(db);
}

async function takePendingPayment(transactionId) {
  const db = await loadDB();
  const data = db.pendingPayments[transactionId];
  if (data) {
    delete db.pendingPayments[transactionId];
    await saveDB(db);
  }
  return data || null;
}

async function getUsedTonTxHashes() {
  const db = await loadDB();
  return db.usedTonTxHashes || [];
}

async function getStats() {
  const db = await loadDB();
  return {
    totalAmount: db.totalAmount || 0,
    totalUsers: Object.keys(db.users).length,
    totalDonations: db.donations.length,
    goal: db.goal || DEFAULT_GOAL,
    tonRubRate: db.tonRubRate || DEFAULT_TON_RUB_RATE,
    totalRub: db.donations.filter(d => d.currency === 'RUB').reduce((s, d) => s + (d.amountOriginal || 0), 0)
  };
}

async function getLeaderboard() {
  const db = await loadDB();
  const totalsByUser = {};
  for (const d of db.donations) {
    if (!totalsByUser[d.userId]) {
      totalsByUser[d.userId] = { username: d.username, amount: 0 };
    }
    totalsByUser[d.userId].amount += d.amountTon;
    totalsByUser[d.userId].username = d.username;
  }
  return Object.values(totalsByUser)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 50);
}

async function setGoal(newGoal) {
  const db = await loadDB();
  db.goal = newGoal;
  await saveDB(db);
}

// ---------- Telegram-бот ----------
const bot = new Telegraf(BOT_TOKEN);

const pendingPasswordInput = new Set();
const authorizedAdmins = new Set();
const pendingGoalInput = new Set();
const pendingRateInput = new Set();

bot.start(async (ctx) => {
  await registerUser(ctx.from.id, ctx.from.username || ctx.from.first_name);

  const webAppUrl = PUBLIC_URL ? `${PUBLIC_URL}/webapp` : null;

  if (!webAppUrl) {
    return ctx.reply('Привет! Бот работает, но PUBLIC_URL ещё не настроен — мини-апп временно недоступен.');
  }

  return ctx.reply(
    'PUSH PEPE 🐸\nЖми кнопку, чтобы открыть приложение и поддержать цель донатом.',
    Markup.inlineKeyboard([
      Markup.button.webApp('🐸 Открыть PUSH PEPE', webAppUrl)
    ])
  );
});

bot.command('admins', (ctx) => {
  pendingPasswordInput.add(ctx.from.id);
  ctx.reply('Введите пароль чтобы войти в админ панель');
});

function adminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💰 Сумма депозитов', 'admin_stat_amount')],
    [Markup.button.callback('👥 Всего пользователей', 'admin_stat_users')],
    [Markup.button.callback('🎯 Изменить цель', 'admin_change_goal')],
    [Markup.button.callback('💱 Изменить курс TON/RUB', 'admin_change_rate')]
  ]);
}

bot.action('admin_stat_amount', async (ctx) => {
  if (!authorizedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  const stats = await getStats();
  ctx.answerCbQuery();
  ctx.reply(`💰 Сумма депозитов: ${stats.totalAmount.toFixed(4)} TON (в т.ч. ${stats.totalRub.toFixed(2)} ₽ по донатам рублями)\nВсего донатов: ${stats.totalDonations}\n🎯 Текущая цель: ${stats.goal} TON\n💱 Курс: 1 TON = ${stats.tonRubRate} ₽`);
});

bot.action('admin_stat_users', async (ctx) => {
  if (!authorizedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  const stats = await getStats();
  ctx.answerCbQuery();
  ctx.reply(`👥 Всего пользователей: ${stats.totalUsers}`);
});

bot.action('admin_change_goal', (ctx) => {
  if (!authorizedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  ctx.answerCbQuery();
  pendingGoalInput.add(ctx.from.id);
  ctx.reply('Введите новую цель в TON (только число), например: 5000');
});

bot.action('admin_change_rate', (ctx) => {
  if (!authorizedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  ctx.answerCbQuery();
  pendingRateInput.add(ctx.from.id);
  ctx.reply('Введите новый курс: сколько рублей стоит 1 TON (только число), например: 420');
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (pendingPasswordInput.has(userId)) {
    pendingPasswordInput.delete(userId);
    if (text === ADMIN_PASSWORD) {
      authorizedAdmins.add(userId);
      return ctx.reply('✅ Доступ разрешён. Админ-панель:', adminKeyboard());
    } else {
      return ctx.reply('❌ Неверный пароль. Попробуйте снова: /admins');
    }
  }

  if (pendingGoalInput.has(userId)) {
    pendingGoalInput.delete(userId);
    const newGoal = Number(text.replace(',', '.'));
    if (!newGoal || newGoal <= 0) {
      return ctx.reply('Некорректное число. Попробуйте ещё раз через кнопку "Изменить цель".', adminKeyboard());
    }
    await setGoal(newGoal);
    return ctx.reply(`✅ Новая цель установлена: ${newGoal} TON`, adminKeyboard());
  }

  if (pendingRateInput.has(userId)) {
    pendingRateInput.delete(userId);
    const newRate = Number(text.replace(',', '.'));
    if (!newRate || newRate <= 0) {
      return ctx.reply('Некорректное число. Попробуйте ещё раз через кнопку "Изменить курс TON/RUB".', adminKeyboard());
    }
    await setTonRubRate(newRate);
    return ctx.reply(`✅ Новый курс установлен: 1 TON = ${newRate} ₽`, adminKeyboard());
  }

  await registerUser(userId, ctx.from.username || ctx.from.first_name);
});

// ---------- Express-сервер ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    tonWalletAddress: TON_WALLET_ADDRESS,
    publicUrl: PUBLIC_URL
  });
});

app.get('/api/stats', async (req, res) => {
  const stats = await getStats();
  res.json(stats);
});

app.get('/api/leaderboard', async (req, res) => {
  const leaderboard = await getLeaderboard();
  res.json({ leaderboard });
});

// Донат в TON — теперь с проверкой initData и проверкой транзакции в блокчейне
app.post('/api/donate', async (req, res) => {
  try {
    const { initData, amountTon, sentAt } = req.body;

    const verifiedUser = validateInitData(initData);
    if (!verifiedUser) {
      return res.status(401).json({ ok: false, error: 'Не удалось подтвердить пользователя Telegram (initData). Перезайдите в приложение.' });
    }

    if (!amountTon || amountTon <= 0) {
      return res.status(400).json({ ok: false, error: 'Некорректная сумма' });
    }

    if (!TON_WALLET_ADDRESS) {
      return res.status(500).json({ ok: false, error: 'Адрес кошелька не настроен на сервере' });
    }

    const notBeforeMs = sentAt ? Number(sentAt) : (Date.now() - 60000);
    const usedHashes = await getUsedTonTxHashes();

    const txHash = await findMatchingIncomingTx(Number(amountTon), notBeforeMs, usedHashes);

    if (!txHash) {
      return res.status(400).json({
        ok: false,
        error: 'Транзакция не найдена в блокчейне. Если вы только что отправили перевод — подождите немного и попробуйте снова.'
      });
    }

    await addDonation(verifiedUser.id, verifiedUser.username, Number(amountTon), txHash);

    try {
      await bot.telegram.sendMessage(verifiedUser.id, 'Спасибо за донат бро! 🐸💎');
    } catch (e) {
      console.warn('Не удалось написать пользователю в личку:', e.message);
    }

    const stats = await getStats();
    res.json({ ok: true, stats, txHash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// Создание платежа в рублях через Platega.io (СБП / карта)
app.post('/api/pay-rub', async (req, res) => {
  try {
    if (!PLATEGA_MERCHANT_ID || !PLATEGA_SECRET) {
      return res.status(500).json({ ok: false, error: 'Платежи в рублях ещё не настроены на сервере' });
    }

    const { initData, amountRub, method } = req.body;

    const verifiedUser = validateInitData(initData);
    if (!verifiedUser) {
      return res.status(401).json({ ok: false, error: 'Не удалось подтвердить пользователя Telegram (initData). Перезайдите в приложение.' });
    }

    if (!amountRub || amountRub <= 0) {
      return res.status(400).json({ ok: false, error: 'Некорректная сумма' });
    }

    const paymentMethod = method === 'card' ? 11 : 2;

    const plategaRes = await fetch(`${PLATEGA_BASE_URL}/transaction/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MerchantId': PLATEGA_MERCHANT_ID,
        'X-Secret': PLATEGA_SECRET
      },
      body: JSON.stringify({
        paymentMethod,
        paymentDetails: { amount: Math.round(amountRub), currency: 'RUB' },
        description: 'Донат PUSH PEPE',
        return: `${PUBLIC_URL}/webapp`,
        failedUrl: `${PUBLIC_URL}/webapp`,
        payload: String(verifiedUser.id),
        metadata: {
          userId: String(verifiedUser.id),
          userName: verifiedUser.username
        }
      })
    });

    const data = await plategaRes.json();

    if (!plategaRes.ok) {
      console.error('Ошибка Platega:', data);
      return res.status(502).json({ ok: false, error: 'Платёжный провайдер вернул ошибку' });
    }

    await savePendingPayment(data.transactionId, {
      userId: verifiedUser.id,
      username: verifiedUser.username,
      amountRub: Number(amountRub)
    });

    res.json({ ok: true, redirect: data.redirect, transactionId: data.transactionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// Вебхук от Platega.io об изменении статуса платежа (сервер-сервер, initData тут не участвует)
app.post('/api/platega/callback', async (req, res) => {
  try {
    const incomingMerchantId = req.headers['x-merchantid'];
    const incomingSecret = req.headers['x-secret'];

    if (incomingMerchantId !== PLATEGA_MERCHANT_ID || incomingSecret !== PLATEGA_SECRET) {
      console.warn('Callback от Platega с неверными заголовками авторизации');
      return res.status(401).json({ ok: false });
    }

    const { id, status } = req.body;

    if (status === 'CONFIRMED') {
      const pending = await takePendingPayment(id);
      if (pending) {
        const db = await loadDB();
        const rate = db.tonRubRate || DEFAULT_TON_RUB_RATE;
        const amountTonEquivalent = pending.amountRub / rate;

        await addDonation(pending.userId, pending.username, amountTonEquivalent, id, {
          currency: 'RUB',
          amountOriginal: pending.amountRub
        });

        try {
          await bot.telegram.sendMessage(pending.userId, 'Спасибо за донат бро! 🐸💎');
        } catch (e) {
          console.warn('Не удалось написать пользователю в личку:', e.message);
        }
      }
    } else {
      await takePendingPayment(id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.get('/webapp', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

bot.launch();
console.log('Бот запущен');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
