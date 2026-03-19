const { Telegraf, Markup, session, Scenes } = require('telegraf');
const axios = require('axios');
const express = require("express");
const { BaseScene, Stage } = Scenes;

/* ---------------- BOT TOKEN ---------------- */
const BOT_TOKEN = "8662842894:AAFfSklFWQCDkCVV-u4ktn2VsraU4DF6ECc";

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
const m = String(url).trim().match(/(?:https?://)?t.me/c/(\d+)/(\d+)/i);
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
const url = "https://api.telegram.org/bot${BOT_TOKEN}/getChatMember";
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

    const groupKey = ctx.message.text.trim();

    await ctx.reply(`Fetching bots for group id ${groupKey}...`);

    let resp;
    try {
        resp = await axios.get(
            `https://broadcast-db.onrender.com/get-all.php?group_id=${encodeURIComponent(groupKey)}`
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
        const count = b.users?.length || 0;
        totalUsers += count;
        lines.push(`${i + 1}. ${b.name} - ${count}`);
    });

    lines.push('', `Total bots: ${bots.length}`);
    lines.push(`Total users: ${totalUsers}`);
    lines.push('', 'Now send serials (1,3)');

    for (const p of splitTelegramMessage(lines.join('\n'))) {
        await ctx.reply(p);
    }

    ctx.session.broadcastFlow = { groupId: groupKey, bots };
    ctx.scene.enter('collectSerialsScene');

} catch {
    ctx.reply('Error.');
    ctx.scene.leave();
}

});

/* ---------------- SERIALS SCENE ---------------- */
collectSerialsScene.on('message', async (ctx) => {
const txt = ctx.message.text.trim();

if (txt === "/cancel") {
    ctx.scene.leave();
    return ctx.reply("Cancelled.");
}

if (txt.startsWith("/"))
    return ctx.reply("Send numbers like 1,2");

const nums = txt.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
if (!nums.length)
    return ctx.reply('Invalid format.');

ctx.session.broadcastFlow.selectedSerials = nums.map(n => n - 1);

ctx.reply("Send message URL.");
ctx.scene.enter('collectUrlScene');

});

/* ---------------- URL SCENE ---------------- */
collectUrlScene.on('message', async (ctx) => {
const txt = ctx.message.text.trim();

if (txt === "/cancel") {
    ctx.scene.leave();
    return ctx.reply("Cancelled.");
}

if (txt.startsWith("/"))
    return ctx.reply("Send valid link.");

const parsed = parseTgUrl(txt);
if (!parsed)
    return ctx.reply('Invalid URL.');

ctx.session.broadcastFlow.parsedFrom = parsed;

ctx.reply(
    "Confirm start?",
    Markup.inlineKeyboard([
        Markup.button.callback('Start Broadcast', 'start_broadcast')
    ])
);

ctx.scene.enter('confirmScene');

});

/* ---------------- CONFIRM SCENE ---------------- */
confirmScene.action('start_broadcast', async (ctx) => {

const flow = ctx.session.broadcastFlow;
if (!flow) return ctx.reply('Session expired.');

ctx.reply("Broadcast started...");

runBroadcast({
    selectedBots: flow.selectedSerials.map(i => flow.bots[i]),
    parsedFrom: flow.parsedFrom,
    initiatorId: ctx.from.id,
    stats: { attempted: 0, success: 0, failed: 0 },
    startTime: Date.now()
});

ctx.scene.leave();

});

/* ---------------- BROADCAST ENGINE ---------------- */
async function runBroadcast(binfo) {
const { selectedBots, parsedFrom } = binfo;

for (const botObj of selectedBots) {
    for (const userId of (botObj.users || [])) {

        binfo.stats.attempted++;

        try {
            const r = await axios.post(
                `https://api.telegram.org/bot${botObj.bot_token}/forwardMessage`,
                {
                    chat_id: userId,
                    from_chat_id: parsedFrom.from_chat_id,
                    message_id: parsedFrom.message_id
                }
            );

            if (r.data.ok) binfo.stats.success++;
            else binfo.stats.failed++;

        } catch {
            binfo.stats.failed++;
        }
    }
}

try {
    await bot.telegram.sendMessage(
        binfo.initiatorId,
        `Done\nSuccess: ${binfo.stats.success}\nFailed: ${binfo.stats.failed}`
    );
} catch {}

}

/* ---------------- SETUP ---------------- */
const stage = new Stage([
broadcastScene,
collectSerialsScene,
collectUrlScene,
confirmScene
]);

bot.use(session());
bot.use(stage.middleware());

bot.start(ctx => ctx.reply("Commands:\n/broadcast\n/kill\n/status"));
bot.command("broadcast", ctx => ctx.scene.enter("broadcastScene"));

bot.launch();
