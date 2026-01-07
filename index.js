// Rancor Menu — GuildStrikeBot (discord.js v14) — SINGLE-FILE index.js
//
// Slash Commands
//   Officers:
//     /strike add member:<user> mode:<TW|TB|Raid> note:<optional>
//     /strike reset member:<user>
//     /strike resetall confirm:YES
//     /strikes all
//
//   Everyone:
//     /strikes me
//
// Behavior
// - Rolling expiry: each strike expires after 30 days from when it was added
// - /strike add/reset/resetall ALWAYS logs to STRIKE_LOG_CHANNEL_ID
// - /strikes all posts the active strike list into STRIKE_LOG_CHANNEL_ID (and confirms ephemerally)
// - When a member reaches 5 active strikes, bot pings OFFICER_REVIEW_CHANNEL_ID + @Officer role
// - BOT_TOKEN is read from Railway Variables (environment variables)
//
// Hosting note (Railway)
// - This uses a local strikes.json file. If your service redeploys onto a new container with no volume,
//   strikes.json can reset. For true persistence, add a Railway Volume and point STRIKES_FILE to that path.

"use strict";

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
// Token comes from Railway Variables
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Set it in Railway → Variables as BOT_TOKEN.");
  process.exit(1);
}

// Discord application (bot) client ID
const CLIENT_ID = "1442232219652325436";

// Your server (guild) ID — CONFIRMED
const GUILD_ID = "544692940644024336";

// Officer role ID — CONFIRMED
const OFFICER_ROLE_ID = "1350503552178589797";

// Channel where the bot posts strike activity + /strikes all output — CONFIRMED
const STRIKE_LOG_CHANNEL_ID = "1451024629333495919";

// Channel where the bot pings officers when someone hits the threshold (5)
// If you want this to ALSO be the bot channel, set it equal to STRIKE_LOG_CHANNEL_ID.
const OFFICER_REVIEW_CHANNEL_ID = "1388904994270351520";

const STRIKE_EXPIRY_DAYS = 30;
const STRIKE_REVIEW_THRESHOLD = 5;

// Storage
const STRIKES_FILE = path.join(__dirname, "strikes.json");
// ================================================================

// --------------------- Safety: keep process alive ----------------
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// --------------------- Storage helpers ---------------------------
function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.error("Failed reading strikes JSON:", e);
    return {};
  }
}

function safeWriteJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("Failed writing strikes JSON:", e);
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

function pruneGuildData(data, guildId) {
  if (!data[guildId]) return false;

  let changed = false;
  const bucket = data[guildId];

  for (const userId of Object.keys(bucket)) {
    const entry = bucket[userId];
    const hist = Array.isArray(entry.history) ? entry.history : [];
    const kept = hist.filter(isActiveStrike);

    if (kept.length !== hist.length) changed = true;

    entry.history = kept;
    entry.total = kept.length;

    if (entry.total <= 0) {
      delete bucket[userId];
      changed = true;
    }
  }

  if (Object.keys(bucket).length === 0) {
    delete data[guildId];
    changed = true;
  }

  return changed;
}

function loadAllStrikes() {
  const data = safeReadJson(STRIKES_FILE);
  const changed = pruneGuildData(data, GUILD_ID);
  if (changed) safeWriteJson(STRIKES_FILE, data);
  return data;
}

function saveAllStrikes(data) {
  pruneGuildData(data, GUILD_ID);
  safeWriteJson(STRIKES_FILE, data);
}

function getGuildBucket(data, guildId) {
  if (!data[guildId]) data[guildId] = {};
  return data[guildId];
}

function getEntry(data, guildId, userId) {
  const bucket = getGuildBucket(data, guildId);
  if (!bucket[userId]) bucket[userId] = { history: [], total: 0 };
  if (!Array.isArray(bucket[userId].history)) bucket[userId].history = [];
  bucket[userId].history = bucket[userId].history.filter(isActiveStrike);
  bucket[userId].total = bucket[userId].history.length;
  return bucket[userId];
}

// --------------------- Discord helpers ---------------------------
function isOfficer(interaction) {
  const roles = interaction.member?.roles;
  if (!roles) return false;

  // discord.js v14 GuildMemberRoleManager
  if (roles.cache && typeof roles.cache.has === "function") {
    return roles.cache.has(OFFICER_ROLE_ID);
  }

  // fallback
  if (Array.isArray(roles)) return roles.includes(OFFICER_ROLE_ID);
  return false;
}

function mentionRole(roleId) {
  return `<@&${roleId}>`;
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

function prettyMode(mode) {
  if (mode === "tw") return "Territory War";
  if (mode === "tb") return "Territory Battle";
  if (mode === "raid") return "Raid";
  return String(mode || "").toUpperCase();
}

function formatStrikeLine(s) {
  const d = new Date(s.date);
  const when = Number.isNaN(d.getTime()) ? String(s.date) : d.toLocaleString();
  const note = s.note ? ` — ${s.note}` : "";
  return `• **${prettyMode(s.mode)}** — ${when}${note}`;
}

// --------------------- Slash commands ----------------------------
// IMPORTANT: .addChoices MUST be passed as varargs or an array of objects.
// Passing a single object incorrectly is a known crash pattern in v14 validation.

const strikeCmd = new SlashCommandBuilder()
  .setName("strike")
  .setDescription("Officer strike actions")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a strike (officers only)")
      .addUserOption((opt) =>
        opt.setName("member").setDescription("Member").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Mode")
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
      .setDescription("Reset ALL strikes (officers only)")
      .addStringOption((opt) =>
        opt
          .setName("confirm")
          .setDescription('Type "YES" to confirm')
          .setRequired(true)
          .addChoices({ name: "YES", value: "YES" }) // Correct varargs form (single choice)
      )
  );

const strikesCmd = new SlashCommandBuilder()
  .setName("strikes")
  .setDescription("View strikes")
  .addSubcommand((sub) =>
    sub.setName("me").setDescription(`Show your active strikes (last ${STRIKE_EXPIRY_DAYS} days)`)
  )
  .addSubcommand((sub) =>
    sub
      .setName("all")
      .setDescription("List everyone with active strikes (officers only)")
  );

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  const body = [strikeCmd.toJSON(), strikesCmd.toJSON()];
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  console.log("Slash commands registered for guild:", GUILD_ID);
}

// --------------------- Client -----------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.on("error", (err) => console.error("Discord client error:", err));
client.on("shardError", (err) => console.error("Discord shard error:", err));

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register commands (guild-scoped = instant-ish updates)
  try {
    await registerCommands();
  } catch (e) {
    console.error("Command registration failed:", e?.message || e);
  }

  // Optional online heartbeat in the strike log channel
  await sendToChannel(
    client,
    STRIKE_LOG_CHANNEL_ID,
    `✅ Strike bot online. (Expiry: ${STRIKE_EXPIRY_DAYS} days)`
  );
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Hard lock to your configured guild (prevents cross-server confusion)
  if (interaction.guildId !== GUILD_ID) {
    try {
      await interaction.reply({
        content: "This bot is not configured for this server.",
        ephemeral: true,
      });
    } catch (_) {}
    return;
  }

  // ACK quickly to avoid Discord 3s timeout
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (_) {}

  // Load/prune strikes every interaction
  const data = loadAllStrikes();
  const bucket = getGuildBucket(data, GUILD_ID);

  // ---------------- /strike ... (officers only) ------------------
  if (interaction.commandName === "strike") {
    if (!isOfficer(interaction)) {
      await interaction.editReply("Officers only.");
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const user = interaction.options.getUser("member", true);
      const mode = interaction.options.getString("mode", true);
      const noteRaw = interaction.options.getString("note", false);
      const note = noteRaw && noteRaw.trim().length ? noteRaw.trim() : null;

      const entry = getEntry(data, GUILD_ID, user.id);

      entry.history.push({
        date: new Date().toISOString(),
        mode,
        note: note || undefined,
        by: interaction.user.id,
      });

      entry.history = entry.history.filter(isActiveStrike);
      entry.total = entry.history.length;

      saveAllStrikes(data);

      await interaction.editReply(
        `✅ Strike added to ${user}.\nMode: **${prettyMode(mode)}**\nActive strikes (last ${STRIKE_EXPIRY_DAYS}d): **${entry.total}**${note ? `\nNote: ${note}` : ""}`
      );

      await sendToChannel(
        client,
        STRIKE_LOG_CHANNEL_ID,
        `🟥 **Strike Added**\nMember: ${user}\nMode: **${prettyMode(mode)}**\nNote: ${note ? `**${note}**` : "_(none)_"}\nActive strikes (last ${STRIKE_EXPIRY_DAYS}d): **${entry.total}**\nBy: ${interaction.user}`
      );

      // Threshold ping when they reach exactly the threshold
      if (entry.total === STRIKE_REVIEW_THRESHOLD) {
        await sendToChannel(
          client,
          OFFICER_REVIEW_CHANNEL_ID,
          `🚨 ${mentionRole(OFFICER_ROLE_ID)} **Review Needed**\n${user} has reached **${STRIKE_REVIEW_THRESHOLD} active strikes** (last ${STRIKE_EXPIRY_DAYS} days).`
        );
      }

      return;
    }

    if (sub === "reset") {
      const user = interaction.options.getUser("member", true);

      const oldTotal = bucket[user.id]
        ? (bucket[user.id].history || []).filter(isActiveStrike).length
        : 0;

      delete bucket[user.id];
      saveAllStrikes(data);

      await interaction.editReply(
        `✅ Strikes reset for ${user}. Old active total: **${oldTotal}** → **0**`
      );

      await sendToChannel(
        client,
        STRIKE_LOG_CHANNEL_ID,
        `🟩 **Strikes Reset**\nMember: ${user}\nOld active total: **${oldTotal}** → **0**\nBy: ${interaction.user}`
      );

      return;
    }

    if (sub === "resetall") {
      const confirm = interaction.options.getString("confirm", true);
      if (confirm !== "YES") {
        await interaction.editReply("Cancelled.");
        return;
      }

      const countBefore = Object.keys(bucket).length;
      data[GUILD_ID] = {};
      saveAllStrikes(data);

      await interaction.editReply(
        `✅ ALL strikes reset. Cleared records: **${countBefore}**`
      );

      await sendToChannel(
        client,
        STRIKE_LOG_CHANNEL_ID,
        `🟧 **ALL Strikes Reset**\nCleared records: **${countBefore}**\nBy: ${interaction.user}`
      );

      return;
    }

    await interaction.editReply("Unknown /strike subcommand.");
    return;
  }

  // ---------------- /strikes ... --------------------------------
  if (interaction.commandName === "strikes") {
    const sub = interaction.options.getSubcommand();

    // Everyone can check themselves
    if (sub === "me") {
      const userId = interaction.user.id;
      const entry = bucket[userId];

      if (!entry) {
        await interaction.editReply(
          `You have **0 active strikes** (last ${STRIKE_EXPIRY_DAYS} days).`
        );
        return;
      }

      entry.history = (entry.history || []).filter(isActiveStrike);
      entry.total = entry.history.length;

      if (entry.total <= 0) {
        delete bucket[userId];
        saveAllStrikes(data);
        await interaction.editReply(
          `You have **0 active strikes** (last ${STRIKE_EXPIRY_DAYS} days).`
        );
        return;
      }

      const sorted = entry.history
        .slice()
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .slice(0, 15);

      const lines = sorted.map(formatStrikeLine);
      const more =
        entry.total > 15
          ? `\n\n(Showing most recent 15 of ${entry.total}.)`
          : "";

      await interaction.editReply(
        `Your active strikes (last ${STRIKE_EXPIRY_DAYS} days): **${entry.total}**\n\n${lines.join(
          "\n"
        )}${more}`
      );
      return;
    }

    // Officers-only: list everyone with active strikes
    if (sub === "all") {
      if (!isOfficer(interaction)) {
        await interaction.editReply("Officers only.");
        return;
      }

      const rows = Object.entries(bucket)
        .map(([userId, entry]) => {
          const hist = Array.isArray(entry.history)
            ? entry.history.filter(isActiveStrike)
            : [];
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

      const header = `📋 **Active Strikes (last ${STRIKE_EXPIRY_DAYS} days)** — ${rows.length} member(s)`;
      const lines = rows.map((r) => `• <@${r.userId}> — **${r.total}**`);

      // Chunk to stay under Discord message limits
      let chunk = header;
      for (const line of lines) {
        if ((chunk + "\n" + line).length > 1900) {
          await sendToChannel(client, STRIKE_LOG_CHANNEL_ID, chunk);
          chunk = header + "\n" + line;
        } else {
          chunk += "\n" + line;
        }
      }
      await sendToChannel(client, STRIKE_LOG_CHANNEL_ID, chunk);

      await interaction.editReply(
        `✅ Posted the active strike list in <#${STRIKE_LOG_CHANNEL_ID}>.`
      );
      return;
    }

    await interaction.editReply("Unknown /strikes subcommand.");
    return;
  }

  await interaction.editReply("Unknown command.");
});

client.login(BOT_TOKEN);
