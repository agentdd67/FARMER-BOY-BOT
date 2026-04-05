const { Vec3 } = require('vec3');
const {
  randomDelay,
  smoothLookAt,
  goNearPosition,
  findStandableNeighbor,
  normalizeAction,
  wait
} = require('./helpers');

const CROP_SEED_MAP = {
  wheat: ['wheat_seeds', 'seeds'],
  carrots: ['carrot'],
  potatoes: ['potato'],
  beetroots: ['beetroot_seeds']
};

const HARVESTABLE_CROPS = new Set([
  'wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart'
]);

function getAllSeedNames() {
  return [...new Set(Object.values(CROP_SEED_MAP).flat())];
}

function getPlantItemName(cropName) {
  return CROP_SEED_MAP[cropName]?.[0] || null;
}

function findInventoryItem(bot, names) {
  const wanted = Array.isArray(names) ? names : [names];
  return bot.inventory.items().find(item => wanted.includes(item.name)) || null;
}

function getBlockAge(block) {
  if (!block) return 0;
  if (typeof block.metadata === 'number') return block.metadata;
  if (block.properties?.age !== undefined) return block.properties.age;
  return 0;
}

function findNearbyCrops(bot, radius = 8, minAge = 5) {
  const origin = bot.entity.position.floored();
  const crops = [];

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const pos = origin.offset(dx, dy, dz);
        const block = bot.blockAt(pos);
        if (!block || !HARVESTABLE_CROPS.has(block.name)) continue;
        
        // Only harvest MATURE crops (age >= minAge)
        const age = getBlockAge(block);
        if (age < minAge) continue;
        
        crops.push({
          pos,
          name: block.name,
          block,
          age,
          distance: bot.entity.position.distanceTo(pos)
        });
      }
    }
  }

  return crops.sort((a, b) => a.distance - b.distance);
}

function findNearbyItems(bot, radius = 6) {
  const entities = bot.nearbyEntities;
  if (!entities) return [];
  
  return Object.values(entities)
    .filter(e => e.type === 'item')
    .map(item => ({
      pos: item.position,
      name: item.metadata?.itemStack?.name || 'item',
      distance: bot.entity.position.distanceTo(item.position),
      entity: item
    }))
    .filter(item => item.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

function findNearbyFarmlandList(bot, radius = 6) {
  const origin = bot.entity.position.floored();
  const spots = [];

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const pos = origin.offset(dx, dy, dz);
        const soil = bot.blockAt(pos);
        const above = bot.blockAt(pos.offset(0, 1, 0));
        if (!soil || soil.name !== 'farmland') continue;
        if (above && above.name !== 'air') continue;

        spots.push({
          pos,
          distance: bot.entity.position.distanceTo(pos)
        });
      }
    }
  }

  return spots.sort((a, b) => a.distance - b.distance).map(entry => entry.pos);
}

async function collectNearbyItems(bot, brain, config, options = {}) {
  const radius = options.radius ?? 10;
  
  // Wait a moment for items to render
  await wait(200);
  
  const items = findNearbyItems(bot, radius);
  if (!items.length) return 0;
  
  let collected = 0;
  for (const item of items.slice(0, 12)) {
    if (brain.shouldAbort()) break;
    
    try {
      const distance = bot.entity.position.distanceTo(item.pos);
      
      // Move closer if needed
      if (distance > 2) {
        await goNearPosition(bot, item.pos, 0.5, {
          jitter: false,
          timeoutMs: 2000,
          shouldAbort: () => brain.shouldAbort()
        });
      }
      
      collected += 1;
      await wait(100);
    } catch {
      // skip
    }
  }
  
  return collected;
}

async function harvestNearbyPlots(bot, brain, config, timeoutMs = 10000) {
  const start = Date.now();
  const crops = findNearbyCrops(bot, 8);
  let harvested = 0;
  
  for (const crop of crops) {
    if (brain.shouldAbort() || Date.now() - start >= timeoutMs) break;
    
    const distance = bot.entity.position.distanceTo(crop.pos);
    
    // Move closer if needed
    if (distance > 4) {
      try {
        await goNearPosition(bot, crop.pos, 2, {
          jitter: false,
          timeoutMs: 3000,
          shouldAbort: () => brain.shouldAbort()
        });
      } catch {
        continue;
      }
    }
    
    // Break the crop
    try {
      await bot.lookAt(crop.pos.offset(0.5, 0.5, 0.5), false);
      await bot.dig(crop.block, true);
      harvested += 1;
      await wait(50);
    } catch (error) {
      // silently skip
    }
  }
  
  return harvested;
}

async function farmCrops(bot, state, brain, config, options = {}) {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 12000;
  
  // Step 0: AGGRESSIVELY collect any dropped items from ground (high priority)
  const collected = await collectNearbyItems(bot, brain, config, { radius: 10 });
  if (collected > 2) {
    return {
      success: true,
      reason: 'collected-items',
      collected
    };
  }
  
  // Step 1: Harvest ONLY MATURE crops (age >= 5)
  const harvested = await harvestNearbyPlots(bot, brain, config, 4000);
  if (harvested > 0 && Date.now() - start < timeoutMs) {
    return {
      success: true,
      reason: 'harvested-crops',
      harvested
    };
  }
  
  // Step 2: Plant farmland - roam while planting
  const farmlandList = findNearbyFarmlandList(bot, 14);
  if (farmlandList.length > 0) {
    const seedItem = findInventoryItem(bot, getAllSeedNames());
    if (seedItem) {
      let planted = 0;
      await bot.equip(seedItem, 'hand');

      // Visit multiple farmland areas to spread planting across farm
      const farmAreas = farmlandList.slice(0, 5);
      
      for (const farmArea of farmAreas) {
        if (brain.shouldAbort() || Date.now() - start >= timeoutMs) break;
        
        const distance = bot.entity.position.distanceTo(farmArea);
        
        // Move to this farm area
        if (distance > 3) {
          try {
            await goNearPosition(bot, farmArea, 2, {
              jitter: false,
              timeoutMs: 3000,
              shouldAbort: () => brain.shouldAbort()
            });
          } catch {
            continue;
          }
        }
        
        // Plant in this area
        for (const farmland of farmlandList) {
          if (brain.shouldAbort() || Date.now() - start >= timeoutMs) break;
          
          const soil = bot.blockAt(farmland);
          const above = bot.blockAt(farmland.offset(0, 1, 0));
          if (!soil || soil.name !== 'farmland' || (above && above.name !== 'air')) continue;

          const dist = bot.entity.position.distanceTo(farmland) || Infinity;
          
          // Plant if within range
          if (dist <= 5) {
            try {
              await bot.lookAt(farmland.offset(0.5, 1.0, 0.5), false);
              await bot.placeBlock(soil, new Vec3(0, 1, 0));
              planted += 1;
              await wait(30);
            } catch (error) {
              // silently skip
            }
          }
        }
      }

      if (planted > 0) {
        return {
          success: true,
          reason: 'planted-seeds',
          planted
        };
      }
    }
  }
  
  // Step 3: If no farmland but we collected or harvested, roam to find more
  if (collected > 0 || harvested > 0) {
    return {
      success: true,
      reason: 'farm-activity',
      collected,
      harvested
    };
  }
  
  // Fallback: Roam around farm to find more areas
  try {
    const center = bot.entity.position;
    const roamTarget = center.offset(
      Math.random() * 16 - 8,
      0,
      Math.random() * 16 - 8
    );
    await goNearPosition(bot, roamTarget, 1, {
      jitter: false,
      timeoutMs: 2000,
      shouldAbort: () => brain.shouldAbort()
    });
    return {
      success: true,
      reason: 'roaming-farm',
      collected: 0
    };
  } catch {
    return {
      success: false,
      reason: 'no-farmland-found',
      harvested: 0
    };
  }
}

module.exports = {
  farmCrops,
  collectNearbyItems,
  harvestNearbyPlots,
  findNearbyCrops,
  findNearbyItems,
  getPlantItemName,
  normalizeAction
};
