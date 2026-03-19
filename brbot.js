const { Telegraf, Markup, session, Scenes } = require('telegraf');
const axios = require('axios');
const express = require("express"); // Keep server alive for Render
const { BaseScene, Stage } = Scenes;

/* ---------------- BOT TOKEN ---------------- */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8569356669:AAGTVEGtse79DAUJuXxaEU9Wt5RgtERyvmc";
if (!BOT_TOKEN) process.exit(1);

const bot = new Telegraf(BOT_TOKEN);

/* ---------------- KEEP RENDER ALIVE ---------------- */
const app = express();
app.get("/", (req, res) => res.send("Broadcast Bot Running"));
app.listen(process.env.PORT || 3000);

/* ---------------- STATE ---------------- */
const runningByGroup = new Map();
const runningByUser = new Map();

const GLOBAL_MAX_CONCURRENCY = 50;
const BATCH_SIZE = 39;
const BATCH_PAUSE_MS = 200;

/* ---------------- HELPERS ---------------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}

function parseTgUrl(url) {
    const m = String(url).trim().match(/(?:https?:\/\/)?t\.me\/c\/(\d+)\/(\d+)/i);
    if (!m) return null;
    return { from_chat_id: '-100' + m[1], message_id: parseInt(m[2], 10) };
}

function splitTelegramMessage(text, maxLen = 4000) {
    if (!text) return [''];
    if (text.length <= maxLen) return [text];

    const lines = text.split('\n');
    const parts = [];
    let cur = '';

    for (const line of lines) {
        if ((cur + '\n' + line).length > maxLen) {
            if (cur.length) parts.push(cur);

            if (line.length > maxLen) {
                for (let i = 0; i < line.length; i += maxLen)
                    parts.push(line.slice(i, i + maxLen));
                cur = '';
            } else cur = line;
        } else cur = cur ? (cur + '\n' + line) : line;
    }

    if (cur.length) parts.push(cur);
    return parts;
}

/* ---------------- SEMAPHORE ---------------- */
class Semaphore {
    constructor(max) {
        this.max = max;
        this.current = 0;
        this.queue = [];
    }
    async acquire() {
        if (this.current < this.max) {
            this.current++;
            return () => this.release();
        }
        return await new Promise(resolve => this.queue.push(resolve));
    }
    release() {
        this.current--;
        if (this.queue.length > 0) {
            this.current++;
            const next = this.queue.shift();
            next(() => this.release());
        }
    }
}
const globalSemaphore = new Semaphore(GLOBAL_MAX_CONCURRENCY);

async function axiosPost(url, payload, opts = {}) {
    const release = await globalSemaphore.acquire();
    try {
        const resp = await axios.post(url, payload, { timeout: opts.timeout || 20000 });
        release();
        return resp;
    } catch (err) {
        release();
        throw err;
    }
}

/* ---------------- CHECK BOT ACCESS ---------------- */
async function checkBotMembership(chatId) {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`;
        const payload = { chat_id: chatId, user_id: bot.botInfo.id };
        const resp = await axiosPost(url, payload);

        if (resp.data.ok && ['member', 'administrator', 'creator'].includes(resp.data.result.status))
            return true;

        return false;
    } catch {
        return false;
    }
}

/* ---------------- SCENES ---------------- */
const broadcastScene = new BaseScene('broadcastScene');
const collectSerialsScene = new BaseScene('collectSerialsScene');
const collectUrlScene = new BaseScene('collectUrlScene');
const confirmScene = new BaseScene('confirmScene');

/* ---------------- BROADCAST SCENE ---------------- */
broadcastScene.enter(ctx => ctx.reply('Send group id to start broadcast.\n/cancel to abort.'));
broadcastScene.on('message', async (ctx) => {
    try {
        if (!ctx.message || !ctx.message.text)
            return ctx.reply('Send text only.');

        const groupKey = String(ctx.message.text.trim());
        const fromId = ctx.from.id;

        if (runningByGroup.has(groupKey))
            return ctx.reply(`Broadcast already running for ${groupKey}.`);

        if (runningByUser.has(fromId))
            return ctx.reply(`You already have a broadcast running.`);

        await ctx.reply(`Fetching bots for group id ${groupKey}...`);

        let resp;
        try {
            resp = await axios.get(
                `https://broadcast.upayme.link/get-all.php?group_id=${encodeURIComponent(groupKey)}`,
                { timeout: 15000 }
            );
        } catch {
            return ctx.reply('API failed.');
        }

        const data = resp.data;
        if (!data || !data.success || !Array.isArray(data.bots))
            return ctx.reply('No bots found.');

        const bots = data.bots;

        let lines = [];
        let totalUsers = 0;

        bots.forEach((b, i) => {
            const count = Array.isArray(b.users) ? b.users.length : 0;
            totalUsers += count;
            lines.push(`${i + 1}. ${b.name} - ${count}`);
        });

        lines.push('', `Total bots: ${bots.length}`);
        lines.push(`Total users: ${totalUsers}`);
        lines.push('', 'Now send serials (1,3)');

        const parts = splitTelegramMessage(lines.join('\n'));
        for (const p of parts) await ctx.reply(p);

        ctx.session.broadcastFlow = { groupId: groupKey, bots, selectedSerials: null, fromUserId: fromId };
        ctx.scene.enter('collectSerialsScene');

    } catch {
        ctx.session.broadcastFlow = null;
        ctx.reply('Error.');
        ctx.scene.leave();
    }
});

/* ---------------- SERIALS SCENE ---------------- */
collectSerialsScene.enter(ctx => {
    const groupId = ctx.session.broadcastFlow.groupId;
    const url = 'https://broadcast.upayme.link/bot-select.html?group_id=' + encodeURIComponent(groupId);
    ctx.reply('Send serial numbers like 1,3', Markup.inlineKeyboard([Markup.button.url('Select bot (web)', url)]));
});

collectSerialsScene.on('message', async (ctx) => {
    try {
        if (!ctx.message || !ctx.message.text)
            return ctx.reply('Send serials.');

        const txt = ctx.message.text.trim();

        if (txt === '/cancel') {
            ctx.session.broadcastFlow = null;
            return ctx.reply('Cancelled.');
        }

        const nums = txt.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (nums.length === 0)
            return ctx.reply('Invalid format.');

        const bots = ctx.session.broadcastFlow.bots;
        const selected = [];

        for (const n of nums) {
            if (n < 1 || n > bots.length)
                return ctx.reply(`Invalid serial: ${n}`);
            selected.push(n - 1);
        }

        ctx.session.broadcastFlow.selectedSerials = selected;
        ctx.reply(`Selected bots: ${selected.map(i => i + 1).join(', ')}\nSend message URL.`);
        ctx.scene.enter('collectUrlScene');

    } catch {
        ctx.session.broadcastFlow = null;
        ctx.reply('Error.');
        ctx.scene.leave();
    }
});

/* ---------------- URL SCENE ---------------- */
collectUrlScene.on('message', async (ctx) => {
    try {
        if (!ctx.message || !ctx.message.text)
            return ctx.reply('Send URL only.');

        const txt = ctx.message.text.trim();

        if (txt === '/cancel')
            return ctx.reply('Cancelled.');

        const parsed = parseTgUrl(txt);
        if (!parsed)
            return ctx.reply('Invalid URL. Use https://t.me/c/<chat>/<msg>');

        const canAccess = await checkBotMembership(parsed.from_chat_id);
        if (!canAccess)
            return ctx.reply('Bot cannot access source chat.');

        await ctx.reply("URL OK.\nPress Start.");

        ctx.session.broadcastFlow.parsedFrom = parsed;

        ctx.reply(
            "Confirm start?",
            Markup.inlineKeyboard([
                Markup.button.callback('Start Broadcast', `start_broadcast`)
            ])
        );

        ctx.scene.enter('confirmScene');

    } catch {
        ctx.session.broadcastFlow = null;
        ctx.reply('Error.');
        ctx.scene.leave();
    }
});

/* ---------------- CONFIRM SCENE ---------------- */
confirmScene.action('start_broadcast', async (ctx) => {
    const flow = ctx.session.broadcastFlow;
    if (!flow) return ctx.reply('Session expired.');

    const { groupId, selectedSerials, bots, parsedFrom, fromUserId } = flow;

    const selectedBots = selectedSerials.map(i => bots[i]);
    const stats = {
        totalBots: selectedBots.length,
        totalUsers: selectedBots.reduce((a, b) => a + (b.users ? b.users.length : 0), 0),
        attempted: 0,
        success: 0,
        failed: 0
    };

    const binfo = {
        groupId,
        initiatorId: fromUserId,
        selectedBots,
        parsedFrom,
        stats,
        startTime: Date.now(),
        cancelled: false
    };

    runningByGroup.set(groupId, binfo);
    runningByUser.set(fromUserId, groupId);

    ctx.reply("Broadcast started.\nUse /kill to stop.\n/status to check.");
    ctx.scene.leave();
    ctx.session.broadcastFlow = null;

    runBroadcast(binfo);
});

confirmScene.on("message", ctx => ctx.reply("Press Start or /cancel"));

/* ---------------- BROADCAST ENGINE ---------------- */
async function runBroadcast(binfo) {
    const { groupId, initiatorId, selectedBots, parsedFrom } = binfo;
    const { from_chat_id, message_id } = parsedFrom;

    try {
        for (const botObj of selectedBots) {
            if (binfo.cancelled) break;

            const users = botObj.users || [];
            const batches = chunkArray(users, BATCH_SIZE);

            for (const batch of batches) {
                if (binfo.cancelled) break;

                const tasks = batch.map(async userId => {
                    binfo.stats.attempted++;

                    const url = `https://api.telegram.org/bot${botObj.bot_token}/forwardMessage`;
                    const payload = { chat_id: userId, from_chat_id, message_id };

                    try {
                        const r = await axiosPost(url, payload);
                        if (r.data.ok) binfo.stats.success++;
                        else binfo.stats.failed++;
                    } catch {
                        binfo.stats.failed++;
                    }
                });

                await Promise.all(tasks);
                await sleep(BATCH_PAUSE_MS);
            }
        }
    } finally {
        const end = Date.now();
        const summary =
            `Broadcast Summary:\n` +
            `Bots: ${binfo.stats.totalBots}\n` +
            `Users: ${binfo.stats.totalUsers}\n` +
            `Attempted: ${binfo.stats.attempted}\n` +
            `Success: ${binfo.stats.success}\n` +
            `Failed: ${binfo.stats.failed}\n` +
            `Time: ${Math.round((end - binfo.startTime) / 1000)}s`;

        try { await bot.telegram.sendMessage(initiatorId, summary); } catch { }

        runningByGroup.delete(groupId);
        runningByUser.delete(initiatorId);
    }
}

/* ---------------- BOT COMMANDS ---------------- */
const stage = new Stage([broadcastScene, collectSerialsScene, collectUrlScene, confirmScene]);
bot.use(session());
bot.use(stage.middleware());

bot.start(ctx => ctx.reply("Commands:\n/broadcast\n/kill\n/status\n/cancel"));
bot.command("broadcast", ctx => ctx.scene.enter("broadcastScene"));

bot.command("cancel", ctx => {
    if (ctx.scene && ctx.session.broadcastFlow) {
        ctx.session.broadcastFlow = null;
        ctx.scene.leave();
        return ctx.reply("Cancelled.");
    }
    ctx.reply("Nothing to cancel.");
});

bot.command("kill", ctx => {
    const uid = ctx.from.id;
    const groupId = runningByUser.get(uid);
    if (!groupId) return ctx.reply("No broadcast running.");

    const binfo = runningByGroup.get(groupId);
    if (!binfo) return ctx.reply("Cleaned.");

    binfo.cancelled = true;
    ctx.reply("Stopping broadcast...");
});

bot.command("status", ctx => {
    const uid = ctx.from.id;
    const groupId = runningByUser.get(uid);
    if (!groupId) return ctx.reply("No broadcast running.");

    const binfo = runningByGroup.get(groupId);
    const elapsed = Math.round((Date.now() - binfo.startTime) / 1000);

    ctx.reply(
        `Status:\nBots: ${binfo.stats.totalBots}\nUsers: ${binfo.stats.totalUsers}\nAttempted: ${binfo.stats.attempted}\nSuccess: ${binfo.stats.success}\nFailed: ${binfo.stats.failed}\nTime: ${elapsed}s`
    );
});

/* ---------------- START BOT ---------------- */
bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
