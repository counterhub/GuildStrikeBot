# Rancor Menu – SWGOH Strike Tracking Bot

Rancor Menu is a simple Discord bot for SWGOH guilds that tracks **strikes** for:

- Missing **Territory Battle** deploys (TB)
- Missing **Territory War** offense (TW)
- **0 score** in guild raids

Officers can add, view, and reset strikes entirely through **slash commands** in Discord.

---

## Features

- `/strike add` – add a strike to a member with mode (TB/TW/Raid) and a note  
- `/strike member` – view total strikes and recent history for a member  
- `/strike reset` – reset a single member’s strikes (officers only)  
- `/strike resetall` – reset all strikes in the guild (officers only)

Strikes are stored locally in `strikes.json` as a simple JSON object.

---

## Setup

1. **Create a Discord application & bot**
   - Go to the Discord Developer Portal
   - Create an application (name it `Rancor Menu` or whatever you like)
   - On the **Bot** tab, click **Add Bot**
   - Turn on:
     - **SERVER MEMBERS INTENT**
     - (Optional) Presence & Message Content intents

2. **Get your IDs**
   - **BOT_TOKEN**: from the Bot tab → Reset Token
   - **CLIENT_ID**: Application (Client) ID from General Information tab
   - **GUILD_ID**: in Discord, enable Developer Mode → right-click your server icon → *Copy ID*
   - **OFFICER_ROLE_ID**: in Server Settings → Roles → right-click your officer role → *Copy ID*

3. **Fill in `index.js`**
   At the top of `index.js`, replace the placeholders:

   ```js
   const BOT_TOKEN = "PUT_YOUR_BOT_TOKEN_HERE";
   const CLIENT_ID = "PUT_YOUR_APPLICATION_ID_HERE";
   const GUILD_ID = "PUT_YOUR_GUILD_ID_HERE";
   const OFFICER_ROLE_ID = "PUT_OFFICER_ROLE_ID_HERE";
   ```

4. **Install Node dependencies**

   ```bash
   npm install
   ```

5. **Run the bot**

   ```bash
   npm start
   ```

   You should see:

   - `✅ Logged in as Rancor Menu#1234`
   - `✅ Slash commands registered for guild.`

6. **Invite the bot to your guild**

   In the Developer Portal → **OAuth2 → URL Generator**:

   - Scopes:
     - `bot`
     - `applications.commands`
   - Bot permissions:
     - `Send Messages`
     - `Embed Links`
     - `Read Message History`
     - `Use Application Commands` / `Use Slash Commands`

   Copy the generated URL, open it in your browser, and invite the bot to your server.

---

## Using the Commands

- `/strike add member:@Player mode:tb note:"No deploy in P2"`
- `/strike add member:@Player mode:tw note:"No offense in TW"`
- `/strike add member:@Player mode:raid note:"0 damage in raid"`

- `/strike member` → shows your strikes  
- `/strike member member:@Player` → shows another member’s strikes  

- `/strike reset member:@Player` → wipes that member’s strikes  
- `/strike resetall` → wipes **all** strikes in the guild (officers only)

Only the guild owner or members with the configured **officer role** can add or reset strikes.

---

## Notes

- This is a **private guild tool** – you don’t need Terms of Service or Privacy URLs filled in.
- Keep your **bot token secret** and regenerate it if you ever think it’s leaked.
- `strikes.json` lives next to `index.js` and will grow as strikes are added.
