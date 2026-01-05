// Rancor Menu — Strike Bot (discord.js v14) — SINGLE FILE index.js
//
// Commands (all under /strikes):
//   Everyone:
//     /strikes me              -> view your own active strikes (last 30 days)
//   Officers only (role-gated):
//     /strikes add             -> add 1 strike to a member (optional note)
//     /strikes all             -> list everyone with active strikes (posts to log channel + confirms ephemerally)
//     /strikes member          -> view a specific member's strikes
//     /strikes reset           -> reset a member
//     /strikes resetall        -> reset everyone (confirm YES)
//
// Rules:
// - Rolling 30-day expiry per strike (each strike falls off after 30 days)
// - All strike adds/resets + /strikes all are posted into STRIKE_LOG_CHANNEL_ID
// - When a member reaches 5 active strikes, bot pings OFFICER_REVIEW_CHANNEL_ID and tags OFFICER_ROLE_ID
//
// Deploy:
// - Set BOT_TOKEN in Railway Variables
// - Run this as your entry (node index.js)
//
// IMPORTANT:
// - Uses local strikes.json. Without persistent storage, data can reset on redeploy.
//   If you want true persistence, add a Railway Volume and point STRIKES_FILE to that mount path.

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ===================== CONFIG (YOUR NUMBERS) =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN environment variable (set it in Railway Variables).");
  process.exit(1);
}

const CLIENT_ID = "1442232219652325436";
const GUILD_ID = "544629940640424336";

const OFFICER_ROLE_ID = "1350503552178589797";
const OFFICER_REVIEW_CHANNEL_ID = "1388904994270351520";
const STRIKE_LOG_CHANNEL_ID = "1451024629333495919";

const STRIKE_EXPIRY_DAYS = 30;
const STRIKE_REVIEW_THRESHOLD = 5;

const STRIKES_FILE = path.join(__dirname, "strikes.json");
// ================================================================

// ===================== STORAGE =====================
function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.error("Failed reading strikes JSON:", e?.message || e);
    return {};
  }
}

function safeWriteJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("Failed writing strikes JSON:", e?.message || e);
  }
}

function daysToMs(days) {
  return days * 24 * 60 * 60 * 1000;
}

function isActiveStrike(strike) {
  if (!strike || !strike.date) return false;
  const t = Date.parse(strike.date);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= daysToMs(STRIKE_EXPIRY_DAYS);
}

// Data shape:
// data[guildId][userId] = { history:[{date, mode, note?, by}], total:number }
function ensureGuild(data, guildId) {
  if (!data[guildId]) data[guildId] = {};
  return data[guildId];
}

function ensureEntry(data, guildId, userId) {
  const g = ensureGuild(data, guildId);
  if (!g[userId]) g[userId] = { history: [], total: 0 };
  if (!Array.isArray(g[userId].history)) g[userId].history = [];
  g[userId].history = g[userId].history.filter(isActiveStrike);
  g[userId].total = g[userId].history.length;
  return g[userId];
}

function pruneGuild(data, guildId) {
  if (!data[guildId]) return false;
  const g = data[guildId];
  let changed = false;

  for (const userId of Object.keys(g)) {
    const entry = g[userId];
    const before = Array.isArray(entry.history) ? entry.history.length : 0;
    const hist = Array.isArray(entry.history) ? entry.history : [];

    const kept = hist.filter(isActiveStrike);
    if (kept.length !== before) changed = true;

    entry.history = kept;
    entry.total = kept.length;

    if (entry.total <= 0) {
      delete g[userId];
      changed = true;
    }
  }

  if (Object.keys(g).length === 0) {
    delete data[guildId];
    changed = true;
  }

  return changed;
}

function loadData() {
  const data = safeReadJson(STRIKES_FILE);
  const changed = pruneGuild(data, GUILD_ID);
  if (changed) safeWriteJson(STRIKES_FILE, data);
  return data;
}

function saveData(data) {
  pruneGuild(data, GUILD_ID);
  safeWriteJson(STRIKES_FILE, data);
}

// ===================== DISCORD HELPERS =====================
function isOfficer(interaction) {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  if (roles.cache && typeof roles.cache.has === "function") return roles.cache.has(OFFICER_ROLE_ID);
  return false;
}

function mentionRole(roleId) {
  return `<@&${roleId}>`;
}

function prettyMode(mode) {
  if (mode === "tw") return "Territory War";
  if (mode === "tb") return "Territory Battle";
  if (mode === "raid") return "Raid";
  return String(mode || "").toUpperCase();
}

function formatStrikeLine(s) {
  const d = new Date(s.date);
  const when = Number.isNaN(d.getTime()) ? s.date : d.toLocaleString();
  const note = s.note ? ` — ${s.note}` : "";
  return `• **${prettyMode(s.mode)}** — ${when}${note}`;
}

async function sendToChannel(client, channelId, content) {
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) return false;
    await ch.send(content);
    return true;
  } catch (e) {
    console.error(`Failed to send to channel ${channelId}:`, e?.message || e);
    return false;
  }
}

function chunkLines(header, lines, maxLen = 1900) {
  const chunks = [];
  let cur = header;

  for (const line of lines) {
    const next = cur + (cur.endsWith("\n") ? "" : "\n") + line;
    if (next.length > maxLen) {
      chunks.push(cur);
      cur = header + line;
    } else {
      cur = next;
    }
  }
  if (cur.trim().length) chunks.push(cur);
  return chunks;
}

// ===================== SLASH COMMANDS =====================
const strikesCmd = new SlashCommandBuilder()
  .setName("strikes")
  .setDescription("Strike tracking")
  .addSubcommand((sub) =>
    sub.setName("me").setDescription("Show your active strikes (last 30 days)")
  )
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a strike to a member (officers only)")
      .addUserOption((opt) =>
        opt.setName("member").setDescription("Member to strike").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Where the strike applies")
          .setRequired(true)
          .addChoices(
            { name: "Territory War", value: "tw" },
            { name: "Territory Battle", value: "tb" },
            { name: "Raid", value: "raid" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("note").setDescription("Optional note").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("all").setDescription("List everyone with active strikes (officers only)")
  )
  .addSubcommand((sub) =>
    sub
      .setName("member")
      .setDescription("Show strikes for a specific member (officers only)")
      .addUserOption((opt) =>
        opt.setName("member").setDescription("Member").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription("Reset strikes for a member (officers only)")
      .addUserOption((opt) =>
        opt.setName("member").setDescription("Member").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("resetall")
      .setDescription("Reset ALL strikes (officers only, dangerous)")
      .addStringOption((opt) =>
        opt
          .setName("confirm")
          .setDescription('Type "YES" to confirm')
          .setRequired(true)
          .addChoices({ name: "YES", value: "YES" })
      )
  );

async function registerCommandsForce() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  // Force refresh: clear then register.
  // This fixes the common issue where a new subcommand doesn't show in Discord.
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [strikesCmd.toJSON()],
  });

  console.log("Slash commands FORCE-registered (/strikes ...).");
}

// ===================== CLIENT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerCommandsForce();
  } catch (e) {
    console.error("Command registration failed:", e?.message || e);
  }

  // Non-fatal startup ping to the log channel (helps confirm correct channel ID)
  await sendToChannel(client, STRIKE_LOG_CHANNEL_ID, "✅ Rancor Menu Strike Bot is online.");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "strikes") return;

  // Hard lock to configured guild
  if (interaction.guildId !== GUILD_ID) {
    try {
      await interaction.reply({ content: "This bot is not configured for this server.", ephemeral: true });
    } catch (_) {}
    return;
  }

  // Always ack quickly
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (_) {}

  const sub = interaction.options.getSubcommand();

  // Load and prune each time for consistent rolling expiry
  const data = loadData();
  const bucket = ensureGuild(data, GUILD_ID);

  // ---------------- Everyone: /strikes me ----------------
  if (sub === "me") {
    const userId = interaction.user.id;
    const entry = bucket[userId];

    if (!entry) {
      await interaction.editReply(`You have **0 active strikes** (last ${STRIKE_EXPIRY_DAYS} days).`);
      return;
    }

    entry.history = Array.isArray(entry.history) ? entry.history.filter(isActiveStrike) : [];
    entry.total = entry.history.length;

    if (entry.total <= 0) {
      delete bucket[userId];
      saveData(data);
      await interaction.editReply(`You have **0 active strikes** (last ${STRIKE_EXPIRY_DAYS} days).`);
      return;
    }

    const sorted = entry.history
      .slice()
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, 15);

    const lines = sorted.map(formatStrikeLine);
    const more = entry.total > 15 ? `\n\n(Showing most recent 15 of ${entry.total}.)` : "";

    await interaction.editReply(
      `Your active strikes (last ${STRIKE_EXPIRY_DAYS} days): **${entry.total}**\n\n${lines.join("\n")}${more}`
    );
    return;
  }

  // Everything else is officer-only
  if (!isOfficer(interaction)) {
    await interaction.editReply("Officers only.");
    return;
  }

  // ---------------- Officers: /strikes add ----------------
  if (sub === "add") {
    const user = interaction.options.getUser("member", true);
    const mode = interaction.options.getString("mode", true);
    const noteRaw = interaction.options.getString("note", false);
    const note = noteRaw && noteRaw.trim().length ? noteRaw.trim() : null;

    const entry = ensureEntry(data, GUILD_ID, user.id);

    entry.history.push({
      date: new Date().toISOString(),
      mode,
      note: note || undefined,
      by: interaction.user.id,
    });

    entry.history = entry.history.filter(isActiveStrike);
    entry.total = entry.history.length;

    saveData(data);

    await interaction.editReply(
      `✅ Strike added to ${user}.\nMode: **${prettyMode(mode)}**\nActive strikes (last ${STRIKE_EXPIRY_DAYS} days): **${entry.total}**${note ? `\nNote: ${note}` : ""}`
    );

    await sendToChannel(
      client,
      STRIKE_LOG_CHANNEL_ID,
      [
        `🟥 **Strike Added**`,
        `Member: ${user} (${user.id})`,
        `Mode: **${prettyMode(mode)}**`,
        `Note: ${note ? `**${note}**` : "_(none)_"} `,
        `Active strikes (last ${STRIKE_EXPIRY_DAYS} days): **${entry.total}**`,
        `By: ${interaction.user} (${interaction.user.id})`,
      ].join("\n")
    );

    // Threshold ping
    if (entry.total === STRIKE_REVIEW_THRESHOLD) {
      await sendToChannel(
        client,
        OFFICER_REVIEW_CHANNEL_ID,
        `🚨 ${mentionRole(OFFICER_ROLE_ID)} **Review Needed**\n${user} has reached **${STRIKE_REVIEW_THRESHOLD} active strikes** (last ${STRIKE_EXPIRY_DAYS} days).`
      );
    }

    return;
  }

  // ---------------- Officers: /strikes member ----------------
  if (sub === "member") {
    const user = interaction.options.getUser("member", true);
    const entry = bucket[user.id];

    if (!entry) {
      await interaction.editReply(`${user} has **0 active strikes** (last ${STRIKE_EXPIRY_DAYS} days).`);
      return;
    }

    entry.history = Array.isArray(entry.history) ? entry.history.filter(isActiveStrike) : [];
    entry.total = entry.history.length;

    if (entry.total <= 0) {
      delete bucket[user.id];
      saveData(data);
      await interaction.editReply(`${user} has **0 active strikes** (last ${STRIKE_EXPIRY_DAYS} days).`);
      return;
    }

    const sorted = entry.history
      .slice()
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, 15);

    const lines = sorted.map(formatStrikeLine);
    const more = entry.total > 15 ? `\n\n(Showing most recent 15 of ${entry.total}.)` : "";

    await interaction.editReply(
      `Strikes for ${user} (last ${STRIKE_EXPIRY_DAYS} days): **${entry.total}**\n\n${lines.join("\n")}${more}`
    );
    return;
  }

  // ---------------- Officers: /strikes all ----------------
  if (sub === "all") {
    const rows = Object.entries(bucket)
      .map(([userId, entry]) => {
        const hist = Array.isArray(entry.history) ? entry.history.filter(isActiveStrike) : [];
        return { userId, total: hist.length };
      })
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);

    if (!rows.length) {
      await sendToChannel(
        client,
        STRIKE_LOG_CHANNEL_ID,
        `📋 **Active Strikes (last ${STRIKE_EXPIRY_DAYS} days)**\nNone.`
      );
      await interaction.editReply("✅ No active strikes.");
      return;
    }

    const header = `📋 **Active Strikes (last ${STRIKE_EXPIRY_DAYS} days)** — ${rows.length} member(s)\n`;
    const lines = rows.map((r) => `• <@${r.userId}> — **${r.total}**`);

    // Post into the strike log channel (as requested)
    const chunks = chunkLines(header, lines);
    for (const c of chunks) {
      await sendToChannel(client, STRIKE_LOG_CHANNEL_ID, c);
    }

    await interaction.editReply(`✅ Posted the active strike list in <#${STRIKE_LOG_CHANNEL_ID}>.`);
    return;
  }

  // ---------------- Officers: /strikes reset ----------------
  if (sub === "reset") {
    const user = interaction.options.getUser("member", true);
    const oldTotal = bucket[user.id] ? (Array.isArray(bucket[user.id].history) ? bucket[user.id].history.filter(isActiveStrike).length : 0) : 0;

    delete bucket[user.id];
    saveData(data);

    await interaction.editReply(`✅ Strikes reset for ${user}. Old active total: **${oldTotal}** → **0**`);

    await sendToChannel(
      client,
      STRIKE_LOG_CHANNEL_ID,
      `🟩 **Strikes Reset**\nMember: ${user}\nOld active total: **${oldTotal}** → **0**\nBy: ${interaction.user}`
    );

    return;
  }

  // ---------------- Officers: /strikes resetall ----------------
  if (sub === "resetall") {
    const confirm = interaction.options.getString("confirm", true);
    if (confirm !== "YES") {
      await interaction.editReply("Cancelled.");
      return;
    }

    const countBefore = Object.keys(bucket).length;
    data[GUILD_ID] = {};
    saveData(data);

    await interaction.editReply(`✅ ALL strikes reset. Cleared records: **${countBefore}**`);

    await sendToChannel(
      client,
      STRIKE_LOG_CHANNEL_ID,
      `🟧 **ALL Strikes Reset**\nCleared records: **${countBefore}**\nBy: ${interaction.user}`
    );

    return;
  }

  await interaction.editReply("Unknown subcommand.");
});

client.login(BOT_TOKEN);
