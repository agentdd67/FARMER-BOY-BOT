const { Vec3 } = require('vec3');
const { compactInventory, getNearestEntityByType } = require('./actions/helpers');

const CROP_DEFINITIONS = {
  wheat: { maxAge: 7, replants: 'wheat_seeds' },
  carrots: { maxAge: 7, replants: 'carrot' },
  potatoes: { maxAge: 7, replants: 'potato' },
  beetroots: { maxAge: 3, replants: 'beetroot_seeds' },
  nether_wart: { maxAge: 3, replants: 'nether_wart' }
};

const TRADEABLE_NAMES = new Set([
  'wheat',
  'carrot',
  'potato',
  'beetroot',
  'beetroot_seeds',
  'wheat_seeds',
  'bread',
  'emerald',
  'paper',
  'coal',
  'string'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isCrop(block) {
  return block && Object.prototype.hasOwnProperty.call(CROP_DEFINITIONS, block.name);
}

function getBlockAge(block) {
  if (!block) return 0;
  if (typeof block.metadata === 'number') return block.metadata;
  if (typeof block.stateId === 'number') return block.stateId;
  if (typeof block.getProperties === 'function') {
    const props = block.getProperties();
    if (typeof props.age === 'number') return props.age;
  }
  if (block.properties && typeof block.properties.age === 'number') return block.properties.age;
  return 0;
}

function isChest(block) {
  return block && (block.name === 'chest' || block.name === 'trapped_chest');
}

function isOpenableChest(bot, block) {
  if (!isChest(block)) return false;
  const top = bot.blockAt(block.position.offset(0, 1, 0));
  return !top || top.name === 'air';
}

function isTradeableItem(item) {
  return TRADEABLE_NAMES.has(item.name);
}

function isLiquidLike(block) {
  return Boolean(block && ['water', 'lava', 'flowing_water', 'flowing_lava'].includes(block.name));
}

function averageVec3(points) {
  if (!points.length) return null;
  const sum = points.reduce((acc, point) => {
    acc.x += point.x;
    acc.y += point.y;
    acc.z += point.z;
    return acc;
  }, { x: 0, y: 0, z: 0 });

  return new Vec3(sum.x / points.length, sum.y / points.length, sum.z / points.length);
}

class BotState {
  constructor(config) {
    this.config = config;
    this.currentTask = 'idle';
    this.position = null;
    this.inventory = { full: false, emptySlots: 0, items: [] };
    this.nearbyCrops = [];
    this.readyCrops = [];
    this.readyCropNames = [];
    this.nearbyChests = [];
    this.nearbyVillagers = [];
    this.nearbyPlayers = [];
    this.tradeableItems = [];
    this.baseBoundaries = {
      center: config.bot.baseCenter,
      radius: config.bot.baseRadius
    };
    this.farmPlot = null;
    this.commandOverride = null;
    this.lastProgressAt = Date.now();
    this.lastPosition = null;
    this.isStuck = false;
    this.lastSnapshot = null;
    this.followTargetName = null;
    this._bot = null;
  }

  attach(bot) {
    this._bot = bot;
    bot.on('physicsTick', () => {
      if (!bot.entity) return;
      const current = bot.entity.position.clone();
      if (this.lastPosition) {
        const delta = this.lastPosition.distanceTo(current);
        if (delta > 0.08) {
          this.lastProgressAt = Date.now();
        }
      }
      this.lastPosition = current;
      this.position = {
        x: current.x,
        y: current.y,
        z: current.z
      };
    });
  }

  setCurrentTask(task) {
    this.currentTask = task || 'idle';
  }

  setCommandOverride(command) {
    this.commandOverride = command;
    this.followTargetName = command?.targetPlayer || null;
  }

  clearCommandOverride() {
    this.commandOverride = null;
    this.followTargetName = null;
  }

  getFollowTarget() {
    if (!this._bot) return null;
    if (this.followTargetName && this._bot.players?.[this.followTargetName]?.entity) {
      return this._bot.players[this.followTargetName].entity;
    }

    const nearest = this.nearbyPlayers[0];
    return nearest ? nearest.entity : null;
  }

  estimateVillageCenter(bot) {
    if (!this.nearbyVillagers.length) {
      return bot.entity.position.clone();
    }

    const points = this.nearbyVillagers.map(villager => new Vec3(villager.position.x, villager.position.y, villager.position.z));
    return averageVec3(points) || bot.entity.position.clone();
  }

  scoreFarmCandidate(bot, center, size) {
    const half = Math.floor(size / 2);
    const sampleOffsets = [
      [0, 0],
      [-half, -half],
      [half, -half],
      [-half, half],
      [half, half],
      [0, -half],
      [0, half],
      [-half, 0],
      [half, 0]
    ];

    const samples = sampleOffsets.map(([dx, dz]) => {
      const pos = new Vec3(Math.floor(center.x + dx), Math.floor(center.y), Math.floor(center.z + dz));
      const ground = bot.blockAt(pos.offset(0, -1, 0));
      const feet = bot.blockAt(pos);
      const head = bot.blockAt(pos.offset(0, 1, 0));
      return { pos, ground, feet, head };
    });

    const validGround = samples.filter(sample => sample.ground && sample.ground.boundingBox === 'block' && !isLiquidLike(sample.ground));
    const clearSpace = samples.filter(sample => (!sample.feet || sample.feet.name === 'air') && (!sample.head || sample.head.name === 'air'));
    const heightVariance = samples.reduce((acc, sample) => acc + Math.abs((sample.ground?.position?.y ?? center.y) - center.y), 0);

    return validGround.length === samples.length && clearSpace.length === samples.length
      ? Math.max(0, 100 - heightVariance)
      : -1;
  }

  findFarmPlot(bot) {
    const size = this.config.bot.farmPlotSize || 25;
    const villageCenter = this.estimateVillageCenter(bot);
    const villagerDistances = this.nearbyVillagers.map(v => new Vec3(v.position.x, v.position.y, v.position.z).distanceTo(villageCenter));
    const villageRadius = villagerDistances.length ? Math.max(...villagerDistances) : 12;
    const searchDistance = Math.max(12, Math.min(villageRadius + 8, 18));
    const fromVillage = new Vec3(
      bot.entity.position.x - villageCenter.x,
      0,
      bot.entity.position.z - villageCenter.z
    );
    const fromVillageDistanceSq = fromVillage.x * fromVillage.x + fromVillage.z * fromVillage.z;
    const preferred = fromVillageDistanceSq > 0 ? fromVillage.normalize() : new Vec3(1, 0, 0);
    const directions = [
      preferred,
      preferred.scaled(-1),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
      new Vec3(1, 0, 1).normalize(),
      new Vec3(-1, 0, 1).normalize(),
      new Vec3(1, 0, -1).normalize(),
      new Vec3(-1, 0, -1).normalize()
    ];

    const candidates = directions.map(direction => {
      const center = villageCenter.plus(direction.normalize().scaled(searchDistance));
      const ground = bot.blockAt(center.floored().offset(0, -1, 0));
      const y = typeof ground?.position?.y === 'number' ? ground.position.y + 1 : Math.floor(villageCenter.y);
      const candidateCenter = new Vec3(Math.floor(center.x), y, Math.floor(center.z));
      return {
        center: candidateCenter,
        score: this.scoreFarmCandidate(bot, candidateCenter, size),
        distanceFromVillage: candidateCenter.distanceTo(villageCenter)
      };
    }).filter(candidate => candidate.score >= 0 && candidate.distanceFromVillage >= villageRadius + 8);

    if (!candidates.length) {
      const fallbackOffset = preferred.scaled(searchDistance);
      const fallbackCenter = new Vec3(
        Math.floor(villageCenter.x + fallbackOffset.x),
        Math.floor(villageCenter.y),
        Math.floor(villageCenter.z + fallbackOffset.z)
      );
      return {
        size,
        center: {
          x: fallbackCenter.x,
          y: fallbackCenter.y,
          z: fallbackCenter.z
        },
        villageCenter: {
          x: Math.floor(villageCenter.x),
          y: Math.floor(villageCenter.y),
          z: Math.floor(villageCenter.z)
        },
        outsideVillage: true,
        built: false,
        confidence: 0,
        reason: 'fallback'
      };
    }

    candidates.sort((a, b) => b.score - a.score || b.distanceFromVillage - a.distanceFromVillage);
    const best = candidates[0];

    return {
      size,
      center: {
        x: best.center.x,
        y: best.center.y,
        z: best.center.z
      },
      villageCenter: {
        x: Math.floor(villageCenter.x),
        y: Math.floor(villageCenter.y),
        z: Math.floor(villageCenter.z)
      },
      outsideVillage: true,
      built: false,
      confidence: best.score,
      reason: 'flat-outside-village'
    };
  }

  scanNearby(bot) {
    const radius = this.config.bot.scanRadius || 8;
    const current = bot.entity.position;
    const crops = [];
    const chests = [];

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -2; dy <= 3; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const pos = current.offset(dx, dy, dz).floored();
          const block = bot.blockAt(pos);
          if (!block) continue;

          if (isCrop(block)) {
            const def = CROP_DEFINITIONS[block.name];
            const age = getBlockAge(block);
            const mature = age >= def.maxAge;
            crops.push({
              name: block.name,
              cropType: block.name,
              age,
              maxAge: def.maxAge,
              mature,
              position: { x: pos.x, y: pos.y, z: pos.z }
            });
          } else if (isChest(block)) {
            const distance = bot.entity.position.distanceTo(block.position);
            chests.push({
              name: block.name,
              distance,
              available: isOpenableChest(bot, block),
              position: { x: pos.x, y: pos.y, z: pos.z }
            });
          }
        }
      }
    }

    const readyCrops = crops.filter(crop => crop.mature).sort((a, b) => {
      const da = bot.entity.position.distanceTo(new Vec3(a.position.x, a.position.y, a.position.z));
      const db = bot.entity.position.distanceTo(new Vec3(b.position.x, b.position.y, b.position.z));
      return da - db;
    });

    const nearbyEntities = Object.values(bot.entities || {});
    const nearbyVillagers = [];
    const nearbyPlayers = [];

    for (const entity of nearbyEntities) {
      if (!entity || entity === bot.entity || !entity.position) continue;
      const distance = bot.entity.position.distanceTo(entity.position);
      if (distance > radius * 2) continue;

      const entityName = String(entity.name || '').toLowerCase();
      const entityType = String(entity.type || '').toLowerCase();

      if (entityType.includes('player') || entityName.includes('player')) {
        nearbyPlayers.push({
          name: entity.username || entity.displayName || entity.name || 'player',
          distance,
          position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
          entity
        });
      } else if (entityName.includes('villager') || entityType.includes('villager')) {
        nearbyVillagers.push({
          name: entity.name || 'villager',
          distance,
          position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
          entity
        });
      }
    }

    nearbyPlayers.sort((a, b) => a.distance - b.distance);
    nearbyVillagers.sort((a, b) => a.distance - b.distance);

    return {
      nearbyCrops: crops,
      readyCrops,
      readyCropNames: [...new Set(readyCrops.map(crop => crop.name))],
      nearbyChests: chests.sort((a, b) => a.distance - b.distance),
      nearbyVillagers,
      nearbyPlayers,
      tradeableItems: bot.inventory.items().filter(isTradeableItem)
    };
  }

  update(bot) {
    const inventory = compactInventory(bot);
    const scan = this.scanNearby(bot);
    const position = bot.entity?.position;
    const baseCenter = new Vec3(this.baseBoundaries.center.x, this.baseBoundaries.center.y, this.baseBoundaries.center.z);
    const withinBase = position ? position.distanceTo(baseCenter) <= this.baseBoundaries.radius : false;
    const isStuck = Date.now() - this.lastProgressAt > (this.config.bot.stuckSeconds || 12) * 1000;

    this.inventory = inventory;
    this.nearbyCrops = scan.nearbyCrops;
    this.readyCrops = scan.readyCrops;
    this.readyCropNames = scan.readyCropNames;
    this.nearbyChests = scan.nearbyChests;
    this.nearbyVillagers = scan.nearbyVillagers;
    this.nearbyPlayers = scan.nearbyPlayers;
    this.tradeableItems = scan.tradeableItems;
    this.farmPlot = this.findFarmPlot(bot);
    this.isStuck = isStuck;

    const snapshot = {
      currentTask: this.currentTask,
      position: this.position,
      inventory,
      nearbyCrops: this.nearbyCrops.map(crop => ({
        name: crop.name,
        cropType: crop.cropType,
        age: crop.age,
        maxAge: crop.maxAge,
        mature: crop.mature,
        position: crop.position
      })),
      readyCrops: this.readyCrops.map(crop => ({
        name: crop.name,
        cropType: crop.cropType,
        age: crop.age,
        maxAge: crop.maxAge,
        mature: crop.mature,
        position: crop.position
      })),
      nearbyChests: this.nearbyChests.map(chest => ({
        distance: chest.distance,
        available: chest.available,
        position: chest.position,
        name: chest.name
      })),
      nearbyVillagers: this.nearbyVillagers.map(villager => ({
        name: villager.name,
        distance: villager.distance,
        position: villager.position
      })),
      nearbyPlayers: this.nearbyPlayers.map(player => ({
        name: player.name,
        distance: player.distance,
        position: player.position
      })),
      tradeableItems: this.tradeableItems.map(item => ({
        name: item.name,
        count: item.count
      })),
      farmPlot: this.farmPlot,
      base: clone(this.baseBoundaries),
      withinBase,
      isStuck,
      commandOverride: this.commandOverride
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  getSnapshot() {
    return this.lastSnapshot || this.update(this._bot);
  }

  getMinimalSummary() {
    const snapshot = this.getSnapshot();
    return {
      currentTask: snapshot.currentTask,
      inventoryFull: snapshot.inventory.full,
      emptySlots: snapshot.inventory.emptySlots,
      readyCrops: snapshot.readyCrops.length,
      nearestChestDistance: snapshot.nearbyChests[0]?.distance ?? null,
      chestAvailable: snapshot.nearbyChests[0]?.available ?? false,
      villagers: snapshot.nearbyVillagers.length,
      players: snapshot.nearbyPlayers.length,
      tradeableItems: snapshot.tradeableItems.map(item => item.name),
      farmPlot: snapshot.farmPlot ? {
        center: snapshot.farmPlot.center,
        size: snapshot.farmPlot.size,
        outsideVillage: snapshot.farmPlot.outsideVillage,
        confidence: snapshot.farmPlot.confidence
      } : null,
      stuck: snapshot.isStuck,
      withinBase: snapshot.withinBase,
      commandOverride: snapshot.commandOverride?.action ?? null
    };
  }
}

module.exports = {
  BotState,
  CROP_DEFINITIONS
};
