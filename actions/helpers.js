const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(minMs = 100, maxMs = 500) {
  return wait(randomInt(minMs, maxMs));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  return a.distanceTo(b);
}

function toBlockPos(position) {
  return new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
}

function getBlockName(block) {
  return block ? block.name : null;
}

function isAirLike(block) {
  return !block || block.name === 'air' || block.boundingBox === 'empty';
}

function findStandableNeighbor(bot, targetPos, searchRadius = 1) {
  const offsets = [];
  for (let dx = -searchRadius; dx <= searchRadius; dx++) {
    for (let dz = -searchRadius; dz <= searchRadius; dz++) {
      if (dx === 0 && dz === 0) continue;
      offsets.push(new Vec3(dx, 0, dz));
    }
  }

  const shuffled = offsets.sort(() => Math.random() - 0.5);
  for (const offset of shuffled) {
    const check = targetPos.plus(offset);
    const feet = bot.blockAt(check);
    const head = bot.blockAt(check.offset(0, 1, 0));
    const below = bot.blockAt(check.offset(0, -1, 0));
    if (isAirLike(feet) && isAirLike(head) && below && below.boundingBox === 'block') {
      return check;
    }
  }

  return null;
}

async function goNearPosition(bot, position, range = 1, options = {}) {
  const target = position instanceof Vec3 ? position : new Vec3(position.x, position.y, position.z);
  const { GoalNear } = goals;
  const goal = new GoalNear(target.x, target.y, target.z, range);
  const pathfinder = bot.pathfinder;
  if (!pathfinder) {
    throw new Error('Pathfinder plugin not loaded');
  }

  if (options.jitter && Math.random() < 0.5) {
    const jittered = target.offset(randomInt(-1, 1), 0, randomInt(-1, 1));
    pathfinder.setGoal(new GoalNear(jittered.x, jittered.y, jittered.z, range), true);
  } else {
    pathfinder.setGoal(goal, true);
  }

  await waitUntilReached(bot, target, range, options.timeoutMs ?? 20000, options.shouldAbort);
}

async function waitUntilReached(bot, target, range = 1, timeoutMs = 20000, shouldAbort = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        // ignore cleanup failures
      }
      throw new Error('Movement aborted');
    }
    const pos = bot.entity?.position;
    if (pos && pos.distanceTo(target) <= range + 0.8) {
      return true;
    }
    await wait(50);
  }

  throw new Error('Timed out while moving to target');
}

async function smoothLookAt(bot, target, durationMs = 250) {
  if (!bot.entity) return;
  try {
    await bot.lookAt(target, true, durationMs);
  } catch {
    // ignore look errors to keep behavior resilient
  }
}

function pickRandomPointAround(center, radius = 8) {
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * radius;
  return new Vec3(
    Math.floor(center.x + Math.cos(angle) * distance),
    Math.floor(center.y),
    Math.floor(center.z + Math.sin(angle) * distance)
  );
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function compactInventory(bot) {
  const items = bot.inventory.items().map(item => ({
    name: item.name,
    count: item.count,
    type: item.type,
    displayName: item.displayName
  }));
  const emptySlots = bot.inventory.emptySlotCount();
  return {
    full: emptySlots === 0,
    emptySlots,
    items
  };
}

function normalizeAction(action) {
  const allowed = new Set(['farm', 'store', 'trade', 'explore', 'idle', 'follow_player']);
  if (!action) return 'idle';
  const normalized = String(action).trim().toLowerCase().replace(/[^a-z_]/g, '');
  if (allowed.has(normalized)) return normalized;
  if (normalized === 'followplayer') return 'follow_player';
  if (normalized === 'searchforchest' || normalized === 'search_for_chest') return 'explore';
  return 'idle';
}

function getNearestEntityByType(bot, typeName, maxDistance = 16) {
  const entities = Object.values(bot.entities || {});
  let nearest = null;
  let nearestDistance = Infinity;

  for (const entity of entities) {
    if (!entity || entity === bot.entity) continue;
    const name = String(entity.name || entity.mobType || '').toLowerCase();
    const type = String(entity.type || '').toLowerCase();
    const matches = name.includes(typeName.toLowerCase()) || type.includes(typeName.toLowerCase());
    if (!matches) continue;

    const d = bot.entity.position.distanceTo(entity.position);
    if (d <= maxDistance && d < nearestDistance) {
      nearest = entity;
      nearestDistance = d;
    }
  }

  return nearest ? { entity: nearest, distance: nearestDistance } : null;
}

function isWalkableBlock(block) {
  return block && block.boundingBox === 'block' && !['lava', 'fire', 'cactus', 'sweet_berry_bush'].includes(block.name);
}

function canStandAt(bot, position) {
  const feet = bot.blockAt(position);
  const head = bot.blockAt(position.offset(0, 1, 0));
  const below = bot.blockAt(position.offset(0, -1, 0));
  return isAirLike(feet) && isAirLike(head) && isWalkableBlock(below);
}

module.exports = {
  wait,
  randomInt,
  randomDelay,
  clamp,
  distance,
  toBlockPos,
  getBlockName,
  isAirLike,
  findStandableNeighbor,
  goNearPosition,
  waitUntilReached,
  smoothLookAt,
  pickRandomPointAround,
  chunk,
  compactInventory,
  normalizeAction,
  getNearestEntityByType,
  canStandAt
};
