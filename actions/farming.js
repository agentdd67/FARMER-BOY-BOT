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
  const entities = bot.entities;
  if (!entities) {
    console.log(`[DEBUG] No entities found`);
    return [];
  }
  
  const allEntities = Object.values(entities);
  console.log(`[DEBUG] Total entities: ${allEntities.length}`);
  
  // Debug: log some entity types
  const entityTypes = new Set();
  for (const entity of allEntities) {
    entityTypes.add(entity.type);
  }
  console.log(`[DEBUG] Entity types present: ${Array.from(entityTypes).join(', ')}`);
  
  const items = allEntities
    .filter(e => {
      // Check for item entity - can be type 'item' or have metadata indicating it's an item drop
      const isItem = e.type === 'item' || 
                    (e.metadata && e.metadata.itemStack) ||
                    (e.name && (e.name.includes('Item') || e.name.includes('item')));
      
      if (isItem && e.metadata?.itemStack) {
        console.log(`[DEBUG] Found item entity: ${e.metadata.itemStack.name || 'unknown stack'} at distance ${bot.entity.position.distanceTo(e.position).toFixed(1)}m`);
      }
      return isItem;
    })
    .map(item => ({
      pos: item.position,
      name: item.metadata?.itemStack?.name || 'item',
      distance: bot.entity.position.distanceTo(item.position),
      entity: item
    }))
    .filter(item => item.distance <= radius && item.name !== 'item')
    .sort((a, b) => a.distance - b.distance);
    
  console.log(`[DEBUG] Filtered to ${items.length} items within radius ${radius}`);
  return items;
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
  const radius = options.radius ?? 15; // Increased from 10 to 15
  
  // Wait longer for items to render on server
  await wait(300);
  
  const items = findNearbyItems(bot, radius);
  if (!items.length) {
    console.log(`[DEBUG] No items found within radius ${radius}`);
    return 0;
  }
  
  console.log(`[DEBUG] Found ${items.length} items: ${items.map(i => `${i.name}@${i.distance.toFixed(1)}m`).join(', ')}`);
  
  let collected = 0;
  for (const item of items.slice(0, 12)) {
    if (brain.shouldAbort()) break;
    
    try {
      const distance = bot.entity.position.distanceTo(item.pos);
      console.log(`[DEBUG] Collecting ${item.name} at distance ${distance.toFixed(1)}m`);
      
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
    } catch (err) {
      console.log(`[DEBUG] Failed to collect item: ${err.message}`);
    }
  }
  
  console.log(`[DEBUG] Collected ${collected} items total`);
  return collected;
}

async function harvestNearbyPlots(bot, brain, config, timeoutMs = 10000) {
  const start = Date.now();
  const crops = findNearbyCrops(bot, 8);
  let harvested = 0;
  
  if (!crops.length) {
    console.log(`[DEBUG] No mature crops found within 8 blocks`);
    return 0;
  }
  
  console.log(`[DEBUG] Found ${crops.length} mature crops to harvest`);
  
  for (const crop of crops) {
    if (brain.shouldAbort() || Date.now() - start >= timeoutMs) break;
    
    const distance = bot.entity.position.distanceTo(crop.pos);
    
    // Move TO the crop position itself (stand on top of it)
    try {
      console.log(`[DEBUG] Moving to crop at (${crop.pos.x}, ${crop.pos.y}, ${crop.pos.z}), distance: ${distance.toFixed(1)}`);
      await goNearPosition(bot, crop.pos, 0.5, {
        jitter: false,
        timeoutMs: 2000,
        shouldAbort: () => brain.shouldAbort()
      });
      
      // Now break it while standing on top
      await bot.lookAt(crop.pos.offset(0.5, 0.5, 0.5), false);
      console.log(`[DEBUG] Breaking ${crop.name} at (${crop.pos.x}, ${crop.pos.y}, ${crop.pos.z})`);
      await bot.dig(crop.block, true);
      harvested += 1;
      
      // CRITICAL: Wait for items to render (servers can be slow)
      await wait(300);
    } catch (error) {
      console.log(`[DEBUG] Failed to break crop: ${error.message}`);
    }
  }
  
  return harvested;
}

async function farmCrops(bot, state, brain, config, options = {}) {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 12000;
  
  // Step 0: AGGRESSIVELY hunt for dropped items (highest priority)
  let collected = await collectNearbyItems(bot, brain, config, { radius: 20 });
  if (collected > 0) {
    console.log(`[DEBUG] Collected items, returning early`);
    return {
      success: true,
      reason: 'collected-items',
      collected
    };
  }
  
  // Step 1: Harvest ONLY MATURE crops (age >= 5)
  const harvested = await harvestNearbyPlots(bot, brain, config, 4000);
  
  // CRITICAL: After harvesting, IMMEDIATELY hunt for dropped items
  if (harvested > 0) {
    console.log(`[DEBUG] Harvested ${harvested} crops, now hunting for dropped items...`);
    
    // Wait a bit for items to spawn
    await wait(200);
    
    // Aggressively search in larger radius
    collected = await collectNearbyItems(bot, brain, config, { radius: 20 });
    console.log(`[DEBUG] Collected ${collected} items after harvesting`);
    
    if (collected > 0 || Date.now() - start < timeoutMs) {
      return {
        success: true,
        reason: 'harvested-crops',
        harvested,
        collected
      };
    }
  }
  
  // Step 2: Still no items? Roam to find farmland while actively looking for items
  const farmlandList = findNearbyFarmlandList(bot, 14);
  if (farmlandList.length > 0) {
    const seedItem = findInventoryItem(bot, getAllSeedNames());
    console.log(`[DEBUG] Checking for seeds to plant: ${seedItem ? seedItem.name : 'NONE FOUND'}`);
    
    if (seedItem) {
      let planted = 0;
      await bot.equip(seedItem, 'hand');

      const farmAreas = farmlandList.slice(0, 5);
      
      for (const farmArea of farmAreas) {
        if (brain.shouldAbort() || Date.now() - start >= timeoutMs) break;
        
        const distance = bot.entity.position.distanceTo(farmArea);
        
        // Move to farm area
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
          
          if (dist <= 5) {
            try {
              await bot.lookAt(farmland.offset(0.5, 1.0, 0.5), false);
              await bot.placeBlock(soil, new Vec3(0, 1, 0));
              planted += 1;
              await wait(30);
            } catch {
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
  
  // Step 3: Actively roam around hunting for both farmland AND dropped items
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
    
    // After moving, check for items again
    await wait(100);
    collected = await collectNearbyItems(bot, brain, config, { radius: 20 });
    
    return {
      success: true,
      reason: 'roaming-farm',
      collected
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
