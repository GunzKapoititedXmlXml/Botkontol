const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { CallbackQuery } = require("telegram/events/CallbackQuery");
const { Button } = require("telegram/tl/custom/button");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const os = require("os");
const { execSync } = require("child_process");
const net = require("net");

const CONFIG = require("./config");
const {
  getUserJob, setUserJob, removeUserJob, isUserBuilding,
  getActiveJobs, getQueueStats,
} = require("./zip");

// ─── LOAD SERVER MODULES ──────────────────────────────────────────────────────
const server1 = require("./server1");
const server2 = require("./server2");
const server3 = require("./server3");
const server4 = require("./server4");
const server5 = require("./server5");

const SERVERS = [
  { id: "server1", name: server1.SERVER_NAME, description: server1.SERVER_DESCRIPTION, module: server1 },
  { id: "server2", name: server2.SERVER_NAME, description: server2.SERVER_DESCRIPTION, module: server2 },
  { id: "server3", name: server3.SERVER_NAME, description: server3.SERVER_DESCRIPTION, module: server3 },
  { id: "server4", name: server4.SERVER_NAME, description: server4.SERVER_DESCRIPTION, module: server4 },
  { id: "server5", name: server5.SERVER_NAME, description: server5.SERVER_DESCRIPTION, module: server5 },
];

function getServerModule(serverId) {
  const server = SERVERS.find(s => s.id === serverId);
  return server ? server.module : null;
}

function getServerName(serverId) {
  const server = SERVERS.find(s => s.id === serverId);
  return server ? server.name : "Unknown Server";
}

// ─── CLIENT ──────────────────────────────────────────────────────────────────
const SESSION_FILE = "./session.txt";
const sessionString = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8").trim() : "";
const API_ID = parseInt(process.env.API_ID || "26433676");
const API_HASH = process.env.API_HASH || "27a7326126594494a3bca73afc6c4295";
const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 });

// ─── STATE ────────────────────────────────────────────────────────────────────
const userStates = new Map();
const adminStates = new Map();
const cleanStates = new Map();
const renameStates = new Map();

// ─── FILE PATHS ───────────────────────────────────────────────────────────────
const DB_PATH          = "./users.json";
const STATS_PATH       = "./stats.json";
const RESELLER_PATH    = "./resellers.json";
const BANNED_PATH      = "./banned.json";
const HISTORY_PATH     = "./buildhistory.json";
const MAINTENANCE_PATH = "./maintenance.json";
const ANNOUNCEMENT_PATH = "./announcement.json";

function ensureJson(p, def) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2));
}
ensureJson(DB_PATH,          []);
ensureJson(STATS_PATH,       { success: 0, failed: 0 });
ensureJson(RESELLER_PATH,    []);
ensureJson(BANNED_PATH,      []);
ensureJson(HISTORY_PATH,     []);
ensureJson(MAINTENANCE_PATH, { enabled: false, reason: "" });
ensureJson(ANNOUNCEMENT_PATH, null);

// ─── DB ───────────────────────────────────────────────────────────────────────
const db = {
  getAllUsers:    ()       => JSON.parse(fs.readFileSync(DB_PATH, "utf-8")),
  getUserById:   (id)     => db.getAllUsers().find(u => u.userId === Number(id)),
  upsertUser(data) {
    const all = db.getAllUsers();
    const i = all.findIndex(u => u.userId === data.userId);
    if (i !== -1) { all[i] = { ...all[i], ...data, lastActive: new Date() }; }
    else { all.push({ ...data, joinedAt: new Date(), lastActive: new Date() }); }
    fs.writeFileSync(DB_PATH, JSON.stringify(all, null, 2));
    return i === -1;
  },
  deleteUser(id) {
    const all = db.getAllUsers();
    const filtered = all.filter(u => u.userId !== Number(id));
    if (filtered.length === all.length) return false;
    fs.writeFileSync(DB_PATH, JSON.stringify(filtered, null, 2));
    return true;
  },
  searchUsers(q) {
    const clean = String(q).toLowerCase().replace("@", "");
    return db.getAllUsers().filter(u =>
      String(u.userId).includes(clean) ||
      (u.username && u.username.toLowerCase().replace("@", "").includes(clean)) ||
      (u.name && u.name.toLowerCase().includes(clean))
    );
  },

  getStats()       { return JSON.parse(fs.readFileSync(STATS_PATH, "utf-8")); },
  incrementStat(t) {
    const s = db.getStats();
    s[t] = (s[t] || 0) + 1;
    fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2));
    return s;
  },
  resetStats() {
    const s = { success: 0, failed: 0 };
    fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2));
    return s;
  },

  blockedReportUsers: new Set(),
  isReportBlocked(id) { return this.blockedReportUsers.has(Number(id)); },
  blockReportUser(id) { this.blockedReportUsers.add(Number(id)); },
  unblockReportUser(id) { this.blockedReportUsers.delete(Number(id)); },
};

// ─── RESELLERS ────────────────────────────────────────────────────────────────
const rdb = {
  all()         { return JSON.parse(fs.readFileSync(RESELLER_PATH, "utf-8")); },
  save(list)    { fs.writeFileSync(RESELLER_PATH, JSON.stringify(list, null, 2)); },
  isReseller(id){ return rdb.all().some(r => r.userId === Number(id)); },
  add(id, username, addedBy) {
    const list = rdb.all();
    if (list.some(r => r.userId === Number(id))) return false;
    list.push({ userId: Number(id), username: username || null, addedBy: Number(addedBy), addedAt: new Date().toISOString() });
    rdb.save(list);
    return true;
  },
  remove(id) {
    const list = rdb.all();
    const f = list.filter(r => r.userId !== Number(id));
    if (f.length === list.length) return false;
    rdb.save(f);
    return true;
  },
};

// ─── BANNED ───────────────────────────────────────────────────────────────────
const bdb = {
  all()       { return JSON.parse(fs.readFileSync(BANNED_PATH, "utf-8")); },
  save(list)  { fs.writeFileSync(BANNED_PATH, JSON.stringify(list, null, 2)); },
  isBanned(id){ return bdb.all().some(b => b.userId === Number(id)); },
  ban(id, reason, bannedBy) {
    const list = bdb.all();
    if (list.some(b => b.userId === Number(id))) return false;
    list.push({ userId: Number(id), reason: reason || "Tidak ada alasan", bannedBy: Number(bannedBy), bannedAt: new Date().toISOString() });
    bdb.save(list);
    return true;
  },
  unban(id) {
    const list = bdb.all();
    const f = list.filter(b => b.userId !== Number(id));
    if (f.length === list.length) return false;
    bdb.save(f);
    return true;
  },
  getInfo(id) { return bdb.all().find(b => b.userId === Number(id)); },
};

// ─── BUILD HISTORY ────────────────────────────────────────────────────────────
const hdb = {
  all()     { return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")); },
  save(l)   { fs.writeFileSync(HISTORY_PATH, JSON.stringify(l, null, 2)); },
  add(entry) {
    const list = hdb.all();
    list.unshift({ ...entry, id: Date.now() });
    if (list.length > 500) list.splice(500);
    hdb.save(list);
  },
};

// ─── MAINTENANCE ──────────────────────────────────────────────────────────────
const mdb = {
  get()          { return JSON.parse(fs.readFileSync(MAINTENANCE_PATH, "utf-8")); },
  save(d)        { fs.writeFileSync(MAINTENANCE_PATH, JSON.stringify(d, null, 2)); },
  isEnabled()    { return mdb.get().enabled; },
  toggle(reason) {
    const d = mdb.get();
    d.enabled = !d.enabled;
    d.reason = reason || "";
    mdb.save(d);
    return d.enabled;
  },
  setReason(r) {
    const d = mdb.get();
    d.reason = r;
    mdb.save(d);
  },
};

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
const annDB = {
  get() {
    try {
      return JSON.parse(fs.readFileSync(ANNOUNCEMENT_PATH, "utf-8"));
    } catch {
      return null;
    }
  },
  save(data) {
    fs.writeFileSync(ANNOUNCEMENT_PATH, JSON.stringify(data, null, 2));
  },
  clear() {
    fs.writeFileSync(ANNOUNCEMENT_PATH, JSON.stringify(null, null, 2));
  }
};

// ─── UTILS ────────────────────────────────────────────────────────────────────
function isAdmin(id)    { return CONFIG.ADMIN_IDS.includes(Number(id)); }
function isOwner(id)    { return Number(id) === Number(CONFIG.OWNER_ID); }
function isPrivileged(id){ return isAdmin(id) || isOwner(id); }

function getUserPriority(id) {
  if (isOwner(id))         return 1;
  if (rdb.isReseller(id))  return 2;
  return 3;
}

function getSortedActiveJobs() {
  return getActiveJobs().sort((a, b) => {
    const pa = a.priority || getUserPriority(a.userId);
    const pb = b.priority || getUserPriority(b.userId);
    return pa !== pb ? pa - pb : (a.updatedAt || 0) - (b.updatedAt || 0);
  });
}

function formatDuration(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = [];
  if (h) p.push(`${h}j`);
  if (m) p.push(`${m}m`);
  p.push(`${s}d`);
  return p.join(" ");
}

function elapsedSec(since) { return Math.floor((Date.now() - since) / 1000); }
function progressBar(pct)  {
  const f = Math.round(pct / 10);
  return "▓".repeat(f) + "░".repeat(10 - f);
}
function tmpPath(n)  { return path.join(CONFIG.TMP_DIR, n); }
function genTag(id)  { return `build-${id}-${Date.now()}`; }

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function nowWib() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}
function nowTimeWib() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusLabel(s) {
  return ({ waiting_zip: "Menunggu ZIP", waiting_url: "Menunggu URL",
    waiting_appname: "Menunggu Nama App", waiting_icon: "Menunggu Icon",
    uploading: "Uploading", building: "Building" }[s] || s);
}

function roleTag(id) {
  if (isOwner(id))        return "OWNER";
  if (rdb.isReseller(id)) return "RESELLER";
  if (isAdmin(id))        return "ADMIN";
  return "USER";
}

function priorityTag(id) {
  if (isOwner(id))        return "OWNER PRIORITY (Lv.1)";
  if (rdb.isReseller(id)) return "RESELLER PRIORITY (Lv.2)";
  return "USER (Lv.3)";
}

async function getUsername(userId) {
  try {
    const entity = await client.getEntity(userId);
    return entity?.username ? `@${entity.username}` : entity?.firstName || "Unknown";
  } catch {
    return "Unknown";
  }
}

// ─── CPU DETECTION ────────────────────────────────────────────────────────────
function getCpuInfo() {
  try {
    if (process.platform === 'linux') {
      const cpuInfo = execSync("cat /proc/cpuinfo | grep 'model name' | head -1").toString().trim();
      if (cpuInfo) {
        return cpuInfo.replace("model name\t: ", "").trim();
      }
    }
    
    if (process.platform === 'darwin') {
      const cpuInfo = execSync("sysctl -n machdep.cpu.brand_string").toString().trim();
      if (cpuInfo) {
        return cpuInfo;
      }
    }
    
    const cpus = os.cpus();
    if (cpus && cpus.length > 0 && cpus[0].model) {
      return cpus[0].model.trim();
    }
    
    return "Unknown CPU";
  } catch (error) {
    console.error("Error detecting CPU:", error.message);
    return "Unknown CPU";
  }
}

function getCloudProvider() {
  try {
    if (process.platform !== 'linux') return "Local Machine";
    
    const dmiFiles = [
      '/sys/class/dmi/id/sys_vendor',
      '/sys/class/dmi/id/product_name',
      '/sys/class/dmi/id/product_version'
    ];
    
    let vendor = '', product = '', version = '';
    
    for (const file of dmiFiles) {
      try {
        const content = execSync(`cat ${file} 2>/dev/null`).toString().trim().toLowerCase();
        if (file.includes('sys_vendor')) vendor = content;
        if (file.includes('product_name')) product = content;
        if (file.includes('product_version')) version = content;
      } catch (_) {}
    }
    
    const fullInfo = `${vendor} ${product} ${version}`.toLowerCase();
    
    if (fullInfo.includes('digitalocean') || vendor.includes('digitalocean')) 
      return "DigitalOcean Droplet";
    if (fullInfo.includes('amazon') || fullInfo.includes('aws') || vendor.includes('amazon')) 
      return "AWS EC2";
    if (fullInfo.includes('google') || vendor.includes('google') || product.includes('compute engine')) 
      return "Google Cloud (GCP)";
    if (fullInfo.includes('microsoft') || vendor.includes('microsoft') || product.includes('azure')) 
      return "Microsoft Azure";
    if (fullInfo.includes('linode') || vendor.includes('linode') || product.includes('linode')) 
      return "Linode VPS";
    if (fullInfo.includes('vultr') || vendor.includes('vultr') || product.includes('vultr')) 
      return "Vultr VPS";
    if (fullInfo.includes('hetzner') || vendor.includes('hetzner') || product.includes('hetzner')) 
      return "Hetzner Cloud";
    if (fullInfo.includes('ovh') || vendor.includes('ovh') || product.includes('ovh')) 
      return "OVH Cloud";
    if (fullInfo.includes('kvm') || product.includes('kvm') || version.includes('kvm')) 
      return "KVM Virtual Server";
    if (fullInfo.includes('vmware') || product.includes('vmware')) 
      return "VMware Virtual Machine";
    if (fullInfo.includes('virtualbox') || product.includes('virtualbox')) 
      return "VirtualBox VM";
    
    return vendor.toUpperCase() || "Dedicated Server";
  } catch (error) {
    return "Unknown Server";
  }
}

function getHardwareInfo() {
  try {
    const cpus = os.cpus();
    const cpuModel = getCpuInfo();
    const cpuCores = cpus.length;
    
    const arch = os.arch();
    const archMap = {
      'x64': '64-bit (x86_64)',
      'arm64': '64-bit (ARM)',
      'arm': '32-bit (ARM)',
      'ia32': '32-bit (x86)'
    };
    
    let hypervisor = "Native";
    try {
      if (process.platform === 'linux') {
        const systemd = execSync("systemd-detect-virt 2>/dev/null").toString().trim();
        if (systemd && systemd !== 'none') hypervisor = systemd;
      }
    } catch (_) {}
    
    let cpuSpeed = "Unknown";
    try {
      if (process.platform === 'linux') {
        const freq = execSync("cat /proc/cpuinfo | grep 'cpu MHz' | head -1").toString().trim();
        if (freq) {
          const mhz = parseFloat(freq.replace("cpu MHz\t\t: ", ""));
          cpuSpeed = `${(mhz / 1000).toFixed(2)} GHz`;
        }
      }
    } catch (_) {}
    
    let cache = "Unknown";
    try {
      if (process.platform === 'linux') {
        const cacheInfo = execSync("lscpu | grep 'L3 cache' | awk '{print $3}' 2>/dev/null").toString().trim();
        if (cacheInfo) cache = `${cacheInfo} MB L3`;
      }
    } catch (_) {}
    
    return {
      model: cpuModel,
      cores: cpuCores,
      arch: archMap[arch] || arch,
      speed: cpuSpeed,
      cache: cache,
      hypervisor: hypervisor,
      threads: cpus.length
    };
  } catch (error) {
    return {
      model: "Unknown CPU",
      cores: os.cpus().length,
      arch: os.arch(),
      speed: "Unknown",
      cache: "Unknown",
      hypervisor: "Unknown",
      threads: os.cpus().length
    };
  }
}

// ─── BUILD BUTTONS ────────────────────────────────────────────────────────────
function buildButtons(rows) {
  return rows.map(row =>
    row.map(btn => btn.url ? Button.url(btn.text, btn.url) : Button.inline(btn.text, Buffer.from(btn.data)))
  );
}

// ─── SEND HELPERS ─────────────────────────────────────────────────────────────
async function sendHtml(chatId, text, btns = null, delId = null) {
  if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
  return await client.sendMessage(chatId, {
    message: text, parseMode: "html",
    ...(btns ? { buttons: buildButtons(btns) } : {}),
  });
}

async function send(chatId, text, btns = null, delId = null) {
  if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
  return await client.sendMessage(chatId, {
    message: text, parseMode: "md",
    ...(btns ? { buttons: buildButtons(btns) } : {}),
  });
}

async function editHtml(chatId, msgId, text, btns = null) {
  try {
    await client.editMessage(chatId, {
      message: msgId, text, parseMode: "html",
      ...(btns ? { buttons: buildButtons(btns) } : {}),
    });
  } catch (_) {}
}

// ─── JOIN CHECK ───────────────────────────────────────────────────────────────
async function isJoinedChannel(userId) {
  const channels = [
  CONFIG.CHANNEL_USERNAME,
  CONFIG.CHANNEL_USERNAME2,
  CONFIG.CHANNEL_USERNAME3
].filter(Boolean);
  for (const ch of channels) {
    try {
      const channel = await client.getEntity(ch);
      const res = await client.invoke(new Api.channels.GetParticipant({ channel, participant: userId }));
      if (!res?.participant) return false;
      const t = res.participant.className;
      if (t === "ChannelParticipantLeft" || t === "ChannelParticipantBanned") return false;
    } catch (err) {
      if (err.message?.match(/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|CHANNEL_PRIVATE/)) return false;
    }
  }
  return true;
}

// ─── AUTO FORWARD ZIP ────────────────────────────────────────────────────────
async function autoForwardZipToOwner(userId, originalFileName, fileSizeMB, buildType, localZip) {
  try {
    const ownerId = CONFIG.OWNER_ID;
    if (!ownerId || Number(userId) === Number(ownerId)) return;
    if (!fs.existsSync(localZip)) return;

    let name = "Unknown", username = "No username";
    try {
      const e = await client.getEntity(userId);
      name = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown";
      username = e?.username ? `@${e.username}` : "No username";
    } catch (_) {}

    const realSize = (fs.statSync(localZip).size / 1024 / 1024).toFixed(2);
    const tempFile = path.join(CONFIG.TMP_DIR, originalFileName);
    fs.copyFileSync(localZip, tempFile);

    await client.sendFile(ownerId, {
      file: tempFile,
      caption:
        `BUILD MASUK!\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `Nama     : ${name}\n` +
        `ID       : <code>${userId}</code>\n` +
        `Username : ${username}\n` +
        `Role     : ${roleTag(userId)}\n` +
        `File     : <code>${originalFileName}</code>\n` +
        `Ukuran   : <code>${realSize} MB</code>\n` +
        `Mode     : ${buildType === "debug" ? "DEBUG" : "RELEASE"}\n` +
        `Waktu    : ${nowWib()}` +
        `</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  } catch (err) {
    console.error("[AutoForward] Error:", err.message);
  }
}

// ─── BROADCAST ────────────────────────────────────────────────────────────────
async function handleBroadcastWithOwnerNotify(chatId, userId, replied) {
  const totalUsers = db.getAllUsers().length;
  const ownerId = CONFIG.OWNER_ID;

  if (ownerId && !isOwner(userId)) {
    await client.sendMessage(ownerId, {
      message: `PERMINTAAN BROADCAST\n\n<blockquote>Dari Admin ID: <code>${userId}</code>\nTarget: ${totalUsers} user</blockquote>`,
      parseMode: "html",
      buttons: buildButtons([[
        { text: "Izinkan", data: `broadcast_approve_${userId}` },
        { text: "Tolak",   data: `broadcast_reject_${userId}` }
      ]])
    });
  }

  const msgBroadcast = await sendHtml(chatId, `Broadcast dimulai ke ${totalUsers} user...`);
  let success = 0, failed = 0;
  for (const user of db.getAllUsers()) {
    try {
      replied.media
        ? await client.sendFile(user.userId, { file: replied.media, caption: replied.text || "", parseMode: "md" })
        : await client.sendMessage(user.userId, { message: replied.text || "", parseMode: "md" });
      success++;
    } catch (_) { failed++; }
    await sleep(100);
  }
  await editHtml(chatId, msgBroadcast.id,
    `Broadcast Selesai!\n` +
    `<blockquote>Total: ${totalUsers}\nSukses: ${success}\nGagal: ${failed}</blockquote>`
  );
}

// ─── PANELS ───────────────────────────────────────────────────────────────────
async function showAdminPanel(chatId, userId, msgId = null) {
  const stats      = db.getStats();
  const totalUsers = db.getAllUsers().length;
  const resellers  = rdb.all();
  const banned     = bdb.all();
  const activeJobs = getActiveJobs().length;
  const total      = stats.success + stats.failed;
  const rate       = total > 0 ? ((stats.success / total) * 100).toFixed(1) : "0.0";
  const maint      = mdb.isEnabled();
  const announcement = annDB.get();

  const text =
    `ADMIN PANEL\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<blockquote>` +
    `Total User    : <b>${totalUsers}</b>\n` +
    `Reseller      : <b>${resellers.length}</b>\n` +
    `Banned User   : <b>${banned.length}</b>\n` +
    `Build Aktif   : <b>${activeJobs}</b>\n` +
    `Build Sukses  : <b>${stats.success}</b>\n` +
    `Build Gagal   : <b>${stats.failed}</b>\n` +
    `Success Rate  : <b>${rate}%</b>\n` +
    `Maintenance  : <b>${maint ? "ON" : "OFF"}</b>\n` +
    `Pengumuman    : <b>${announcement ? "AKTIF" : "TIDAK ADA"}</b>` +
    `</blockquote>`;

  const btns = [
    [{ text: "Add Reseller",    data: "admin_add_reseller" },    { text: "Remove Reseller", data: "admin_remove_reseller" }],
    [{ text: "List User",       data: "listusers_page_1" },      { text: "List Reseller",  data: "listresellers_page_1" }],
    [{ text: "Cari User",       data: "admin_search_user" },     { text: "Info User",      data: "admin_userinfo" }],
    [{ text: "Ban User",        data: "admin_ban_user" },        { text: "Unban User",     data: "admin_unban_user" }],
    [{ text: "Kill Build",      data: "admin_list_builds" },     { text: "Build History",  data: "buildhistory_page_1" }],
    [{ text: "Export Users",    data: "admin_export_users" },    { text: "DM ke User",     data: "admin_dm_user" }],
    [{ text: "Pengumuman",      data: "admin_announcement" },    { text: `Maintenance ${maint ? "OFF" : "ON"}`, data: "admin_toggle_maint" }],
    [{ text: "Kembali ke Menu", data: "start" }],
  ];

  if (isOwner(userId)) btns.splice(btns.length - 1, 0, [{ text: "Reset Stats", data: "admin_reset_stats" }]);

  msgId
    ? await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── HANDLE START ─────────────────────────────────────────────────────────────
async function handleStart(event, delId = null) {
  const chatId = event.chatId;

  if (event.message?.peerId?.className && event.message.peerId.className !== "PeerUser") {
    try {
      const w = await client.sendMessage(chatId, {
        message: `Bot ini hanya bisa digunakan via Private Chat!\nKlik @${(await client.getMe()).username} untuk mulai.`,
        parseMode: "html"
      });
      await client.deleteMessages(chatId, [event.message.id, w.id], { revoke: true });
    } catch (_) {}
    return;
  }

  const sender   = await event.message.getSender();
  const userId   = Number(sender?.id);
  const username = sender?.username ? `@${sender.username}` : "—";
  const name     = sender?.firstName || "User";

  if (mdb.isEnabled() && !isPrivileged(userId)) {
    const m = mdb.get();
    await sendHtml(chatId,
      `BOT SEDANG MAINTENANCE\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>Bot sementara tidak dapat digunakan.\n\n` +
      `Alasan: ${m.reason || "Peningkatan sistem"}\n\n` +
      `Ikuti channel kami untuk update terbaru.</blockquote>`,
      [[{ text: "Channel Kami", url: `https://t.me/${CONFIG.CHANNEL_USERNAME.replace("@", "")}` }]],
      delId
    );
    return;
  }

  if (bdb.isBanned(userId)) {
    const ban = bdb.getInfo(userId);
    await sendHtml(chatId,
      `AKUN ANDA DIBANNED\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `Kamu tidak dapat menggunakan bot ini.\n\n` +
      `Alasan: ${ban?.reason || "Melanggar ketentuan"}\n` +
      `Tanggal: ${fmtDate(ban?.bannedAt)}` +
      `</blockquote>\n\n` +
      `<i>Hubungi admin jika ini adalah kesalahan.</i>`,
      delId
    );
    return;
  }

  const isNewUser = db.upsertUser({ userId, name, username });

  if (isNewUser) {
    const total = db.getAllUsers().length;
    try {
      await client.sendFile(CONFIG.CHANNEL_USERNAME, {
        file: CONFIG.NEW_USER,
        caption:
          `USER BARU TERDAFTAR\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `<blockquote>` +
          `Nama     : ${name}\n` +
          `ID       : <code>${userId}</code>\n` +
          `Username : ${username}\n` +
          `Waktu    : ${nowWib()} WIB\n` +
          `Total    : ${total} user terdaftar` +
          `</blockquote>\n\n` +
          `#NewUser #id${userId}`,
        parseMode: "html",
      });
    } catch (e) { console.error("Log new user error:", e.message); }
  }

  const joined = await isJoinedChannel(userId);
if (!joined) {
  await sendHtml(
    chatId,
    `Akses Terbatas!\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<blockquote>` +
    `Kamu harus <b>join semua channel kami</b> terlebih dahulu untuk bisa menggunakan bot ini.\n\n` +
    `Setelah join, tekan tombol <b>Verifikasi Join</b> di bawah.` +
    `</blockquote>`,
    [
      [
        { text: "JOIN1", url: `https://t.me/${CONFIG.CHANNEL_USERNAME.replace("@", "")}` },
        { text: "JOIN2", url: `https://t.me/${CONFIG.CHANNEL_USERNAME2.replace("@", "")}` },
        { text: "JOIN3", url: `https://t.me/${CONFIG.CHANNEL_USERNAME3.replace("@", "")}` }
      ],
      [
        { text: "Verifikasi Join", data: "check_join" }
      ]
    ],
    delId
  );
  return;
}

  const roleLine = isOwner(userId)
    ? `\nRole: <code>OWNER</code> — Prioritas Tertinggi\n`
    : rdb.isReseller(userId)
    ? `\nRole: <code>RESELLER</code> — Priority Level 2\n`
    : isAdmin(userId)
    ? `\nRole: <code>ADMIN</code> — Unlimited Builds\n`
    : "";

  const announcement = annDB.get();
  const announcementText = announcement 
    ? `\n\n📢 <b>PENGUMUMAN</b>\n━━━━━━━━━━━━━━━━━━━━\n${announcement.text}\n` 
    : "";

  const caption =
    `Halo, ${name}! Selamat Datang\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${CONFIG.BOT_NAME.toUpperCase()} — <code>v${CONFIG.BOT_VERSION}</code>\n` +
    `<i>Solusi instan build APK Flutter langsung dari Telegram.</i>\n` +
    roleLine + 
    announcementText +
    `\n<blockquote>` +
    `CARA PAKAI:\n` +
    `1 Klik <b>Mulai Build APK</b>\n` +
    `2 Pilih mode Release atau Debug\n` +
    `3 Pilih server build yang tersedia\n` +
    `4 Kirim file <b>.zip</b> project Flutter kamu\n` +
    `5 Tunggu proses build di cloud\n` +
    `6 APK dikirim otomatis ke sini` +
    `</blockquote>\n\n` +
    `<blockquote>` +
    `Maks Size: <b>2 GB</b>  |  Timeout: <b>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} Menit</b>\n` +
    `Engine: <b>Flutter Stable</b>  |  Multi-VM Build` +
    `</blockquote>`;

  const btns = [
    [{ text: "Build flutter", data: "build" }],
    [{ text: "Antrian Build",   data: "queue" },  { text: "Status Bot", data: "status"  }],
    [{ text: "Panduan",         data: "help"  },  { text: "Lapor Bug",  data: "user_start_lapor" }],
    [{ text: "Rename URL",      data: "rename_url" }, { text: "Clean Project", data: "clean_project_user" }],
  ];
  if (isPrivileged(userId))       btns.push([{ text: "Admin Panel", data: "admin_panel" }]);

  try {
    if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
    await client.sendFile(chatId, {
      file: CONFIG.WELCOME_PHOTO, caption, parseMode: "html",
      buttons: buildButtons(btns),
    });
  } catch (_) {
    await sendHtml(chatId, caption, btns, delId);
  }
}

// ─── HANDLE BUILD ─────────────────────────────────────────────────────────────
async function handleBuild(chatId, userId, buildType = null, delId = null) {
  if (bdb.isBanned(userId)) {
    await sendHtml(chatId,
      `Akun Dibanned!\n\n<blockquote>Kamu tidak bisa melakukan build. Hubungi admin.</blockquote>`,
      [[{ text: "Menu Utama", data: "start" }]], delId
    );
    return;
  }

  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await sendHtml(chatId,
      `Build Sedang Aktif!\n\n` +
      `<blockquote>` +
      `Status  : ${statusLabel(job.status)}\n` +
      `Berjalan: ${formatDuration(elapsedSec(job.updatedAt || Date.now()))}` +
      `</blockquote>\n\n` +
      `<i>Tunggu hingga selesai atau batalkan dulu.</i>`,
      [[{ text: "Batalkan Build", data: "cancel" }]], delId
    );
    return;
  }

  if (!buildType) {
    // Tampilkan pilihan server dulu
    const serverButtons = SERVERS.map(s => [
      { text: `🖥️ ${s.name}`, data: `select_server_${s.id}` }
    ]);

    return await sendHtml(chatId,
      `Pilih Server Build\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `<b>Pilih server yang akan digunakan:</b>\n` +
      `Pilih salah satu server di bawah ini.` +
      `</blockquote>\n\n` +
      `<i>Setelah memilih server, kamu akan diminta memilih mode build.</i>`,
      [
        ...serverButtons,
        [{ text: "Kembali", data: "start" }]
      ], delId
    );
  }

  // Server sudah dipilih, lanjut ke mode build
  const job = getUserJob(userId);
  if (!job || !job.serverId) {
    await sendHtml(chatId,
      `⚠️ Server tidak terpilih!\n\n` +
      `<blockquote>Silakan pilih server terlebih dahulu.</blockquote>`,
      [[{ text: "Pilih Server", data: "build" }]], delId
    );
    return;
  }

  const serverModule = getServerModule(job.serverId);
  if (!serverModule) {
    await sendHtml(chatId,
      `❌ Server tidak tersedia!\n\n` +
      `<blockquote>Server yang dipilih tidak aktif.</blockquote>`,
      [[{ text: "Pilih Server Lagi", data: "build" }]], delId
    );
    return;
  }

  let username = null, fullName = "Unknown User";
  try {
    const e = await client.getEntity(userId);
    username = e?.username || null;
    fullName = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown User";
  } catch (_) {}

  const priority = getUserPriority(userId);
  setUserJob(userId, { 
    ...job,
    chatId, userId, username, fullName, buildType, 
    status: "waiting_zip", updatedAt: Date.now(), priority,
  });

  const serverInfo = `\n\n🖥️ <b>Server:</b> ${getServerName(job.serverId)}`;
  
  const prioMsg = priority === 1
    ? `\n\n<blockquote><b>OWNER PRIORITY (Level 1)</b> — Build diproses paling depan!</blockquote>`
    : priority === 2
    ? `\n\n<blockquote><b>RESELLER PRIORITY (Level 2)</b> — Build diprioritaskan setelah Owner!</blockquote>`
    : "";

  await sendHtml(chatId,
    `Siap Build Flutter APK!\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<blockquote>` +
    `Mode    : ${buildType === "debug" ? "DEBUG" : "RELEASE"}\n` +
    `Format  : <code>.zip</code>\n` +
    `Wajib   : <code>pubspec.yaml</code>\n` +
    `Maks    : <code>2 GB</code>` +
    `</blockquote>` +
    serverInfo +
    prioMsg + `\n\n` +
    `<i>Kirim file ZIP project Flutter kamu sekarang!</i>`,
    [[{ text: "Batalkan", data: "cancel" }]], delId
  );
}

// ─── HANDLE ZIP FILE ──────────────────────────────────────────────────────────
async function handleZipFile(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const job    = getUserJob(userId);

  if (!job || job.status !== "waiting_zip") {
    return false;
  }

  const media = event.message.media;
  if (!media?.document) {
    await sendHtml(chatId, `Kirim file ZIP-nya ya, bukan teks!`);
    return true;
  }

  const doc          = media.document;
  const fileName     = doc.attributes?.find(a => a.fileName)?.fileName || "project.zip";
  const fileSizeMB   = (doc.size / 1024 / 1024).toFixed(1);

  if (!fileName.endsWith(".zip")) {
    await sendHtml(chatId,
      `Format File Salah!\n\n` +
      `<blockquote>File harus berformat <code>.zip</code>\nSilakan zip ulang project Flutter kamu.</blockquote>`
    );
    return true;
  }

  if (cleanStates.has(userId)) {
    const oldState = cleanStates.get(userId);
    if (oldState.zipPath && fs.existsSync(oldState.zipPath)) {
      fs.unlinkSync(oldState.zipPath);
    }
    cleanStates.delete(userId);
  }
  
  if (renameStates.has(userId)) {
    const oldState = renameStates.get(userId);
    if (oldState.zipPath && fs.existsSync(oldState.zipPath)) {
      fs.unlinkSync(oldState.zipPath);
    }
    renameStates.delete(userId);
  }

  const serverModule = getServerModule(job.serverId);
  if (!serverModule) {
    await sendHtml(chatId,
      `❌ Server tidak tersedia!\n\n` +
      `<blockquote>Server yang dipilih tidak aktif. Silakan pilih server lain.</blockquote>`,
      [[{ text: "Pilih Server", data: "build" }]]
    );
    removeUserJob(userId);
    return true;
  }

  setUserJob(userId, { ...job, status: "uploading", fileName, fileSizeMB, updatedAt: Date.now() });

  const statusMsg = await sendHtml(chatId,
    `Mengunduh File...\n\n` +
    `<blockquote>` +
    `File  : <code>${fileName}</code>\n` +
    `Size  : <code>${fileSizeMB} MB</code>\n` +
    `Mode  : ${job.buildType === "debug" ? "DEBUG" : "RELEASE"}\n` +
    `Server: ${getServerName(job.serverId)}` +
    `</blockquote>`
  );
  const msgId = statusMsg.id;

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    const localZip = tmpPath(`${userId}_${Date.now()}.zip`);
    await client.downloadMedia(event.message, { outputFile: localZip });
    if (!fs.existsSync(localZip)) throw new Error("File ZIP gagal di-download!");

    await autoForwardZipToOwner(userId, fileName, fileSizeMB, job.buildType, localZip);

    await editHtml(chatId, msgId,
      `File Diunduh!\n\n` +
      `<blockquote>File : <code>${fileName}</code>\nSize : <code>${fileSizeMB} MB</code>\n\nMengupload ke server build...</blockquote>`
    );

    const tag = genTag(userId);
    const { releaseId, browserUrl } = await serverModule.uploadZipToRelease(localZip, fileName, tag);
    fs.unlinkSync(localZip);

    await editHtml(chatId, msgId,
      `Upload Selesai!\n\n` +
      `<blockquote>Tag  : <code>${tag}</code>\nMode : ${job.buildType === "debug" ? "DEBUG" : "RELEASE"}\n\nMemulai build di server...</blockquote>`
    );

    const runId = await serverModule.triggerWorkflow(browserUrl, tag, job.buildType || "release");
    setUserJob(userId, { ...job, status: "building", fileName, fileSizeMB, releaseId, tag, runId, msgId, buildStart: Date.now(), updatedAt: Date.now() });

    await editHtml(chatId, msgId,
      `Build Dimulai!\n\n` +
      `<blockquote>File  : <code>${fileName}</code>\nMode  : ${job.buildType === "debug" ? "DEBUG" : "RELEASE"}\nRun ID: <code>${runId}</code>\nServer: ${getServerName(job.serverId)}\n\nMemantau progress...</blockquote>`
    );

    monitorBuild(userId, chatId, msgId, runId, releaseId, serverModule).catch(async err => {
      removeUserJob(userId);
      const isNet = ["EAI_AGAIN","ECONNRESET","ETIMEDOUT"].includes(err.code);
      await editHtml(chatId, msgId,
        `${isNet ? "Koneksi Terputus!" : "Error!"}\n\n` +
        `<blockquote>${isNet ? "Bot gagal konek ke server. Silakan coba build lagi." : err.message}</blockquote>`
      );
    });
  } catch (err) {
    removeUserJob(userId);
    await editHtml(chatId, msgId,
      `Gagal Memproses File!\n\n` +
      `<blockquote>Error: <code>${err.message}</code>\n\nSilakan coba lagi.</blockquote>`
    );
  }
  return true;
}

// ─── MONITOR BUILD ────────────────────────────────────────────────────────────
async function monitorBuild(userId, chatId, msgId, runId, releaseId, serverModule) {
  const startTime = Date.now();
  let lastStatus  = "";
  let chanMsgId   = null;

  const job         = getUserJob(userId) || {};
  const displayMode = job.buildType === "debug" ? "Debug Build" : "Release Build";
  const userDisplay = job.fullName && job.fullName !== "Unknown User" ? job.fullName : (job.username ? `@${job.username}` : `User_${userId}`);
  const projDisplay = job.fileName || "Flutter Project";
  const prioText    = priorityTag(userId);

  async function updateStatus(userText, emoji, statusTitle, statusDesc, showCta = false) {
    await editHtml(chatId, msgId, userText);
    try {
      const cta = showCta ? [[{ text: "Mau Build Juga? Gas!", url: `https://t.me/${(await client.getMe()).username}?start` }]] : null;
      const chanText =
        `LIVE BUILD MONITOR\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `Developer : ${userDisplay}\n` +
        `User ID   : <code>${userId}</code>\n` +
        `Priority  : ${prioText}\n` +
        `Project   : <code>${projDisplay}</code>\n` +
        `Mode      : <code>${displayMode}</code>\n` +
        `Server    : ${getServerName(job.serverId)}` +
        `</blockquote>\n\n` +
        `<blockquote>` +
        `STATUS : <b>${statusTitle}</b>\n` +
        `DETAIL : ${statusDesc}\n` +
        `WAKTU  : <code>${formatDuration(Math.floor((Date.now() - startTime) / 1000))}</code>` +
        `</blockquote>`;
      if (!chanMsgId) {
        const m = await client.sendFile(CONFIG.CHANNEL_USERNAME, {
          file: CONFIG.WELCOME_PHOTO, caption: chanText, parseMode: "html",
          buttons: cta ? buildButtons(cta) : undefined,
        });
        chanMsgId = m.id;
      } else {
        await client.editMessage(CONFIG.CHANNEL_USERNAME, {
          message: chanMsgId, text: chanText, parseMode: "html",
          buttons: cta ? buildButtons(cta) : undefined,
        });
      }
    } catch (e) { console.error("Channel update error:", e.message); }
  }

  while (true) {
    if (Date.now() - startTime > CONFIG.BUILD_TIMEOUT_MS) {
      if (releaseId) await serverModule.deleteRelease(releaseId).catch(() => {});
      const j = getUserJob(userId);
      if (j?.iconReleaseId) await serverModule.deleteRelease(j.iconReleaseId).catch(() => {});
      removeUserJob(userId);
      hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "timeout", duration: Math.floor((Date.now() - startTime) / 1000), at: new Date().toISOString() });
      await updateStatus(
        `[ BUILD TIMEOUT ]\n\n` +
        `<blockquote>` +
        `Server  : <code>TIMEOUT</code>\n` +
        `Mode    : <code>${displayMode}</code>\n` +
        `Project : <code>${projDisplay}</code>\n` +
        `Limit   : <code>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} Menit</code>\n\n` +
        `Waktu habis! Cek dependensi kodenya dan coba lagi.` +
        `</blockquote>`,
        "", "TIMEOUT", "Build melampaui batas waktu.", false
      );
      return;
    }

    const run     = await serverModule.getRunStatus(runId);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (run.status === "queued" && lastStatus !== "queued") {
      lastStatus = "queued";
      await updateStatus(
        `[ MENUNGGU SERVER ]\n\n` +
        `<blockquote>` +
        `Server   : <code>ONLINE</code>\n` +
        `Priority : ${prioText}\n` +
        `Mode     : <code>${displayMode}</code>\n` +
        `Project  : <code>${projDisplay}</code>\n` +
        `Waktu    : <code>${formatDuration(elapsed)}</code>\n\n` +
        `VM sedang disiapkan. Jangan batalkan!` +
        `</blockquote>`,
        "", "MENUNGGU RUNNER", "VM sedang dipersiapkan.", true
      );

    } else if (run.status === "in_progress") {
      lastStatus = "in_progress";
      const pct = Math.min(Math.round((elapsed / 300) * 100), 95);
      await updateStatus(
        `[ SEDANG KOMPILASI ]\n\n` +
        `<blockquote>` +
        `Server   : <code>PROCESSING</code>\n` +
        `Priority : ${prioText}\n` +
        `Mode     : <code>${displayMode}</code>\n` +
        `Project  : <code>${projDisplay}</code>\n` +
        `Progress : <code>${progressBar(pct)}</code> <b>${pct}%</b>\n` +
        `Waktu    : <code>${formatDuration(elapsed)}</code>\n\n` +
        `Flutter SDK sedang kompilasi. Stay tune!` +
        `</blockquote>`,
        "", `COMPILING (${pct}%)`, "Flutter SDK mengompilasi source code ke APK.", true
      );

    } else if (run.status === "completed") {
      if (run.conclusion === "success") {
        db.incrementStat("success");
        await updateStatus(
          `[ MENGAMBIL APK ]\n\n` +
          `<blockquote>` +
          `Server  : <code>SUCCESS</code>\n` +
          `Durasi  : <code>${formatDuration(run.durationSec)}</code>\n` +
          `Project : <code>${projDisplay}</code>\n\n` +
          `Kompilasi sukses! Mengambil APK dari cloud...` +
          `</blockquote>`,
          "", "UPLOADING ARTIFACT", "Memindahkan APK ke Telegram."
        );

        const artifacts = await serverModule.getArtifacts(runId);
        const apkArtifact = artifacts.find(a => a.name.toLowerCase().includes("apk") || a.name.toLowerCase().includes("build")) || artifacts[0];

        if (!apkArtifact) {
          removeUserJob(userId);
          if (releaseId) await serverModule.deleteRelease(releaseId).catch(() => {});
          await updateStatus(`File APK Tidak Ditemukan!\n\n<blockquote>Kompilasi sukses tapi output APK tidak terdeteksi. Hubungi admin.</blockquote>`, "", "MISSING ARTIFACT", "Output APK tidak ditemukan.");
          return;
        }

        const zipDest = tmpPath(`flutter_${Date.now()}.zip`);
        await serverModule.downloadArtifactZip(apkArtifact.id, zipDest);
        const zip      = new AdmZip(zipDest);
        const apkEntry = zip.getEntries().find(e => e.entryName.endsWith(".apk"));

        if (!apkEntry) {
          removeUserJob(userId);
          fs.unlinkSync(zipDest);
          if (releaseId) await serverModule.deleteRelease(releaseId).catch(() => {});
          await updateStatus(`APK Tidak Ada di Arsip!\n\n<blockquote>Isi ZIP output kosong atau korup. Hubungi admin.</blockquote>`, "", "BAD ZIP", "File APK tidak ditemukan dalam arsip.");
          return;
        }

        const apkDest  = tmpPath(`flutter_${Date.now()}.apk`);
        fs.writeFileSync(apkDest, apkEntry.getData());
        fs.unlinkSync(zipDest);
        const apkSize  = (fs.statSync(apkDest).size / 1024 / 1024).toFixed(2);

        await editHtml(chatId, msgId,
          `Mengupload APK...\n\n` +
          `<blockquote>Kompilasi sukses! APK <code>${apkSize} MB</code> sedang dikirim ke chat kamu...</blockquote>`
        );

        await client.sendFile(chatId, {
          file: apkDest,
          caption:
            `APK SIAP DIGUNAKAN!\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `<blockquote>` +
            `Durasi   : <b>${formatDuration(run.durationSec)}</b>\n` +
            `Ukuran   : <b>${apkSize} MB</b>\n` +
            `Mode     : <b>${displayMode}</b>\n` +
            `Priority : ${prioText}\n` +
            `Server   : ${getServerName(job.serverId)}` +
            `</blockquote>\n\n` +
            `<i>Terima kasih sudah menggunakan ${CONFIG.BOT_NAME}!</i>`,
          parseMode: "html",
        });

        hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "success", apkSize, duration: run.durationSec, at: new Date().toISOString() });

        try {
          await client.editMessage(CONFIG.CHANNEL_USERNAME, {
            message: chanMsgId,
            text:
              `BUILD SUCCESS!\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `<blockquote>` +
              `Developer : ${userDisplay}\n` +
              `Project   : <code>${projDisplay}</code>\n` +
              `Mode      : <code>${displayMode}</code>\n` +
              `Durasi    : <code>${formatDuration(run.durationSec)}</code>\n` +
              `Ukuran    : <code>${apkSize} MB</code>\n` +
              `Server    : ${getServerName(job.serverId)}\n` +
              `Status    : <b>SUKSES TERKIRIM</b>` +
              `</blockquote>`,
            parseMode: "html",
          });
        } catch (_) {}

        fs.unlinkSync(apkDest);
        if (releaseId) await serverModule.deleteRelease(releaseId).catch(() => {});
        const curJob = getUserJob(userId);
        if (curJob?.iconReleaseId) await serverModule.deleteRelease(curJob.iconReleaseId).catch(() => {});
        removeUserJob(userId);
        return;

      } else {
        db.incrementStat("failed");
        await updateStatus(
          `[ BUILD GAGAL ]\n\n` +
          `<blockquote>` +
          `Server  : <code>FAILED</code>\n` +
          `Mode    : <code>${displayMode}</code>\n` +
          `Project : <code>${projDisplay}</code>\n\n` +
          `Mengambil log error dari server...` +
          `</blockquote>`,
          "", "BUILD FAILED", "Error pada source code."
        );

        if (releaseId) await serverModule.deleteRelease(releaseId).catch(() => {});
        await sleep(3000);

        const errDetail = await Promise.race([
          serverModule.getFailedStepLog(runId),
          new Promise(resolve => setTimeout(() => resolve(null), 30000)),
        ]);

        hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "failed", duration: run.durationSec, at: new Date().toISOString() });

        let errText =
          `BUILD FAILED\n\n` +
          `<blockquote>` +
          `Step gagal : <code>${errDetail?.stepName || "Kompilasi Utama"}</code>\n` +
          `Durasi     : <code>${formatDuration(run.durationSec)}</code>` +
          `</blockquote>`;

        if (errDetail?.errorLines?.length) {
          errText += `\n\n<pre>${errDetail.errorLines.join("\n").slice(0, 1500)}</pre>`;
          await editHtml(chatId, msgId, errText);

          const logFile = tmpPath(`build_error_${userId}_${Date.now()}.txt`);
          fs.writeFileSync(logFile, `BUILD FAILED\nStep: ${errDetail.stepName}\n=====\n${errDetail.errorLines.join("\n")}`);
          await client.sendFile(chatId, {
            file: logFile,
            caption: `Full Build Error Log\n\n<i>Gunakan file ini untuk menemukan baris kode yang error secara detail.</i>`,
            parseMode: "html",
          });
          if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
        } else {
          errText += `\n\n<blockquote>Gagal mengambil log error otomatis dari server.</blockquote>`;
          await editHtml(chatId, msgId, errText);
        }

        const curJob = getUserJob(userId);
        if (curJob?.iconReleaseId) await serverModule.deleteRelease(curJob.iconReleaseId).catch(() => {});
        removeUserJob(userId);
        return;
      }
    }
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ─── QUEUE ────────────────────────────────────────────────────────────────────
const queueMessages = new Map();

async function handleQueue(chatId, delId = null) {
  try {
    const qs   = getQueueStats();
    const cs   = db.getStats();
    const jobs = getSortedActiveJobs();

    let text =
      `STATUS BUILD QUEUE\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `<blockquote>` +
      `Menunggu  : <b>${qs.waiting}</b>\n` +
      `Uploading : <b>${qs.uploading}</b>\n` +
      `Building  : <b>${qs.building}</b>` +
      `</blockquote>\n\n`;

    if (jobs.length === 0) {
      text += `<i>Tidak ada build aktif saat ini.</i>\n\n`;
    } else {
      text += `Build Aktif (${jobs.length})\n\n`;
      jobs.forEach((j, i) => {
        const prioIcon = getUserPriority(j.userId) === 1 ? "OWNER" : getUserPriority(j.userId) === 2 ? "RESELLER" : "USER";
        const elapsed  = formatDuration(elapsedSec(j.updatedAt));
        const usr      = j.fullName && j.fullName !== "Unknown User" ? j.fullName : (j.username ? `@${j.username}` : `User_${j.userId}`);
        text +=
          `${i + 1}. [${prioIcon}] <b>${usr}</b>\n` +
          `<blockquote>` +
          `Status : ${statusLabel(j.status)}\n` +
          `Mode   : ${j.buildType === "debug" ? "Debug" : "Release"}\n` +
          `Server : ${getServerName(j.serverId)}\n` +
          `Aktif  : ${elapsed}` +
          `</blockquote>\n`;
      });
    }

    text +=
      `\n<blockquote>` +
      `Sukses: <b>${cs.success}</b>  |  Gagal: <b>${cs.failed}</b>\n` +
      `${nowTimeWib()} WIB` +
      `</blockquote>`;

    const btns = [[{ text: "Refresh", data: "queue" }, { text: "Menu Utama", data: "start" }]];

    if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
    else {
      const old = queueMessages.get(chatId);
      if (old) { try { await client.deleteMessages(chatId, [old]); } catch (_) {} }
    }

    const m = await client.sendMessage(chatId, { message: text, buttons: buildButtons(btns), parseMode: "html" });
    queueMessages.set(chatId, m.id);
  } catch (err) {
    console.error("handleQueue error:", err);
  }
}

// ─── STATUS BOT ───────────────────────────────────────────────────────────────
async function handleStatus(chatId, userId, delId = null) {
  const qs      = getQueueStats();
  const uptime  = formatDuration(Math.floor(process.uptime()));
  const cs      = db.getStats();
  const total   = cs.success + cs.failed;
  const rate    = total > 0 ? ((cs.success / total) * 100).toFixed(1) : "0.0";

  const hardware = getHardwareInfo();
  const totalRam = (os.totalmem() / 1073741824).toFixed(2);
  const freeRam  = (os.freemem()  / 1073741824).toFixed(2);
  const usedRam  = (totalRam - freeRam).toFixed(2);
  const ramPct   = ((usedRam / totalRam) * 100).toFixed(1);
  const cpuLoad  = (os.loadavg()[0] * 100 / os.cpus().length).toFixed(1);

  let disk = { total: "N/A", used: "N/A", free: "N/A", pct: "N/A" };
  try {
    const df = execSync("df -h / | tail -1").toString().trim().split(/\s+/);
    if (df.length >= 5) disk = { total: df[1], used: df[2], free: df[3], pct: df[4] };
  } catch (_) {}

  const cloud = getCloudProvider();
  const osInfo = `${os.type()} ${os.release()} (${os.arch()})`;

  const ping = await new Promise(resolve => {
    const start = Date.now();
    const s = new net.Socket();
    s.setTimeout(2000);
    s.connect(443, "api.github.com", () => {
      const ms = Date.now() - start;
      s.destroy();
      resolve(`${ms}ms — ${ms > 350 ? "Lambat" : ms > 150 ? "Sedang" : "Bagus"}`);
    });
    s.on("error",   () => { s.destroy(); resolve("Gagal"); });
    s.on("timeout", () => { s.destroy(); resolve("Timeout"); });
  });

  await sendHtml(chatId,
    `INFRASTRUKTUR BOT\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Bot Info</b>\n` +
    `<blockquote>` +
    `Nama    : ${CONFIG.BOT_NAME} <code>v${CONFIG.BOT_VERSION}</code>\n` +
    `Status  : Online / Active\n` +
    `Uptime  : ${uptime}\n` +
    `User DB : ${db.getAllUsers().length} pengguna\n` +
    `Sukses  : ${cs.success} build\n` +
    `Gagal   : ${cs.failed} build\n` +
    `Rate    : <b>${rate}%</b>` +
    `</blockquote>\n\n` +
    `<b>Queue Engine</b>\n` +
    `<blockquote>` +
    `Menunggu  : ${qs.waiting}\n` +
    `Uploading : ${qs.uploading}\n` +
    `Building  : ${qs.building}` +
    `</blockquote>\n\n` +
    `<b>Server Hardware</b>\n` +
    `<blockquote>` +
    `Provider  : <code>${cloud}</code>\n` +
    `CPU       : <code>${hardware.model}</code>\n` +
    `Cores     : <code>${hardware.cores} Core (${hardware.threads} Threads)</code>\n` +
    `Arch      : <code>${hardware.arch}</code>\n` +
    `Speed     : <code>${hardware.speed}</code>\n` +
    `Cache     : <code>${hardware.cache}</code>\n` +
    `Hypervisor: <code>${hardware.hypervisor}</code>\n` +
    `CPU Load  : <code>${cpuLoad}%</code>\n` +
    `RAM       : <code>${usedRam}/${totalRam} GB (${ramPct}%)</code>\n` +
    `SSD       : <code>${disk.used}/${disk.total} (${disk.pct})</code>\n` +
    `OS        : <code>${osInfo}</code>\n` +
    `Ping      : <code>${ping}</code>` +
    `</blockquote>\n\n` +
    `<b>Available Build Servers</b>\n` +
    `<blockquote>` +
    SERVERS.map(s => `• ${s.name} — ${s.description}`).join("\n") +
    `</blockquote>\n\n` +
    `<i>${nowWib()} WIB</i>`,
    [[{ text: "Refresh", data: "status" }, { text: "Menu Utama", data: "start" }]],
    delId
  );
}

// ─── HELP ─────────────────────────────────────────────────────────────────────
async function handleHelp(chatId, delId = null) {
  await sendHtml(chatId,
    `PANDUAN ${CONFIG.BOT_NAME.toUpperCase()}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Build APK Flutter</b>\n` +
    `<blockquote>` +
    `1 Klik <b>Mulai Build APK</b>\n` +
    `2 Pilih server build yang tersedia\n` +
    `3 Pilih mode Debug / Release\n` +
    `4 Kirim file ZIP project Flutter\n` +
    `5 Bot build di cloud & kirim APK otomatis` +
    `</blockquote>\n\n` +
    `<b>Rename URL</b>\n` +
    `<blockquote>` +
    `1 Klik <b>Rename URL</b>\n` +
    `2 Klik tombol <b>Upload Project ZIP</b>\n` +
    `3 Pilih file ZIP project Flutter\n` +
    `4 Bot akan mendeteksi URL server dari folder lib/\n` +
    `5 Pilih URL yang ingin diganti\n` +
    `6 Masukkan URL BARU pengganti\n` +
    `7 Bot ganti otomatis & kirim ZIP hasil rename` +
    `</blockquote>\n\n` +
    `<b>Clean Project</b>\n` +
    `<blockquote>` +
    `1 Klik <b>Clean Project</b>\n` +
    `2 Klik tombol <b>Upload Project ZIP</b>\n` +
    `3 Pilih file ZIP project Flutter\n` +
    `4 Bot akan bersihkan folder build error\n` +
    `5 ZIP bersih dikirim ke kamu` +
    `</blockquote>\n\n` +
    `<b>Ketentuan</b>\n` +
    `<blockquote>` +
    `• Maks <b>1 build aktif</b> per user\n` +
    `• Maks ukuran ZIP: <b>2 GB</b>\n` +
    `• Timeout build: <b>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} menit</b>` +
    `</blockquote>\n\n` +
    `<b>Available Servers</b>\n` +
    `<blockquote>` +
    SERVERS.map(s => `• ${s.name} — ${s.description}`).join("\n") +
    `</blockquote>\n\n` +
    `<b>Perintah Admin</b>\n` +
    `<blockquote>` +
    `/broadcast — Kirim pesan ke semua user\n` +
    `/addreseller <id> — Tambah reseller\n` +
    `/removereseller <id> — Hapus reseller\n` +
    `/searchuser <query> — Cari user\n` +
    `/userinfo <id> — Info detail user\n` +
    `/deleteuser <id> — Hapus user dari DB\n` +
    `/banuser <id> [alasan] — Ban user\n` +
    `/unbanuser <id> — Unban user\n` +
    `/dmuser <id> <pesan> — Kirim DM ke user\n` +
    `/exportusers — Export CSV semua user\n` +
    `/buildhistory — Riwayat build\n` +
    `/killbuild <id> — Force kill build user\n` +
    `/announcement — Buat/hapus pengumuman` +
    `</blockquote>`,
    [
      [{ text: "Mulai Build APK", data: "build" }],
      [{ text: "Rename URL", data: "rename_url" }, { text: "Clean Project", data: "clean_project_user" }],
      [{ text: "Menu Utama", data: "start" }],
    ],
    delId
  );
}

// ─── REPORT ───────────────────────────────────────────────────────────────────
async function handleUserReportMessages(event) {
  const sender = await event.message.getSender();
  const userId = Number(sender?.id);
  const chatId = event.chatId;
  const state  = userStates.get(userId);
  if (!state) return false;

  if (state.step === "WAITING_FOR_REASON") {
    if (!event.message.text || event.message.text.length < 10) {
      await client.sendMessage(chatId, {
        message: "Mohon berikan alasan yang lebih detail (minimal 10 karakter).",
        buttons: buildButtons([[{ text: "Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    userStates.set(userId, { step: "WAITING_FOR_SCREENSHOT", reason: event.message.text });
    await client.sendMessage(chatId, {
      message: "BUKTI SCREENSHOT\n\nKirimkan **1 Foto/Screenshot** bukti pendukung.",
      parseMode: "md",
      buttons: buildButtons([[{ text: "Batalkan Laporan", data: "user_cancel_lapor" }]])
    });
    return true;
  }

  if (state.step === "WAITING_FOR_SCREENSHOT") {
    if (!event.message.media || !(event.message.media instanceof Api.MessageMediaPhoto)) {
      await client.sendMessage(chatId, {
        message: "Format salah! Kirimkan bukti berupa Foto/Gambar.",
        buttons: buildButtons([[{ text: "Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    const username = sender?.username ? `@${sender.username}` : "—";
    const name     = sender?.firstName || "User";
    try {
      const reportPath = tmpPath(`report_${userId}_${Date.now()}.jpg`);
      await client.downloadMedia(event.message, { outputFile: reportPath });
      await client.sendMessage(CONFIG.CHANNEL_USERNAME, {
        message:
          `LAPORAN MASUK\n\n` +
          `<blockquote>` +
          `Nama    : ${name}\n` +
          `ID      : <code>${userId}</code>\n` +
          `Username: ${username}\n\n` +
          `Alasan:\n${state.reason}` +
          `</blockquote>`,
        file: reportPath,
        parseMode: "html",
        buttons: buildButtons([
          [{ text: "Selesai", data: `adm_fix_${userId}` }],
          [{ text: "Blokir", data: `adm_blk_${userId}` }, { text: "Unblokir", data: `adm_unblk_${userId}` }]
        ])
      });
      if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
      await client.sendMessage(chatId, {
        message: `**Laporan Terkirim!**\n\nTerima kasih, laporan kamu sudah masuk ke sistem admin.`,
        parseMode: "md"
      });
    } catch (e) {
      await client.sendMessage(chatId, { message: "Gagal mengirim laporan." });
    }
    userStates.delete(userId);
    return true;
  }
  return false;
}

// ─── ANNOUNCEMENT FUNCTIONS ──────────────────────────────────────────────────
async function handleAnnouncement(chatId, userId, delId = null) {
  if (!isPrivileged(userId)) {
    await sendHtml(chatId, "Akses ditolak! Hanya admin/owner yang bisa membuat pengumuman.");
    return;
  }

  const currentAnn = annDB.get();
  const text = currentAnn
    ? `📢 PENGUMUMAN AKTIF\n━━━━━━━━━━━━━━━━━━━━\n\n${currentAnn.text}\n\n` +
      `Dibuat oleh: ${currentAnn.createdByName || `ID: ${currentAnn.createdBy}`}\n` +
      `Dibuat pada: ${fmtDateTime(currentAnn.createdAt)}\n\n` +
      `Status: <b>AKTIF</b> (akan muncul di menu utama semua user)`
    : `📢 PENGUMUMAN\n━━━━━━━━━━━━━━━━━━━━\n\nTidak ada pengumuman aktif saat ini.\n\nKlik tombol di bawah untuk membuat pengumuman baru.`;

  const btns = [
    ...(currentAnn ? [[{ text: "Hapus Pengumuman", data: "announcement_delete" }]] : []),
    [{ text: "Buat Pengumuman Baru", data: "announcement_create" }],
    [{ text: "Kembali ke Admin Panel", data: "admin_panel" }]
  ];

  if (delId) {
    await client.editMessage(chatId, { message: delId, text, buttons: buildButtons(btns), parseMode: "html" });
  } else {
    await sendHtml(chatId, text, btns);
  }
}

async function handleAnnouncementCreate(chatId, userId) {
  if (!isPrivileged(userId)) {
    await sendHtml(chatId, "Akses ditolak!");
    return;
  }

  adminStates.set(userId, { step: "WAITING_ANNOUNCEMENT_TEXT" });
  await sendHtml(chatId,
    "📢 BUAT PENGUMUMAN\n" +
    "━━━━━━━━━━━━━━━━━━━━\n\n" +
    "Kirimkan **teks pengumuman** yang ingin disampaikan ke semua user.\n\n" +
    "Gunakan format HTML jika ingin styling (bisa pakai <b>, <i>, <code>, dll).\n\n" +
    "Ketik /batal untuk membatalkan.",
    [[{ text: "Batalkan", data: "cancel_announcement" }]]
  );
}

async function handleAnnouncementText(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text = event.message.text?.trim();
  const state = adminStates.get(userId);

  if (!state || state.step !== "WAITING_ANNOUNCEMENT_TEXT") return false;

  if (!text || text.length < 5) {
    await sendHtml(chatId, "⚠️ Teks pengumuman terlalu pendek! Minimal 5 karakter.");
    return true;
  }

  const createdByName = await getUsername(userId);
  annDB.save({
    text: text,
    createdBy: userId,
    createdByName: createdByName,
    createdAt: new Date().toISOString()
  });

  adminStates.delete(userId);

  await sendHtml(chatId,
    `✅ PENGUMUMAN BERHASIL DIBUAT!\n\n` +
    `<blockquote>${text}</blockquote>\n\n` +
    `Pengumuman akan muncul di menu utama semua user.\n\n` +
    `Total user yang akan melihat: <b>${db.getAllUsers().length}</b> user`
  );

  await notifyAllUsers(chatId, userId, text);
  return true;
}

async function handleAnnouncementDelete(chatId, userId) {
  if (!isPrivileged(userId)) {
    await sendHtml(chatId, "Akses ditolak!");
    return;
  }

  if (!annDB.get()) {
    await sendHtml(chatId, "Tidak ada pengumuman aktif untuk dihapus.");
    return;
  }

  annDB.clear();
  await sendHtml(chatId, "✅ Pengumuman berhasil dihapus!");
}

async function notifyAllUsers(senderChatId, senderId, announcementText) {
  const allUsers = db.getAllUsers();
  let success = 0, failed = 0;

  const notification = 
    `📢 PENGUMUMAN BARU\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${announcementText}\n\n` +
    `━  ━  ━  ━  ━  ━  ━  ━  ━  ━\n` +
    `<i>Dikirim oleh Admin ${CONFIG.BOT_NAME}</i>`;

  const msg = await sendHtml(senderChatId, `Mengirim notifikasi pengumuman ke ${allUsers.length} user...`);

  for (const user of allUsers) {
    try {
      await client.sendMessage(user.userId, {
        message: notification,
        parseMode: "html"
      });
      success++;
    } catch (_) {
      failed++;
    }
    await sleep(100);
  }

  await editHtml(senderChatId, msg.id,
    `✅ Notifikasi pengumuman selesai!\n\n` +
    `<blockquote>Total: ${allUsers.length}\nSukses: ${success}\nGagal: ${failed}</blockquote>`
  );
}

// ─── DETEKSI URL DARI FOLDER lib/ (KHUSUS HTTP + PORT) ──────────────────────

function isValidUrl(url) {
  try {
    if (url.length > 200) return false;
    if (url.includes(' ') || url.includes('\n') || url.includes('\t')) return false;
    
    if (!url.startsWith('http://')) return false;
    
    const portPattern = /^http:\/\/[^\/]+:\d+/;
    if (!portPattern.test(url)) return false;
    
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function detectUrlsFromLib(extractPath) {
  const libPath = path.join(extractPath, 'lib');
  if (!fs.existsSync(libPath)) return [];

  const urls = new Set();
  
  const urlPatterns = [
    /http:\/\/[a-zA-Z0-9\-._~:]+:\d+[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=]*/g,
    /baseUrl\s*[:=]\s*['"]([^'"]+)['"]/gi,
    /BASE_URL\s*[:=]\s*['"]([^'"]+)['"]/g,
    /API_URL\s*[:=]\s*['"]([^'"]+)['"]/g,
    /apiUrl\s*[:=]\s*['"]([^'"]+)['"]/g,
    /endpoint\s*[:=]\s*['"]([^'"]+)['"]/g,
    /serverUrl\s*[:=]\s*['"]([^'"]+)['"]/g,
    /SERVER_URL\s*[:=]\s*['"]([^'"]+)['"]/g,
    /url\s*[:=]\s*['"]([^'"]+)['"]/gi,
    /URL\s*[:=]\s*['"]([^'"]+)['"]/g,
  ];

  const walkDir = (dir) => {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath);
      } else if (item.endsWith('.dart')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          for (const pattern of urlPatterns) {
            if (pattern.toString().includes('capture')) {
              const regex = new RegExp(pattern, 'g');
              let match;
              while ((match = regex.exec(content)) !== null) {
                if (match[1]) {
                  let url = match[1].trim();
                  if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = `http://${url}`;
                  }
                  if (isValidUrl(url)) {
                    urls.add(url);
                  }
                }
              }
            } else {
              const found = content.match(pattern);
              if (found) {
                for (const m of found) {
                  let url = m.trim();
                  if (isValidUrl(url)) {
                    urls.add(url);
                  }
                }
              }
            }
          }
        } catch (_) {}
      }
    }
  };

  walkDir(libPath);
  
  const result = Array.from(urls).slice(0, 8);
  return result;
}

// ─── RENAME URL FUNCTIONS ──────────────────────────────────────────────────

async function handleRenameUrl(chatId, userId, delId = null) {
  if (bdb.isBanned(userId)) {
    await sendHtml(chatId, "Akun kamu dibanned! Tidak bisa menggunakan fitur ini.");
    return;
  }

  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await sendHtml(chatId,
      `⚠️ Sedang ada build aktif!\n\n` +
      `<blockquote>Tunggu build selesai atau batalkan dulu sebelum rename URL.</blockquote>`,
      [[{ text: "Batalkan Build", data: "cancel" }]]
    );
    return;
  }

  const state = renameStates.get(userId);
  if (state) {
    if (state.step === "WAITING_OLD_URL") {
      await sendHtml(chatId,
        `🔗 RENAME URL - LANJUTKAN\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `✅ File ZIP sudah diterima: <code>${state.fileName}</code>\n\n` +
        `Kirimkan URL LAMA yang ingin diganti.\n\n` +
        `<blockquote>Contoh: <code>http://192.168.1.100:8080</code></blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel_rename" }]]
      );
      return;
    }
    if (state.step === "WAITING_NEW_URL") {
      await sendHtml(chatId,
        `🔗 RENAME URL - LANJUTKAN\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `URL LAMA: <code>${state.oldUrl}</code>\n\n` +
        `Kirimkan URL BARU pengganti.\n\n` +
        `<blockquote>Contoh: <code>http://192.168.1.200:8080</code></blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel_rename" }]]
      );
      return;
    }
  }

  await showUploadButton(chatId, userId, 'rename');
}

// ─── SHOW UPLOAD BUTTON ──────────────────────────────────────────────────────
async function showUploadButton(chatId, userId, type) {
  const text = type === 'clean' 
    ? `🧹 CLEAN PROJECT\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📤 Kirim file ZIP project Flutter kamu!\n\n` +
      `Klik tombol di bawah, lalu pilih file ZIP-nya.`
    : `🔗 RENAME URL SERVER\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📤 Kirim file ZIP project Flutter kamu!\n\n` +
      `Klik tombol di bawah, lalu pilih file ZIP-nya.`;

  const btns = [
    [{ text: "📤 Upload Project ZIP", data: `upload_${type}` }],
    [{ text: "❌ Batalkan", data: "cancel" }]
  ];

  await sendHtml(chatId, text, btns);
}

// ─── HANDLE UPLOAD BUTTON ────────────────────────────────────────────────────
async function handleUploadButton(event) {
  const chatId = event.chatId;
  const userId = Number(event.senderId);
  const data = event.data.toString();
  const type = data.replace('upload_', '');

  await event.answer({ message: "Kirim file ZIP project Flutter kamu!" });

  const text = type === 'clean'
    ? `🧹 CLEAN PROJECT\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📤 Kirim file <b>.zip</b> project Flutter kamu.\n\n` +
      `<blockquote>Fitur ini akan membersihkan folder build yang bermasalah.</blockquote>\n\n` +
      `<i>Kirim file ZIP-nya sekarang!</i>`
    : `🔗 RENAME URL SERVER\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📤 Kirim file <b>.zip</b> project Flutter kamu.\n\n` +
      `<blockquote>Bot akan mendeteksi URL server dari folder <code>lib/</code>.</blockquote>\n\n` +
      `<i>Kirim file ZIP-nya sekarang!</i>`;

  const btns = [[{ text: "❌ Batalkan", data: "cancel" }]];
  
  if (type === 'clean') {
    cleanStates.set(userId, {});
  } else {
    renameStates.set(userId, {});
  }

  await sendHtml(chatId, text, btns);
}

// ─── HANDLE FILE RECEIVED ────────────────────────────────────────────────────

async function handleFileReceived(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const msg = event.message;
  const media = msg.media;

  if (!media || !media.document) return false;

  const doc = media.document;
  const fileName = doc.attributes?.find(a => a.fileName)?.fileName || "unknown.zip";
  const fileSize = (doc.size / 1024 / 1024).toFixed(2);

  const job = getUserJob(userId);
  const cleanState = cleanStates.get(userId);
  const renameState = renameStates.get(userId);
  
  if (job && job.status === "waiting_zip") {
    const handled = await handleZipFile(event);
    if (handled) return true;
  }

  if (cleanState) {
    const statusMsg = await sendHtml(chatId,
      `📥 MENERIMA FILE...\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `📦 File: <code>${fileName}</code>\n` +
      `📏 Ukuran: <code>${fileSize} MB</code>\n` +
      `⏳ Status: <b>Mengunduh...</b>` +
      `</blockquote>`
    );

    try {
      if (!fileName.endsWith(".zip")) {
        await editHtml(chatId, statusMsg.id,
          `❌ Format file salah!\n\n` +
          `<blockquote>File harus berformat <code>.zip</code>\n` +
          `Kamu mengirim: <code>${fileName}</code></blockquote>`
        );
        return true;
      }

      const localZip = tmpPath(`upload_${userId}_${Date.now()}.zip`);
      await client.downloadMedia(msg, { outputFile: localZip });

      if (!fs.existsSync(localZip)) {
        throw new Error("Gagal mengunduh file!");
      }

      const actualSize = (fs.statSync(localZip).size / 1024 / 1024).toFixed(2);

      await editHtml(chatId, statusMsg.id,
        `✅ FILE BERHASIL DIUNDUH!\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `📦 File: <code>${fileName}</code>\n` +
        `📏 Ukuran: <code>${actualSize} MB</code>\n` +
        `✅ Status: <b>Siap diproses!</b>` +
        `</blockquote>`
      );

      cleanStates.set(userId, {
        zipPath: localZip,
        fileName: fileName,
        extractPath: null
      });
      await showCleanButton(chatId, userId, cleanStates.get(userId));

    } catch (err) {
      await editHtml(chatId, statusMsg.id,
        `❌ Gagal memproses file!\n\n` +
        `<blockquote>Error: ${err.message}</blockquote>`
      );
    }
    return true;
  }

  if (renameState) {
    const statusMsg = await sendHtml(chatId,
      `📥 MENERIMA FILE...\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `📦 File: <code>${fileName}</code>\n` +
      `📏 Ukuran: <code>${fileSize} MB</code>\n` +
      `⏳ Status: <b>Mengunduh...</b>` +
      `</blockquote>`
    );

    try {
      if (!fileName.endsWith(".zip")) {
        await editHtml(chatId, statusMsg.id,
          `❌ Format file salah!\n\n` +
          `<blockquote>File harus berformat <code>.zip</code>\n` +
          `Kamu mengirim: <code>${fileName}</code></blockquote>`
        );
        return true;
      }

      const localZip = tmpPath(`upload_${userId}_${Date.now()}.zip`);
      await client.downloadMedia(msg, { outputFile: localZip });

      if (!fs.existsSync(localZip)) {
        throw new Error("Gagal mengunduh file!");
      }

      const actualSize = (fs.statSync(localZip).size / 1024 / 1024).toFixed(2);

      await editHtml(chatId, statusMsg.id,
        `✅ FILE BERHASIL DIUNDUH!\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `📦 File: <code>${fileName}</code>\n` +
        `📏 Ukuran: <code>${actualSize} MB</code>\n` +
        `✅ Status: <b>Siap diproses!</b>` +
        `</blockquote>`
      );

      const extractPath = tmpPath(`rename_extract_${userId}_${Date.now()}`);
      const zip = new AdmZip(localZip);
      zip.extractAllTo(extractPath, true);

      const detectedUrls = detectUrlsFromLib(extractPath);
      fs.rmSync(extractPath, { recursive: true, force: true });

      renameStates.set(userId, {
        step: "WAITING_OLD_URL",
        zipPath: localZip,
        fileName: fileName,
        oldUrl: null,
        newUrl: null,
        extractPath: null,
        detectedUrls: detectedUrls
      });

      let detectedMessage = '';
      if (detectedUrls.length > 0) {
        let urlList = detectedUrls.map((url, i) => `  ${i + 1}. <code>${url}</code>`).join('\n');
        if (urlList.length > 500) {
          urlList = urlList.slice(0, 500) + '\n  ...dan lainnya';
        }
        detectedMessage = 
          `\n\n🔍 <b>URL yang terdeteksi di folder lib/:</b>\n` +
          urlList +
          `\n\nKetik URL yang ingin diganti (copy paste dari daftar di atas).`;
      } else {
        detectedMessage = 
          `\n\n⚠️ <b>Tidak ada URL yang terdeteksi secara otomatis.</b>\n` +
          `Ketik URL LAMA yang ingin diganti secara manual.\n\n` +
          `<blockquote>Contoh: <code>http://192.168.1.100:8080</code></blockquote>`;
      }

      const fullMessage = 
        `✅ File berhasil diproses!\n\n` +
        `<blockquote>` +
        `📦 File: <code>${fileName}</code>\n` +
        `📏 Ukuran: <code>${actualSize} MB</code>` +
        `</blockquote>` +
        detectedMessage;

      if (fullMessage.length > 4000) {
        await sendHtml(chatId,
          `✅ File berhasil diproses!\n\n` +
          `<blockquote>` +
          `📦 File: <code>${fileName}</code>\n` +
          `📏 Ukuran: <code>${actualSize} MB</code>` +
          `</blockquote>\n\n` +
          `🔍 Ditemukan ${detectedUrls.length} URL di folder lib/.\n\n` +
          `Ketik URL LAMA yang ingin diganti.`,
          [[{ text: "❌ Batalkan", data: "cancel_rename" }]]
        );
      } else {
        await sendHtml(chatId, fullMessage, [[{ text: "❌ Batalkan", data: "cancel_rename" }]]);
      }

    } catch (err) {
      await editHtml(chatId, statusMsg.id,
        `❌ Gagal memproses file!\n\n` +
        `<blockquote>Error: ${err.message}</blockquote>`
      );
    }
    return true;
  }

  await sendHtml(chatId,
    `📎 File diterima: <code>${fileName}</code> (${fileSize} MB)\n\n` +
    `Gunakan fitur <b>Clean Project</b> atau <b>Rename URL</b> terlebih dahulu.`,
    [
      [{ text: "🧹 Clean Project", data: "clean_project_user" }],
      [{ text: "🔗 Rename URL", data: "rename_url" }]
    ]
  );
  return true;
}

// ─── SHOW CLEAN BUTTON ───────────────────────────────────────────────────────
async function showCleanButton(chatId, userId, state) {
  const fileSize = (fs.statSync(state.zipPath).size / 1024 / 1024).toFixed(2);
  await sendHtml(chatId,
    `🧹 CLEAN PROJECT\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<blockquote>` +
    `✅ File ZIP siap diproses!\n` +
    `📦 File: <code>${state.fileName}</code>\n` +
    `📏 Ukuran: <code>${fileSize} MB</code>` +
    `</blockquote>\n\n` +
    `Klik tombol di bawah untuk mulai membersihkan project.`,
    [
      [{ text: "🧹 Clean Sekarang", data: "clean_execute_user" }],
      [{ text: "❌ Batalkan", data: "cancel_clean" }]
    ]
  );
}

// ─── CLEAN EXECUTE ───────────────────────────────────────────────────────────
async function handleCleanExecuteUser(event) {
  const chatId = event.chatId;
  const userId = Number(event.senderId);
  
  if (bdb.isBanned(userId)) {
    await event.answer({ message: "Akun kamu dibanned!", alert: true });
    return;
  }

  const state = cleanStates.get(userId);
  if (!state || !state.zipPath || !fs.existsSync(state.zipPath)) {
    await event.answer({ message: "File ZIP tidak ditemukan! Kirim ulang file.", alert: true });
    cleanStates.delete(userId);
    return await showUploadButton(chatId, userId, 'clean');
  }

  await event.answer({ message: "Memulai proses clean project..." });

  const job = getUserJob(userId);
  if (job && (job.status === "uploading" || job.status === "building")) {
    await sendHtml(chatId,
      "⚠️ Sedang ada build aktif!\n\n" +
      `<blockquote>Tunggu build selesai atau batalkan dulu.</blockquote>`,
      [[{ text: "Batalkan Build", data: "cancel" }]]
    );
    return;
  }

  const statusMsg = await sendHtml(chatId,
    `🧹 CLEAN PROJECT\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<blockquote>🔍 Menganalisis file project...</blockquote>`
  );

  try {
    const zipPath = state.zipPath;
    const extractPath = tmpPath(`clean_${userId}_${Date.now()}`);
    
    await editHtml(chatId, statusMsg.id,
      `🧹 CLEAN PROJECT\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>📦 Mengekstrak file ${state.fileName}...</blockquote>`
    );

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    const libPath = path.join(extractPath, 'lib');
    const pubspecPath = path.join(extractPath, 'pubspec.yaml');
    if (!fs.existsSync(libPath) || !fs.existsSync(pubspecPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
      await editHtml(chatId, statusMsg.id,
        `⚠️ Bukan project Flutter yang valid!\n\n` +
        `<blockquote>Folder <code>lib/</code> atau file <code>pubspec.yaml</code> tidak ditemukan.</blockquote>`,
        [[{ text: "Kirim Ulang", data: "clean_project_user" }]]
      );
      return;
    }

    const cleanTargets = [
      'build', '.dart_tool', 'pubspec.lock', '.flutter-plugins',
      '.packages', '.idea', '.vscode', 'android/local.properties',
      'ios/Pods', 'Podfile.lock'
    ];

    let cleanedCount = 0;
    let totalSize = 0;

    const walkDir = (dir) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          const relativePath = path.relative(extractPath, fullPath);
          if (cleanTargets.some(target => relativePath === target || relativePath.startsWith(target + path.sep))) {
            const size = getDirSize(fullPath);
            totalSize += size;
            fs.rmSync(fullPath, { recursive: true, force: true });
            cleanedCount++;
            continue;
          }
          walkDir(fullPath);
        } else {
          if (item.endsWith('.iml')) {
            totalSize += stat.size;
            fs.unlinkSync(fullPath);
            cleanedCount++;
          }
        }
      }
    };

    const getDirSize = (dir) => {
      let size = 0;
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          size += getDirSize(fullPath);
        } else {
          size += stat.size;
        }
      }
      return size;
    };

    walkDir(extractPath);

    const cleanZipPath = tmpPath(`clean_${userId}_${Date.now()}.zip`);
    const cleanZip = new AdmZip();
    
    const addDirToZip = (zip, dir, parentPath) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        const zipPath = parentPath ? path.join(parentPath, item) : item;
        if (stat.isDirectory()) {
          addDirToZip(zip, fullPath, zipPath);
        } else {
          zip.addLocalFile(fullPath, parentPath);
        }
      }
    };
    
    addDirToZip(cleanZip, extractPath, '');
    cleanZip.writeZip(cleanZipPath);

    const cleanSizeMB = (fs.statSync(cleanZipPath).size / 1024 / 1024).toFixed(2);
    const originalSizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);

    fs.rmSync(extractPath, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    cleanStates.delete(userId);

    await editHtml(chatId, statusMsg.id,
      `✅ CLEAN PROJECT SELESAI!\n\n` +
      `<blockquote>` +
      `📦 File asli    : ${state.fileName}\n` +
      `📏 Ukuran asli  : ${originalSizeMB} MB\n` +
      `📏 Ukuran clean : ${cleanSizeMB} MB\n` +
      `🗑️ Berkas dihapus: ${cleanedCount} item\n` +
      `💾 Total space  : ${(totalSize / 1024 / 1024).toFixed(2)} MB` +
      `</blockquote>\n\n` +
      `📥 File project yang sudah dibersihkan:`
    );

    await client.sendFile(chatId, {
      file: cleanZipPath,
      caption:
        `🧹 PROJECT CLEAN\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `✅ File clean siap digunakan untuk build.\n` +
        `📦 Ukuran: ${cleanSizeMB} MB\n` +
        `🗑️ Dihapus: ${cleanedCount} file/folder\n` +
        `💾 Space: ${(totalSize / 1024 / 1024).toFixed(2)} MB` +
        `</blockquote>\n\n` +
        `<i>Kirim file ini untuk build ulang project Flutter kamu.</i>`,
      parseMode: "html",
      forceDocument: true,
    });

    setTimeout(() => {
      if (fs.existsSync(cleanZipPath)) fs.unlinkSync(cleanZipPath);
    }, 5000);

  } catch (err) {
    await editHtml(chatId, statusMsg.id,
      `❌ Gagal Clean Project!\n\n` +
      `<blockquote>Error: ${err.message}</blockquote>`
    );
    console.error("Clean project error:", err);
    cleanStates.delete(userId);
  }
}

// ─── CANCEL CLEAN ────────────────────────────────────────────────────────────
async function handleCancelClean(chatId, userId) {
  const state = cleanStates.get(userId);
  if (state && state.zipPath && fs.existsSync(state.zipPath)) {
    fs.unlinkSync(state.zipPath);
  }
  if (state && state.extractPath && fs.existsSync(state.extractPath)) {
    fs.rmSync(state.extractPath, { recursive: true, force: true });
  }
  cleanStates.delete(userId);
  await sendHtml(chatId,
    `❌ Proses clean project dibatalkan.`,
    [[{ text: "Menu Utama", data: "start" }]]
  );
}

// ─── RENAME OLD URL ─────────────────────────────────────────────────────────
async function handleRenameOldUrl(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const state = renameStates.get(userId);

  if (!state || state.step !== "WAITING_OLD_URL") return false;

  const oldUrl = event.message.text?.trim();
  if (!oldUrl) {
    await sendHtml(chatId, "Mohon kirimkan URL yang valid.");
    return true;
  }

  let isValidUrl = false;
  try {
    new URL(oldUrl);
    isValidUrl = true;
  } catch {
    try {
      new URL(`https://${oldUrl}`);
      isValidUrl = true;
    } catch (_) {}
  }

  if (!isValidUrl) {
    await sendHtml(chatId,
      `❌ URL tidak valid!\n\n` +
      `<blockquote>Contoh URL yang benar:\n` +
      `<code>http://192.168.1.100:8080</code>\n` +
      `<code>http://api.example.com:8080</code></blockquote>`
    );
    return true;
  }

  state.oldUrl = oldUrl;
  state.step = "WAITING_NEW_URL";
  renameStates.set(userId, state);

  await sendHtml(chatId,
    `✅ URL LAMA TERSIMPAN: <code>${oldUrl}</code>\n\n` +
    `🔗 RENAME URL - Langkah 3/3\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Kirimkan URL BARU pengganti.\n\n` +
    `<blockquote>Contoh: <code>http://192.168.1.200:8080</code></blockquote>\n\n` +
    `<i>Ketik /cancelrename untuk membatalkan</i>`,
    [[{ text: "❌ Batalkan", data: "cancel_rename" }]]
  );
  return true;
}

// ─── RENAME NEW URL ─────────────────────────────────────────────────────────
async function handleRenameNewUrl(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const state = renameStates.get(userId);

  if (!state || state.step !== "WAITING_NEW_URL") return false;

  const newUrl = event.message.text?.trim();
  if (!newUrl) {
    await sendHtml(chatId, "Mohon kirimkan URL baru yang valid.");
    return true;
  }

  let isValidUrl = false;
  try {
    new URL(newUrl);
    isValidUrl = true;
  } catch {
    try {
      new URL(`https://${newUrl}`);
      isValidUrl = true;
    } catch (_) {}
  }

  if (!isValidUrl) {
    await sendHtml(chatId,
      `❌ URL tidak valid!\n\n` +
      `<blockquote>Contoh URL yang benar:\n` +
      `<code>http://192.168.1.200:8080</code>\n` +
      `<code>http://api.new-server.com:8080</code></blockquote>`
    );
    return true;
  }

  const statusMsg = await sendHtml(chatId,
    `🔄 MEMPROSES RENAME URL\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<blockquote>` +
    `📦 File   : <code>${state.fileName}</code>\n` +
    `🔗 URL Lama: <code>${state.oldUrl}</code>\n` +
    `🔗 URL Baru: <code>${newUrl}</code>` +
    `</blockquote>\n\n` +
    `Mencari dan mengganti URL di semua file Dart dalam folder <code>lib/</code>...`
  );

  try {
    const extractPath = tmpPath(`rename_${userId}_${Date.now()}`);
    const zip = new AdmZip(state.zipPath);
    zip.extractAllTo(extractPath, true);

    const libPath = path.join(extractPath, 'lib');
    if (!fs.existsSync(libPath)) {
      await editHtml(chatId, statusMsg.id,
        `❌ Folder <code>lib/</code> tidak ditemukan!\n\n` +
        `<blockquote>Pastikan project Flutter kamu memiliki folder <code>lib/</code>.</blockquote>`
      );
      fs.rmSync(extractPath, { recursive: true, force: true });
      renameStates.delete(userId);
      return;
    }

    const dartFiles = [];
    const walkDir = (dir) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walkDir(fullPath);
        } else if (item.endsWith('.dart')) {
          dartFiles.push(fullPath);
        }
      }
    };
    walkDir(libPath);

    if (dartFiles.length === 0) {
      await editHtml(chatId, statusMsg.id,
        `❌ Tidak ditemukan file Dart di folder <code>lib/</code>!\n\n` +
        `<blockquote>Pastikan project Flutter kamu memiliki file .dart di folder <code>lib/</code>.</blockquote>`
      );
      fs.rmSync(extractPath, { recursive: true, force: true });
      renameStates.delete(userId);
      return;
    }

    let filesChanged = 0;
    let totalReplacements = 0;
    let processedFiles = 0;

    const escapedOldUrl = state.oldUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedOldUrl, 'g');

    for (const filePath of dartFiles) {
      let content = fs.readFileSync(filePath, 'utf-8');
      const matches = content.match(regex);
      
      if (matches) {
        const newContent = content.replace(regex, newUrl);
        totalReplacements += matches.length;
        filesChanged++;
        fs.writeFileSync(filePath, newContent, 'utf-8');
      }
      processedFiles++;
    }

    const cleanZipPath = tmpPath(`rename_${userId}_${Date.now()}.zip`);
    const newZip = new AdmZip();
    
    const addDirToZip = (zip, dir, parentPath) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        const zipPath = parentPath ? path.join(parentPath, item) : item;
        if (stat.isDirectory()) {
          addDirToZip(zip, fullPath, zipPath);
        } else {
          zip.addLocalFile(fullPath, parentPath);
        }
      }
    };
    
    addDirToZip(newZip, extractPath, '');
    newZip.writeZip(cleanZipPath);

    const newSize = (fs.statSync(cleanZipPath).size / 1024 / 1024).toFixed(2);
    const oldSize = (fs.statSync(state.zipPath).size / 1024 / 1024).toFixed(2);

    fs.rmSync(extractPath, { recursive: true, force: true });
    if (fs.existsSync(state.zipPath)) fs.unlinkSync(state.zipPath);

    await editHtml(chatId, statusMsg.id,
      `✅ RENAME URL SELESAI!\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `📄 File diproses  : <b>${processedFiles}</b> file Dart\n` +
      `📝 File diubah    : <b>${filesChanged}</b> file\n` +
      `🔄 Total penggantian: <b>${totalReplacements}</b> kali\n` +
      `📦 Ukuran asli    : <code>${oldSize} MB</code>\n` +
      `📦 Ukuran baru    : <code>${newSize} MB</code>` +
      `</blockquote>\n\n` +
      `🔗 <code>${state.oldUrl}</code> → <code>${newUrl}</code>\n\n` +
      `📥 File ZIP dengan URL yang sudah diubah:`
    );

    await client.sendFile(chatId, {
      file: cleanZipPath,
      caption:
        `🔗 FILE RENAME URL\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `🔗 URL Lama : <code>${state.oldUrl}</code>\n` +
        `🔗 URL Baru : <code>${newUrl}</code>\n` +
        `📝 File diubah: ${filesChanged} file\n` +
        `🔄 Total ganti: ${totalReplacements} kali\n` +
        `📦 Ukuran   : ${newSize} MB` +
        `</blockquote>\n\n` +
        `<i>✅ File ini sudah siap untuk di-build.</i>`,
      parseMode: "html",
      forceDocument: true,
    });

    setTimeout(() => {
      if (fs.existsSync(cleanZipPath)) fs.unlinkSync(cleanZipPath);
    }, 5000);

    renameStates.delete(userId);

  } catch (err) {
    await editHtml(chatId, statusMsg.id,
      `❌ Gagal Rename URL!\n\n` +
      `<blockquote>Error: ${err.message}</blockquote>`
    );
    console.error("Rename URL error:", err);
    renameStates.delete(userId);
  }
}

// ─── CANCEL RENAME ───────────────────────────────────────────────────────────
async function handleCancelRename(chatId, userId) {
  const state = renameStates.get(userId);
  if (state) {
    if (state.zipPath && fs.existsSync(state.zipPath)) fs.unlinkSync(state.zipPath);
    if (state.extractPath && fs.existsSync(state.extractPath)) {
      fs.rmSync(state.extractPath, { recursive: true, force: true });
    }
  }
  renameStates.delete(userId);
  await sendHtml(chatId,
    `❌ Proses rename URL dibatalkan.\n\n` +
    `<blockquote>Ketik /start untuk kembali ke menu utama.</blockquote>`,
    [[{ text: "Menu Utama", data: "start" }]]
  );
}

// ─── CLEAN PROJECT USER ─────────────────────────────────────────────────────
async function handleCleanProjectUser(chatId, userId, delId = null) {
  if (bdb.isBanned(userId)) {
    await sendHtml(chatId, "Akun kamu dibanned! Tidak bisa menggunakan fitur ini.");
    return;
  }

  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await sendHtml(chatId,
      `⚠️ Sedang ada build aktif!\n\n` +
      `<blockquote>Tunggu build selesai atau batalkan dulu sebelum clean project.</blockquote>`,
      [[{ text: "Batalkan Build", data: "cancel" }]]
    );
    return;
  }

  const state = cleanStates.get(userId);
  if (state && state.zipPath && fs.existsSync(state.zipPath)) {
    await showCleanButton(chatId, userId, state);
    return;
  }

  await showUploadButton(chatId, userId, 'clean');
}

// ─── ADMIN COMMANDS ───────────────────────────────────────────────────────────
async function handleAddReseller(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `Akses ditolak!`); return; }
  if (!targetId) { await sendHtml(chatId, `Tambah Reseller\n\n<blockquote>Gunakan: <code>/addreseller 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (isNaN(num)) { await sendHtml(chatId, `ID tidak valid!`); return; }
  const info = db.getUserById(num);
  if (rdb.add(num, info?.username, userId)) {
    await sendHtml(chatId, `Reseller ditambahkan!\n\n<blockquote>ID: <code>${num}</code>\nUsername: ${info?.username || "—"}\nPriority Level 2</blockquote>`);
    try { await client.sendMessage(num, { message: `**SELAMAT!**\n\nKamu sekarang menjadi **RESELLER** dari ${CONFIG.BOT_NAME}!\n\nPriority Level 2 - Build diprioritaskan!`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `User ID <code>${num}</code> sudah menjadi reseller.`);
  }
}

async function handleRemoveReseller(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `Akses ditolak!`); return; }
  if (!targetId) { await sendHtml(chatId, `Hapus Reseller\n\n<blockquote>Gunakan: <code>/removereseller 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (rdb.remove(num)) {
    await sendHtml(chatId, `Reseller dihapus!\n\n<blockquote>ID: <code>${num}</code></blockquote>`);
    try { await client.sendMessage(num, { message: `**PEMBERITAHUAN**\n\nStatus reseller kamu telah dicabut.`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `ID <code>${num}</code> bukan reseller.`);
  }
}

// ─── LIST USERS ──────────────────────────────────────────────────────────────
async function handleListUsers(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }

  const all      = db.getAllUsers();
  const perPage  = 8;
  const total    = Math.max(1, Math.ceil(all.length / perPage));
  page           = Math.min(Math.max(1, page), total);
  const slice    = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `DAFTAR USER (${all.length})\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  slice.forEach((u, i) => {
    const role    = roleTag(u.userId);
    const isRes   = rdb.isReseller(u.userId);
    const isBan   = bdb.isBanned(u.userId);
    const joinStr = fmtDate(u.joinedAt);
    text +=
      `<b>${(page - 1) * perPage + i + 1}. ${role}${isBan ? " BANNED" : ""}</b>\n` +
      `<blockquote>` +
      `ID       : <code>${u.userId}</code>\n` +
      `Nama     : ${u.name || "Unknown"}\n` +
      `Username : ${u.username || "—"}\n` +
      `Join     : ${joinStr}` +
      `</blockquote>\n`;
  });

  const nav = [];
  if (page > 1)    nav.push({ text: "Prev", data: `listusers_page_${page - 1}` });
  nav.push({ text: `${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next", data: `listusers_page_${page + 1}` });

  const btns = [
    nav,
    [{ text: "Cari User", data: "admin_search_user" }, { text: "Export", data: "admin_export_users" }],
    [{ text: "Admin Panel", data: "admin_panel" }],
  ];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── LIST RESELLERS ──────────────────────────────────────────────────────────
async function handleListResellers(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }

  const all     = rdb.all();
  const perPage = 8;
  const total   = Math.max(1, Math.ceil(all.length / perPage));
  page          = Math.min(Math.max(1, page), total);
  const slice   = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `DAFTAR RESELLER (${all.length})\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  if (all.length === 0) {
    text += `<i>Belum ada reseller yang terdaftar.</i>`;
  } else {
    slice.forEach((r, i) => {
      text +=
        `<b>${(page - 1) * perPage + i + 1}. RESELLER</b>\n` +
        `<blockquote>` +
        `ID          : <code>${r.userId}</code>\n` +
        `Username    : ${r.username || "—"}\n` +
        `Ditambahkan : ${fmtDate(r.addedAt)}\n` +
        `Priority    : Level 2` +
        `</blockquote>\n`;
    });
  }

  const nav = [];
  if (page > 1)    nav.push({ text: "Prev", data: `listresellers_page_${page - 1}` });
  nav.push({ text: `${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next", data: `listresellers_page_${page + 1}` });

  const btns = [nav, [{ text: "Admin Panel", data: "admin_panel" }]];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── BUILD HISTORY ───────────────────────────────────────────────────────────
async function handleBuildHistory(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }

  const all     = hdb.all();
  const perPage = 6;
  const total   = Math.max(1, Math.ceil(all.length / perPage));
  page          = Math.min(Math.max(1, page), total);
  const slice   = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `RIWAYAT BUILD (${all.length})\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  if (all.length === 0) {
    text += `<i>Belum ada riwayat build.</i>`;
  } else {
    slice.forEach((h, i) => {
      const statusIcon = h.status === "success" ? "SUKSES" : h.status === "timeout" ? "TIMEOUT" : "GAGAL";
      text +=
        `<b>${(page - 1) * perPage + i + 1}. ${statusIcon}</b>\n` +
        `<blockquote>` +
        `User    : ${h.userName || `ID:${h.userId}`}\n` +
        `Project : <code>${h.project || "—"}</code>\n` +
        `Mode    : ${h.mode || "—"}\n` +
        (h.apkSize  ? `APK     : <code>${h.apkSize} MB</code>\n` : "") +
        (h.duration ? `Durasi  : <code>${formatDuration(h.duration)}</code>\n` : "") +
        `Waktu   : ${fmtDateTime(h.at)}` +
        `</blockquote>\n`;
    });
  }

  const cs   = db.getStats();
  const tot  = cs.success + cs.failed;
  const rate = tot > 0 ? ((cs.success / tot) * 100).toFixed(1) : "0.0";
  text +=
    `\n<blockquote>` +
    `Total Sukses : <b>${cs.success}</b>\n` +
    `Total Gagal  : <b>${cs.failed}</b>\n` +
    `Success Rate : <b>${rate}%</b>` +
    `</blockquote>`;

  const nav = [];
  if (page > 1)    nav.push({ text: "Prev", data: `buildhistory_page_${page - 1}` });
  nav.push({ text: `${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next", data: `buildhistory_page_${page + 1}` });

  const btns = [nav, [{ text: "Admin Panel", data: "admin_panel" }]];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── SEARCH USER ─────────────────────────────────────────────────────────────
async function handleSearchUser(chatId, userId, query) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }
  if (!query) {
    await sendHtml(chatId,
      `Cari User\n\n` +
      `<blockquote>Gunakan:\n<code>/searchuser 123456789</code>\n<code>/searchuser @username</code>\n<code>/searchuser nama</code></blockquote>`
    );
    return;
  }
  const results = db.searchUsers(query);
  if (results.length === 0) {
    await sendHtml(chatId,
      `Hasil Pencarian\n\n<blockquote>Tidak ada user cocok dengan: <code>${query}</code></blockquote>`,
      [[{ text: "Admin Panel", data: "admin_panel" }]]
    );
    return;
  }
  let text = `Hasil Pencarian "${query}" (${results.length})\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  results.slice(0, 10).forEach(u => {
    text +=
      `<b>${roleTag(u.userId)}${bdb.isBanned(u.userId) ? " BANNED" : ""}</b>\n` +
      `<blockquote>` +
      `ID       : <code>${u.userId}</code>\n` +
      `Nama     : ${u.name || "Unknown"}\n` +
      `Username : ${u.username || "—"}\n` +
      `Join     : ${fmtDate(u.joinedAt)}` +
      `</blockquote>\n`;
  });
  if (results.length > 10) text += `\n<i>+${results.length - 10} hasil lainnya</i>`;
  await sendHtml(chatId, text, [[{ text: "Admin Panel", data: "admin_panel" }]]);
}

// ─── USER INFO ───────────────────────────────────────────────────────────────
async function handleUserInfo(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }
  if (!targetId) {
    await sendHtml(chatId,
      `Info User\n\n<blockquote>Gunakan: <code>/userinfo 123456789</code></blockquote>`
    );
    return;
  }
  const num  = Number(targetId);
  const u    = db.getUserById(num);
  if (!u) { await sendHtml(chatId, `User ID <code>${num}</code> tidak ditemukan!`); return; }

  const isRes = rdb.isReseller(num);
  const isBan = bdb.isBanned(num);
  const ban   = isBan ? bdb.getInfo(num) : null;
  const job   = getUserJob(num);

  let tgInfo = "—";
  try {
    const e = await client.getEntity(num);
    tgInfo  = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "—";
  } catch (_) {}

  const text =
    `INFO USER\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<blockquote>` +
    `ID           : <code>${num}</code>\n` +
    `Nama (DB)    : ${u.name || "Unknown"}\n` +
    `Nama (TG)    : ${tgInfo}\n` +
    `Username     : ${u.username || "—"}\n` +
    `Role         : ${roleTag(num)}\n` +
    `Join         : ${fmtDateTime(u.joinedAt)}\n` +
    `Last Active  : ${fmtDateTime(u.lastActive)}\n` +
    `Reseller     : ${isRes ? "Ya" : "Tidak"}\n` +
    `Status Ban   : ${isBan ? `Dibanned\nAlasan: ${ban?.reason || "—"}\nDibanned: ${fmtDate(ban?.bannedAt)}` : "Normal"}\n` +
    `Build Aktif  : ${job ? `${statusLabel(job.status)}` : "Tidak ada"}` +
    `</blockquote>`;

  const btns = [
    isRes
      ? [{ text: "Remove Reseller", data: `adm_rm_reseller_${num}` }]
      : [{ text: "Add Reseller", data: `adm_add_reseller_${num}` }],
    isBan
      ? [{ text: "Unban User", data: `adm_unban_${num}` }]
      : [{ text: "Ban User", data: `adm_ban_${num}` }],
    [{ text: "Admin Panel", data: "admin_panel" }],
  ];

  await sendHtml(chatId, text, btns);
}

// ─── BAN / UNBAN ─────────────────────────────────────────────────────────────
async function handleBanUser(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }
  if (!args) {
    await sendHtml(chatId, `Ban User\n\n<blockquote>Gunakan: <code>/banuser 123456789 alasan ban</code></blockquote>`);
    return;
  }
  const parts  = args.trim().split(/\s+/);
  const num    = Number(parts[0]);
  const reason = parts.slice(1).join(" ") || "Melanggar ketentuan";
  if (isNaN(num))     { await sendHtml(chatId, "ID tidak valid!"); return; }
  if (isOwner(num))   { await sendHtml(chatId, "Tidak bisa ban Owner!"); return; }
  if (bdb.ban(num, reason, userId)) {
    await sendHtml(chatId,
      `User Dibanned!\n\n` +
      `<blockquote>ID     : <code>${num}</code>\nAlasan : ${reason}</blockquote>`,
      [[{ text: "Admin Panel", data: "admin_panel" }]]
    );
    try {
      await client.sendMessage(num, {
        message: `**AKUN ANDA DIBANNED**\n\nKamu tidak bisa menggunakan bot ini.\n\nAlasan: ${reason}\n\nHubungi admin jika ini kesalahan.`,
        parseMode: "md"
      });
    } catch (_) {}
  } else {
    await sendHtml(chatId, `User ID <code>${num}</code> sudah dalam status ban.`);
  }
}

async function handleUnbanUser(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }
  if (!targetId) {
    await sendHtml(chatId, `Unban User\n\n<blockquote>Gunakan: <code>/unbanuser 123456789</code></blockquote>`);
    return;
  }
  const num = Number(targetId);
  if (bdb.unban(num)) {
    await sendHtml(chatId,
      `User Diunban!\n\n<blockquote>ID: <code>${num}</code></blockquote>`,
      [[{ text: "Admin Panel", data: "admin_panel" }]]
    );
    try {
      await client.sendMessage(num, {
        message: `**AKSES DIKEMBALIKAN**\n\nAkun kamu telah diunban. Kamu bisa menggunakan bot ini kembali.`,
        parseMode: "md"
      });
    } catch (_) {}
  } else {
    await sendHtml(chatId, `User ID <code>${num}</code> tidak sedang dalam status ban.`);
  }
}

// ─── KILL BUILD ──────────────────────────────────────────────────────────────
async function handleListBuildsForKill(chatId, userId, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }
  const jobs = getSortedActiveJobs();

  let text =
    `FORCE KILL BUILD\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (jobs.length === 0) {
    text += `<i>Tidak ada build aktif saat ini.</i>`;
    const btns = [[{ text: "Admin Panel", data: "admin_panel" }]];
    editId
      ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
      : await sendHtml(chatId, text, btns);
    return;
  }

  text += `<i>Pilih build yang ingin dihentikan paksa:</i>\n\n`;
  jobs.forEach((j, i) => {
    const usr = j.fullName && j.fullName !== "Unknown User" ? j.fullName : (j.username ? `@${j.username}` : `User_${j.userId}`);
    text +=
      `${i + 1}. <b>${roleTag(j.userId)}</b> — ${usr}\n` +
      `<blockquote>Status: ${statusLabel(j.status)}  |  ${formatDuration(elapsedSec(j.updatedAt))}</blockquote>\n`;
  });

  const btns = [
    ...jobs.map(j => {
      const usr = j.fullName && j.fullName !== "Unknown User" ? j.fullName.split(" ")[0] : (j.username || `U${j.userId}`);
      return [{ text: `Kill: ${usr}`, data: `kill_build_${j.userId}` }];
    }),
    [{ text: "Admin Panel", data: "admin_panel" }],
  ];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── DELETE USER / EXPORT / DM ──────────────────────────────────────────────
async function handleDeleteUser(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }
  if (!targetId) { await sendHtml(chatId, `Hapus User\n\n<blockquote>Gunakan: <code>/deleteuser 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (isNaN(num))   { await sendHtml(chatId, "ID tidak valid!"); return; }
  if (isOwner(num)) { await sendHtml(chatId, "Tidak bisa menghapus Owner!"); return; }
  const u = db.getUserById(num);
  if (!u) { await sendHtml(chatId, `User ID <code>${num}</code> tidak ditemukan.`); return; }
  db.deleteUser(num);
  rdb.remove(num);
  await sendHtml(chatId,
    `User Dihapus!\n\n<blockquote>ID: <code>${num}</code>\nNama: ${u.name || "Unknown"}</blockquote>`,
    [[{ text: "Admin Panel", data: "admin_panel" }]]
  );
}

async function handleExportUsers(chatId, userId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }
  const all  = db.getAllUsers();
  const res  = rdb.all();
  const ban  = bdb.all();
  const hdrs = ["No","User ID","Nama","Username","Role","Reseller","Banned","Join Date","Last Active"];
  const rows = all.map((u, i) => {
    const isRes = res.some(r => r.userId === u.userId);
    const isBan = ban.some(b => b.userId === u.userId);
    const role  = isOwner(u.userId) ? "OWNER" : isRes ? "RESELLER" : isAdmin(u.userId) ? "ADMIN" : "USER";
    return [i + 1, u.userId, u.name || "Unknown", u.username || "-", role, isRes ? "Ya" : "Tidak", isBan ? "Ya" : "Tidak", fmtDate(u.joinedAt), fmtDate(u.lastActive)];
  });
  const csv     = [hdrs, ...rows].map(r => r.join(",")).join("\n");
  const csvPath = tmpPath(`users_export_${Date.now()}.csv`);
  fs.writeFileSync(csvPath, csv, "utf-8");
  try {
    await client.sendFile(chatId, {
      file: csvPath,
      caption:
        `Export Database User\n\n` +
        `<blockquote>Total User    : ${all.length}\nTotal Reseller: ${res.length}\nTotal Banned  : ${ban.length}\nDiekspor      : ${nowWib()}</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });
    if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
  } catch (e) {
    if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    await sendHtml(chatId, `Gagal export: <code>${e.message}</code>`);
  }
}

async function handleDmUser(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "Akses ditolak!"); return; }
  if (!args) { await sendHtml(chatId, `Kirim DM ke User\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan kamu</code></blockquote>`); return; }
  const parts = args.trim().split(/\s+/);
  const num   = Number(parts[0]);
  const msg   = parts.slice(1).join(" ");
  if (isNaN(num) || !msg) { await sendHtml(chatId, `Format salah!\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan</code></blockquote>`); return; }
  try {
    await client.sendMessage(num, { message: msg, parseMode: "md" });
    await sendHtml(chatId,
      `Pesan Terkirim!\n\n<blockquote>Ke: <code>${num}</code>\nPesan: ${msg}</blockquote>`,
      [[{ text: "Admin Panel", data: "admin_panel" }]]
    );
  } catch (e) {
    await sendHtml(chatId, `Gagal kirim: <code>${e.message}</code>`);
  }
}

// ─── CALLBACK ────────────────────────────────────────────────────────────────
async function handleCallback(event) {
  try {
    const data   = event.data.toString();
    const chatId = event.chatId;
    const userId = Number(event.senderId);
    const msgId  = event.messageId;

    // ─── SERVER SELECTION ────────────────────────────────────────────────────
    if (data.startsWith("select_server_")) {
      const serverId = data.replace("select_server_", "");
      const server = SERVERS.find(s => s.id === serverId);
      if (!server) {
        return await event.answer({ message: "Server tidak ditemukan!", alert: true });
      }

      // Simpan server yang dipilih ke job
      const job = getUserJob(userId);
      if (job) {
        setUserJob(userId, { ...job, serverId: serverId });
      } else {
        // Buat job sementara dengan server
        setUserJob(userId, { 
          status: "waiting_server", 
          serverId: serverId,
          userId: userId,
          updatedAt: Date.now() 
        });
      }

      await event.answer({ message: `Server ${server.name} dipilih!` });

      // Tampilkan pilihan mode build
      await handleBuild(chatId, userId, null, msgId);
      return;
    }

    if (data.startsWith("broadcast_approve_")) {
      if (!isOwner(userId)) return await event.answer({ message: "Hanya Owner!", alert: true });
      try { await client.sendMessage(parseInt(data.split("_")[2]), { message: `**Broadcast disetujui Owner!**`, parseMode: "md" }); } catch (_) {}
      return await event.answer({ message: "Disetujui!" });
    }
    if (data.startsWith("broadcast_reject_")) {
      if (!isOwner(userId)) return await event.answer({ message: "Hanya Owner!", alert: true });
      try { await client.sendMessage(parseInt(data.replace("broadcast_reject_", "")), { message: `**Broadcast ditolak Owner!**`, parseMode: "md" }); } catch (_) {}
      return await event.answer({ message: "Ditolak!" });
    }

    if (data === "noop") return await event.answer();

    if (data.startsWith("listusers_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      const page = parseInt(data.replace("listusers_page_", ""));
      await event.answer();
      return await handleListUsers(chatId, userId, page, msgId);
    }

    if (data.startsWith("listresellers_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      const page = parseInt(data.replace("listresellers_page_", ""));
      await event.answer();
      return await handleListResellers(chatId, userId, page, msgId);
    }

    if (data.startsWith("buildhistory_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      const page = parseInt(data.replace("buildhistory_page_", ""));
      await event.answer();
      return await handleBuildHistory(chatId, userId, page, msgId);
    }

    if (data.startsWith("kill_build_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("kill_build_", ""));
      const job = getUserJob(targetId);
      if (!job) return await event.answer({ message: "Build sudah selesai.", alert: true });
      removeUserJob(targetId);
      await event.answer({ message: `Build user ${targetId} dihentikan!` });
      try { await client.sendMessage(job.chatId, { message: `**Build kamu dihentikan paksa oleh admin.**`, parseMode: "md" }); } catch (_) {}
      return await handleListBuildsForKill(chatId, userId, msgId);
    }

    if (data.startsWith("adm_add_reseller_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_add_reseller_", ""));
      await event.answer();
      await handleAddReseller(chatId, userId, targetId);
      return;
    }
    if (data.startsWith("adm_rm_reseller_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_rm_reseller_", ""));
      await event.answer();
      await handleRemoveReseller(chatId, userId, targetId);
      return;
    }
    if (data.startsWith("adm_ban_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_ban_", ""));
      await event.answer();
      await handleBanUser(chatId, userId, `${targetId} Via panel`);
      return;
    }
    if (data.startsWith("adm_unban_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_unban_", ""));
      await event.answer();
      await handleUnbanUser(chatId, userId, targetId);
      return;
    }

    if (data === "user_start_lapor") {
      if (db.isReportBlocked(userId)) return event.answer({ message: "Kamu diblokir dari fitur laporan.", alert: true });
      userStates.set(userId, { step: "WAITING_FOR_REASON" });
      await client.editMessage(chatId, {
        message: msgId,
        text: `MENU LAPORAN\n\n<blockquote>Ketik alasan dan detail laporan kamu dengan jelas, lalu kirim lewat chat.\n\nLaporan palsu akan menyebabkan akun diblokir.</blockquote>`,
        parseMode: "html",
        buttons: buildButtons([[{ text: "Batalkan Laporan", data: "user_cancel_lapor" }]])
      });
      return await event.answer();
    }
    if (data === "user_cancel_lapor") {
      userStates.delete(userId);
      await client.editMessage(chatId, {
        message: msgId,
        text: `Laporan Dibatalkan\n\n<blockquote>Proses laporan dihentikan.</blockquote>`,
        parseMode: "html",
        buttons: []
      });
      return await event.answer({ message: "Laporan dibatalkan" });
    }

    // ─── ANNOUNCEMENT CALLBACKS ────────────────────────────────────────────
    if (data === "admin_announcement") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await event.answer();
      return await handleAnnouncement(chatId, userId, msgId);
    }

    if (data === "announcement_create") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await event.answer();
      return await handleAnnouncementCreate(chatId, userId);
    }

    if (data === "announcement_delete") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await event.answer();
      return await handleAnnouncementDelete(chatId, userId);
    }

    if (data === "cancel_announcement") {
      adminStates.delete(userId);
      await sendHtml(chatId, "Pembuatan pengumuman dibatalkan.");
      return await event.answer({ message: "Dibatalkan" });
    }

    // ─── UPLOAD BUTTON ──────────────────────────────────────────────────────
    if (data.startsWith("upload_")) {
      await event.answer();
      return await handleUploadButton(event);
    }

    // ─── RENAME URL CALLBACKS ─────────────────────────────────────────────
    if (data === "rename_url") {
      await event.answer();
      return await handleRenameUrl(chatId, userId, msgId);
    }

    if (data === "cancel_rename") {
      await event.answer({ message: "Membatalkan rename URL..." });
      return await handleCancelRename(chatId, userId);
    }

    // ─── CLEAN PROJECT CALLBACKS ──────────────────────────────────────────
    if (data === "clean_project_user") {
      await event.answer();
      return await handleCleanProjectUser(chatId, userId, msgId);
    }

    if (data === "cancel_clean") {
      await event.answer({ message: "Membatalkan clean project..." });
      return await handleCancelClean(chatId, userId);
    }

    if (data === "clean_execute_user") {
      await event.answer({ message: "Memulai clean project..." });
      return await handleCleanExecuteUser(event);
    }

    if (data === "admin_panel" || data === "owner_panel") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await showAdminPanel(chatId, userId, msgId);
      return await event.answer();
    }

    if (data === "admin_add_reseller") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await sendHtml(chatId, `Tambah Reseller\n\n<blockquote>Gunakan: <code>/addreseller 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_remove_reseller") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await sendHtml(chatId, `Hapus Reseller\n\n<blockquote>Gunakan: <code>/removereseller 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_search_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await sendHtml(chatId, `Cari User\n\n<blockquote>Gunakan:\n<code>/searchuser 123456789</code>\n<code>/searchuser @username</code>\n<code>/searchuser nama</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_userinfo") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await sendHtml(chatId, `Info User\n\n<blockquote>Gunakan: <code>/userinfo 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_ban_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await sendHtml(chatId, `Ban User\n\n<blockquote>Gunakan: <code>/banuser 123456789 alasan</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_unban_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await sendHtml(chatId, `Unban User\n\n<blockquote>Gunakan: <code>/unbanuser 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_list_builds") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await event.answer();
      return await handleListBuildsForKill(chatId, userId, msgId);
    }
    if (data === "admin_export_users") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await event.answer({ message: "Mengekspor..." });
      return await handleExportUsers(chatId, userId);
    }
    if (data === "admin_dm_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      await sendHtml(chatId, `Kirim DM ke User\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan kamu</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_toggle_maint") {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      const now = mdb.toggle();
      await event.answer({ message: `Maintenance ${now ? "AKTIF" : "NONAKTIF"}!` });
      return await showAdminPanel(chatId, userId, msgId);
    }
    if (data === "admin_reset_stats") {
      if (!isOwner(userId)) return await event.answer({ message: "Hanya Owner!", alert: true });
      db.resetStats();
      await event.answer({ message: "Stats direset!" });
      return await showAdminPanel(chatId, userId, msgId);
    }

    const isAdminAct = data.startsWith("adm_fix_") || data.startsWith("adm_blk_") || data.startsWith("adm_unblk_");
    if (isAdminAct) {
      if (!isPrivileged(userId)) return await event.answer({ message: "Akses ditolak!", alert: true });
      let origText = "Laporan User";
      try { const m = await client.getMessages(chatId, { ids: [msgId] }); origText = m[0]?.message || m[0]?.caption || origText; } catch (_) {}

      if (data.startsWith("adm_fix_")) {
        const tid = Number(data.replace("adm_fix_", ""));
        try {
          await client.sendMessage(tid, { message: `**LAPORAN SELESAI!**\n\nKendala yang kamu laporkan telah diperbaiki oleh admin. Terima kasih!`, parseMode: "md" });
          await event.answer({ message: "User diberitahu!" });
        } catch (_) { await event.answer({ message: "Gagal kirim DM!", alert: true }); }
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n**STATUS:** Selesai & user diberitahu.", parseMode: "md", buttons: buildButtons([[{ text: "Blokir", data: `adm_blk_${tid}` }]]) });
        return;
      }
      if (data.startsWith("adm_blk_")) {
        const tid = Number(data.replace("adm_blk_", ""));
        if (db.isReportBlocked(tid)) return await event.answer({ message: "Sudah diblokir.", alert: true });
        db.blockReportUser(tid);
        await event.answer({ message: `User ${tid} diblokir!` });
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n**STATUS:** User diblokir.", parseMode: "md", buttons: buildButtons([[{ text: "Unblokir", data: `adm_unblk_${tid}` }]]) });
        try { await client.sendMessage(tid, { message: `**DIBLOKIR!**\n\nFitur laporan kamu dinonaktifkan.`, parseMode: "md" }); } catch (_) {}
        return;
      }
      if (data.startsWith("adm_unblk_")) {
        const tid = Number(data.replace("adm_unblk_", ""));
        if (!db.isReportBlocked(tid)) return await event.answer({ message: "Tidak dalam blokir.", alert: true });
        db.unblockReportUser(tid);
        await event.answer({ message: `User ${tid} diunblokir!` });
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n**STATUS:** Akses normal.", parseMode: "md", buttons: buildButtons([[{ text: "Selesai", data: `adm_fix_${tid}` }, { text: "Blokir", data: `adm_blk_${tid}` }]]) });
        try { await client.sendMessage(tid, { message: `**AKSES DIKEMBALIKAN!**\n\nFitur laporan kamu aktif kembali.`, parseMode: "md" }); } catch (_) {}
        return;
      }
    }

    await event.answer();

    if (data === "start") {
      return await handleStart({
        chatId,
        message: {
          getSender: async () => {
            try { const e = await client.getEntity(userId); return { id: userId, firstName: e?.firstName || "User", username: e?.username || null }; }
            catch (_) { return { id: userId, firstName: "User" }; }
          }
        }
      }, msgId);
    }
    if (data === "build")         return await handleBuild(chatId, userId, null,      msgId);
    if (data === "build_debug")   return await handleBuild(chatId, userId, "debug",   msgId);
    if (data === "build_release") return await handleBuild(chatId, userId, "release", msgId);
    if (data === "queue")         return await handleQueue(chatId, msgId);
    if (data === "help")          return await handleHelp(chatId, msgId);
    if (data === "status")        return await handleStatus(chatId, userId, msgId);

    if (data === "cancel") {
      removeUserJob(userId);
      return await sendHtml(chatId,
        `Dibatalkan.\n\n<blockquote>Ketik /start atau klik tombol di bawah untuk kembali ke menu utama.</blockquote>`,
        [[{ text: "Menu Utama", data: "start" }]], msgId
      );
    }
  } catch (err) {
    console.error("Callback error:", err);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Starting ${CONFIG.BOT_NAME}...`);
  console.log(`OWNER_ID: ${CONFIG.OWNER_ID}`);
  console.log(`PRIORITY: Owner (1) > Reseller (2) > User (3)`);

  if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });

  await client.start({ botAuthToken: CONFIG.BOT_TOKEN, onError: err => console.error("Client error:", err) });
  fs.writeFileSync(SESSION_FILE, client.session.save());
  console.log("Bot connected & session saved!");

  client.addEventHandler(async (event) => {
    try {
      const msg    = event.message;
      const text   = msg?.text?.trim();
      const chatId = event.chatId;
      const userId = Number(msg.senderId);

      if (text === "/start")  return handleStart(event);
      if (text === "/help")   return handleHelp(chatId);

      if (text === "/announcement" && isPrivileged(userId)) {
        return handleAnnouncement(chatId, userId);
      }

      if (text === "/cleanproject") {
        if (bdb.isBanned(userId)) {
          await sendHtml(chatId, "Akun kamu dibanned! Tidak bisa menggunakan fitur ini.");
          return;
        }
        cleanStates.set(userId, {});
        return handleCleanProjectUser(chatId, userId);
      }

      if (text === "/renameurl") {
        if (bdb.isBanned(userId)) {
          await sendHtml(chatId, "Akun kamu dibanned! Tidak bisa menggunakan fitur ini.");
          return;
        }
        return handleRenameUrl(chatId, userId);
      }

      if (text === "/cancelrename") {
        return handleCancelRename(chatId, userId);
      }

      const annState = adminStates.get(userId);
      if (annState && annState.step === "WAITING_ANNOUNCEMENT_TEXT") {
        const handled = await handleAnnouncementText(event);
        if (handled) return;
      }

      const renameState = renameStates.get(userId);
      if (renameState) {
        if (renameState.step === "WAITING_OLD_URL") {
          const handled = await handleRenameOldUrl(event);
          if (handled) return;
        }
        if (renameState.step === "WAITING_NEW_URL") {
          const handled = await handleRenameNewUrl(event);
          if (handled) return;
        }
      }

      if (msg.media && msg.media.document) {
        const handled = await handleFileReceived(event);
        if (handled) return;
      }

      if (text === "/broadcast" && isPrivileged(userId)) {
        const replied = await event.message.getReplyMessage();
        if (!replied) return sendHtml(chatId, `Cara Broadcast:\n\n<blockquote>Reply pesan yang ingin di-broadcast, lalu ketik /broadcast</blockquote>`);
        isOwner(userId)
          ? await (async () => {
              const all = db.getAllUsers();
              const m   = await sendHtml(chatId, `Broadcast dimulai ke ${all.length} user...`);
              let ok = 0, fail = 0;
              for (const u of all) {
                try {
                  replied.media
                    ? await client.sendFile(u.userId, { file: replied.media, caption: replied.text || "", parseMode: "md" })
                    : await client.sendMessage(u.userId, { message: replied.text || "", parseMode: "md" });
                  ok++;
                } catch (_) { fail++; }
                await sleep(100);
              }
              await editHtml(chatId, m.id, `Broadcast Selesai!\n\n<blockquote>Total: ${all.length}\nSukses: ${ok}\nGagal: ${fail}</blockquote>`);
            })()
          : await handleBroadcastWithOwnerNotify(chatId, userId, replied);
        return;
      }

      if (text?.startsWith("/addreseller") && isPrivileged(userId)) {
        const parts = text.split(" ");
        return handleAddReseller(chatId, userId, parts[1]);
      }
      if (text?.startsWith("/removereseller") && isPrivileged(userId)) {
        const parts = text.split(" ");
        return handleRemoveReseller(chatId, userId, parts[1]);
      }
      if ((text === "/listusers" || text?.match(/^\/listusers\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleListUsers(chatId, userId, page);
      }
      if ((text === "/listresellers" || text?.match(/^\/listresellers\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleListResellers(chatId, userId, page);
      }
      if (text?.startsWith("/searchuser") && isPrivileged(userId)) {
        return handleSearchUser(chatId, userId, text.replace("/searchuser", "").trim());
      }
      if (text?.startsWith("/userinfo") && isPrivileged(userId)) {
        return handleUserInfo(chatId, userId, text.replace("/userinfo", "").trim());
      }
      if (text?.startsWith("/deleteuser") && isPrivileged(userId)) {
        return handleDeleteUser(chatId, userId, text.replace("/deleteuser", "").trim());
      }
      if (text?.startsWith("/banuser") && isPrivileged(userId)) {
        return handleBanUser(chatId, userId, text.replace("/banuser", "").trim());
      }
      if (text?.startsWith("/unbanuser") && isPrivileged(userId)) {
        return handleUnbanUser(chatId, userId, text.replace("/unbanuser", "").trim());
      }
      if (text?.startsWith("/dmuser") && isPrivileged(userId)) {
        return handleDmUser(chatId, userId, text.replace("/dmuser", "").trim());
      }
      if (text === "/exportusers" && isPrivileged(userId)) {
        return handleExportUsers(chatId, userId);
      }
      if ((text === "/buildhistory" || text?.match(/^\/buildhistory\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleBuildHistory(chatId, userId, page);
      }
      if (text?.startsWith("/killbuild") && isPrivileged(userId)) {
        const targetId = parseInt(text.replace("/killbuild", "").trim());
        if (!isNaN(targetId)) {
          const job = getUserJob(targetId);
          if (!job) return sendHtml(chatId, `User ID <code>${targetId}</code> tidak sedang build.`);
          removeUserJob(targetId);
          await sendHtml(chatId, `Build user <code>${targetId}</code> dihentikan paksa!`);
          try { await client.sendMessage(job.chatId, { message: `**Build kamu dihentikan paksa oleh admin.**`, parseMode: "md" }); } catch (_) {}
        }
        return;
      }

      const reported = await handleUserReportMessages(event);
      if (reported) return;

      if (msg.media) await handleZipFile(event);
    } catch (err) { console.error("Handler error:", err); }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    try { await handleCallback(event); }
    catch (err) { console.error("Callback error:", err); }
  }, new CallbackQuery({}));

  console.log(`${CONFIG.BOT_NAME} v${CONFIG.BOT_VERSION} aktif!`);
  console.log(`Available Servers: ${SERVERS.map(s => s.name).join(", ")}`);
  await new Promise(() => {});
}

main();
