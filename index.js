// GuildStrikeBot — FINAL VERIFIED index.js
// discord.js v14 — Railway compatible
// -------------------------------------
//
// Commands
// Officers:
//   /strike add member:<user> mode:<tw|tb|raid> note:<optional>
//   /strike reset member:<user>
//   /strike resetall confirm:YES
//   /strikes all
//
// Everyone:
//   /strikes me
//
// Rules:
// - Rolling expiry: 30 days per strike
// - All strike activity logs to STRIKE_LOG_CHANNEL_ID
// - At 5 active strikes, ping OFFICER_REVIEW_CHANNEL_ID + officer role
// - BOT_TOKEN comes from Railway env var

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing in Railway variables");
  process.exit(1);
}

const CLIENT_ID = "1442232219652325436";
const GUILD_ID = "544629940640424336";

const OFFICER_ROLE_ID = "1350503552178589797";

const STRIKE_LOG_CHANNEL_ID = "1451024629333495919";
const OFFICER_REVIEW_CHANNEL_ID = "1451024629333495919";

const STRIKE_EXPIRY_DAYS = 30;
const STRIKE_THRESHOLD = 5;

const STRIKES_FILE = path.join(__dirname, "strikes.json");
// ==================================================

// ---------- Utilities ----------
const msDays = (d) => d * 24 * 60 * 60 * 1000;
const isActive = (s) => Date.now() - Date.parse(s.date) <= msDays(STRIKE_EXPIRY_DAYS);

function load() {
  if (!fs.existsSync(STRIKES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STRIKES_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(STRIKES_FILE, JSON.stringify(data, null, 2));
}

function bucket(data) {
  if (!data[GUILD_ID]) data[GUILD_ID] = {};
  return data[GUILD_ID];
}

function isOfficer(interaction) {
  return interaction.member.roles.cache.has(OFFICER_ROLE_ID);
}

async function send(client, channelId, msg) {
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch?.isTextBased()) await ch.send(msg);
  } catch (e) {
    console.error("Send failed:", e.message);
  }
}

// ---------- Slash Commands ----------
const strikeCmd = new SlashCommandBuilder()
  .setName("strike")
  .setDescription("Officer strike commands")
  .addSubcommand((s) =>
    s.setName("add")
      .setDescription("Add a strike")
      .addUserOption(o => o.setName("member").setRequired(true))
      .addStringOption(o =>
        o.setName("mode").setRequired(true).addChoices(
          { name: "TW", value: "tw" },
          { name: "TB", value: "tb" },
          { name: "Raid", value: "raid" },
        )
      )
      .addStringOption(o => o.setName("note").setRequired(false))
  )
  .addSubcommand((s) =>
    s.setName("reset")
      .setDescription("Reset strikes for a member")
      .addUserOption(o => o.setName("member").setRequired(true))
  )
  .addSubcommand((s) =>
    s.setName("resetall")
      .setDescription("Reset ALL strikes")
      .addStringOption(o =>
        o.setName("confirm").setRequired(true).addChoices({ name: "YES", value: "YES" })
      )
  );

const strikesCmd = new SlashCommandBuilder()
  .setName("strikes")
  .setDescription("View strikes")
  .addSubcommand(s => s.setName("me").setDescription("View your strikes"))
  .addSubcommand(s => s.setName("all").setDescription("View all strikes (officers)"));

async function register() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: [strikeCmd.toJSON(), strikesCmd.toJSON()] }
  );
}

// ---------- Client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await register();
  await send(client, STRIKE_LOG_CHANNEL_ID, "✅ Strike bot online.");
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.guildId !== GUILD_ID) {
    return i.reply({ content: "This bot is not configured for this server.", ephemeral: true });
  }

  await i.deferReply({ ephemeral: true });
  const data = load();
  const g = bucket(data);

  // -------- /strike --------
  if (i.commandName === "strike") {
    if (!isOfficer(i)) return i.editReply("Officers only.");

    const sub = i.options.getSubcommand();

    if (sub === "add") {
      const user = i.options.getUser("member");
      const mode = i.options.getString("mode");
      const note = i.options.getString("note");

      if (!g[user.id]) g[user.id] = [];
      g[user.id].push({ date: new Date().toISOString(), mode, note });
      g[user.id] = g[user.id].filter(isActive);

      save(data);

      await send(
        client,
        STRIKE_LOG_CHANNEL_ID,
        `🟥 **Strike Added** — ${user}\nMode: **${mode.toUpperCase()}**${note ? `\nNote: ${note}` : ""}\nTotal: **${g[user.id].length}**`
      );

      if (g[user.id].length === STRIKE_THRESHOLD) {
        await send(
          client,
          OFFICER_REVIEW_CHANNEL_ID,
          `🚨 <@&${OFFICER_ROLE_ID}> **Review Needed**\n${user} reached **${STRIKE_THRESHOLD} strikes**`
        );
      }

      return i.editReply(`Strike added. Total: **${g[user.id].length}**`);
    }

    if (sub === "reset") {
      const user = i.options.getUser("member");
      delete g[user.id];
      save(data);
      await send(client, STRIKE_LOG_CHANNEL_ID, `🟩 Strikes reset for ${user}`);
      return i.editReply("Strikes reset.");
    }

    if (sub === "resetall") {
      data[GUILD_ID] = {};
      save(data);
      await send(client, STRIKE_LOG_CHANNEL_ID, "🟧 ALL strikes reset.");
      return i.editReply("All strikes reset.");
    }
  }

  // -------- /strikes --------
  if (i.commandName === "strikes") {
    const sub = i.options.getSubcommand();

    if (sub === "me") {
      const list = (g[i.user.id] || []).filter(isActive);
      if (!list.length) return i.editReply("You have **0 active strikes**.");
      return i.editReply(
        `Your active strikes (**${list.length}**):\n` +
        list.map(s => `• ${s.mode.toUpperCase()} — ${new Date(s.date).toLocaleDateString()}`).join("\n")
      );
    }

    if (sub === "all") {
      if (!isOfficer(i)) return i.editReply("Officers only.");

      const rows = Object.entries(g)
        .map(([id, list]) => ({ id, total: list.filter(isActive).length }))
        .filter(r => r.total > 0)
        .sort((a, b) => b.total - a.total);

      if (!rows.length) {
        await send(client, STRIKE_LOG_CHANNEL_ID, "📋 No active strikes.");
        return i.editReply("No active strikes.");
      }

      await send(
        client,
        STRIKE_LOG_CHANNEL_ID,
        "📋 **Active Strikes**\n" +
        rows.map(r => `• <@${r.id}> — **${r.total}**`).join("\n")
      );

      return i.editReply("Posted strike list.");
    }
  }
});

client.login(BOT_TOKEN);
