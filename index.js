/**
 * Rancor Menu — Strike Bot (discord.js v14) — FINAL index.js
 *
 * What this bot does (your requirements):
 * - 30-day rolling expiry per strike (each strike expires 30 days after it was added)
 * - Commands are under /strikes (plural)
 * - Everyone can look up themselves
 * - Officers can: add strikes, view all, view any member, reset member, reset all
 * - When a member reaches 5 active strikes, bot pings officers in the officer review channel
 * - Strike activity is posted to your dedicated strike log channel
 *
 * Commands:
 *   Everyone:
 *     /strikes me
 *   Officers only (OFFICER_ROLE_ID):
 *     /strikes add member:<user> mode:<tb|tw|raid> note:<optional>
 *     /strikes member member:<user>
 *     /strikes all
 *     /strikes reset member:<user>
 *     /strikes resetall confirm:YES
 *
 * Hosting:
 * - Railway
 * - Set BOT_TOKEN in Railway Variables
 *
 * NOTE ON STORAGE:
 * - This uses a local strikes.json file. Without a persistent volume, data may reset on redeploy.
 */

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ===================== YOUR NUMBERS (LOCKED) =====================
const CLIENT_ID = "1442232219652325436";
const GUILD_ID = "544629940640424336";

const OFFICER_ROLE_ID = "1350503552178589797";
const OFFICER_REVIEW_CHANNEL_ID = "1388904994270351520";
const STRIKE_LOG_CHANNEL_ID = "1451024629333495919";

// 30-day rolling expiry (hard-coded so it can’t be blank)
const STRIKE_EXPIRY_DAYS = 30;

// Threshold to ping officers
const REVIEW_THRESHOLD = 5;

// Railway env var
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN environment variable. Set it in Railway Variables.");
  process.exit(1);
}

// Local storage file
const STRIKES_FILE = path.join(__dirname, "strikes.json");

// ===================== STORAGE HELPERS =====================
// Data shape (guild-scoped):
// {
//   "544629940640424336": {
//     "123456789012345678": {
//       "history": [
//         { "ts": 1710000000000, "mode": "tb", "note": "no deploy", "by": "officerUserId" }
//       ]
//     }
//   }
// }

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.error("Failed reading JSON:", e?.message || e);
    return {};
  }
}

function safeWriteJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("Failed writing JSON:", e?.message || e);
    return false;
  }
}

function daysToMs(days) {
  return days * 24 * 60 * 60 * 1000;
}

function cutoffMs() {
  return Date.now() - daysToMs(STRIKE_EXPIRY_DAYS);
}

function ensureGuild(data, guildId) {
  if (!data[guildId]) data[guildId] = {};
  return data[guildId];
}

function ensureEntry(data, guildId, userId) {
  const g = ensureGuild(data, guildId);
  if (!g[userId]) g[userId] = { history: [] };
  if (!Array.isArray(g[userId].history)) g[userId].history = [];
  return g[userId];
}

function pruneExpired(data, guildId) {
  const g = data[guildId];
  if (!g) return false;

  const cut = cutoffMs();
  let changed = false;

  for (const userId of Object.keys(g)) {
    const entry = g[userId];
    if (!entry || !Array.isArray(entry.history)) {
      delete g[userId];
      changed = true;
      continue;
    }

    const before = entry.history.length;
    entry.history = entry.history.filter((s) => s && typeof s.ts === "number" && s.ts >= cut);
    if (entry.history.length !== before) changed = true;

    if (entry.history.length === 0) {
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

function getCount(data, guildId, userId) {
  const g = data[guildId];
  if (!g || !g[userId] || !Array.isArray(g[userId].history)) return 0;
  return g[userId].history.length;
}

// ===================== DISCORD HELPERS =====================
function isOfficer(interaction) {
  const roles = interaction.member?.roles;
  if (!roles || !roles.cache) return false;
  return roles.cache.has(OFFICER_ROLE_ID);
}

function modeLabel(mode) {
  if (mode === "tb") return "Territory Battle";
  if (mode === "tw") return "Territory War";
  return "Raid";
}

function formatStrikeLine(s) {
  const when = new Date(s.ts).toLocaleString();
  const note = s.note ? ` — ${s.note}` : "";
  return `• **${modeLabel(s.mode)}** — ${when}${note}`;
}

async function sendToChannel(client, channelId, content) {
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) return false;
    await ch.send(content);
    return true;
  } catch (e) {
    console.error("Failed to send to channel:", channelId, e?.message || e);
    return false;
  }
}

function chunkTextLines(header, lines, maxLen = 1900) {
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

  if (cur && cur.trim().length) chunks.push(cur);
  return chunks;
}

// ===================== SLASH COMMANDS =====================
const strikesCmd = new SlashCommandBuilder()
  .setName("strikes")
  .setDescription("Strike tracking (Rancor Menu)")
  .addSubcommand((sub) =>
    sub.setName("me").setDescription("Show your active strikes (last 30 days)")
  )
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a strike to a member (officers only)")
      .addUserOption((opt) =>
        opt.setName("member").setDescription("Member").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Mode")
          .setRequired(true)
          .addChoices(
            { name: "Territory Battle", value: "tb" },
            { name: "Territory War", value: "tw" },
            { name: "Raid", value: "raid" }
          )
      )
      .addStringOption((opt) =>
        opt
          .setName("note")
          .setDescription("Optional note (ex: no deploy, no offense, no defense, zero)")
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("member")
      .setDescription("Show strikes for a member (officers only)")
      .addUserOption((opt) =>
        opt.setName("member").setDescription("Member").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("all")
      .setDescription("List everyone with active strikes (officers only)")
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

async function registerGuildCommandsForce() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  // Force refresh so new subcommands (like /strikes all) actually appear:
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [strikesCmd.toJSON()],
  });

  console.log(`Registered guild commands: /strikes (guild ${GUILD_ID})`);
}

// ===================== CLIENT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerGuildCommandsForce();
  } catch (e) {
    console.error("Command registration failed:", e?.message || e);
  }

  // Optional: show in logs channel that bot is up (helps verify channel IDs)
  await sendToChannel(client, STRIKE_LOG_CHANNEL_ID, "✅ Rancor Menu Strike Bot online.");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "strikes") return;

  // Hard lock to your configured guild
  if (interaction.guildId !== GUILD_ID) {
    try {
      await interaction.reply({ content: "This bot is not configured for this server.", ephemeral: true });
    } catch (_) {}
    return;
  }

  // Acknowledge quickly to avoid timeouts
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (_) {}

  const sub = interaction.options.getSubcommand();

  // Load + prune (rolling 30-day window)
  const data = safeReadJson(STRIKES_FILE);
  const changed = pruneExpired(data, GUILD_ID);
  if (changed) safeWriteJson(STRIKES_FILE, data);

  const g = ensureGuild(data, GUILD_ID);

  // ===================== /strikes me (everyone) =====================
  if (sub === "me") {
    const userId = interaction.user.id;
    const entry = g[userId];

    if (!entry || !Array.isArray(entry.history) || entry.history.length === 0) {
      await interaction.editReply(`You have **0** active strikes (rolling **${STRIKE_EXPIRY_DAYS} days**).`);
      return;
    }

    const hist = entry.history
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 15);

    const lines = hist.map(formatStrikeLine);
    const total = entry.history.length;
    const more = total > 15 ? `\n\n(Showing most recent 15 of ${total}.)` : "";

    await interaction.editReply(
      `Your active strikes (rolling **${STRIKE_EXPIRY_DAYS} days**): **${total}**\n\n${lines.join("\n")}${more}`
    );
    return;
  }

  // Everything else requires officer role
  if (!isOfficer(interaction)) {
    await interaction.editReply("Officers only.");
    return;
  }

  // ===================== /strikes add =====================
  if (sub === "add") {
    const member = interaction.options.getUser("member", true);
    const mode = interaction.options.getString("mode", true);
    const note = (interaction.options.getString("note", false) || "").trim();

    const entry = ensureEntry(data, GUILD_ID, member.id);
    entry.history.push({
      ts: Date.now(),
      mode,
      note: note || undefined,
      by: interaction.user.id,
    });

    // prune + save
    pruneExpired(data, GUILD_ID);
    safeWriteJson(STRIKES_FILE, data);

    const total = getCount(data, GUILD_ID, member.id);

    await interaction.editReply(
      `✅ Strike added to ${member}.\nMode: **${modeLabel(mode)}**\nActive strikes (rolling **${STRIKE_EXPIRY_DAYS} days**): **${total}**${note ? `\nNote: ${note}` : ""}`
    );

    await sendToChannel(
      client,
      STRIKE_LOG_CHANNEL_ID,
      [
        `🟥 **Strike Added**`,
        `Member: ${member} (${member.id})`,
        `Mode: **${modeLabel(mode)}**`,
        `Note: ${note ? `**${note}**` : "_(none)_"} `,
        `Active strikes (rolling ${STRIKE_EXPIRY_DAYS} days): **${total}**`,
        `By: ${interaction.user} (${interaction.user.id})`,
      ].join("\n")
    );

    if (total === REVIEW_THRESHOLD) {
      await sendToChannel(
        client,
        OFFICER_REVIEW_CHANNEL_ID,
        `🚨 <@&${OFFICER_ROLE_ID}> **Review Needed**\n${member} has reached **${REVIEW_THRESHOLD} active strikes** (rolling ${STRIKE_EXPIRY_DAYS} days).`
      );
    }

    return;
  }

  // ===================== /strikes member =====================
  if (sub === "member") {
    const member = interaction.options.getUser("member", true);
    const entry = g[member.id];

    if (!entry || !Array.isArray(entry.history) || entry.history.length === 0) {
      await interaction.editReply(`${member} has **0** active strikes (rolling **${STRIKE_EXPIRY_DAYS} days**).`);
      return;
    }

    const hist = entry.history
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 15);

    const lines = hist.map(formatStrikeLine);
    const total = entry.history.length;
    const more = total > 15 ? `\n\n(Showing most recent 15 of ${total}.)` : "";

    await interaction.editReply(
      `Active strikes for ${member} (rolling **${STRIKE_EXPIRY_DAYS} days**): **${total}**\n\n${lines.join("\n")}${more}`
    );
    return;
  }

  // ===================== /strikes all =====================
  if (sub === "all") {
    const rows = Object.entries(g)
      .map(([userId, entry]) => {
        const hist = Array.isArray(entry.history) ? entry.history : [];
        return { userId, total: hist.length };
      })
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);

    if (rows.length === 0) {
      // Log the list request (optional)
      await sendToChannel(
        client,
        STRIKE_LOG_CHANNEL_ID,
        `📋 **Active Strikes (rolling ${STRIKE_EXPIRY_DAYS} days)**\nNone. (Requested by ${interaction.user})`
      );

      await interaction.editReply(`✅ No active strikes (rolling **${STRIKE_EXPIRY_DAYS} days**).`);
      return;
    }

    const header = `📋 **Active Strikes (rolling ${STRIKE_EXPIRY_DAYS} days)** — ${rows.length} member(s)\n`;
    const lines = rows.map((r) => `• <@${r.userId}> — **${r.total}**`);

    // Post into strike log channel so officers see it in the bot channel (your request)
    const chunks = chunkTextLines(header, lines);
    for (const c of chunks) {
      await sendToChannel(client, STRIKE_LOG_CHANNEL_ID, c);
    }
    await sendToChannel(
      client,
      STRIKE_LOG_CHANNEL_ID,
      `Requested by: ${interaction.user} (${interaction.user.id})`
    );

    // Ephemeral confirmation to the command runner
    await interaction.editReply(`✅ Posted the active strike list in <#${STRIKE_LOG_CHANNEL_ID}>.`);
    return;
  }

  // ===================== /strikes reset =====================
  if (sub === "reset") {
    const member = interaction.options.getUser("member", true);
    const oldTotal = getCount(data, GUILD_ID, member.id);

    if (g[member.id]) delete g[member.id];
    safeWriteJson(STRIKES_FILE, data);

    await interaction.editReply(`✅ Strikes reset for ${member}. Old active total: **${oldTotal}** → **0**`);

    await sendToChannel(
      client,
      STRIKE_LOG_CHANNEL_ID,
      `🟩 **Strikes Reset**\nMember: ${member}\nOld active total: **${oldTotal}** → **0**\nBy: ${interaction.user}`
    );
    return;
  }

  // ===================== /strikes resetall =====================
  if (sub === "resetall") {
    const confirm = interaction.options.getString("confirm", true);
    if (confirm !== "YES") {
      await interaction.editReply("Cancelled.");
      return;
    }

    const countBefore = Object.keys(g).length;
    data[GUILD_ID] = {};
    safeWriteJson(STRIKES_FILE, data);

    await interaction.editReply(`✅ ALL strikes reset. Cleared records: **${countBefore}**`);

    await sendToChannel(
      client,
      STRIKE_LOG_CHANNEL_ID,
      `🟧 **RESET ALL**\nCleared records: **${countBefore}**\nBy: ${interaction.user}`
    );
    return;
  }

  // Fallback
  await interaction.editReply("Unknown subcommand.");
});

client.login(BOT_TOKEN);
