const fakeDB = await import('fake-indexeddb')
Object.assign(globalThis, { indexedDB: fakeDB.indexedDB, IDBKeyRange: fakeDB.IDBKeyRange })
const Dexie = (await import('dexie')).Dexie

let passed = 0, failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✓', label) }
  else { failed++; console.log('  ✗ FAIL:', label) }
}

// 1) 以“旧版本”结构创建 v2 数据库（无 sourceTraced 字段、无 stocks/mixes 表）
const old = new Dexie('gbfilmdev-db')
old.version(1).stores({
  films: '++id, model, format, expireDate, rollsLeft',
  developers: '++id, category, state, mixedAt',
  recipes: '++id, filmId, developerId, dilution, pushPull, tempC',
  runs: '++id, recipeId, runDate, tankType'
})
old.version(2).stores({
  films: '++id, model, format, expireDate, rollsLeft',
  developers: '++id, category, state, mixedAt',
  recipes: '++id, filmId, developerId, dilution, pushPull, tempC',
  runs: '++id, recipeId, runDate, tankType'
})
await old.open()
await old.developers.bulkAdd([
  { id: 1, name: '旧工作液 A', category: 'D-76', dilution: '1:1', volumeMl: 1000, mixedAt: '2026-09-01', maxRolls: 12, usedRolls: 2, state: '在用', schemaRev: 2 },
  { id: 2, name: '旧工作液 B', category: 'C-41', dilution: '1:3', volumeMl: 500, mixedAt: '2026-08-01', maxRolls: 10, usedRolls: 0, state: '新配', schemaRev: 2 }
])
await old.close()

// 2) 用应用的 v3 模式重新打开，触发 upgrade
const { db } = await import('./src/utils/db.ts')
await db.open()

const devs = await db.developers.toArray()
console.log('=== v2 → v3 升级 ===')
assert(devs.length === 2, '旧工作液全部保留')
assert(devs.every(d => d.sourceTraced === false), '旧工作液标记为来源未追溯')
assert(devs.every(d => d.schemaRev === 3), 'schemaRev 回填为 3')
assert(devs.every(d => d.sourceStockId === undefined), '不补造母液（无 sourceStockId）')

const tableNames = db.tables.map(t => t.name)
assert(tableNames.includes('stocks') && tableNames.includes('mixes'), '新增 stocks/mixes 表')
const stockCount = await db.stocks.count()
assert(stockCount === 0, '升级不为老用户补造任何母液')
const mixCount = await db.mixes.count()
assert(mixCount === 0, '升级不补造台账记录')

// 旧工作液仍可用于业务（activeDevelopers getter 逻辑等价判断）
assert(devs.filter(d => d.state !== '报废' && d.state !== '已撤销').length === 2, '旧工作液仍可用')

// 3) 升级后可以正常走新流程
const { useStockStore } = await import('./src/stores/stockStore.ts')
const { setActivePinia, createPinia } = await import('pinia')
setActivePinia(createPinia())
const store = useStockStore()
await db.stocks.add({ id: 1, name: '新母液', category: 'D-76', openedAt: '2026-09-01', expireDate: '2027-03-01', volumeMl: 500, schemaRev: 3 })
await store.load()
const res = await store.mixWorking({ category: 'D-76', stockId: 1, workingName: '升级后配制', dilution: '1:1', targetVolumeMl: 400, mixedAt: '2026-09-29' })
assert(res.stockUsedMl === 200, '升级后配制换算正常')
assert((await db.stocks.get(1)).volumeMl === 300, '升级后配制可正常扣减')

console.log(`\n结果：${passed} 通过, ${failed} 失败`)
if (failed > 0) process.exit(1)
