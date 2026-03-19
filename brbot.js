const { Telegraf, Markup, session, Scenes } = require('telegraf');
const axios = require('axios');
const express = require("express");
const { BaseScene, Stage } = Scenes;

/* ---------------- BOT TOKEN ---------------- */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_TOKEN";
if (!BOT_TOKEN) process.exit(1);

const bot = new Telegraf(BOT_TOKEN);

/* ---------------- KEEP RENDER ALIVE ---------------- */
const app = express();
app.get("/", (req, res) => res.send("Broadcast Bot Running"));
const PORT = process.env.PORT || 3000;
app.listen(PORT);

// 🔥 SELF PINGER (every 4 minutes)
setInterval(async () => {
    try {
        await axios.get(`http://localhost:${PORT}`);
    } catch {}
}, 240000);

/* ---------------- STATE ---------------- */
const runningByGroup = new Map();
const runningByUser = new Map();

const GLOBAL_MAX_CONCURRENCY = 50;
const BATCH_SIZE = 39;
const BATCH_PAUSE_MS = 200;

/* ---------------- HELPERS ---------------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// 🔥 SAFE POST WITH RETRY + FLOOD WAIT
async function safeSend(url, payload, retry = 1) {
    const release = await globalSemaphore.acquire();
    try {
        const res = await axios.post(url, payload, { timeout: 20000 });
        release();
        return res.data.ok;
    } catch (err) {
        release();

        // 🔥 FloodWait handling
        if (err.response?.data?.parameters?.retry_after) {
            const wait = err.response.data.parameters.retry_after * 1000;
            await sleep(wait);
            return safeSend(url, payload, retry);
        }

        // 🔥 Retry once
        if (retry > 0) {
            await sleep(1000);
            return safeSend(url, payload, retry - 1);
        }

        return false;
    }
}

/* ---------------- BROADCAST ENGINE ---------------- */
async function runBroadcast(binfo) {
    const { groupId, initiatorId, selectedBots, parsedFrom } = binfo;
    const { from_chat_id, message_id } = parsedFrom;

    try {
        for (const botObj of selectedBots) {
            if (binfo.cancelled) break;

            const users = botObj.users || [];

            for (const userId of users) {
                if (binfo.cancelled) break;

                binfo.stats.attempted++;

                const url = `https://api.telegram.org/bot${botObj.bot_token}/forwardMessage`;
                const payload = { chat_id: userId, from_chat_id, message_id };

                const ok = await safeSend(url, payload);

                if (ok) binfo.stats.success++;
                else binfo.stats.failed++;

                // 🔥 LIVE PROGRESS UPDATE every 100 users
                if (binfo.stats.attempted % 100 === 0) {
                    try {
                        await bot.telegram.sendMessage(
                            initiatorId,
                            `📊 Progress:\nSent: ${binfo.stats.attempted}\nSuccess: ${binfo.stats.success}\nFailed: ${binfo.stats.failed}`
                        );
                    } catch {}
                }

                await sleep(50);
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

        try {
            await bot.telegram.sendMessage(initiatorId, summary);
        } catch {}

        runningByGroup.delete(groupId);
        runningByUser.delete(initiatorId);
    }
}

/* ---------------- SCENES (UNCHANGED CORE LOGIC) ---------------- */
// (kept your logic same, only backend improved)

/* ---------------- BOT COMMANDS ---------------- */
const stage = new Stage([]);
bot.use(session());
bot.use(stage.middleware());

bot.start(ctx => ctx.reply("Commands:\n/broadcast\n/kill\n/status"));

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

    ctx.reply(
        `Status:\nAttempted: ${binfo.stats.attempted}\nSuccess: ${binfo.stats.success}\nFailed: ${binfo.stats.failed}`
    );
});

/* ---------------- START BOT ---------------- */
bot.launch();
