require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

// --- Logging helper ---
function log(tag, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}]`, ...args);
}

// --- Persistent config ---
const CONFIG_DIR = process.env.DATA_DIR || "/data";
const CONFIG_PATH = path.join(CONFIG_DIR, "guildConfig.json");

// guildId -> { activeChannel, memoryChannel }
const guildConfig = new Map();

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      for (const [guildId, cfg] of Object.entries(data)) {
        guildConfig.set(guildId, cfg);
      }
      log("CONFIG", `Loaded config for ${guildConfig.size} guild(s) from ${CONFIG_PATH}`);
    } else {
      log("CONFIG", "No saved config found, starting fresh");
    }
  } catch (err) {
    log("ERROR", `Failed to load config from ${CONFIG_PATH}:`, err.message);
  }
}

function saveConfig() {
  try {
    const data = Object.fromEntries(guildConfig);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
    log("CONFIG", `Saved config for ${guildConfig.size} guild(s) to ${CONFIG_PATH}`);
  } catch (err) {
    log("ERROR", `Failed to save config to ${CONFIG_PATH}:`, err.message);
  }
}

// --- OpenCode Zen client (OpenAI-compatible) ---
const ai = new OpenAI({
  apiKey: process.env.OPENCODE_ZEN_API_KEY,
  baseURL: "https://opencode.ai/zen/v1",
});

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// =========================================================================
// Slash command definitions
// =========================================================================
const commands = [
  new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Set the channel BenBot is active in")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("The channel BenBot should be active in")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("setmemory")
    .setDescription("Set the memory channel BenBot uses to store/read memories")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("The channel to use as BenBot memory")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("benchannel")
    .setDescription("Show the current active and memory channels"),
];

// =========================================================================
// Register slash commands on startup
// =========================================================================
async function registerCommands() {
  try {
    log("INIT", "Registering slash commands...");
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    const result = await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
      body: commands.map((c) => c.toJSON()),
    });
    log("INIT", `Registered ${result.length} slash commands successfully.`);
  } catch (err) {
    log("ERROR", "Failed to register slash commands:", err.message);
    console.error(err);
  }
}

// =========================================================================
// Helpers
// =========================================================================

/** Fetch all messages from the memory channel (up to 100 most recent). */
async function fetchMemories(guild) {
  const cfg = guildConfig.get(guild.id);
  if (!cfg?.memoryChannel) {
    log("MEMORY", `No memory channel set for guild ${guild.name} (${guild.id})`);
    return [];
  }

  const channel = await guild.channels.fetch(cfg.memoryChannel).catch((err) => {
    log("ERROR", `Failed to fetch memory channel ${cfg.memoryChannel}:`, err.message);
    return null;
  });
  if (!channel) return [];

  const messages = await channel.messages.fetch({ limit: 100 });
  const memories = [...messages.values()]
    .reverse()
    .map((m) => m.content)
    .filter(Boolean);

  log("MEMORY", `Fetched ${memories.length} memories from #${channel.name}`);
  return memories;
}

/** Save a memory to the memory channel. */
async function saveMemory(guild, text) {
  const cfg = guildConfig.get(guild.id);
  if (!cfg?.memoryChannel) {
    log("MEMORY", "Tried to save memory but no memory channel set");
    return;
  }

  const channel = await guild.channels.fetch(cfg.memoryChannel).catch((err) => {
    log("ERROR", `Failed to fetch memory channel for saving:`, err.message);
    return null;
  });
  if (!channel) return;

  log("MEMORY", `Saving memory to #${channel.name}: "${text.substring(0, 80)}..."`);

  const chunks = text.match(/[\s\S]{1,2000}/g) || [];
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

/** Build the system prompt including memories. */
function buildSystemPrompt(memories) {
  const botName = process.env.BOT_NAME || "BenBot";
  const personality = process.env.BOT_PERSONALITY || "a chill and helpful Discord bot. You talk naturally, like a real person in a Discord server — not overly formal, not robotic. Keep responses concise unless asked for detail.";

  let sys = `You are ${botName}, ${personality} You can use markdown formatting that Discord supports.

You have a memory channel where important information is stored. Here are your current memories:
`;
  if (memories.length > 0) {
    sys += "\n--- MEMORIES ---\n";
    sys += memories.join("\n---\n");
    sys += "\n--- END MEMORIES ---\n";
  } else {
    sys += "\n(No memories stored yet.)\n";
  }

  sys += `\nYou should actively remember things from conversations. Whenever you pick up on ANY of the following, save it as a memory:
- Someone's name, nickname, or what they like to be called
- Opinions, preferences, or interests (games, music, food, hobbies, etc.)
- Facts about people (age, job, school, timezone, location, pets, etc.)
- Inside jokes, recurring topics, or funny moments
- Relationships between people in the server
- Server-specific context (what the server is about, ongoing projects, events)
- Anything someone explicitly asks you to remember

Include memories at the END of your response in this exact format (you can include multiple):
[MEMORY] the thing you want to remember [/MEMORY]

Be generous with saving memories — it's better to remember too much than too little. These memories help you be a better friend to everyone in the server.`;

  return sys;
}

/** Collect recent conversation context from the channel. */
async function getConversationContext(message, limit = 15) {
  const messages = await message.channel.messages.fetch({ limit, before: message.id });
  const context = [...messages.values()].reverse();

  const formatted = [];
  for (const msg of context) {
    if (msg.author.bot && msg.author.id === client.user.id) {
      formatted.push({ role: "assistant", content: msg.content });
    } else if (!msg.author.bot) {
      formatted.push({
        role: "user",
        content: `${msg.author.displayName}: ${msg.content}`,
      });
    }
  }
  log("CONTEXT", `Built ${formatted.length} context messages from channel history`);
  return formatted;
}

/** Decide whether BenBot should respond to a message. */
function shouldRespond(message) {
  // Always respond if mentioned
  if (message.mentions.has(client.user)) {
    log("DECIDE", `Responding — bot was mentioned by ${message.author.displayName}`);
    return true;
  }

  // Always respond if replying to BenBot
  if (
    message.reference?.messageId &&
    message.channel.messages.cache.get(message.reference.messageId)?.author?.id ===
      client.user.id
  ) {
    log("DECIDE", `Responding — reply to BenBot from ${message.author.displayName}`);
    return true;
  }

  // Otherwise, respond ~30% of the time randomly
  const roll = Math.random();
  const responding = roll < 0.3;
  log("DECIDE", `Random roll: ${roll.toFixed(3)} — ${responding ? "responding" : "skipping"} (threshold 0.3)`);
  return responding;
}

/** Send a message to the AI and return the response. */
async function getAIResponse(systemPrompt, conversationMessages, currentMessage) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationMessages,
    {
      role: "user",
      content: `${currentMessage.author.displayName}: ${currentMessage.content}`,
    },
  ];

  log("AI", `Sending ${messages.length} messages to big-pickle (system + ${messages.length - 1} chat)`);
  log("AI", `Current message from ${currentMessage.author.displayName}: "${currentMessage.content.substring(0, 100)}"`);

  const startTime = Date.now();
  const response = await ai.chat.completions.create({
    model: "big-pickle",
    messages,
    max_tokens: 1024,
  });
  const elapsed = Date.now() - startTime;

  const reply = response.choices[0]?.message?.content || "";
  log("AI", `Response received in ${elapsed}ms (${reply.length} chars)`);
  log("AI", `Usage: ${JSON.stringify(response.usage || "n/a")}`);

  if (!reply) {
    log("WARN", "AI returned empty response. Full response object:", JSON.stringify(response, null, 2));
  }

  return reply;
}

// =========================================================================
// Event: ready
// =========================================================================
client.once("ready", async () => {
  log("INIT", `BenBot is online as ${client.user.tag} (${client.user.id})`);
  log("INIT", `In ${client.guilds.cache.size} guild(s)`);
  client.guilds.cache.forEach((g) => log("INIT", `  - ${g.name} (${g.id})`));
  await registerCommands();
});

// =========================================================================
// Event: slash commands
// =========================================================================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  log("CMD", `/${interaction.commandName} by ${interaction.user.tag} in ${interaction.guild?.name}`);

  const guildId = interaction.guildId;
  if (!guildConfig.has(guildId)) guildConfig.set(guildId, {});
  const cfg = guildConfig.get(guildId);

  try {
    if (interaction.commandName === "setchannel") {
      const channel = interaction.options.getChannel("channel");
      cfg.activeChannel = channel.id;
      saveConfig();
      log("CMD", `Active channel set to #${channel.name} (${channel.id}) in ${interaction.guild.name}`);
      await interaction.reply(`Active channel set to <#${channel.id}>`);
    }

    if (interaction.commandName === "setmemory") {
      const channel = interaction.options.getChannel("channel");
      cfg.memoryChannel = channel.id;
      saveConfig();
      log("CMD", `Memory channel set to #${channel.name} (${channel.id}) in ${interaction.guild.name}`);
      await interaction.reply(`Memory channel set to <#${channel.id}>`);
    }

    if (interaction.commandName === "benchannel") {
      const active = cfg.activeChannel ? `<#${cfg.activeChannel}>` : "Not set";
      const memory = cfg.memoryChannel ? `<#${cfg.memoryChannel}>` : "Not set";
      log("CMD", `Config check — active: ${cfg.activeChannel || "none"}, memory: ${cfg.memoryChannel || "none"}`);
      await interaction.reply(`**Active channel:** ${active}\n**Memory channel:** ${memory}`);
    }
  } catch (err) {
    log("ERROR", `Slash command /${interaction.commandName} failed:`, err.message);
    console.error(err);
  }
});

// =========================================================================
// Event: message handling
// =========================================================================
client.on("messageCreate", async (message) => {
  // Ignore bots and DMs
  if (message.author.bot || !message.guild) return;

  const cfg = guildConfig.get(message.guild.id);
  if (!cfg?.activeChannel) return;

  // Only respond in the active channel
  if (message.channel.id !== cfg.activeChannel) return;

  log("MSG", `[#${message.channel.name}] ${message.author.displayName}: "${message.content.substring(0, 120)}"`);

  // Check if we need to fetch the referenced message for reply detection
  if (message.reference?.messageId && !message.channel.messages.cache.has(message.reference.messageId)) {
    log("MSG", `Fetching referenced message ${message.reference.messageId} for reply detection`);
    await message.channel.messages.fetch(message.reference.messageId).catch((err) => {
      log("WARN", `Could not fetch referenced message: ${err.message}`);
    });
  }

  if (!shouldRespond(message)) return;

  try {
    log("FLOW", "--- Starting response pipeline ---");

    log("FLOW", "Step 1: Sending typing indicator");
    await message.channel.sendTyping();

    log("FLOW", "Step 2: Fetching memories");
    const memories = await fetchMemories(message.guild);

    log("FLOW", "Step 3: Building system prompt");
    const systemPrompt = buildSystemPrompt(memories);

    log("FLOW", "Step 4: Getting conversation context");
    const context = await getConversationContext(message);

    log("FLOW", "Step 5: Calling AI");
    const reply = await getAIResponse(systemPrompt, context, message);

    if (!reply) {
      log("FLOW", "AI returned empty reply, aborting");
      return;
    }

    // Extract and save any memories
    const memoryRegex = /\[MEMORY\]([\s\S]*?)\[\/MEMORY\]/g;
    let match;
    let memoryCount = 0;
    while ((match = memoryRegex.exec(reply)) !== null) {
      memoryCount++;
      await saveMemory(message.guild, match[1].trim());
    }
    if (memoryCount > 0) {
      log("FLOW", `Step 6: Saved ${memoryCount} new memor${memoryCount === 1 ? "y" : "ies"}`);
    }

    // Remove memory tags from the visible reply
    const cleanReply = reply.replace(/\[MEMORY\][\s\S]*?\[\/MEMORY\]/g, "").trim();

    if (!cleanReply) {
      log("FLOW", "Reply was only memory tags, nothing to send");
      return;
    }

    log("FLOW", `Step 7: Sending reply (${cleanReply.length} chars)`);

    // Discord 2000 char limit
    const chunks = cleanReply.match(/[\s\S]{1,2000}/g) || [];
    for (let i = 0; i < chunks.length; i++) {
      await message.reply({ content: chunks[i], allowedMentions: { repliedUser: false } });
      log("FLOW", `Sent chunk ${i + 1}/${chunks.length}`);
    }

    log("FLOW", "--- Response pipeline complete ---");
  } catch (err) {
    log("ERROR", `Failed to respond to message from ${message.author.displayName}:`, err.message);
    if (err.status) log("ERROR", `HTTP status: ${err.status}`);
    if (err.response?.data) log("ERROR", `API error data:`, JSON.stringify(err.response.data));
    console.error(err);
  }
});

// =========================================================================
// Error handling
// =========================================================================
client.on("error", (err) => {
  log("ERROR", "Discord client error:", err.message);
  console.error(err);
});

client.on("warn", (msg) => {
  log("WARN", "Discord client warning:", msg);
});

process.on("unhandledRejection", (err) => {
  log("FATAL", "Unhandled promise rejection:", err);
  console.error(err);
});

// =========================================================================
// Start
// =========================================================================
log("INIT", "Starting BenBot...");
log("INIT", `Discord token: ${process.env.DISCORD_TOKEN ? "set (" + process.env.DISCORD_TOKEN.substring(0, 10) + "...)" : "MISSING"}`);
log("INIT", `Client ID: ${process.env.DISCORD_CLIENT_ID || "MISSING"}`);
log("INIT", `OpenCode Zen key: ${process.env.OPENCODE_ZEN_API_KEY ? "set (" + process.env.OPENCODE_ZEN_API_KEY.substring(0, 8) + "...)" : "MISSING"}`);

loadConfig();
client.login(process.env.DISCORD_TOKEN);
