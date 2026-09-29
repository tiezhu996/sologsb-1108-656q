import { defineStore } from 'pinia'
import { db, plain, SCHEMA_REV } from '../utils/db'
import type { Developer } from '../types/developer'
import { remainingRolls } from '../utils/ratio'

type NewDeveloper = Omit<Developer, 'id' | 'schemaRev' | 'sourceTraced' | 'sourceStockId'>

export const useDeveloperStore = defineStore('developer', {
  state: () => ({
    developers: [] as Developer[],
    loading: false
  }),
  getters: {
    /** 可用于配方/冲洗的工作液：排除报废与已撤销 */
    activeDevelopers: (state) =>
      state.developers.filter((developer) => developer.state !== '报废' && developer.state !== '已撤销'),
    tracedDevelopers: (state) => state.developers.filter((developer) => developer.sourceTraced === true),
    untracedDevelopers: (state) => state.developers.filter((developer) => developer.sourceTraced !== true),
    availableRolls(): number {
      return this.activeDevelopers.reduce(
        (sum, developer) => sum + remainingRolls(developer.maxRolls, developer.usedRolls),
        0
      )
    }
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.developers = await db.developers.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    /** 手工登记工作液（非母液分装）：来源不可追溯，不补造母液 */
    async addDeveloper(payload: NewDeveloper): Promise<number> {
      const next: Developer = { ...payload, sourceTraced: false, schemaRev: SCHEMA_REV }
      const id = await db.developers.add(plain(next))
      await this.load()
      return id
    },
    async incrementUsed(id: number): Promise<void> {
      const developer = await db.developers.get(id)
      if (!developer) return
      const usedRolls = developer.usedRolls + 1
      await db.developers.update(id, plain({ usedRolls }))
      await this.load()
    },
    async scrap(id: number): Promise<void> {
      await db.developers.update(id, plain({ state: '报废' }))
      await this.load()
    }
  }
})
