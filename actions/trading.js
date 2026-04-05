const { randomDelay, goNearPosition, smoothLookAt, getNearestEntityByType } = require('./helpers');

function canAffordTrade(bot, trade) {
  const inventory = bot.inventory.items();
  const byName = new Map();

  for (const item of inventory) {
    byName.set(item.name, (byName.get(item.name) || 0) + item.count);
  }

  const ingredients = [trade.inputItem1, trade.inputItem2].filter(Boolean);
  if (!ingredients.length) return false;

  return ingredients.every(ingredient => {
    const count = byName.get(ingredient.name) || 0;
    return count >= ingredient.count;
  });
}

function chooseTrade(window, bot) {
  const trades = window?.trades || [];
  if (!trades.length) return -1;

  for (let i = 0; i < trades.length; i++) {
    if (canAffordTrade(bot, trades[i])) return i;
  }

  return 0;
}

async function tradeWithVillager(bot, state, brain, config, options = {}) {
  const villagerInfo = options.villager || state.nearbyVillagers?.[0] || getNearestEntityByType(bot, 'villager', 16);
  if (!villagerInfo || !villagerInfo.entity) {
    return { success: false, reason: 'no-villager-found' };
  }

  const villager = villagerInfo.entity;
  await goNearPosition(bot, villager.position, 2, { jitter: false, timeoutMs: options.timeoutMs ?? 6000, shouldAbort: () => brain.shouldAbort() });
  await bot.lookAt(villager.position.offset(0, 1.2, 0), false);

  let window = null;
  try {
    window = await bot.openVillager(villager);
  } catch (error) {
    return { success: false, reason: `open-villager-failed:${error.message}` };
  }

  let traded = false;
  try {
    const tradeIndex = chooseTrade(window, bot);
    if (tradeIndex >= 0 && typeof window.trade === 'function') {
      await window.trade(tradeIndex, 1);
      traded = true;
    } else if (tradeIndex >= 0 && typeof window.selectTrade === 'function') {
      window.selectTrade(tradeIndex);
      traded = true;
    }
  } catch (error) {
    // silently skip
  }

  try {
    if (window && typeof window.close === 'function') {
      window.close();
    } else if (bot.currentWindow) {
      bot.closeWindow(bot.currentWindow);
    }
  } catch {
    // ignore close errors
  }

  return {
    success: traded,
    reason: traded ? 'trade-complete' : 'opened-villager-no-trade',
    traded
  };
}

module.exports = {
  tradeWithVillager,
  canAffordTrade,
  chooseTrade
};
