import { RemotePlayerManager } from "./RemotePlayerManager";

/**
 * 其他在线用户角色渲染器。
 *
 * 与 NPC 的 CharacterMovement/characterSprites 分开管理，避免用户角色被当成 NPC。
 */
export class RemoteUserCharacterManager extends RemotePlayerManager {}
