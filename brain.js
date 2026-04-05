const { farmCrops } = require('./actions/farming');
const { storeItems, findNearestChest } = require('./actions/storage');
const { tradeWithVillager } = require('./actions/trading');
const { exploreArea, followPlayer, idleBehavior } = require('./actions/movement');
const { normalizeAction, wait } = require('./actions/helpers');
const OpenAI = require('openai');

const ACTIONS = {
  farm: farmCrops,
  store: storeItems,
  trade: tradeWithVillager,
  explore: exploreArea,
  follow_player: followPlayer,
  idle: idleBehavior
};

class BrainController {
  constructor(bot, state, config, logger) {
    this.bot = bot;
    this.state = state;
    this.config = config;
    this.logger = logger;

    this.currentTaskPromise = null;
    this.currentTask = 'idle';
    this.taskStartedAt = 0;
    this.taskLockUntil = 0;
    this.abortRequested = false;
    this.aiCooldownUntil = 0;
    this.lastDecisionSource = 'rule';
    this.lastTaskResult = null;
    this.aiClient = null;
    this.aiClientKey = null;
  }

  getApiKey(ai = this.getAIConfig()) {
    if (ai.apiKey) {
      return ai.apiKey;
    }

    return null;
  }

  getAIConfig() {
    const provider = (this.config.ai?.provider || 'sambanova').toLowerCase();
    const apiKeyEnv = this.config.ai?.apiKeyEnv || (provider === 'sambanova' ? 'SAMBANOVA_API_KEY' : 'OPENAI_API_KEY');
    const configuredKey = this.config.ai?.apiKey ? String(this.config.ai.apiKey) : null;
    const envKey = process.env[apiKeyEnv] || null;
    const apiKey = envKey || configuredKey || (apiKeyEnv && apiKeyEnv.includes('KEY') ? null : apiKeyEnv);
    const baseURL = this.config.ai?.baseURL || (provider === 'sambanova' ? 'https://api.sambanova.ai/v1' : undefined);
    const model = this.config.ai?.model || (provider === 'sambanova' ? 'Meta-Llama-3.1-8B-Instruct' : 'gpt-4o-mini');

    return {
      provider,
      apiKeyEnv,
      apiKey,
      baseURL,
      model
    };
  }

  getAIClient() {
    const ai = this.getAIConfig();
    const apiKey = this.getApiKey(ai);
    const cacheKey = `${ai.provider}:${ai.baseURL || ''}:${apiKey || ''}`;

    if (this.aiClient && this.aiClientKey === cacheKey) {
      return this.aiClient;
    }

    if (!apiKey) {
      throw new Error(`Missing ${ai.provider} API key`);
    }

    this.aiClient = new OpenAI({ apiKey, baseURL: ai.baseURL });
    this.aiClientKey = cacheKey;
    return this.aiClient;
  }

  async askChat(prompt, context = {}) {
    const ai = this.getAIConfig();
    const apiKey = this.getApiKey(ai);
    if (!apiKey) {
      return 'AI is not configured yet.';
    }

    const client = this.getAIClient();
    const system = [
      'You are a helpful Minecraft bot companion.',
      'Keep answers short, clear, and safe.',
      'Do not mention policies or internal rules.',
      context.username ? `The current user is ${context.username}.` : ''
    ].filter(Boolean).join(' ');

    const response = await client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4,
      max_tokens: 120
    });

    const text = response?.choices?.[0]?.message?.content || '';
    return text.trim();
  }

  shouldAbort() {
    return this.abortRequested || Boolean(this.state.commandOverride);
  }

  requestAbort(reason = 'command') {
    this.abortRequested = true;
    this.logger.warn(`Abort requested: ${reason}`);
  }

  clearAbort() {
    this.abortRequested = false;
  }

  isBusy() {
    return Boolean(this.currentTaskPromise);
  }

  getTaskName() {
    return this.currentTask;
  }

  isLocked() {
    return Date.now() < this.taskLockUntil;
  }

  decideRuleAction(snapshot) {
    const nearestChest = snapshot.nearbyChests?.find(chest => chest.available && typeof chest.distance === 'number');
    const readyCropCount = snapshot.readyCrops?.length || 0;
    const villagerNearby = snapshot.nearbyVillagers?.length > 0;
    const tradeable = snapshot.tradeableItems?.length > 0;

    // Count crop items in inventory
    const cropItems = (snapshot.inventory.items || []).filter(item => 
      ['wheat', 'carrot', 'potato', 'beetroot', 'nether_wart', 'wheat_seeds', 'seeds'].includes(item.name)
    );
    const totalCrops = cropItems.reduce((sum, item) => sum + (item.count || 0), 0);

    // Priority 1: Store if inventory is full OR has lots of crops (lower threshold for constant farming)
    if (nearestChest && (snapshot.inventory.full || totalCrops >= 25)) {
      return 'store';
    }

    // Priority 2: ALWAYS farm - most important action for AFK farming
    return 'farm';
  }

  shouldUseAI(snapshot) {
    if (!this.config.ai?.enabled) return false;
    if (Date.now() < this.aiCooldownUntil) return false;
    const ai = this.getAIConfig();
    if (!this.getApiKey(ai)) return false;

    const inventoryFull = snapshot.inventory.full;
    const noChestFound = inventoryFull && !(snapshot.nearbyChests || []).some(chest => chest.available);
    const stuck = snapshot.isStuck;

    return stuck || noChestFound;
  }

  buildAiSummary(snapshot) {
    return {
      currentTask: snapshot.currentTask,
      inventoryFull: snapshot.inventory.full,
      emptySlots: snapshot.inventory.emptySlots,
      readyCrops: snapshot.readyCrops.length,
      nearestChestDistance: snapshot.nearbyChests[0]?.distance ?? null,
      chestAvailable: snapshot.nearbyChests[0]?.available ?? false,
      villagersNearby: snapshot.nearbyVillagers.length,
      playersNearby: snapshot.nearbyPlayers.length,
      tradeableItems: snapshot.tradeableItems.map(item => item.name),
      stuck: snapshot.isStuck,
      withinBase: snapshot.withinBase
    };
  }

  async callAi(snapshot) {
    const ai = this.getAIConfig();
    const summary = this.buildAiSummary(snapshot);
    const prompt = [
      'You are a Minecraft bot decision engine.',
      'Choose exactly one action from: farm, store, trade, explore, idle, follow_player.',
      'Return only the action word, with no extra text.',
      'If inventory is full and no chest is nearby, choose explore.',
      'If the bot is stuck, choose explore or idle.',
      'If a player command exists, prefer follow_player when it matches.',
      'State summary:',
      JSON.stringify(summary)
    ].join('\n');

    if (!this.getApiKey(ai)) {
      return 'explore';
    }

    const client = this.getAIClient();
    const response = await client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      max_tokens: 8
    });

    const text = response?.choices?.[0]?.message?.content || '';
    return normalizeAction(text);
  }

  async resolveDirectedTask(text, context = {}) {
    const input = text.trim();
    const lower = input.toLowerCase();

    const directMap = [
      { match: /\bfarm(?:ing|s|ed)?\b|\bstart farming\b|\bstart farm\b|\bharvest\b|\bplant\b/, action: 'farm' },
      { match: /\bstore\b|\bchest\b|\bdeposit\b/, action: 'store' },
      { match: /\btrade\b|\bvillager\b/, action: 'trade' },
      { match: /\bfollow\b|\bcome\b|\bme\b/, action: 'follow_player' },
      { match: /\bstop following\b|\bstop follow\b|\bunfollow\b|\bcancel follow\b|^stop$/, action: 'idle' },
      { match: /\bexplore\b|\bsearch\b|\blook\b/, action: 'explore' },
      { match: /\bidle\b|\bwait\b|\bstop\b/, action: 'idle' }
    ];

    for (const item of directMap) {
      if (item.match.test(lower)) {
        return {
          type: 'action',
          action: item.action,
          targetPlayer: item.action === 'follow_player' ? (context.username || null) : null,
          raw: input,
          source: 'direct'
        };
      }
    }

    const ai = this.getAIConfig();
    if (!this.getApiKey(ai)) {
      return { type: 'chat', text: 'I can do that, but AI is not configured yet.' };
    }

    const client = this.getAIClient();
    const prompt = [
      'Classify the user message into exactly one bot action.',
      'Allowed actions: farm, store, trade, explore, idle, follow_player.',
      'Return only the action word.',
      'Message:',
      input
    ].join('\n');

    const response = await client.chat.completions.create({
      model: ai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 8
    });

    const resolved = normalizeAction(response?.choices?.[0]?.message?.content || 'idle');
    return {
      type: 'action',
      action: resolved,
      targetPlayer: resolved === 'follow_player' ? (context.username || null) : null,
      raw: input,
      source: ai.provider
    };
  }

  async startAction(actionName, source, snapshot, extra = {}) {
    const action = normalizeAction(actionName);
    const taskFn = ACTIONS[action] || idleBehavior;
    const startedAt = Date.now();
    const lockMs = Math.max(this.config.bot.taskLockMs || 5000, extra.lockMs || 0);

    if (source === 'command') {
      this.clearAbort();
    }

    this.currentTask = action;
    this.taskStartedAt = startedAt;
    this.taskLockUntil = startedAt + lockMs;
    this.lastDecisionSource = source;
    this.state.setCurrentTask(action);

    this.logger.info(`Decision: ${action} (${source})`);

    this.currentTaskPromise = (async () => {
      try {
        const result = await taskFn(this.bot, this.state, this, this.config, extra);
        this.lastTaskResult = result;
        const reason = result?.reason || 'completed';
        this.logger.info(`Task ${action} finished: ${reason}`);
        return result;
      } catch (error) {
        this.logger.error(`Task ${action} failed: ${error.message}`);
        return { success: false, reason: error.message };
      } finally {
        this.currentTaskPromise = null;
        this.taskLockUntil = Math.max(this.taskLockUntil, Date.now() + (this.config.bot.taskLockMs || 5000));
        if (!this.state.commandOverride) {
          this.currentTask = 'idle';
          this.state.setCurrentTask('idle');
        }
        this.clearAbort();
      }
    })();

    return this.currentTaskPromise;
  }

  consumeCommand(snapshot) {
    const command = snapshot.commandOverride;
    if (!command) return null;

    const action = normalizeAction(command.action);
    const extra = {
      targetEntity: command.targetEntity || null,
      targetPlayer: command.targetPlayer || null,
      followDistance: this.config.bot.followDistance,
      lockMs: this.config.bot.taskLockMs
    };

    this.state.clearCommandOverride();
    this.requestAbort('player-command');
    return { action, extra };
  }

  async tick() {
    if (!this.bot.entity) return;
    if (this.currentTaskPromise) return;

    const snapshot = this.state.update(this.bot);
    this.state.setCurrentTask(this.currentTask);

    const command = this.consumeCommand(snapshot);
    if (command) {
      await this.startAction(command.action, 'command', snapshot, command.extra);
      return;
    }

    if (this.shouldAbort()) {
      return;
    }

    if (this.isLocked()) {
      return;
    }

    const ruleAction = this.decideRuleAction(snapshot);
    if (ruleAction) {
      // Only farm if there's actually something to do
      if (ruleAction === 'farm' && !snapshot.nearbyCrops?.length && !snapshot.readyCrops?.length) {
        // No crops available, explore instead
        await this.startAction('explore', 'fallback', snapshot);
        return;
      }
      await this.startAction(ruleAction, 'rule', snapshot);
      return;
    }

    if (this.shouldUseAI(snapshot)) {
      try {
        const aiAction = await this.callAi(snapshot);
        const normalized = normalizeAction(aiAction);
        this.aiCooldownUntil = Date.now() + (this.config.bot.aiCooldownMs || 5000);
        this.logger.info(`Decision: ${normalized} (ai)`);
        await this.startAction(normalized, 'ai', snapshot);
        return;
      } catch (error) {
        this.aiCooldownUntil = Date.now() + (this.config.bot.aiCooldownMs || 5000);
        this.logger.warn(`AI decision failed, using fallback: ${error.message}`);
      }
    }

    // Only try to farm a plot if bot has seeds
    const hasSeedItem = snapshot.inventory.items.some(item => 
      ['wheat_seeds', 'seeds', 'carrot', 'potato', 'beetroot_seeds'].includes(item.name)
    );
    
    if (snapshot.farmPlot?.center && hasSeedItem) {
      await this.startAction('farm', 'fallback', snapshot, { targetPlot: snapshot.farmPlot });
      return;
    }

    // Default: explore and move around
    await this.startAction('explore', 'fallback', snapshot);
  }
}

module.exports = {
  BrainController,
  ACTIONS
};
