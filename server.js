require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'okcfk9902';
const TON_WALLET_ADDRESS = process.env.TON_WALLET_ADDRESS;
const PUBLIC_URL = process.env.PUBLIC_URL;
const DEFAULT_GOAL = Number(process.env.GOAL_AMOUNT) || 4750;
const DEFAULT_TON_RUB_RATE = Number(process.env.TON_RUB_RATE) || 400;
const PLATEGA_MERCHANT_ID = process.env.PLATEGA_MERCHANT_ID;
const PLATEGA_SECRET = process.env.PLATEGA_SECRET;
const PLATEGA_BASE_URL = 'https://app.platega.io';
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

// ---------- Слой хранения данных ----------
const DB_PATH = path.join(__dirname, 'db.json');

function defaultDB() {
  return {
    users: {},
    donations: [],
    totalAmount: 0,
    goal: DEFAULT_GOAL,
    tonRubRate: DEFAULT_TON_RUB_RATE,
    pendingPayments: {}
  };
}

function ensureDefaults(db) {
  if (typeof db.goal !== 'number') db.goal = DEFAULT_GOAL;
  if (typeof db.tonRubRate !== 'number') db.tonRubRate = DEFAULT_TON_RUB_RATE;
  if (!db.pendingPayments) db.pendingPayments = {};
  if (!db.users) db.users = {};
  if (!db.donations) db.donations = [];
  if (typeof db.totalAmount !== 'number') db.totalAmount = 0;
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

app.post('/api/donate', async (req, res) => {
  try {
    const { userId, username, amountTon, txHash } = req.body;

    if (!userId || !amountTon) {
      return res.status(400).json({ ok: false, error: 'userId и amountTon обязательны' });
    }

    await addDonation(userId, username, Number(amountTon), txHash);

    try {
      await bot.telegram.sendMessage(userId, 'Спасибо за донат бро! 🐸💎');
    } catch (e) {
      console.warn('Не удалось написать пользователю в личку:', e.message);
    }

    const stats = await getStats();
    res.json({ ok: true, stats });
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

    const { userId, username, amountRub, method } = req.body;
    if (!userId || !amountRub || amountRub <= 0) {
      return res.status(400).json({ ok: false, error: 'userId и amountRub обязательны' });
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
        payload: String(userId),
        metadata: {
          userId: String(userId),
          userName: username || 'без имени'
        }
      })
    });

    const data = await plategaRes.json();

    if (!plategaRes.ok) {
      console.error('Ошибка Platega:', data);
      return res.status(502).json({ ok: false, error: 'Платёжный провайдер вернул ошибку' });
    }

    await savePendingPayment(data.transactionId, {
      userId,
      username: username || 'без имени',
      amountRub: Number(amountRub)
    });

    res.json({ ok: true, redirect: data.redirect, transactionId: data.transactionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// Вебхук от Platega.io об изменении статуса платежа
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
