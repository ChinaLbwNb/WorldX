import { PlayerController } from "./PlayerController";
import type { PlayerAvatarData, PlayerMode } from "./PlayerController";

/**
 * 本地用户角色控制器。
 *
 * 当前阶段复用旧 PlayerController 的移动、同步和采集半径能力；WorldScene 已改为依赖
 * UserCharacterController，后续可以在这里继续剥离旧 player/god mode 兼容逻辑。
 */
export class UserCharacterController extends PlayerController {}

export type UserCharacterMode = PlayerMode;
export type UserCharacterData = PlayerAvatarData;

