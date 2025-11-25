// Rancor Menu / GuildStrikeBot – SWGOH Strike Tracking Bot
// FINAL VERSION: No dropdown reason. Uses (member, mode, note).
// Keeps 30-day reset + 5-strike officer ping. No owner re-auth required.

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
} = require("discord.js");

// ====== CONFIG ======
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN environment variable");
  process.exit(1);
}

// These values are correct and already inserted:
const CLIENT_ID = "1442232219652325436";             // Application ID
const GUILD_ID = "544629940640424336";               // Server ID
const OFFICER_ROLE_ID = "1350503552178589797";       // Your Officer Role ID
const OFFICER_REVIEW_CHANNEL_ID = "1388904994270351520"; // 5-strike alert channel

// How long strikes last before expiring
const STRIKE_EXPIRY_DAYS = 30;

// ====== STRIKE STORAGE ======
const STRIKES_FILE = path.join(__dirname, "strikes.json");

function loadStrikes() {
  try {
    const raw = fs.readFileSync(STRIKES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : {};
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

// ===== AUTO-PRUNE 30-DAY OLD STRIKES =====
function pruneOldStrikes() {
  const cutoff = Date.now() - STRIKE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

  for (const guildId of Object.keys(strikesData)) {
    const guild = strikesData[guildId];

    for (const userId of Object.keys(guild)) {
      const record = guild[userId];

      const newHistory = (record.history || []).filter(entry => {
        const t = Date.parse(entry.date);
        return !Number.isNaN(t) && t >= cutoff;
      });

      if (newHistory.length === 0) {
        delete guild[userId];
      } else {
        record.history = newHistory;
        record.total = newHistory.length;
      }
    }

    if (Object.keys(guild).length === 0) {
      delete strikesData[guildId];
    }
  }

  saveStrikes(strikesData);
}

pruneOldStrikes();

// ====== DISCORD CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

// ====== PERMISSION CHECK ======
function isOfficer(interaction) {
  const member = interaction.member;
  if (!member) return false;

  // Guild owner always allowed
  if (interaction.guild.ownerId === interaction.user.id) return true;

  return member.roles?.cache?.has(OFFICER_ROLE_ID);
}

// ====== BOT READY ======
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log("Strike bot READY. No slash command registration required.");
});

// ====== COMMAND HANDLER ======
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "strike") return;

  pruneOldStrikes();

  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (!guildId) {
    return interaction.reply({
      content: "This command can only be used inside a guild.",
      ephemeral: true,
    });
  }

  if (!strikesData[guildId]) strikesData[guildId] = {};

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
      const note = interaction.options.getString("note") || ""; // optional

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

      const modePretty =
        mode === "tb" ? "Territory Battle" :
        mode === "tw" ? "Territory War" :
        mode === "raid" ? "Raid" : mode;

      // 5-strike alert
      if (record.total === 5) {
        try {
          const ch = await interaction.client.channels.fetch(OFFICER_REVIEW_CHANNEL_ID);
          await ch.send(`⚠️ ${target} has reached **5 strikes**. Review for Rancor.`);
        } catch (e) {}
      }

      return interaction.reply(
        `⚠️ Strike added for ${target} (${modePretty}${note ? ` – ${note}` : ""}). Total: **${record.total}**.`
      );
    }

    // ===== /strike member =====
    if (sub === "member") {
      const user = interaction.options.getUser("member", true);
      const record = strikesData[guildId][user.id];

      if (!record || !record.total) {
        return interaction.reply(`${user} has **0** strikes (last 30 days).`);
      }

      return interaction.reply(
        `${user} has **${record.total}** strike${record.total === 1 ? "" : "s"} (last 30 days).`
      );
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

      return interaction.reply(
        `✅ Strikes reset for ${user}.`
      );
    }

    // ===== /strike resetall =====
    if (sub === "resetall") {
      if (!isOfficer(interaction)) {
        return interaction.reply({
          content: "You don’t have permission to reset ALL strikes.",
          ephemeral: true,
        });
      }

      strikesData[guildId] = {};
      saveStrikes(strikesData);

      return interaction.reply("✅ All strikes have been reset for this guild.");
    }

  } catch (err) {
    console.error("Command error:", err);
    return interaction.reply({
      content: "❌ Something went wrong. Try again.",
      ephemeral: true,
    });
  }
});

// ====== LOGIN ======
client.login(BOT_TOKEN);
