const { GoalFollow } = require('mineflayer-pathfinder').goals;
const { randomDelay, smoothLookAt, pickRandomPointAround, goNearPosition, findStandableNeighbor, wait } = require('./helpers');

async function followPlayer(bot, state, brain, config, options = {}) {
  const target = options.targetEntity || state.getFollowTarget();
  if (!target) {
    return { success: false, reason: 'no-player-target' };
  }

  const followDistance = options.followDistance ?? config.bot.followDistance ?? 2;
  const goal = new GoalFollow(target, followDistance);
  bot.pathfinder.setGoal(goal, true);

  const timeoutMs = options.timeoutMs ?? 15000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (brain.shouldAbort()) break;
    if (!target.isValid) break;
    const distance = bot.entity.position.distanceTo(target.position);
    if (distance <= followDistance + 0.8) break;
    await wait(50);
  }

  bot.pathfinder.setGoal(null);
  return { success: true, reason: 'follow-complete' };
}

async function exploreArea(bot, state, brain, config, options = {}) {
  const center = options.center || state.position || bot.entity.position;
  const radius = options.radius ?? config.bot.exploreRadius ?? 18;
  
  // Make 3 guaranteed exploration movements
  for (let pass = 0; pass < 3; pass++) {
    if (brain.shouldAbort()) break;
    
    const target = pickRandomPointAround(center, radius);
    const ground = bot.blockAt(target.offset(0, -1, 0));
    if (!ground || ground.boundingBox !== 'block') {
      target.y = Math.floor(center.y);
    }

    // Try pathfinding first
    try {
      const standableTarget = findStandableNeighbor(bot, target, 6);
      if (standableTarget) {
        await goNearPosition(bot, standableTarget, 1, {
          jitter: false,
          timeoutMs: 4000,
          shouldAbort: () => brain.shouldAbort()
        });
      } else {
        throw new Error('No standable spot');
      }
    } catch {
      // Fallback: Direct movement towards target
      bot.clearControlStates();
      bot.setControlState('forward', true);
      await wait(800);
      bot.setControlState('back', false);
      bot.clearControlStates();
    }

    const lookTarget = target.offset(0, 1, 0);
    await bot.lookAt(lookTarget, false);
  }

  return { success: true, reason: 'explore-complete' };
}

async function idleBehavior(bot, state, brain, config, options = {}) {
  // Aggressive constant movement
  for (let i = 0; i < 10; i++) {
    if (brain.shouldAbort()) break;
    
    // Always move forward
    bot.clearControlStates();
    bot.setControlState('forward', true);
    await wait(300);
    bot.clearControlStates();
    
    // Random look
    const pos = bot.entity.position;
    const target = pos.offset(Math.random() * 4 - 2, 1.5, Math.random() * 4 - 2);
    await bot.lookAt(target, false);
    
    // Try to pathfind to a nearby point for variety
    if (Math.random() < 0.6) {
      const roamTarget = pickRandomPointAround(pos, 4);
      try {
        await goNearPosition(bot, roamTarget, 1, {
          jitter: false,
          timeoutMs: 2000,
          shouldAbort: () => brain.shouldAbort()
        });
      } catch {
        // Ignored, already moving forward
      }
    }
  }

  return { success: true, reason: 'idle-complete' };
}

module.exports = {
  followPlayer,
  exploreArea,
  idleBehavior
};
