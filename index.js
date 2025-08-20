const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const io = require("socket.io-client");

/* ====== ENV ====== */
const TOKEN  = process.env.TELEGRAM_TOKEN;   // <— coloque no Render
const CHAT_ID = Number(process.env.CHAT_ID || 0);
const PORT = process.env.PORT || 10000;      // Render injeta PORT (ex.: 10000)
if (!TOKEN || !CHAT_ID) {
  console.error("❌ Faltam TELEGRAM_TOKEN e/ou CHAT_ID");
  process.exit(1);
}

/* ====== HTTP mínimo (Render precisa ouvir PORT) ====== */
const app = express();
app.get("/", (req, res) => res.send("OK - bot rodando"));
app.listen(PORT, () => console.log("🌐 HTTP on", PORT));

/* ====== Telegram (polling – apenas 1 instância!) ====== */
const bot = new TelegramBot(TOKEN, { polling: true });
bot.on("polling_error", e => console.log("polling_error:", e?.message || e));

let running = false;
const sent = [];
const AUTODELETE_SEC = 3600;
const keyboard = {
  reply_markup: {
    keyboard: [[{text:"▶️ Iniciar"},{text:"⏹ Parar"}],[{text:"🧹 Limpar"}]],
    resize_keyboard: true
  }
};
async function send(text) {
  try {
    const m = await bot.sendMessage(CHAT_ID, text, keyboard);
    sent.push({ id: m.message_id, ts: Math.floor(Date.now()/1000) });
  } catch (e) { console.log("send err:", e?.message || e); }
}
setInterval(() => {
  const now = Math.floor(Date.now()/1000);
  for (let i=sent.length-1;i>=0;i--) {
    if (now - sent[i].ts >= AUTODELETE_SEC) {
      bot.deleteMessage(CHAT_ID, sent[i].id).catch(()=>{});
      sent.splice(i,1);
    }
  }
}, 30000);

bot.on("message", async (msg)=>{
  const t = (msg.text||"").trim();
  if (t === "/start") return bot.sendMessage(CHAT_ID, "🤖 Pronto! Use os botões abaixo.", keyboard);
  if (t === "▶️ Iniciar") { running = true;  return send("✅ Sinais INICIADOS"); }
  if (t === "⏹ Parar")   { running = false; return send("🛑 Sinais PARADOS"); }
  if (t === "🧹 Limpar") {
    for (const s of [...sent]) await bot.deleteMessage(CHAT_ID, s.id).catch(()=>{});
    sent.length = 0; return send("🧽 Limpeza concluída.");
  }
});

/* ====== Estratégia (2 antes + 2 depois) ====== */
const fortesSet = new Set([5,7,8,9,12]);
const HISTORY_MAX = 400;
const history = [];       // [{roll,color,ts}]
const pendingWhites = []; // {id, idx, hour, minute, completed, pred[]}
const minutePredMap = new Map(); // minute -> Set(whiteIds)
let whiteSeq = 0;
const pad2 = n => n.toString().padStart(2,"0");

function combosFromFour(minute, nums) {
  const v = nums.filter(n => n !== 0 && Number.isFinite(n));
  const out = [];
  const push = arr => {
    const sum = arr.reduce((a,b)=>a+b,0);
    out.push({ label: `${minute}+${arr.join("+")}`, minute: (minute + sum) % 60 });
  };
  for (let i=0;i<v.length;i++) push([v[i]]);
  for (let i=0;i<v.length;i++) for (let j=i+1;j<v.length;j++) push([v[i], v[j]]);
  for (let i=0;i<v.length;i++) for (let j=i+1;j<v.length;j++) for (let k=j+1;k<v.length;k++) push([v[i], v[j], v[k]]);
  if (v.length === 4) push(v);
  const seen = new Set();
  return out.filter(c => !seen.has(`${c.minute}:${c.label}`) && (seen.add(`${c.minute}:${c.label}`), true));
}
function strength(distance, minute) {
  const base = fortesSet.has(distance) ? "🔥 Forte" : "Sinal";
  const set = minutePredMap.get(minute);
  if (set && set.size >= 2) return "⚡ Muito Forte";
  return base;
}
function onTick(roll, color, at) {
  const ts = new Date(at || Date.now());
  history.unshift({ roll, color, ts });
  if (history.length > HISTORY_MAX) history.pop();

  // completar janelas (2 após)
  for (const w of pendingWhites) {
    if (!w.completed) {
      const a1 = history[w.idx - 1];
      const a2 = history[w.idx - 2];
      if (a1 && a2) {
        w.completed = true;
        const b1 = history[w.idx + 1]?.roll ?? null;
        const b2 = history[w.idx + 2]?.roll ?? null;
        const win = [b2, b1, a1.roll, a2.roll].filter(x=>x!==null);
        w.pred = combosFromFour(w.minute, win);
        for (const p of w.pred) {
          if (!minutePredMap.has(p.minute)) minutePredMap.set(p.minute, new Set());
          minutePredMap.get(p.minute).add(w.id);
        }
      }
    }
  }

  // validar minuto atual
  const mNow = ts.getMinutes();
  for (const w of pendingWhites) {
    if (!w.completed || !w.pred) continue;
    const hits = w.pred.filter(p => p.minute === mNow);
    if (hits.length) {
      const dist = w.idx;
      const labels = hits.map(h => h.label).slice(0,6).join(" | ");
      const text =
        `⚪ Sinal Detectado\n`+
        `🕐 Branco às ${pad2(w.hour)}:${pad2(w.minute)}\n`+
        `🔢 Combinações: ${labels}\n`+
        `🎯 Minuto alvo: ${pad2(mNow)}\n`+
        `📏 Distância: ${dist} casas\n`+
        `⭐ Força: ${strength(dist, mNow)}`;
      if (running) send(text);
    }
  }

  // novo branco
  if (roll === 0) {
    const h = ts.getHours(), m = ts.getMinutes();
    pendingWhites.push({ id: ++whiteSeq, idx: 0, hour: h, minute: m, completed: false, pred: [] });
    if (running) send(`⚪ Branco detectado ${pad2(h)}:${pad2(m)}. Montando (2 antes + 2 depois)…`);
  }

  // reindex e limpeza
  for (const w of pendingWhites) w.idx++;
  while (pendingWhites.length && pendingWhites[0].idx > 200) {
    const old = pendingWhites.shift();
    if (old?.pred) for (const p of old.pred) {
      const set = minutePredMap.get(p.minute);
      if (set) { set.delete(old.id); if (!set.size) minutePredMap.delete(p.minute); }
    }
  }
}

/* ====== Socket.IO v2 – Blaze ======
   Tentamos múltiplos hosts e fazemos fallback. */
const HOSTS = [
  "https://api-v2.blaze.com",
  "https://api2.blaze.com",
  "https://api.blaze.com"
];
let socket = null, hostIdx = 0, ticks = 0;

function connect() {
  const base = HOSTS[hostIdx % HOSTS.length];
  console.log("🔌 Conectando:", base, "…");

  // v2: io.connect + path de replication + transports websocket
  socket = io.connect(base, {
    path: "/replication/socket.io/",
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    timeout: 10000
  });

  socket.on("connect", () => console.log("✅ Conectado em", base));

  // alguns ambientes emitem 'double.tick', outros 'doubles:tick'
  const handle = (msg) => {
    const roll = Number(msg && msg.roll);
    const color = Number(msg && msg.color);
    const at = (msg && (msg.created_at || msg.rolled_at)) || undefined;
    ticks++;
    if (ticks % 30 === 0) console.log("ticks:", ticks);
    if (Number.isFinite(roll)) onTick(roll, color, at);
  };
  socket.on("double.tick", handle);
  socket.on("doubles:tick", handle);

  socket.on("connect_error", (err) => { console.log("⚠️ connect_error:", err?.message || err); fallback(); });
  socket.on("error", (err) => console.log("⚠️ error:", err?.message || err));
  socket.on("disconnect", (reason) => { console.log("🔌 disconnect:", reason); fallback(); });
}
function fallback() {
  try { socket && socket.close(); } catch {}
  hostIdx++;
  const wait = Math.min(15000, 2000 * hostIdx);
  console.log(`⏳ Tentando próximo host em ${Math.floor(wait/1000)}s…`);
  setTimeout(connect, wait);
}

connect();
send("🤖 Bot pronto. Use ▶️ Iniciar / ⏹ Parar / 🧹 Limpar").catch(()=>{});
