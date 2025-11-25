// Rancor Menu — SWGOH Strike Tracking Bot
// Tracks guild member strikes for TB, TW, and Raids using slash commands.

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

/**
 *  >>>>> EDIT THESE FOUR VALUES BEFORE RUNNING <<<<<
 *
 */ 
const BOT_TOKEN = process.env.BOT_TOKEN;      
const CLIENT_ID = "1442232219652325436";
const GUILD_ID = "544692940644024336";
const OFFICER_ROLE_ID = "1350503552178589797";

const STRIKES_FILE = path.join(__dirname, "strikes.json");

function loadStrikes() {
  try {
    const raw = fs.readFileSync(STRIKES_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveStrikes(data) {
  fs.writeFileSync(STRIKES_FILE, JSON.stringify(data, null, 2), "utf8");
}

let strikesData = loadStrikes();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("strike")
    .setDescription("Rancor Menu strike commands")
    .addSubcommand(sub =>
      sub
        .setName("add")
        .setDescription("Add a strike to a member")
        .addUserOption(o =>
          o.setName("member")
            .setDescription("Member to strike")
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName("mode")
            .setDescription("Where they failed")
            .setRequired(true)
            .addChoices(
              { name: "Territory Battle", value: "tb" },
              { name: "Territory War", value: "tw" },
              { name: "Raid", value: "raid" }
            )
        )
        .addStringOption(o =>
          o.setName("note")
            .setDescription("Reason (e.g. no deploy, no offense, 0 score)")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("member")
        .setDescription("Show strikes for a member")
        .addUserOption(o =>
          o.setName("member")
            .setDescription("Member to view (defaults to you)")
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("reset")
        .setDescription("Reset strikes for one member (officers only)")
        .addUserOption(o =>
          o.setName("member")
            .setDescription("Member to reset")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("resetall")
        .setDescription("Reset ALL strikes in this guild (officers only, dangerous!)")
    )
    .toJSON()
];

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  try {
    console.log("🔁 Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered for guild.");
  } catch (err) {
    console.error("Error registering commands:", err);
  }
});

function isOfficer(interaction) {
  const member = interaction.member;
  if (!member) return false;
  if (interaction.guild.ownerId === member.user.id) return true;
  return member.roles.cache.has(OFFICER_ROLE_ID);
}

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "strike") return;

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (!strikesData[guildId]) strikesData[guildId] = {};

  if (sub === "add") {
    if (!isOfficer(interaction)) {
      await interaction.reply({ content: "You don’t have permission to add strikes.", ephemeral: true });
      return;
    }

    const user = interaction.options.getUser("member", true);
    const mode = interaction.options.getString("mode", true);
    const note = interaction.options.getString("note", true);

    if (!strikesData[guildId][user.id]) {
      strikesData[guildId][user.id] = { total: 0, history: [] };
    }

    const entry = strikesData[guildId][user.id];

    entry.total += 1;
    entry.history.push({
      date: new Date().toISOString(),
      mode,
      note,
      by: interaction.user.id
    });

    saveStrikes(strikesData);

    const modePretty =
      mode === "tb" ? "Territory Battle" :
      mode === "tw" ? "Territory War" :
      "Raid";

    await interaction.reply({
      content:
        `⚠️ Strike added for <@${user.id}>\n` +
        `• Mode: **${modePretty}**\n` +
        `• Reason: ${note}\n` +
        `• Total strikes: **${entry.total}**`
    });
  }

  if (sub === "member") {
    const user = interaction.options.getUser("member") || interaction.user;

    const entry = strikesData[guildId][user.id];
    if (!entry || entry.total === 0) {
      await interaction.reply({
        content: `📋 <@${user.id}> currently has **0 strikes**.`,
        ephemeral: false
      });
      return;
    }

    let tb = 0, tw = 0, raid = 0;
    for (const h of entry.history) {
      if (h.mode === "tb") tb++;
      else if (h.mode === "tw") tw++;
      else if (h.mode === "raid") raid++;
    }

    const historyLines = entry.history
      .slice(-5)
      .map(h => {
        const m =
          h.mode === "tb" ? "TB" :
          h.mode === "tw" ? "TW" :
          "Raid";
        const date = new Date(h.date).toLocaleString();
        return `• [${m}] ${h.note} – <@${h.by}> (${date})`;
      })
      .join("\n");

    await interaction.reply({
      content:
        `📋 Strikes for <@${user.id}>:\n` +
        `• Total: **${entry.total}** (TB: ${tb}, TW: ${tw}, Raid: ${raid})\n\n` +
        `Recent:\n${historyLines}`
    });
  }

  if (sub === "reset") {
    if (!isOfficer(interaction)) {
      await interaction.reply({ content: "You don’t have permission to reset strikes.", ephemeral: true });
      return;
    }

    const user = interaction.options.getUser("member", true);

    const entry = strikesData[guildId][user.id];
    const oldTotal = entry ? entry.total : 0;

    strikesData[guildId][user.id] = { total: 0, history: [] };
    saveStrikes(strikesData);

    await interaction.reply({
      content:
        `✅ Strikes reset for <@${user.id}>.\n` +
        `Old total: **${oldTotal}** → New total: **0**`
    });
  }

  if (sub === "resetall") {
    if (!isOfficer(interaction)) {
      await interaction.reply({ content: "You don’t have permission to reset all strikes.", ephemeral: true });
      return;
    }

    const guildStrikes = strikesData[guildId] || {};
    let membersWithStrikes = Object.values(guildStrikes).filter(e => e.total > 0).length;

    strikesData[guildId] = {};
    saveStrikes(strikesData);

    await interaction.reply({
      content:
        `✅ All strikes reset for this guild.\n` +
        `Members affected: **${membersWithStrikes}**`
    });
  }
});

client.login(BOT_TOKEN);
