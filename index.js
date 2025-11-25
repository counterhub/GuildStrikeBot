// Rancor Menu / GuildStrikeBot – SWGOH Strike Tracking Bot
// Tracks guild member strikes for TB, TW, and Raids using slash commands.

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

// These three should already be correct for your setup:
const CLIENT_ID = "1442232219652325436";      // Application (client) ID
const GUILD_ID = "544629940640424336";        // Your Discord server ID
const OFFICER_ROLE_ID = "1350503552178589797"; // CARB Officer role ID

// New config:
// How long strikes last before expiring (in days)
const STRIKE_EXPIRY_DAYS = 30;

// Channel to ping when someone hits 5 strikes (officer review channel)
const OFFICER_REVIEW_CHANNEL_ID = "1388904994270351520";

// ====== STRIKE STORAGE ======
const STRIKES_FILE = path.join(__dirname, "strikes.json");

function loadStrikes() {
  try {
    const raw = fs.readFileSync(STRIKES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return {};
  } catch (e) {
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

// Shape: strikesData[guildId][userId] = { total: number, history: [...] }
let strikesData = loadStrikes();

// Remove strikes older than STRIKE_EXPIRY_DAYS
function pruneOldStrikes() {
  const cutoff = Date.now() - STRIKE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

  for (const guildId of Object.keys(strikesData)) {
    const guild = strikesData[guildId];

    for (const userId of Object.keys(guild)) {
      const record = guild[userId];
      if (!record.history || !record.history.length) {
        delete guild[userId];
        continue;
      }

      const newHistory = record.history.filter((entry) => {
        const t = Date.parse(entry.date);
        if (Number.isNaN(t)) return true; // if date is bad, keep it
        return t >= cutoff;
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

// Prune once on startup
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

  // Normal case: member has officer role
  if (member.roles && member.roles.cache) {
    return member.roles.cache.has(OFFICER_ROLE_ID);
  }

  return false;
}

// ====== SLASH COMMANDS ======
const strikeCommand = new SlashCommandBuilder()
  .setName("strike")
  .setDescription("Manage guild strikes")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a strike to a member.")
      .addUserOption((option) =>
        option
          .setName("member")
          .setDescription("Guild member to strike")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Game mode for this strike")
          .setRequired(true)
          .addChoices(
            { name: "Territory Battle", value: "tb" },
            { name: "Territory War", value: "tw" },
            { name: "Raid", value: "raid" }
          )
      )
      .addStringOption((option) =>
        option
          .setName("reason")
          .setDescription("Reason for the strike")
          .setRequired(true)
          .addChoices(
            { name: "TW - no offense", value: "TW - no offense" },
            { name: "TW - no defense", value: "TW - no defense" },
            { name: "TB - no deploy", value: "TB - no deploy" },
            { name: "Raid - zero damage", value: "Raid - zero damage" },
            { name: "Other", value: "Other" }
          )
      )
      .addStringOption((option) =>
        option
          .setName("note")
          .setDescription("Optional extra details")
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("member")
      .setDescription("Check strikes for a member.")
      .addUserOption((option) =>
        option
          .setName("member")
          .setDescription("Member to check")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription("Reset strikes for a member.")
      .addUserOption((option) =>
        option
          .setName("member")
          .setDescription("Member to reset")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("resetall")
      .setDescription("Reset ALL strikes in this guild (officers only).")
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

// ====== EVENT HANDLERS ======
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "strike") return;

  // keep data fresh
  pruneOldStrikes();

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (!guildId) {
    return interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
  }

  if (!strikesData[guildId]) {
    strikesData[guildId] = {};
  }

  try {
    if (sub === "add") {
      if (!isOfficer(interaction)) {
        await interaction.reply({
          content: "You don’t have permission to add strikes.",
          ephemeral: true,
        });
        return;
      }

      const user = interaction.options.getUser("member", true);
      const mode = interaction.options.getString("mode", true);
      const reason = interaction.options.getString("reason", true);
      const extra = interaction.options.getString("note") || "";
      const note = extra ? `${reason} - ${extra}` : reason;

      if (!strikesData[guildId][user.id]) {
        strikesData[guildId][user.id] = { total: 0, history: [] };
      }

      const entry = strikesData[guildId][user.id];
      entry.total += 1;
      entry.history.push({
        date: new Date().toISOString(),
        mode,
        note,
        by: interaction.user.id,
      });

      saveStrikes(strikesData);

      // Pretty mode name
      const modePretty =
        mode === "tb"
          ? "Territory Battle"
          : mode === "tw"
          ? "Territory War"
          : mode === "raid"
          ? "Raid"
          : mode;

      // If this member just hit 5 strikes, notify officers
      if (entry.total === 5 && OFFICER_REVIEW_CHANNEL_ID) {
        try {
          const reviewChannel = await interaction.client.channels.fetch(
            OFFICER_REVIEW_CHANNEL_ID
          );
          if (reviewChannel) {
            await reviewChannel.send(
              `⚠️ ${user} has reached **5 strikes**. Time to review them for the Rancor.`
            );
          }
        } catch (err) {
          console.error("Failed to send 5-strike alert:", err);
        }
      }

      await interaction.reply(
        `⚠️ Strike added for ${user} (${modePretty}). Total strikes (last ${STRIKE_EXPIRY_DAYS} days): **${entry.total}**.`
      );
    } else if (sub === "member") {
      const user = interaction.options.getUser("member", true);
      const record = strikesData[guildId][user.id];

      if (!record || !record.total) {
        await interaction.reply(
          `${user} currently has **0** strikes in the last ${STRIKE_EXPIRY_DAYS} days.`
        );
      } else {
        await interaction.reply(
          `${user} currently has **${record.total}** strike${
            record.total === 1 ? "" : "s"
          } in the last ${STRIKE_EXPIRY_DAYS} days.`
        );
      }
    } else if (sub === "reset") {
      if (!isOfficer(interaction)) {
        await interaction.reply({
          content: "You don’t have permission to reset strikes.",
          ephemeral: true,
        });
        return;
      }

      const user = interaction.options.getUser("member", true);
      if (strikesData[guildId]) {
        delete strikesData[guildId][user.id];
        saveStrikes(strikesData);
      }

      await interaction.reply(
        `✅ Strikes reset for ${user}. They now have **0** strikes.`
      );
    } else if (sub === "resetall") {
      if (!isOfficer(interaction)) {
        await interaction.reply({
          content: "You don’t have permission to reset all strikes.",
          ephemeral: true,
        });
        return;
      }

      strikesData[guildId] = {};
      saveStrikes(strikesData);

      await interaction.reply(
        `✅ All strikes for this guild have been reset.`
      );
    }
  } catch (err) {
    console.error("Error handling /strike command:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content:
          "❌ Something went wrong while handling this command. Try again in a moment.",
        ephemeral: true,
      });
    }
  }
});

// ====== LOGIN ======
client.login(BOT_TOKEN);
