import { TimerManager } from "../../utils/pluginUtils";
import { GamePlugin } from "../pluginManager";
import {
    attachCustomGasDamage,
    attachCustomQuickSwitch,
    attachGracePeriod,
    attachKillRewards,
    attachLootPingNotification,
    attachMovingGas,
    attachTimerManagerUpdate,
    attachLootDisabler,
    spawnPlayer,
} from "./internalUtils";
import { MapId } from "../../../../shared/defs/types/misc";
import { Game } from "../game";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { util } from "../../../../shared/utils/util";
import { coldet, Collider } from "../../../../shared/utils/coldet";
import { collider } from "../../../../shared/utils/collider";
import { ObstacleDef } from "../../../../shared/defs/types/obstacle";
import { MapObjectDefs } from "../../../../shared/defs/mapObjectDefs";
import { GameConfig } from "../../../../shared/gameConfig";
import { v2 } from "../../../../shared/utils/v2";
import { GameMap } from "../map";
import { Obstacle } from "../objects/obstacle";
import { DamageParams } from "../objects/gameObject";

// TODO: create collection of all loot and each teams 
interface fixedLootTable { 
    t1: number,
    t2: number,
    type: Array<string>,
    amt: Array<number>,
};
let lootTables = new Map<string, fixedLootTable>();

function getObstacleLootTierOrItem(obstacle: Obstacle) : string {
    let tier = "";
    const def = MapObjectDefs[obstacle.type] as ObstacleDef;
    const loot = [...def.loot];

    for (const lootTierOrItem of loot) {
        if (!loot) continue;
        if ("tier" in lootTierOrItem) 
            tier += lootTierOrItem.tier + " ";          
        else 
            tier += lootTierOrItem.type + " ";
    }
    return tier;
}

// This is prob done rlly ahh but im too lazy atm
const TOTAL_SEED_TYPES = 2;
const SEED = util.randomInt(1, TOTAL_SEED_TYPES);

function generateFixedLoot(map: GameMap) {
    for (let i: number = 0; i < map.obstacles.length; i++) {
        const obstacle = map.obstacles[i];
        if (obstacle == null || obstacle.pos.x > map.width / 2) return;

        const def = MapObjectDefs[obstacle.type] as ObstacleDef;
        const loot = [...def.loot];

        // For now, tier_world will be what the looting axe drops from, but a custom tier might be nice
        if (SEED == 1) 
            loot.push({
                tier: "tier_world",
                min: 1,
                max: 1,
                props: {},
            });      
      
        if (!loot.length) return;

        const type = getObstacleLootTierOrItem(obstacle);
        let table = lootTables.get(type);

        if (!table) {
            table = { t1: 0, t2: 0, type: [], amt: [] };
            lootTables.set(type, table);
        }

        for (const lootTierOrItem of loot) {
            if ("tier" in lootTierOrItem) {
                const count = util.randomInt(lootTierOrItem.min!, lootTierOrItem.max!);

                for (let i = 0; i < count; i++) {
                    const items = obstacle.game.lootBarn.getLootTable(lootTierOrItem.tier!);

                    for (const item of items) {
                        if (item === undefined) continue;
                        table.type.push(item.name);
                        table.amt.push(item.count);
                    }
                }
            } 
            else {
                table.type.push(lootTierOrItem.type!);
                table.amt.push(lootTierOrItem.count!);
            }    
        }       
    }
}
function dropFixedLoot(plugin: GamePlugin, obstacle: Obstacle, params: DamageParams, team: number) {
    const def = MapObjectDefs[obstacle.type] as ObstacleDef;
    const tier = getObstacleLootTierOrItem(obstacle);
    let lootTable = lootTables.get(tier);

    if (team == 0 || lootTable === undefined)
        return; 

    let idx = team == 1 ? lootTable.t1 : lootTable.t2;
    const lootPos = v2.copy(obstacle.pos);

    if (def.lootSpawn) 
        v2.set(lootPos, v2.add(obstacle.pos, v2.rotate(def.lootSpawn.offset, obstacle.rot)));     

    plugin.game.lootBarn.addLoot(lootTable.type[idx!], 
        v2.add(lootPos, v2.mul(v2.randomUnit(), 0.2)),
            obstacle.layer,
            lootTable.amt[idx!],
            undefined,
            undefined,
            params.dir,
            false,
        );

    if (team == 1) lootTable.t1++; else lootTable.t2++;

    // Looting axe drops
    if (params.weaponSourceType != "woodaxe") return;

    const lootingTable = lootTables.get("tier_world ");
    if (lootingTable === undefined) return;

    let idx2 = team == 1 ? lootingTable.t1 : lootingTable.t2;

    plugin.game.lootBarn.addLoot(lootingTable.type[idx2!],
        v2.add(lootPos, v2.mul(v2.randomUnit(), 0.2)),
        obstacle.layer,
        lootingTable.amt[idx2!],
        undefined,
        undefined,
        params.dir,
        false,
        );

    if (team == 1) lootingTable.t1++; else lootingTable.t2++;
    }

function loadoutSeeds(game: Game) {
    for (const player of game.playerBarn.players) {
        player.inventory["2xscope"] = 1;
        player.inventory["4xscope"] = 1;
        player.scope = "4xscope";    

        player.backpack = "backpack02";
        player.addPerk("endless_ammo");

        // TODO: add seeded loadouts (looting axe, 75 adren etc.)
        // switch (SEED) {
        //     case 1:
        //         player.weaponManager.setWeapon(GameConfig.WeaponSlot.Melee, "woodaxe", 0);
        //         break;
        //     case 2:
        //         player.boost = 75;
        //         break;
        // }

        player.boostDirty = true;
        player.zoomDirty = true;
        player.weapsDirty = true;
        player.inventoryDirty = true;
        player.setDirty();
    }
}

const GRACE_PERIOD_DURATION = 1;

const HEALTH_AND_BOOST_ON_KILL = true;
const RELOAD_ON_KILL = true;

const CUSTOM_SWITCH_DELAY = 0.205;

export default class fixedLootPlugin extends GamePlugin {
    timerManager = new TimerManager();
    public override initListeners(): void {
        if (this.game.map.mapId !== MapId.FixedLoot)
            return;
        attachCustomQuickSwitch(this, CUSTOM_SWITCH_DELAY);
        attachTimerManagerUpdate(this);
        attachKillRewards(this, HEALTH_AND_BOOST_ON_KILL, RELOAD_ON_KILL);
        attachGracePeriod(
            this,
            GRACE_PERIOD_DURATION,
            GRACE_PERIOD_DURATION,
            GRACE_PERIOD_DURATION,
        );
        attachLootPingNotification(this, 2, 5);
        attachCustomGasDamage(
            this,
            (dmg: number, n: number, stage: number) => dmg * (1 + Math.min(n, 40) / 20),
        );
        attachMovingGas(this, {
            firstMovingZone: 4,
            stationaryZoneRadiusMultiplier: 0.55,
            movingZoneRadiusMultiplier: 0.7,
            damages: [3, 4, 6, 7, 10],
            initWaitTime: 60,
            minWaitTime: 20,
            waitTimeDecrement: 15,
            initMovingTime: 25,
            minMovingTime: 15,
            movingTimeDecrement: 5,
            movingZoneOffset: 1,
            minRadius: 20,
        });
        attachLootDisabler(this);

        this.on("mapCreated", (event) => {
            generateFixedLoot(event.data.map);
        });
        
        this.on("playerDidJoin", (event, ctx) => {
            const { player } = event.data;
            const map = this.game.map;

            spawnPlayer(player, 
                () => {
                    return () => v2.create(util.randomInt(0, map.width * 0.4), util.randomInt(0, map.height));                    
                }, 
                () => {
                    const enemyGroups = this.game.playerBarn.groups.filter(
                        (g) => g != player.group && !g.allDeadOrDisconnected,
                    );
                    const points = enemyGroups
                        .map((g) => g.livingPlayers[0])
                        .map((p) => p.pos);
                    if (points.length == 0)
                        return () => v2.create(util.randomInt(0, map.width / 2), util.randomInt(0, map.height));      
                    return () => v2.create(map.width - points[0].x, map.height - points[0].y);              
                }, 
                () => {                
                    const rad = GameConfig.player.teammateSpawnRadius;
                    const pos = player.group!.spawnPosition!;
                    return () => v2.add(pos, util.randomPointInCircle(rad));
                },
            );
        });

        this.on("gameStarted", (event) => {
            loadoutSeeds(this.game);
        });

        this.on("obstacleDeathBeforeEffects", (event) => {
            let obstacle = event.data.obstacle;
            const def = MapObjectDefs[obstacle.type] as ObstacleDef;

            if (def.loot.length) {
                let source = event.data.params.source;
                if (source?.__type !== ObjectType.Player) return;

                dropFixedLoot(this, obstacle, event.data.params, source.groupId);
            }
        });
    }
}