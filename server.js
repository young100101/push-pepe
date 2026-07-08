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
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Ошибка: не задан BOT_TOKEN в переменных окружения (.env)');
  process.exit(1);
}

// ---------- "База данных" в JSON-файле ----------
const DB_PATH = path.join(__dirname, 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      users: {},          // { userId: { username, firstSeen } }
      donations: [],       // [{ userId, username, amountTon, txHash, date }]
      totalAmount: 0,
      goal: DEFAULT_GOAL
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (typeof db.goal !== 'number') db.goal = DEFAULT_GOAL;
  return db;
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function registerUser(userId, username) {
  const db = loadDB();
  if (!db.users[userId]) {
    db.users[userId] = { username: username || 'без имени', firstSeen: Date.now() };
    saveDB(db);
  }
}

function addDonation(userId, username, amountTon, txHash) {
  const db = loadDB();
  db.donations.push({
    userId,
    username: username || 'без имени',
    amountTon,
    txHash: txHash || null,
    date: Date.now()
  });
  db.totalAmount = (db.totalAmount || 0) + amountTon;
  if (!db.users[userId]) {
    db.users[userId] = { username: username || 'без имени', firstSeen: Date.now() };
  } else {
    // обновляем username на случай если сменился
    db.users[userId].username = username || db.users[userId].username;
  }
  saveDB(db);
}

function getStats() {
  const db = loadDB();
  return {
    totalAmount: db.totalAmount || 0,
    totalUsers: Object.keys(db.users).length,
    totalDonations: db.donations.length,
    goal: db.goal || DEFAULT_GOAL
  };
}

function getLeaderboard() {
  const db = loadDB();
  const totalsByUser = {};
  for (const d of db.donations) {
    if (!totalsByUser[d.userId]) {
      totalsByUser[d.userId] = { username: d.username, amount: 0 };
    }
    totalsByUser[d.userId].amount += d.amountTon;
    totalsByUser[d.userId].username = d.username; // самый свежий username
  }
  return Object.values(totalsByUser)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 50);
}

function setGoal(newGoal) {
  const db = loadDB();
  db.goal = newGoal;
  saveDB(db);
}

// ---------- Telegram-бот ----------
const bot = new Telegraf(BOT_TOKEN);

const pendingPasswordInput = new Set();
const authorizedAdmins = new Set();
const pendingGoalInput = new Set();

bot.start((ctx) => {
  registerUser(ctx.from.id, ctx.from.username || ctx.from.first_name);

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
    [Markup.button.callback('🎯 Изменить цель', 'admin_change_goal')]
  ]);
}

bot.action('admin_stat_amount', (ctx) => {
  if (!authorizedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  const stats = getStats();
  ctx.answerCbQuery();
  ctx.reply(`💰 Сумма депозитов: ${stats.totalAmount.toFixed(4)} TON\nВсего донатов: ${stats.totalDonations}\n🎯 Текущая цель: ${stats.goal} TON`);
});

bot.action('admin_stat_users', (ctx) => {
  if (!authorizedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  const stats = getStats();
  ctx.answerCbQuery();
  ctx.reply(`👥 Всего пользователей: ${stats.totalUsers}`);
});

bot.action('admin_change_goal', (ctx) => {
  if (!authorizedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  ctx.answerCbQuery();
  pendingGoalInput.add(ctx.from.id);
  ctx.reply('Введите новую цель в TON (только число), например: 5000');
});

bot.on('text', (ctx) => {
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
    setGoal(newGoal);
    return ctx.reply(`✅ Новая цель установлена: ${newGoal} TON`, adminKeyboard());
  }

  registerUser(userId, ctx.from.username || ctx.from.first_name);
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

app.get('/api/stats', (req, res) => {
  const stats = getStats();
  res.json(stats);
});

app.get('/api/leaderboard', (req, res) => {
  res.json({ leaderboard: getLeaderboard() });
});

app.post('/api/donate', async (req, res) => {
  try {
    const { userId, username, amountTon, txHash } = req.body;

    if (!userId || !amountTon) {
      return res.status(400).json({ ok: false, error: 'userId и amountTon обязательны' });
    }

    addDonation(userId, username, Number(amountTon), txHash);

    try {
      await bot.telegram.sendMessage(userId, 'Спасибо за донат бро! 🐸💎');
    } catch (e) {
      console.warn('Не удалось написать пользователю в личку:', e.message);
    }

    const stats = getStats();
    res.json({ ok: true, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'internal error' });
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
