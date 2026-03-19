const { Telegraf, Markup, session, Scenes } = require('telegraf');
const axios = require('axios');
const express = require("express");
const { BaseScene, Stage } = Scenes;

/* ---------------- BOT TOKEN ---------------- */
const BOT_TOKEN = "8662842894:AAFfSklFWQCDkCVV-u4ktn2VsraU4DF6ECc";

const bot = new Telegraf(BOT_TOKEN);

/* ---------------- KEEP ALIVE ---------------- */
const app = express();
app.get("/", (req, res) => res.send("Broadcast Bot Running"));
const PORT = process.env.PORT || 3000;
app.listen(PORT);

// self ping
setInterval(() => {
axios.get("http://localhost:${PORT}").catch(()=>{});
}, 240000);

/* ---------------- HELPERS ---------------- */
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function parseTgUrl(url){
const m = String(url).match(/t.me/c/(\d+)/(\d+)/);
if(!m) return null;
return { from_chat_id: "-100"+m[1], message_id: parseInt(m[2]) };
}

async function safeSend(url, payload){
try{
const r = await axios.post(url, payload);
return r.data.ok;
}catch(e){
if(e.response?.data?.parameters?.retry_after){
await sleep(e.response.data.parameters.retry_after * 1000);
return safeSend(url, payload);
}
return false;
}
}

/* ---------------- GLOBAL COMMAND FIX ---------------- */
bot.use((ctx,next)=>{
if(ctx.message?.text?.startsWith("/")){
try{ ctx.scene.leave(); }catch{}
}
return next();
});

/* ---------------- SCENES ---------------- */
const broadcastScene = new BaseScene("broadcast");
const serialScene = new BaseScene("serial");
const urlScene = new BaseScene("url");
const confirmScene = new BaseScene("confirm");

/* -------- START -------- */
broadcastScene.enter(ctx=>ctx.reply("Send group_id"));

broadcastScene.on("message", async ctx=>{
const groupId = ctx.message.text.trim();

let resp;
try{
resp = await axios.get("https://broadcast-db.onrender.com/get-all.php?group_id=${groupId}");
}catch{
return ctx.reply("API failed.");
}

if(!resp.data.success || !resp.data.bots.length)
return ctx.reply("No bots found.");

ctx.session.flow = {
groupId,
bots: resp.data.bots
};

let msg = resp.data.bots.map((b,i)=>"${i+1}. ${b.name} (${b.users.length})").join("\n");
msg += "\n\nSend serials like 1,2";

ctx.reply(msg);
ctx.scene.enter("serial");
});

/* -------- SERIAL -------- */
serialScene.on("message", ctx=>{
const txt = ctx.message.text.trim();

if(txt.startsWith("/")){
ctx.scene.leave();
return ctx.reply("Exited.");
}

const nums = txt.split(",").map(x=>parseInt(x)).filter(x=>!isNaN(x));
if(!nums.length) return ctx.reply("Invalid format.");

ctx.session.flow.selected = nums.map(i=>i-1);

ctx.reply("Send message URL");
ctx.scene.enter("url");
});

/* -------- URL -------- */
urlScene.on("message", ctx=>{
const txt = ctx.message.text.trim();

if(txt.startsWith("/")){
ctx.scene.leave();
return ctx.reply("Exited.");
}

const parsed = parseTgUrl(txt);
if(!parsed) return ctx.reply("Invalid link.");

ctx.session.flow.parsed = parsed;

ctx.reply("Start broadcast?", Markup.inlineKeyboard([
Markup.button.callback("Start","go")
]));

ctx.scene.enter("confirm");
});

/* -------- CONFIRM -------- */
confirmScene.action("go", async ctx=>{
const flow = ctx.session.flow;

const selectedBots = flow.selected.map(i=>flow.bots[i]);

const stats = { attempted:0, success:0, failed:0 };

ctx.reply("Started.");

for(const b of selectedBots){
for(const user of b.users){
stats.attempted++;

  const ok = await safeSend(
    `https://api.telegram.org/bot${b.bot_token}/forwardMessage`,
    {
      chat_id:user,
      from_chat_id:flow.parsed.from_chat_id,
      message_id:flow.parsed.message_id
    }
  );

  if(ok) stats.success++;
  else stats.failed++;

  if(stats.attempted % 100 === 0){
    ctx.telegram.sendMessage(ctx.from.id,
      `Progress:\n${stats.attempted} sent\n${stats.success} success`
    );
  }
}

}

ctx.reply(
"Done\nSent: ${stats.attempted}\nSuccess: ${stats.success}\nFailed: ${stats.failed}"
);

ctx.scene.leave();
});

/* ---------------- SETUP ---------------- */
const stage = new Stage([broadcastScene, serialScene, urlScene, confirmScene]);
bot.use(session());
bot.use(stage.middleware());

bot.start(ctx=>ctx.reply("Use /broadcast"));
bot.command("broadcast", ctx=>ctx.scene.enter("broadcast"));

bot.launch();
