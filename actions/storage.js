const { Vec3 } = require('vec3');
const { randomDelay, goNearPosition, smoothLookAt, wait } = require('./helpers');

const CHEST_NAMES = new Set(['chest', 'trapped_chest']);

function isChestBlock(block) {
  return block && CHEST_NAMES.has(block.name);
}

function getKeepCountForItem(itemName, config) {
  const storage = config.storage || {};
  
  // Check keep1 items (keep 1 of each - tools, bread, etc)
  if (storage.keepItems?.keep1?.includes(itemName)) {
    return 1;
  }
  
  // Check keep1Stack items (keep 64 items = 1 stack for seeds and crops)
  if (storage.keepItems?.keep1Stack?.includes(itemName)) {
    return 64;
  }
  
  // Check old keep2Stacks for backwards compatibility
  if (storage.keepItems?.keep2Stacks?.includes(itemName)) {
    return 128;
  }
  
  return 0;
}

function listDepositTargets(bot, config) {
  const items = bot.inventory.items();
  const result = [];
  
  for (const item of items) {
    const keepCount = getKeepCountForItem(item.name, config);
    const canDeposit = item.count > keepCount;
    console.log(`[DEBUG] Storage check: ${item.name} (count: ${item.count}, keep: ${keepCount}) - deposit: ${canDeposit}`);
    
    if (canDeposit) {
      result.push(item);
    }
  }
  
  return result;
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
    console.log(`[DEBUG] Moving to chest at (${chestPos.x}, ${chestPos.y}, ${chestPos.z})`);
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
    console.log(`[DEBUG] Chest no longer present at (${chestPos.x}, ${chestPos.y}, ${chestPos.z})`);
    return { success: false, reason: 'chest-no-longer-present' };
  }

  let chestWindow = null;
  try {
    console.log(`[DEBUG] Opening chest at (${chestPos.x}, ${chestPos.y}, ${chestPos.z})`);
    chestWindow = await bot.openChest(chestBlock);
  } catch (error) {
    console.log(`[DEBUG] Failed to open chest: ${error.message}`);
    return { success: false, reason: 'open-chest-failed' };
  }

  const items = listDepositTargets(bot, config);
  console.log(`[DEBUG] Items to deposit: ${items.length}`);
  let deposited = 0;

  // Deposit all crops and harvestable items
  for (const item of items) {
    if (brain.shouldAbort()) break;
    const keepCount = getKeepCountForItem(item.name, config);
    const depositCount = Math.max(0, item.count - keepCount);
    if (depositCount <= 0) continue;

    try {
      console.log(`[DEBUG] Depositing ${item.name} x${depositCount}`);
      await chestWindow.deposit(item.type, null, depositCount);
      deposited += depositCount;
      await wait(100);
    } catch (error) {
      console.log(`[DEBUG] Failed to deposit ${item.name}: ${error.message}`);
    }
  }

  try {
    console.log(`[DEBUG] Closing chest after depositing ${deposited} items`);
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
