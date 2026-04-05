const { Vec3 } = require('vec3');
const { randomDelay, goNearPosition, smoothLookAt } = require('./helpers');

const CHEST_NAMES = new Set(['chest', 'trapped_chest']);

function isChestBlock(block) {
  return block && CHEST_NAMES.has(block.name);
}

function getKeepCountForItem(itemName, config) {
  const keepItems = new Set(config.storage?.keepItems || []);
  return keepItems.has(itemName) ? 1 : 0;
}

function listDepositTargets(bot, config) {
  return bot.inventory.items().filter(item => getKeepCountForItem(item.name, config) === 0 || item.count > 1);
}

function findNearestChest(state) {
  const chests = state.nearbyChests || [];
  if (!chests.length) return null;
  return chests.slice().sort((a, b) => a.distance - b.distance)[0];
}

async function storeItems(bot, state, brain, config, options = {}) {
  const chestInfo = options.chest || findNearestChest(state);
  if (!chestInfo || !chestInfo.position) {
    return { success: false, reason: 'no-chest-found' };
  }

  const chestPos = new Vec3(chestInfo.position.x, chestInfo.position.y, chestInfo.position.z);
  
  // Move to chest with timeout
  try {
    await goNearPosition(bot, chestPos, 1, { 
      jitter: false, 
      timeoutMs: options.timeoutMs ?? 4000, 
      shouldAbort: () => brain.shouldAbort() 
    });
  } catch {
    return { success: false, reason: 'failed-to-reach-chest' };
  }
  
  await bot.lookAt(chestPos.offset(0.5, 0.5, 0.5), false);

  const chestBlock = bot.blockAt(chestPos);
  if (!isChestBlock(chestBlock)) {
    return { success: false, reason: 'chest-no-longer-present' };
  }

  let chestWindow = null;
  try {
    chestWindow = await bot.openChest(chestBlock);
  } catch (error) {
    return { success: false, reason: 'open-chest-failed' };
  }

  const items = listDepositTargets(bot, config);
  let deposited = 0;

  // Deposit all crops and harvestable items
  for (const item of items) {
    if (brain.shouldAbort()) break;
    const keepCount = getKeepCountForItem(item.name, config);
    const depositCount = Math.max(0, item.count - keepCount);
    if (depositCount <= 0) continue;

    try {
      await chestWindow.deposit(item.type, null, depositCount);
      deposited += depositCount;
    } catch (error) {
      // skip failed deposits
    }
  }

  try {
    chestWindow.close();
  } catch {
    // ignore
  }

  return {
    success: deposited > 0,
    reason: deposited > 0 ? 'stored-items' : 'nothing-to-store',
    deposited
  };
}

module.exports = {
  storeItems,
  findNearestChest,
  isChestBlock
};
