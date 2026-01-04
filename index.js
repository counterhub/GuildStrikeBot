// These values are correct and already inserted:
const CLIENT_ID = "1442232219652325436";             // Application ID
const GUILD_ID = "544629940640424336";               // Server ID
const OFFICER_ROLE_ID = "1350503552178589797";       // Your Officer Role ID
const OFFICER_REVIEW_CHANNEL_ID = "1388904994270351520"; // 5-strike alert channel
// Rancor Menu / GuildStrikeBot – SWGOH Strike Tracking Bot
// Features:
// - /strike add (officers only) -> ALWAYS logs the strike to STRIKE_LOG_CHANNEL_ID
// - /strike member -> checks strikes for one member
// - /strike all -> lists everyone with strikes (last 30 days)
// - /strike reset (officers only)
// - /strike resetall (officers only)
// - Auto-expire strikes older than STRIKE_EXPIRY_DAYS
// - Ping OFFICER_REVIEW_CHANNEL_ID when someone hits 5 strikes
//
// Hosting: Railway always-on Node process

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ====== CONFIG ======
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN environment variable");
  process.exit(1);
}

// Your known IDs (already set from this project)
const CLIENT_ID = "1442232219652325436";
const GUILD_ID = "544629940640424336";

// You said your officer role ID changed — keep this set to YOUR current one:
const OFFICER_ROLE_ID = "1350503552178589797";

// Where the bot pings at 5 strikes (your officer review channel)
const OFFICER_REVIEW_CHANNEL_ID = "1388904994270351520";

// NEW: Dedicated bot channel where ALL strike activity should land
// (This is the channel you just created)
const STRIKE_LOG_CHANNEL_ID = "1451024629333495919";

// Auto-expire window
const STRIKE_EXPIRY_DAYS = 30;

// ====== STRIKE STORAGE ======
const STRIKES_FILE = path.join(__dirname, "strikes.json");

function loadStrikes() {
  try {
    const raw = fs.readFileSync(STRIKES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStrikes(data) {
  try {
    fs.writeFileSync(STRIKES_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save strikes.json:", e);
  }
}

let strikesData = loadStrikes();

function pruneOldStrikes() {
  const cutoff = Date.now() - STRIKE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

  for (const guildId of Object.keys(strikesData)) {
    const guild = strikesData[guildId];

    for (const userId of Object.keys(guild)) {
      const record = guild[userId];
      const history = Array.isArray(record.history) ? record.history : [];

      const newHistory = history.filter((entry) => {
        const t = Date.parse(entry.date);
        return !Number.isNaN(t) && t >= cutoff;
      });

      if (!newHistory.length) {
        delete guild[userId];
      } else {
        record.history = newHistory;
        record.total = newHistory.length;
      }
    }

    if (!Object.keys(guild).length) {
      delete strikesData[guildId];
    }
  }

  saveStrikes(strikesData);
}

// prune once on startup
pruneOldStrikes();

// ====== DISCORD CLIENT ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ====== PERMISSION CHECK ======
function isOfficer(interaction) {
  const member = interaction.member;
  if (!member) return false;

  // Guild owner always allowed
  if (interaction.guild && interaction.guild.ownerId === interaction.user.id) {
    return true;
  }

  return member.roles?.cache?.has(OFFICER_ROLE_ID) || false;
}

// ====== SLASH COMMANDS ======
const strikeCommand = new SlashCommandBuilder()
  .setName("strike")
  .setDescription("Manage guild strikes")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a strike to a member.")
      .addUserOption((opt) =>
        opt.setName("member").setDescription("Member to strike").setRequired(true)
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
      // NOTE stays free-typed (no dropdown)
      .addStringOption((opt) =>
        opt
          .setName("note")
          .setDescription("Optional note (e.g., 'no deploy', 'no offense', '0 damage')")
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("member")
      .setDescription("Check strikes for a member.")
      .addUserOption((opt) =>
        opt.setName("member").setDescription("Member to check").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("all")
      .setDescription("Show all members who currently have strikes (last 30 days).")
  )
  .addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription("Reset strikes for a member.")
      .addUserOption((opt) =>
        opt.setName("member").setDescription("Member to reset").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("resetall").setDescription("Reset ALL strikes in this guild (officers only).")
  );

const commands = [strikeCommand.toJSON()];

// ====== REGISTER COMMANDS ======
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  try {
    console.log("Registering /strike commands for guild:", GUILD_ID);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Error registering commands:", err);
  }
}

// ====== HELPERS ======
function modePretty(mode) {
  if (mode === "tb") return "Territory Battle";
  if (mode === "tw") return "Territory War";
  if (mode === "raid") return "Raid";
  return mode || "Unknown";
}

async function sendToLogChannel(guild, text) {
  try {
    const ch = await guild.channels.fetch(STRIKE_LOG_CHANNEL_ID);
    if (ch) await ch.send(text);
  } catch (e) {
    console.error("Failed to send to STRIKE_LOG_CHANNEL_ID:", e);
  }
}

async function sendToReviewChannel(guild, text) {
  try {
    const ch = await guild.channels.fetch(OFFICER_REVIEW_CHANNEL_ID);
    if (ch) await ch.send(text);
  } catch (e) {
    console.error("Failed to send to OFFICER_REVIEW_CHANNEL_ID:", e);
  }
}

// ====== EVENTS ======
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "strike") return;

  pruneOldStrikes();

  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({ content: "Use this in a server.", ephemeral: true });
  }
  if (!strikesData[guildId]) strikesData[guildId] = {};

  const sub = interaction.options.getSubcommand();

  try {
    // ===== /strike add =====
    if (sub === "add") {
      if (!isOfficer(interaction)) {
        return interaction.reply({
          content: "You don’t have permission to add strikes.",
          ephemeral: true,
        });
      }

      const target = interaction.options.getUser("member", true);
      const mode = interaction.options.getString("mode", true);
      const note = interaction.options.getString("note") || "";

      if (!strikesData[guildId][target.id]) {
        strikesData[guildId][target.id] = { total: 0, history: [] };
      }

      const record = strikesData[guildId][target.id];
      record.total += 1;
      record.history.push({
        date: new Date().toISOString(),
        mode,
        note,
        by: interaction.user.id,
      });

      saveStrikes(strikesData);

      const line = `⚠️ Strike added: ${target} — **${modePretty(mode)}**${note ? ` — *${note}*` : ""}. Total (last ${STRIKE_EXPIRY_DAYS} days): **${record.total}**. Added by: ${interaction.user}`;

      // ALWAYS post into the bot channel, regardless of where command was used
      await sendToLogChannel(interaction.guild, line);

      // Optional ephemeral ack to the officer (keeps channels clean)
      await interaction.reply({
        content: `✅ Logged. ${target} now has **${record.total}** strike(s) (last ${STRIKE_EXPIRY_DAYS} days).`,
        ephemeral: true,
      });

      // 5-strike review ping
      if (record.total === 5) {
        await sendToReviewChannel(
          interaction.guild,
          `🚨 **RANCOR REVIEW**: ${target} has reached **5 strikes** (last ${STRIKE_EXPIRY_DAYS} days).`
        );
      }

      return;
    }

    // ===== /strike member =====
    if (sub === "member") {
      const user = interaction.options.getUser("member", true);
      const record = strikesData[guildId][user.id];

      if (!record || !record.total) {
        return interaction.reply({
          content: `${user} has **0** strikes (last ${STRIKE_EXPIRY_DAYS} days).`,
          ephemeral: true,
        });
      }

      return interaction.reply({
        content: `${user} has **${record.total}** strike(s) (last ${STRIKE_EXPIRY_DAYS} days).`,
        ephemeral: true,
      });
    }

    // ===== /strike all =====
    if (sub === "all") {
      // This one can be used by officers only (recommended)
      if (!isOfficer(interaction)) {
        return interaction.reply({
          content: "You don’t have permission to view the full strike list.",
          ephemeral: true,
        });
      }

      const guild = strikesData[guildId] || {};
      const rows = Object.entries(guild)
        .map(([userId, rec]) => ({ userId, total: rec?.total || 0 }))
        .filter((r) => r.total > 0)
        .sort((a, b) => b.total - a.total);

      if (!rows.length) {
        await sendToLogChannel(interaction.guild, `📋 Strike list (last ${STRIKE_EXPIRY_DAYS} days): **No active strikes**.`);
        return interaction.reply({ content: "✅ No active strikes.", ephemeral: true });
      }

      // Build message(s) respecting Discord length limits
      const header = `📋 **Active Strikes (last ${STRIKE_EXPIRY_DAYS} days)** — ${rows.length} member(s)\n`;
      let chunk = header;
      const chunks = [];

      for (const r of rows) {
        const line = `• <@${r.userId}> — **${r.total}**\n`;
        if (chunk.length + line.length > 1800) {
          chunks.push(chunk);
          chunk = header + line;
        } else {
          chunk += line;
        }
      }
      chunks.push(chunk);

      // Post full list into the bot channel
      for (const c of chunks) {
        await sendToLogChannel(interaction.guild, c);
      }

      return interaction.reply({
        content: `✅ Posted the full strike list in <#${STRIKE_LOG_CHANNEL_ID}>.`,
        ephemeral: true,
      });
    }

    // ===== /strike reset =====
    if (sub === "reset") {
      if (!isOfficer(interaction)) {
        return interaction.reply({
          content: "You don’t have permission to reset strikes.",
          ephemeral: true,
        });
      }

      const user = interaction.options.getUser("member", true);
      delete strikesData[guildId][user.id];
      saveStrikes(strikesData);

      await sendToLogChannel(
        interaction.guild,
        `♻️ Strikes reset: ${user} — reset by ${interaction.user}`
      );

      return interaction.reply({ content: "✅ Reset logged.", ephemeral: true });
    }

    // ===== /strike resetall =====
    if (sub === "resetall") {
      if (!isOfficer(interaction)) {
        return interaction.reply({
          content: "You don’t have permission to reset all strikes.",
          ephemeral: true,
        });
      }

      strikesData[guildId] = {};
      saveStrikes(strikesData);

      await sendToLogChannel(
        interaction.guild,
        `♻️ **ALL strikes reset** — reset by ${interaction.user}`
      );

      return interaction.reply({ content: "✅ Reset-all logged.", ephemeral: true });
    }
  } catch (err) {
    console.error("Command error:", err);
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({
        content: "❌ Something went wrong while handling this command.",
        ephemeral: true,
      });
    }
  }
});

// ====== LOGIN ======
client.login(BOT_TOKEN);



