import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { Developer } from '../types/developer'
import { remainingRolls } from '../utils/ratio'

export const useDeveloperStore = defineStore('developer', {
  state: () => ({
    developers: [] as Developer[],
    loading: false
  }),
  getters: {
    activeDevelopers: (state) => state.developers.filter(
      (developer) => developer.state !== '报废' && developer.state !== '已撤销'
    ),
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
