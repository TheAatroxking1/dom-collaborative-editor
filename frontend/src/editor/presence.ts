/**
 * 协作者临时状态：访客身份，以及后续的鼠标与段落选区投影。
 *
 * 这里的所有内容都只放 Awareness，不写正文、不进数据库、不进备份或撤销栈。
 * Awareness 是临时状态：断线或离开时它自然消失，不需要心跳协议。
 */

/** 固定调色板。颜色只用于显示，不参与任何业务判断。 */
const GUEST_COLORS = ['#2563eb', '#9333ea', '#0f766e', '#c2410c', '#be185d'] as const

export type GuestUser = { name: string; color: string }

/**
 * 由客户端 ID 生成固定的访客名与颜色。
 *
 * 不做昵称设置页：同一份文档里不同客户端拿到不同的名字与颜色，足够区分即可。
 * clientID 是 Yjs 随机生成的，因此名字形如「访客 1a2b3c」而不是序号。
 */
export function guestUser(clientId: number): GuestUser {
  return {
    name: `访客 ${clientId.toString(36)}`,
    color: GUEST_COLORS[clientId % GUEST_COLORS.length] as string,
  }
}
