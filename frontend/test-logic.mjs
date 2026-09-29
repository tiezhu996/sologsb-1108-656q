const fakeDB = await import('fake-indexeddb')
const { setActivePinia, createPinia } = await import('pinia')

Object.assign(globalThis, {
  indexedDB: fakeDB.indexedDB,
  IDBKeyRange: fakeDB.IDBKeyRange
})
setActivePinia(createPinia())

const storeMod = await import('./src/stores/stockStore.ts')
const devMod = await import('./src/stores/developerStore.ts')
const dbMod = await import('./src/utils/db.ts')
const dateMod = await import('./src/utils/date.ts')

const stockStore = storeMod.useStockStore()
const devStore = devMod.useDeveloperStore()
const db = dbMod.db

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✓', label) }
  else { failed++; console.log('  ✗ FAIL:', label) }
}
async function section(name, fn) {
  console.log('\n=== ' + name + ' ===')
  await fn()
}

await db.open()
await Promise.all([stockStore.load(), devStore.load()])

await section('种子数据', () => {
  assert(stockStore.stocks.length === 3, '3 瓶母液种子')
  assert(devStore.developers.length === 5, '5 条旧工作液')
  assert(devStore.developers.every(d => d.sourceTraced === false), '旧工作液全部来源未追溯')
  assert(devStore.activeDevelopers.length === 4, '可用工作液 4 条（1 条报废排除）')
})

await section('正常配制：扣减母液 + 生成工作液 + 台账', async () => {
  const stock = stockStore.stocks.find(s => s.id === 1)
  const before = stock.volumeMl
  const res = await stockStore.mixWorking({
    category: 'D-76', stockId: 1, workingName: '测试 D-76 工作液',
    dilution: '1:1', targetVolumeMl: 600, mixedAt: dateMod.today()
  })
  assert(res.stockUsedMl === 300, '1:1 配 600mL 需母液 300mL')
  const after = (await db.stocks.get(1)).volumeMl
  assert(after === before - 300, `母液余量 ${before} → ${after}`)
  const dev = await db.developers.get(res.developerId)
  assert(dev && dev.sourceTraced === true && dev.sourceStockId === 1, '新工作液标记来源可追溯')
  assert(dev.category === 'D-76' && dev.volumeMl === 600, '工作液类别/容量正确')
  const mix = await db.mixes.get(res.mixId)
  assert(mix && mix.status === '正常' && mix.stockUsedMl === 300, '台账记录正常')
})

await section('1:3 换算', async () => {
  const before = (await db.stocks.get(2)).volumeMl
  const res = await stockStore.mixWorking({
    category: 'HC-110', stockId: 2, workingName: 'HC110 1to3',
    dilution: '1:3', targetVolumeMl: 800, mixedAt: dateMod.today()
  })
  assert(res.stockUsedMl === 200, '1:3 配 800mL 需母液 200mL')
  assert((await db.stocks.get(2)).volumeMl === before - 200, '扣减 200mL')
})

await section('过期拒绝配制', async () => {
  await db.stocks.add({ id: 99, name: '过期母液', category: 'D-76', openedAt: '2025-01-01', expireDate: '2026-01-01', volumeMl: 1000, schemaRev: 3 })
  await stockStore.load()
  const stockBefore = (await db.stocks.get(99)).volumeMl
  const devCountBefore = await db.developers.count()
  const mixCountBefore = await db.mixes.count()
  let err = null
  try {
    await stockStore.mixWorking({ category: 'D-76', stockId: 99, workingName: 'X', dilution: '1:1', targetVolumeMl: 100, mixedAt: dateMod.today() })
  } catch (e) { err = e }
  assert(err && err.name === 'MixValidationError', '抛 MixValidationError')
  assert(/过期/.test(err.message), '错误信息提到过期')
  assert((await db.stocks.get(99)).volumeMl === stockBefore, '过期母液余量未变')
  assert(await db.developers.count() === devCountBefore, '未生成工作液')
  assert(await db.mixes.count() === mixCountBefore, '未写台账')
})

await section('余量不足拒绝', async () => {
  const before = (await db.stocks.get(2)).volumeMl // 50
  const devCountBefore = await db.developers.count()
  let err = null
  try {
    await stockStore.mixWorking({ category: 'HC-110', stockId: 2, workingName: 'Y', dilution: '1:3', targetVolumeMl: 1000, mixedAt: dateMod.today() })
  } catch (e) { err = e }
  assert(err && /余量不足/.test(err.message), '提示余量不足（需250，余50）')
  assert((await db.stocks.get(2)).volumeMl === before, '母液余量未变')
  assert(await db.developers.count() === devCountBefore, '未写入')
})

await section('类别不符拒绝', async () => {
  // stock 2 是 HC-110，请求 C-41
  const before = (await db.stocks.get(2)).volumeMl
  let err = null
  try {
    await stockStore.mixWorking({ category: 'C-41', stockId: 2, workingName: 'Z', dilution: '1:3', targetVolumeMl: 40, mixedAt: dateMod.today() })
  } catch (e) { err = e }
  assert(err && /类别不符/.test(err.message), '提示类别不符')
  assert((await db.stocks.get(2)).volumeMl === before, '母液余量未变')
})

await section('撤销未冲洗：回余量 + 工作液作废 + 留已撤销', async () => {
  const firstMix = (await db.mixes.toArray()).find(m => m.workingName === '测试 D-76 工作液')
  const stockBefore = (await db.stocks.get(1)).volumeMl
  const res = await stockStore.revokeMix(firstMix.id)
  assert(res.restoredMl === 300, '恢复 300mL')
  assert((await db.stocks.get(1)).volumeMl === stockBefore + 300, '母液余量确实恢复')
  const mix = await db.mixes.get(firstMix.id)
  assert(mix.status === '已撤销' && !!mix.revokedAt, '台账标记已撤销且留痕')
  const dev = await db.developers.get(firstMix.workingDeveloperId)
  assert(dev.state === '已撤销', '工作液标记已撤销')
  await devStore.load()
  assert(!devStore.activeDevelopers.some(d => d.id === dev.id), '已撤销工作液不进入可用列表')
})

await section('重复撤销被拒', async () => {
  const firstMix = (await db.mixes.toArray()).find(m => m.workingName === '测试 D-76 工作液')
  const stockBefore = (await db.stocks.get(1)).volumeMl
  let err = null
  try { await stockStore.revokeMix(firstMix.id) } catch (e) { err = e }
  assert(err && /已经撤销/.test(err.message), '拒绝重复撤销')
  assert((await db.stocks.get(1)).volumeMl === stockBefore, '余量不再变化')
})

await section('已冲洗不可撤销', async () => {
  const hcMix = (await db.mixes.toArray()).find(m => m.workingName === 'HC110 1to3')
  await db.developers.update(hcMix.workingDeveloperId, { usedRolls: 1 })
  const stockBefore = (await db.stocks.get(2)).volumeMl
  let err = null
  try { await stockStore.revokeMix(hcMix.id) } catch (e) { err = e }
  assert(err && /已冲洗/.test(err.message), '提示已冲洗不能撤销')
  assert((await db.stocks.get(2)).volumeMl === stockBefore, '母液余量未变')
  const mix = await db.mixes.get(hcMix.id)
  assert(mix.status === '正常', '台账仍为正常')
  const dev = await db.developers.get(hcMix.workingDeveloperId)
  assert(dev.state !== '已撤销', '工作液未作废')
})

await section('撤销事务失败回滚（模拟母液缺失）', async () => {
  // 新建一笔配制，然后强行删除母液，撤销应整体回滚
  const res = await stockStore.mixWorking({
    category: 'Rodinal', stockId: 3, workingName: 'Rodinal 工作液',
    dilution: '1:3', targetVolumeMl: 120, mixedAt: dateMod.today()
  })
  const mix = await db.mixes.get(res.mixId)
  await db.stocks.delete(3)
  let err = null
  try { await stockStore.revokeMix(res.mixId) } catch (e) { err = e }
  assert(err && err.name === 'MixValidationError', '母液缺失时报错')
  const mixAfter = await db.mixes.get(res.mixId)
  assert(mixAfter.status === '正常', '记录回滚为正常（未留已撤销）')
  const devAfter = await db.developers.get(res.developerId)
  assert(devAfter.state !== '已撤销', '工作液回滚未作废')
})

await section('旧数据升级：不补造母液', () => {
  assert(devStore.untracedDevelopers.length >= 5, '旧工作液仍标未追溯')
})

console.log(`\n结果：${passed} 通过, ${failed} 失败`)
if (failed > 0) process.exit(1)
