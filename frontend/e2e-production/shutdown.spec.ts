import { ProductionServer, expect, test } from './fixtures'

/**
 * 夹具对「服务有没有正常停机」的判断本身是否可信。
 *
 * 生产套件的每个用例都在收尾时断言服务以退出码 0 正常停止。如果夹具把「进程早就
 * 自己退了」也报成退出码 0，那么服务已经崩掉的用例照样会通过——停机测试就失去了
 * 意义。这里刻意不用常规的 server 夹具：它会替每个用例断言正常停机，而本用例要
 * 故意让进程提前消失。所以自己起一个实例，只验证夹具报出来的退出结果。
 */

test('进程提前退出时不会被判成退出码 0', async () => {
  const server = await ProductionServer.start()
  try {
    // 模拟「还没等到正常停止请求，进程就已经不在了」。
    await server.kill()

    const result = await server.stopGracefully()
    expect(result.exited).toBe(true)
    expect(result.code).not.toBe(0)
  } finally {
    server.cleanup()
  }
})
