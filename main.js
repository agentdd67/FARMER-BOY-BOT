const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { BotState } = require('./state');
const { BrainController } = require('./brain');
const { wait } = require('./actions/helpers');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function createLogger() {
  const stamp = () => new Date().toISOString();
  return {
    info(message) {
      console.log(`[${stamp()}] [INFO] ${message}`);
    },
    warn(message) {
      console.warn(`[${stamp()}] [WARN] ${message}`);
    },
    error(message) {
      console.error(`[${stamp()}] [ERROR] ${message}`);
    }
  };
}

const logger = createLogger();
let reconnectTimer = null;
let activeBot = null;

function normalizeCommand(message) {
  const prefix = config.bot.commandPrefix || '!';
  if (!message.startsWith(prefix)) return null;

  const raw = message.slice(prefix.length).trim();
  if (!raw) return null;

  const parts = raw.split(/\s+/);
  const verb = parts[0].toLowerCase();
  const target = parts[1];

  const aliases = {
    follow: 'follow_player',
    followme: 'follow_player',
    come: 'follow_player',
    stop: 'idle',
    stopfollow: 'idle',
    stopfollowing: 'idle',
    unfollow: 'idle',
    farm: 'farm',
    store: 'store',
    trade: 'trade',
    explore: 'explore',
    idle: 'idle'
  };

  const action = aliases[verb] || verb;
  const allowed = new Set(['farm', 'store', 'trade', 'explore', 'idle', 'follow_player']);
  if (!allowed.has(action)) return null;

  return {
    action,
    targetPlayer: action === 'follow_player' ? (!target || target.toLowerCase() === 'me' ? null : target) : null,
    defaultToSender: action === 'follow_player'
  };
}

function configureMovements(bot) {
  const movements = new Movements(bot, bot.registry);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowFreeMotion = false;
  movements.scafoldingBlocks = [];
  bot.pathfinder.setMovements(movements);
}

function wireCommandListeners(bot, state, brain) {
  const botNamePattern = new RegExp(`^(?:hey\s+)?${bot.username}(?:[,:!\-\s]+)?(.*)$`, 'i');

  const handleIncomingMessage = (username, message) => {
    if (username === bot.username) return;

    const prefix = config.bot.commandPrefix || '!';
    const trimmed = message.trim();
    if (trimmed.toLowerCase().startsWith(`${prefix}ask `)) {
      const prompt = trimmed.slice((prefix + 'ask ').length).trim();
      if (!prompt) return;

      brain.askChat(prompt, { username })
        .then(reply => {
          if (reply) {
            logger.info(`AI reply to ${username}: ${reply}`);
            bot.chat(reply.slice(0, 240));
          }
        })
        .catch(error => logger.error(`AI chat failed: ${error.message}`));
      return;
    }

    const mentionMatch = trimmed.match(botNamePattern);
    if (mentionMatch) {
      const payload = mentionMatch[1].trim();
      if (!payload) {
        bot.chat(`Yes ${username}?`);
        return;
      }

      if (/^(stop|stop following|stop following me|unfollow|cancel follow)$/i.test(payload)) {
        state.setCommandOverride({
          action: 'idle',
          targetPlayer: null,
          sourcePlayer: username,
          rawMessage: message,
          viaMention: true,
          stopFollowing: true
        });
        brain.requestAbort(`stop-follow command from ${username}`);
        logger.info(`Stop-follow command received from ${username}`);
        return;
      }

      brain.resolveDirectedTask(payload, { username })
        .then(result => {
          if (!result) return;

          if (result.type === 'chat' && result.text) {
            logger.info(`AI mention reply to ${username}: ${result.text}`);
            bot.chat(result.text.slice(0, 240));
            return;
          }

          if (result.type === 'action') {
            state.setCommandOverride({
              action: result.action,
              targetPlayer: result.targetPlayer || username,
              sourcePlayer: username,
              rawMessage: message,
              viaMention: true
            });
            brain.requestAbort(`mention task from ${username}`);
            logger.info(`Mention command received from ${username}: ${result.action}`);
          }
        })
        .catch(error => logger.error(`Mention task failed: ${error.message}`));
      return;
    }

    const command = normalizeCommand(message);
    if (!command) return;

    if (command.action === 'follow_player' && !command.targetPlayer) {
      command.targetPlayer = username;
    }

    state.setCommandOverride({
      ...command,
      sourcePlayer: username,
      rawMessage: message
    });
    brain.requestAbort(`player command from ${username}`);
    logger.info(`Command received from ${username}: ${command.action}`);
  };

  bot.on('chat', (username, message) => {
    handleIncomingMessage(username, message);
  });
}

async function brainLoop(brain, state, bot) {
  let running = true;
  bot.once('end', () => {
    running = false;
  });

  while (running) {
    if (!bot.entity) {
      break;
    }
    try {
      await brain.tick();
    } catch (error) {
      logger.error(`Brain loop error: ${error.message}`);
    }

    await wait(1000);
  }
}

function startBot() {
  const server = config.server;
  logger.info(`Connecting to ${server.host}:${server.port} as ${server.username}`);

  const bot = mineflayer.createBot({
    host: server.host,
    port: server.port,
    username: server.username,
    password: server.password || undefined,
    auth: server.auth || 'offline',
    version: server.version || false
  });

  activeBot = bot;
  bot.loadPlugin(pathfinder);
  bot.logger = logger;

  const state = new BotState(config);
  const brain = new BrainController(bot, state, config, logger);
  state.attach(bot);
  wireCommandListeners(bot, state, brain);

  bot.once('spawn', () => {
    logger.info('Bot spawned');
    configureMovements(bot);
    brainLoop(brain, state, bot).catch(error => logger.error(`Brain loop stopped: ${error.message}`));
  });

  bot.on('end', () => {
    logger.warn('Disconnected from server');
    scheduleReconnect();
  });

  bot.on('kicked', reason => {
    logger.warn(`Kicked from server: ${reason}`);
  });

  bot.on('error', error => {
    logger.error(`Bot error: ${error.message}`);
  });

  return bot;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const reconnectDelayMs = config.bot.reconnectDelayMs || 10000;
  logger.info(`Reconnecting in ${Math.round(reconnectDelayMs / 1000)} seconds`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try {
      if (activeBot && activeBot.quit) {
        activeBot.quit('reconnect');
      }
    } catch {
      // ignore quit errors
    }
    startBot();
  }, reconnectDelayMs);
}

process.on('SIGINT', () => {
  logger.warn('Shutting down bot');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (activeBot) {
    try {
      activeBot.quit('shutdown');
    } catch {
      // ignore
    }
  }
  process.exit(0);
});

process.on('uncaughtException', error => {
  logger.error(`Uncaught exception: ${error.message}`);
});

startBot();
