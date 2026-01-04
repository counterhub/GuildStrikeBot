// GuildStrikeBot – SWGOH Strike Tracking Bot
// Production version – Railway always-on
// ----------------------------------------------------
// Features:
// - /strike add (officers only)
// - /strike member
// - /strike all (only members with strikes)
// - /strike reset (officers only)
// - /strike resetall (officers only)
// - Auto-expire strikes after 30 days
// - Log ALL strike activity to STRIKE_LOG_CHANNEL_ID
// - Ping officers in OFFICER_REVIEW_CHANNEL_ID at 5 strikes
// ----------------------------------------------------

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

// IDs (as provided by you)
const CLIENT_ID = "1442232219652325436";
const GUILD_ID = "544629940640424336";
const OFFICER_ROLE_ID = "1350503552178589797";
const OFFICER_REVIEW_CHANNEL_ID = "1388904994270351520";
const STRIKE_LOG_CHANNEL_ID = "1451024629333495919";

// Strike rules
const STRIKE_EXPIRY_DAYS = 30;
const STRIKE_THRESHOLD = 5;

// Storage
const STRIKES_FILE = path.join(__dirname, "strikes.json");

// ===================== CLIENT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ===================== STORAGE =====================
function loadStrikes() {
  try {
    return JSON.parse(fs.readFileSync(STRIKES_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveStrikes(data) {
  fs.writeFileSync(STRIKES_FILE, JSON.stringify(data, null, 2));
}

function pruneExpired(strikes) {
  const cutoff = Date.now() - STRIKE_EXPIRY_DAYS * 86400000;
  for (const uid in strikes) {
    strikes[uid].history = strikes[uid].history.filter(
      (s) => new Date(s.date).getTime() >= cutoff
    );
    strikes[uid].total = strikes[uid].history.length;
    if (strikes[uid].total === 0) delete strikes[uid];
  }
}

// ===================== COMMANDS =====================
const commands = [
  new SlashCommandBuilder()
    .setName("strike")
    .setDescription("Strike management")
    .addSubcommand((s) =>
      s
        .setName("add")
        .setDescription("Add a strike (officers only)")
        .addUserOption((o) =>
          o.setName("member").setDescription("Member").setRequired(true)
        )
        .addStringOption((o) =>
          o.setName("mode").setDescription("TB / TW / Raid").setRequired(true)
        )
        .addStringOption((o) =>
          o.setName("note").setDescription("Optional note").setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("member")
        .setDescription("View strikes for a member")
        .addUserOption((o) =>
          o.setName("member").setDescription("Member").setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName("all").setDescription("List all members with strikes")
    )
    .addSubcommand((s) =>
      s
        .setName("reset")
        .setDescription("Reset strikes for a member (officers only)")
        .addUserOption((o) =>
          o.setName("member").setDescription("Member").setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("resetall")
        .setDescription("Reset ALL strikes (officers only)")
    ),
].map((c) => c.toJSON());

// ===================== REGISTER =====================
(async () => {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log("Commands registered");
})();

// ===================== HANDLER =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const sub = interaction.options.getSubcommand();
  const member = interaction.member;
  const strikes = loadStrikes();
  pruneExpired(strikes);

  const isOfficer = member.roles.cache.has(OFFICER_ROLE_ID);

  // -------- ADD --------
  if (sub === "add") {
    if (!isOfficer)
      return interaction.reply({ content: "Officers only.", ephemeral: true });

    const user = interaction.options.getUser("member");
    const mode = interaction.options.getString("mode");
    const note = interaction.options.getString("note") || "—";

    if (!strikes[user.id]) strikes[user.id] = { total: 0, history: [] };

    strikes[user.id].history.push({
      date: new Date().toISOString(),
      mode,
      note,
      by: interaction.user.id,
    });

    strikes[user.id].total = strikes[user.id].history.length;
    saveStrikes(strikes);

    // Log
    const log = await client.channels.fetch(STRIKE_LOG_CHANNEL_ID);
    log.send(
      `⚠️ **Strike Added**\nMember: ${user}\nMode: ${mode}\nNote: ${note}\nTotal: ${strikes[user.id].total}`
    );

    // Threshold ping
    if (strikes[user.id].total === STRIKE_THRESHOLD) {
      const review = await client.channels.fetch(
        OFFICER_REVIEW_CHANNEL_ID
      );
      review.send(
        `🚨 <@&${OFFICER_ROLE_ID}> **Review Required**\n${user} has reached **${STRIKE_THRESHOLD} strikes**.`
      );
    }

    return interaction.reply({
      content: `Strike added to ${user}. Total: ${strikes[user.id].total}`,
      ephemeral: true,
    });
  }

  // -------- MEMBER --------
  if (sub === "member") {
    const user = interaction.options.getUser("member");
    if (!strikes[user.id])
      return interaction.reply({
        content: `${user} has no strikes.`,
        ephemeral: true,
      });

    return interaction.reply({
      content: `${user} has **${strikes[user.id].total}** strike(s).`,
      ephemeral: true,
    });
  }

  // -------- ALL --------
  if (sub === "all") {
    const list = Object.entries(strikes)
      .map(([id, s]) => `<@${id}> — ${s.total}`)
      .join("\n");

    return interaction.reply({
      content: list || "No active strikes.",
      ephemeral: true,
    });
  }

  // -------- RESET --------
  if (sub === "reset") {
    if (!isOfficer)
      return interaction.reply({ content: "Officers only.", ephemeral: true });

    const user = interaction.options.getUser("member");
    delete strikes[user.id];
    saveStrikes(strikes);

    return interaction.reply({
      content: `Strikes reset for ${user}.`,
      ephemeral: true,
    });
  }

  // -------- RESET ALL --------
  if (sub === "resetall") {
    if (!isOfficer)
      return interaction.reply({ content: "Officers only.", ephemeral: true });

    saveStrikes({});
    return interaction.reply({
      content: "ALL strikes reset.",
      ephemeral: true,
    });
  }
});

// ===================== READY =====================
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(BOT_TOKEN);
